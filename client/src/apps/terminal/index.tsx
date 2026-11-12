import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import type { AppProps } from '../registry';
import { useShellStore } from '../../stores/shell';
import { useTheme } from '../../stores/theme';
import { terminalWindows } from './menus';
import { TerminalSession, type SessionStatus } from './session';
import './terminal.css';

const CONNECTING: SessionStatus = { phase: 'connecting', ending: null, exitCode: null };

/** One plain sentence for how the session ended. */
function endingText(status: SessionStatus, cwd: string): string {
  if (status.ending === 'refused') return `The shell could not start in ${cwd || 'that folder'}.`;
  if (status.ending === 'dropped') return 'The connection to the shell was lost.';
  return 'The shell has exited.';
}

/** A real shell on this machine: one PTY per window, kept alive for as long as the window exists. */
export default function TerminalApp({ windowId, params, setTitle, focused }: AppProps) {
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const session = useRef<TerminalSession | null>(null);
  const [status, setStatus] = useState<SessionStatus>(CONNECTING);
  const theme = useTheme();
  const cwd = typeof params.cwd === 'string' ? params.cwd : '';

  // The session is made once per window.
  useEffect(() => {
    const created = new TerminalSession(host.current!, { cwd, onStatus: setStatus, onTitle: setTitle });
    session.current = created;
    terminalWindows.set(windowId, created);
    // Tests read the screen through this.
    const hook = (window.__specos ??= {});
    const terminals = (hook.terminals ??= {}) as Record<string, unknown>;
    terminals[windowId] = created.terminal;
    return () => {
      delete terminals[windowId];
      terminalWindows.delete(windowId);
      session.current = null;
      created.dispose();
    };
    // The folder is read once, when the window opens: a session is never moved.
  }, [windowId]);

  // The keyboard follows the window: in front it types into the shell, behind it does not.
  // The overview and the launcher borrow it; it comes back when they close.
  const covered = useShellStore((state) => state.overviewOpen || state.launcherOpen);
  useEffect(() => {
    if (!focused) session.current?.blur();
    else if (!covered) session.current?.focus();
  }, [focused, covered]);

  useEffect(() => {
    session.current?.setTheme(theme);
  }, [theme]);

  // A press on the title bar or the strip below takes the focus off the screen; hand it back.
  useEffect(() => {
    const frame = root.current?.closest<HTMLElement>('.wm-frame');
    if (!frame) return;
    const onPointerUp = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest('.terminal__host, .window__controls')) return;
      requestAnimationFrame(() => {
        if (frame.hasAttribute('data-focused')) session.current?.focus();
      });
    };
    frame.addEventListener('pointerup', onPointerUp);
    return () => frame.removeEventListener('pointerup', onPointerUp);
  }, []);

  const ended = status.phase === 'ended';

  return (
    <div className="terminal" ref={root} data-testid="app-terminal" data-phase={status.phase}>
      <div className="terminal__screen">
        <div className="terminal__host" ref={host} />
      </div>
      {ended && (
        <div className="terminal__ended" role="status" data-testid="terminal-ended">
          <span className="terminal__ended-mark" aria-hidden="true" />
          <span className="terminal__ended-title">Session ended</span>
          <span className="terminal__ended-text">{endingText(status, cwd)}</span>
          {status.exitCode !== null && <span className="terminal__ended-code">exit {status.exitCode}</span>}
          <button
            type="button"
            className="terminal__restart"
            data-testid="terminal-restart"
            onClick={() => session.current?.restart()}
          >
            <kbd>Enter</kbd>
            Start a new shell
          </button>
        </div>
      )}
    </div>
  );
}
