import fsp from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { spawn, type IPty } from 'node-pty';
import { WebSocket } from 'ws';
import type { PtyClientFrame, PtyServerFrame } from '../../shared/protocol';
import type { Ctx } from './context';
import { PathError, resolveInHome, toRel } from './paths';

/**
 * The terminal: one real shell per socket on /ws/pty, running as the server's
 * user. It starts in the home folder but is not confined to it; the token is
 * what stands between the network and this shell.
 */

const PTY_PATH = '/ws/pty';
const FALLBACK_SHELL = '/bin/bash';

const DEFAULT_SIZE = { cols: 80, rows: 24 };
/** A window can be dragged very small or very large; the kernel accepts any number, programs do not cope with all. */
const COLS = { min: 2, max: 500 };
const ROWS = { min: 1, max: 300 };

/** WebSocket close code for "this request breaks a rule", used when the starting folder is refused. */
const POLICY_VIOLATION = 1008;
/** How long a shell gets to leave after a hangup before it is killed outright. */
const HANGUP_GRACE_MS = 500;
/** Output waiting to be sent to a slow client. Past this the shell is held back instead of filling memory. */
const BACKLOG_HIGH_BYTES = 1024 * 1024;
const BACKLOG_LOW_BYTES = 64 * 1024;

interface Size {
  cols: number;
  rows: number;
}

const clamp = (value: number, { min, max }: { min: number; max: number }): number =>
  Math.min(max, Math.max(min, Math.trunc(value)));

/** A usable size from whatever the client sent, or undefined when it is not a pair of numbers. */
function toSize(cols: unknown, rows: unknown): Size | undefined {
  if (typeof cols !== 'number' || typeof rows !== 'number') return undefined;
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined;
  return { cols: clamp(cols, COLS), rows: clamp(rows, ROWS) };
}

/** The size in the query string; a missing or unreadable number falls back to the classic 80 by 24. */
function sizeFromQuery(query: URLSearchParams): Size {
  const read = (name: keyof Size): number => {
    const raw = query.get(name);
    const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(value) ? value : DEFAULT_SIZE[name];
  };
  return toSize(read('cols'), read('rows')) ?? DEFAULT_SIZE;
}

/**
 * The environment of the shell: the server's own, announced as a colour
 * terminal, minus everything that would let a program started from the shell
 * find the access token or the server's settings.
 */
function shellEnv(token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith('SPECOS_') || value.includes(token)) continue;
    env[name] = value;
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', SPECOS: '1' };
}

/** A frame from the client, or undefined for anything that is not one. */
function parseFrame(data: WebSocket.RawData, isBinary: boolean): PtyClientFrame | undefined {
  if (isBinary) return undefined;
  let frame: unknown;
  try {
    frame = JSON.parse(data.toString());
  } catch {
    return undefined;
  }
  if (typeof frame !== 'object' || frame === null) return undefined;
  const { type, data: input, cols, rows } = frame as Record<string, unknown>;
  if (type === 'input' && typeof input === 'string') return { type, data: input };
  if (type === 'resize') {
    const size = toSize(cols, rows);
    if (size) return { type, ...size };
  }
  return undefined;
}

/** A shell that is running, and how to end it. */
interface Session {
  /** Hangs the terminal up, kills the shell if it stays, and settles once it is gone. */
  end(): Promise<void>;
}

export function registerPty(_app: FastifyInstance, ctx: Ctx): void {
  const { sockets } = ctx;
  if (!sockets) throw new Error('The terminal module needs the socket registry: register ws before it');
  const { home, token } = ctx.config;
  const sessions = new Set<Session>();
  let closing = false;

  /** The absolute starting folder for a home relative one. Throws a PathError when it leaves home. */
  async function startingFolder(rel: string): Promise<string> {
    const abs = resolveInHome(home, rel);
    const stat = await fsp.stat(abs);
    if (!stat.isDirectory()) throw new PathError('bad_path', 'The starting folder is not a folder');
    return abs;
  }

  function start(socket: WebSocket, cwd: string, size: Size): void {
    const shell = process.env.SHELL || FALLBACK_SHELL;
    // No arguments: on a terminal the shell is interactive by itself, and it is not a login shell, so the
    // profile scripts that belong to signing in do not run again for every window.
    const pty: IPty = spawn(shell, [], { name: 'xterm-256color', ...size, cwd, env: shellEnv(token) });

    const send = (frame: PtyServerFrame, sent?: () => void): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame), sent);
    };

    let exited = false;
    let gone!: () => void;
    const whenGone = new Promise<void>((resolve) => (gone = resolve));
    let killTimer: NodeJS.Timeout | undefined;

    const signal = (name: 'SIGHUP' | 'SIGKILL'): void => {
      if (exited) return;
      try {
        pty.kill(name);
      } catch {
        // It exited between the check and the signal.
      }
    };

    const session: Session = {
      end() {
        if (!exited && !killTimer) {
          signal('SIGHUP');
          // A shell can trap the hangup, and a program in it can ignore it. The window is gone either way.
          killTimer = setTimeout(() => signal('SIGKILL'), HANGUP_GRACE_MS);
        }
        return whenGone;
      },
    };
    sessions.add(session);

    // --- shell to client ---
    let held = false;
    pty.onData((data) => {
      send({ type: 'output', data }, () => {
        if (held && socket.bufferedAmount < BACKLOG_LOW_BYTES) {
          held = false;
          pty.resume();
        }
      });
      // `yes` or a huge `cat` writes faster than a network delivers. Holding the shell makes it wait, as a real
      // terminal would, instead of queueing its output in the server's memory.
      if (!held && socket.bufferedAmount > BACKLOG_HIGH_BYTES) {
        held = true;
        pty.pause();
      }
    });

    pty.onExit(({ exitCode }) => {
      exited = true;
      clearTimeout(killTimer);
      sessions.delete(session);
      send({ type: 'exit', code: exitCode });
      socket.close(1000, 'The shell exited');
      gone();
    });

    // --- client to shell ---
    socket.on('message', (data, isBinary) => {
      const frame = parseFrame(data, isBinary);
      if (!frame || exited) return;
      if (frame.type === 'input') pty.write(frame.data);
      else pty.resize(frame.cols, frame.rows);
    });
    socket.on('close', () => void session.end());

    send({ type: 'ready', pid: pty.pid, shell, cwd: toRel(home, cwd) });
  }

  sockets.route(PTY_PATH, (socket: WebSocket, request: IncomingMessage) => {
    const query = new URLSearchParams((request.url ?? '').split('?')[1] ?? '');
    startingFolder(query.get('cwd') ?? '').then(
      (cwd) => {
        // The client may have left, or the server begun to stop, while the folder was being checked.
        if (closing || socket.readyState !== WebSocket.OPEN) return socket.close();
        try {
          start(socket, cwd, sizeFromQuery(query));
        } catch {
          socket.close(1011, 'The shell could not be started');
        }
      },
      (error: unknown) => {
        const reason = error instanceof PathError ? error.message : 'The starting folder does not exist';
        socket.close(POLICY_VIOLATION, reason);
      },
    );
  });

  ctx.onClose(async () => {
    closing = true;
    await Promise.all([...sessions].map((session) => session.end()));
  });
}
