import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import WebSocket from 'ws';
import type { PtyClientFrame, PtyServerFrame } from '../../shared/protocol';
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers';

let server: TestServer;
/** The home folder as the shell reports it, with any symlink in the temp path resolved. */
let realHome: string;
const opened: WebSocket[] = [];

beforeAll(async () => {
  server = await startTestServer();
  realHome = fs.realpathSync(server.home);
});
afterEach(() => {
  for (const socket of opened.splice(0)) socket.terminate();
});
afterAll(() => server.close());

/** Colour, cursor and title sequences a prompt may print; they are not part of what a command wrote. */
const CONTROL_SEQUENCES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/** One terminal session as a test sees it: every frame it received, and what the shell has printed so far. */
class Terminal {
  readonly frames: PtyServerFrame[] = [];
  closed: { code: number; reason: string } | undefined;

  constructor(readonly socket: WebSocket) {
    // Attached before the socket opens, so the ready frame cannot slip past.
    socket.on('message', (data) => this.frames.push(JSON.parse(data.toString()) as PtyServerFrame));
    socket.on('close', (code, reason) => (this.closed = { code, reason: reason.toString() }));
    // A failed connect shows up as the missing ready frame of the test, not as an uncaught error.
    socket.on('error', () => undefined);
  }

  /** Everything the shell has written, without control sequences. */
  get output(): string {
    return this.frames
      .map((frame) => (frame.type === 'output' ? frame.data : ''))
      .join('')
      .replace(CONTROL_SEQUENCES, '');
  }

