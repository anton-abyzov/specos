/**
 * One terminal: an xterm.js screen wired to its own shell on /ws/pty. It lives
 * outside React, because nothing in it should wait for a render: keys go to
 * the socket and output goes to the screen.
 */
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import type { PtyClientFrame, PtyServerFrame } from '@shared/protocol';
import { getTheme, type Theme } from '../../lib/theme';
import type { TerminalCommands } from './menus';
import { terminalTheme } from './theme';

export type SessionPhase = 'connecting' | 'running' | 'ended';

export interface SessionStatus {
  phase: SessionPhase;
  /** Why the session ended: the shell left, the connection dropped, or the folder was refused. */
  ending: 'exit' | 'dropped' | 'refused' | null;
  exitCode: number | null;
}

interface SessionOptions {
  /** Home relative folder the shell starts in. */
  cwd: string;
  onStatus(status: SessionStatus): void;
  onTitle(title: string): void;
}

const FONT_SIZE = 13;
/** The server closes with this code when it will not start a shell in the folder asked for. */
const POLICY_VIOLATION = 1008;

/** The folder as the title shows it: the SpecOS home is "Home". */
const folderLabel = (cwd: string): string => (cwd ? `Home/${cwd}` : 'Home');

const shellName = (shell: string): string => shell.split('/').pop() || shell;

export class TerminalSession implements TerminalCommands {
  readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private readonly frame: HTMLElement | null;
  private readonly observers: Array<{ disconnect(): void }> = [];
  private socket: WebSocket | null = null;
  private status: SessionStatus = { phase: 'connecting', ending: null, exitCode: null };
  private cwd: string;
  /** The title the shell asked for; empty until it sends one. */
  private shellTitle = '';
  private fallbackTitle = 'Terminal';
  private fitFrame = 0;
  private opened = false;
  private disposed = false;
  /** Whether the window wants the keyboard; remembered so a focus asked for before the screen opens still lands. */
  private wantsFocus = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly options: SessionOptions,
  ) {
    this.cwd = options.cwd;
    this.frame = host.closest<HTMLElement>('.wm-frame');
    const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();

    this.terminal = new Terminal({
      fontFamily,
      fontSize: FONT_SIZE,
      fontWeight: 400,
      fontWeightBold: 650,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'outline',
      scrollback: 10_000,
      allowProposedApi: false,
      // Programs pick colours for a dark screen; this keeps every pairing readable on paper too.
      minimumContrastRatio: 4.5,
      theme: terminalTheme(getTheme()),
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));

    this.terminal.attachCustomKeyEventHandler((event) => this.handleKey(event));
    this.terminal.onData((data) => {
      if (this.status.phase === 'ended') {
        if (data === '\r') this.restart();
        return;
      }
      this.send({ type: 'input', data });
    });
    this.terminal.onResize(({ cols, rows }) => this.send({ type: 'resize', cols, rows }));
    this.terminal.onTitleChange((title) => {
      this.shellTitle = title.trim();
      this.reportTitle();
    });

    void this.open(fontFamily);
  }

  /** Opens the screen once the font is there, so the first cell is measured in the right face. */
  private async open(fontFamily: string): Promise<void> {
    const face = fontFamily.split(',')[0] ?? 'monospace';
    await Promise.all([
      document.fonts.load(`${FONT_SIZE}px ${face}`),
      document.fonts.load(`650 ${FONT_SIZE}px ${face}`),
    ]).catch(() => undefined);
    if (this.disposed) return;

    this.terminal.open(this.host);
    this.opened = true;
    this.fitAddon.fit();
    this.watchSize();
    this.connect();
    if (this.wantsFocus) this.terminal.focus();
  }

  /** Refits when the window's size changes, and once more when a snap, tile or full screen move has settled. */
  private watchSize(): void {
    const resize = new ResizeObserver(() => this.scheduleFit());
    resize.observe(this.host);
    this.observers.push(resize);
    if (!this.frame) return;
    const settle = new MutationObserver(() => this.scheduleFit());
    settle.observe(this.frame, { attributes: true, attributeFilter: ['data-moving'] });
    this.observers.push(settle);
  }

  private scheduleFit(): void {
    if (this.fitFrame) return;
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = 0;
      // While a spring carries the window to its new rectangle the shell is left alone;
      // the frame drops data-moving when it arrives and that asks for the fit again.
      if (this.disposed || this.frame?.hasAttribute('data-moving')) return;
      if (this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
      this.fitAddon.fit();
    });
  }

  private connect(): void {
    const { cols, rows } = this.terminal;
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const query = new URLSearchParams({ cols: String(cols), rows: String(rows), cwd: this.cwd });
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws/pty?${query}`);
    this.socket = socket;
    this.setStatus({ phase: 'connecting', ending: null, exitCode: null });

    socket.addEventListener('message', (message) => {
      if (socket !== this.socket || typeof message.data !== 'string') return;
      let frame: PtyServerFrame;
      try {
        frame = JSON.parse(message.data) as PtyServerFrame;
      } catch {
        return;
      }
      if (frame.type === 'output') {
        this.terminal.write(frame.data);
      } else if (frame.type === 'ready') {
        this.fallbackTitle = `${shellName(frame.shell)} in ${folderLabel(frame.cwd)}`;
        this.setStatus({ phase: 'running', ending: null, exitCode: null });
        this.reportTitle();
        // The window may have been resized while the socket was opening.
        if (this.terminal.cols !== cols || this.terminal.rows !== rows) {
          this.send({ type: 'resize', cols: this.terminal.cols, rows: this.terminal.rows });
        }
      } else if (frame.type === 'exit') {
        this.end('exit', frame.code);
      }
    });

    socket.addEventListener('close', (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      if (this.status.phase === 'ended') return;
      const refused = this.status.phase === 'connecting' && event.code === POLICY_VIOLATION;
      this.end(refused ? 'refused' : 'dropped', null);
    });
  }

  private end(ending: NonNullable<SessionStatus['ending']>, exitCode: number | null): void {
    this.shellTitle = '';
    // Nothing reads the keyboard any more, so the cursor goes; a restart resets the screen and brings it back.
    this.terminal.write('\x1b[?25l');
    this.setStatus({ phase: 'ended', ending, exitCode });
    this.reportTitle();
  }

  private send(frame: PtyClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this.options.onStatus(status);
  }

  private reportTitle(): void {
    this.options.onTitle(this.shellTitle || this.fallbackTitle);
  }

  /** Keys the terminal keeps for itself. Returning false keeps the key from the shell. */
  private handleKey(event: KeyboardEvent): boolean {
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return true;
    if (event.code === 'KeyC') {
      if (event.type === 'keydown') {
        event.preventDefault();
        this.copy();
      }
      return false;
    }
    // Paste is left to the browser: its own paste lands in xterm's input, which works
    // on every origin, while reading the clipboard from script needs a secure one.
    if (event.code === 'KeyV') return false;
    return true;
  }

  copy(): void {
    const text = this.terminal.getSelection();
    if (!text) return;
    const fallback = () => {
      // Without the clipboard API (a plain http origin) the browser copies from a selected field.
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.append(field);
      field.select();
      document.execCommand('copy');
      field.remove();
      this.focus();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(fallback);
    else fallback();
  }

  paste(): void {
    navigator.clipboard?.readText().then(
      (text) => {
        if (text && !this.disposed) this.terminal.paste(text);
      },
      () => undefined,
    );
  }

  selectAll(): void {
    this.terminal.selectAll();
  }

  clear(): void {
    this.terminal.clear();
  }

  /** Ends the shell that is there, if any, and starts a fresh one on a clean screen. */
  restart(): void {
    if (!this.opened || this.disposed) return;
    const old = this.socket;
    this.socket = null;
    old?.close();
    // A folder that was refused will be refused again; the home folder always works.
    if (this.status.ending === 'refused') this.cwd = '';
    this.shellTitle = '';
    this.terminal.reset();
    this.connect();
    this.focus();
  }

  focus(): void {
    this.wantsFocus = true;
    if (this.opened) this.terminal.focus();
  }

  blur(): void {
    this.wantsFocus = false;
    if (this.opened) this.terminal.blur();
  }

  setTheme(theme: Theme): void {
    this.terminal.options.theme = terminalTheme(theme);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.fitFrame);
    for (const observer of this.observers) observer.disconnect();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.terminal.dispose();
  }
}