  send(frame: PtyClientFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  type(line: string): void {
    this.send({ type: 'input', data: line + '\n' });
  }

  async frame<T extends PtyServerFrame['type']>(type: T): Promise<Extract<PtyServerFrame, { type: T }>> {
    const find = () => this.frames.find((frame) => frame.type === type);
    await expect.poll(find, { timeout: 5000, interval: 10, message: `no ${type} frame` }).toBeDefined();
    return find() as Extract<PtyServerFrame, { type: T }>;
  }

  /** Waits until the shell has printed a line that is exactly `line`, which the echo of a command never is. */
  async printsLine(line: string): Promise<void> {
    const printed = () => this.output.split(/\r?\n|\r/).includes(line);
    await expect
      .poll(printed, { timeout: 5000, interval: 10, message: `the shell never printed the line ${line}` })
      .toBe(true);
  }

  async closes(): Promise<{ code: number; reason: string }> {
    await expect.poll(() => this.closed, { timeout: 5000, interval: 10, message: 'the socket stayed open' }).toBeDefined();
    return this.closed as { code: number; reason: string };
  }
}

function open(query = '', target: TestServer = server): Terminal {
  const socket = new WebSocket(`${target.wsUrl}/ws/pty${query}`, { headers: { cookie: target.cookie, origin: target.url } });
  opened.push(socket);
  return new Terminal(socket);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const dies = (pid: number): Promise<void> =>
  expect.poll(() => isAlive(pid), { timeout: 3000, interval: 20, message: `process ${pid} is still running` }).toBe(false);

test('a terminal is a real shell that starts in the home folder', async () => {
  const terminal = open();
  const ready = await terminal.frame('ready');

  expect(ready.shell).toBe(process.env.SHELL || '/bin/bash');
  expect(ready.cwd).toBe('');
  expect(ready.pid).toBeGreaterThan(1);
  expect(isAlive(ready.pid)).toBe(true);

  terminal.type('pwd');
  await terminal.printsLine(realHome);
});

test('what is typed is run by the shell', async () => {
  const terminal = open();
  await terminal.frame('ready');

  terminal.type('echo $((6*7))');
  await terminal.printsLine('42');
});

test('the shell starts at the size in the query and follows a resize', async () => {
  const terminal = open('?cols=100&rows=30');
  await terminal.frame('ready');

  terminal.type('stty size');
  await terminal.printsLine('30 100');

  terminal.send({ type: 'resize', cols: 132, rows: 43 });
  terminal.type('stty size');
  await terminal.printsLine('43 132');
});

test('a size out of bounds is clamped instead of refused', async () => {
  const terminal = open('?cols=100000&rows=0');
  await terminal.frame('ready');

  terminal.type('stty size');
  await terminal.printsLine('1 500');

  terminal.send({ type: 'resize', cols: 1, rows: 99999 });
  terminal.type('stty size');
  await terminal.printsLine('300 2');
});

test('a cwd inside home starts the shell there', async () => {
  const folder = path.join(server.home, 'Projects', 'notes');
  fs.mkdirSync(folder, { recursive: true });

  const terminal = open('?cwd=' + encodeURIComponent('Projects/notes'));
  expect((await terminal.frame('ready')).cwd).toBe('Projects/notes');

  terminal.type('pwd');
  await terminal.printsLine(path.join(realHome, 'Projects', 'notes'));
});

test.each([
  ['a parent folder', '../'],
  ['a path that climbs out half way', 'Projects/../../etc'],
  ['an absolute path', '/etc'],
])('a cwd that is %s is refused and no shell starts', async (_name, cwd) => {
  const terminal = open('?cwd=' + encodeURIComponent(cwd));

  expect((await terminal.closes()).code).toBe(1008);
  expect(terminal.frames).toEqual([]);
});

test('a cwd that leaves home through a symlink is refused', async () => {
  fs.symlinkSync('/etc', path.join(server.home, 'way-out'));

  const terminal = open('?cwd=way-out');

  expect((await terminal.closes()).code).toBe(1008);
  expect(terminal.frames).toEqual([]);
});

test('a cwd that is not a folder is refused', async () => {
  fs.writeFileSync(path.join(server.home, 'a-file.txt'), 'text\n');

  for (const cwd of ['a-file.txt', 'no-such-folder']) {
    const terminal = open('?cwd=' + cwd);
    expect((await terminal.closes()).code, cwd).toBe(1008);
    expect(terminal.frames, cwd).toEqual([]);
  }
});

test('the shell sees a terminal environment without the access token or the server settings', async () => {
  const before = { token: process.env.SPECOS_TOKEN, data: process.env.SPECOS_DATA, copy: process.env.PTY_TEST_TOKEN_COPY };
  process.env.SPECOS_TOKEN = TEST_TOKEN;
  process.env.SPECOS_DATA = server.data;
  // The token under a name the server knows nothing about must not get through either.
  process.env.PTY_TEST_TOKEN_COPY = TEST_TOKEN;
  process.env.PTY_TEST_KEPT = 'kept';
  try {
    const terminal = open();
    await terminal.frame('ready');

    terminal.type(
      'echo "<$TERM|$COLORTERM|$SPECOS|${SPECOS_TOKEN:-gone}|${SPECOS_DATA:-gone}|${PTY_TEST_TOKEN_COPY:-gone}|$PTY_TEST_KEPT>"',
    );
    await terminal.printsLine('<xterm-256color|truecolor|1|gone|gone|gone|kept>');
  } finally {
    for (const [name, value] of [
      ['SPECOS_TOKEN', before.token],
      ['SPECOS_DATA', before.data],
      ['PTY_TEST_TOKEN_COPY', before.copy],
      ['PTY_TEST_KEPT', undefined],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('malformed frames are ignored and the terminal keeps working', async () => {
  const terminal = open();
  await terminal.frame('ready');

  terminal.socket.send('not json');
  terminal.socket.send('null');
  terminal.socket.send(JSON.stringify({ type: 'input' }));
  terminal.socket.send(JSON.stringify({ type: 'input', data: 7 }));
  terminal.socket.send(JSON.stringify({ type: 'resize', cols: 'wide', rows: 10 }));
  terminal.socket.send(JSON.stringify({ type: 'resize', cols: 80 }));
  terminal.socket.send(JSON.stringify({ type: 'launch', data: 'missiles' }));
  terminal.socket.send(Buffer.from([0xff, 0xfe, 0x00]));

  terminal.type('echo $((40+2)) still here');
  await terminal.printsLine('42 still here');
  expect(terminal.closed).toBeUndefined();
});

test('closing the socket kills the shell', async () => {
  const terminal = open();
  const { pid } = await terminal.frame('ready');
  expect(isAlive(pid)).toBe(true);

  terminal.socket.close();

  await dies(pid);
});

test('a shell that ignores the hangup is still killed when its socket closes', async () => {
  const terminal = open();
  const { pid } = await terminal.frame('ready');
  terminal.type("trap '' HUP; echo trap-$((1+1))-set");
  await terminal.printsLine('trap-2-set');

  terminal.socket.close();

  await dies(pid);
});

test('when the shell exits the client gets its exit code and the socket closes', async () => {
  const terminal = open();
  const { pid } = await terminal.frame('ready');

  terminal.type('exit 3');

  expect((await terminal.frame('exit')).code).toBe(3);
  expect((await terminal.closes()).code).toBe(1000);
  expect(terminal.frames.at(-1)?.type).toBe('exit');
  await dies(pid);
});

test('terminals are independent of each other', async () => {
  const first = open();
  const second = open();
  const [a, b] = await Promise.all([first.frame('ready'), second.frame('ready')]);
  expect(a.pid).not.toBe(b.pid);

  first.type('echo only-$((1+0))');
  await first.printsLine('only-1');
  expect(second.output).not.toContain('only-1');

  first.socket.close();
  await dies(a.pid);
  second.type('echo other-$((1+1))');
  await second.printsLine('other-2');
});

test('stopping the server kills every shell', async () => {
  const other = await startTestServer();
  let pids: number[];
  try {
    const terminals = [open('', other), open('', other)];
    pids = (await Promise.all(terminals.map((terminal) => terminal.frame('ready')))).map((ready) => ready.pid);
    expect(pids.every(isAlive)).toBe(true);
  } finally {
    await other.close();
  }

  for (const pid of pids) await dies(pid);
});

test('the terminal socket needs the session like every other socket', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(server.wsUrl + '/ws/pty', { headers: { origin: server.url } });
    opened.push(socket);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => reject(new Error('the socket opened without a session')));
    socket.once('error', reject);
  });

  expect(status).toBe(401);
});
