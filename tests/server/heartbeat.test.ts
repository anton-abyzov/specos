import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import WebSocket from 'ws';
import { startTestServer, type TestServer } from './helpers';

const HEARTBEAT_MS = 40;

let server: TestServer;
const opened: WebSocket[] = [];

beforeAll(async () => {
  server = await startTestServer({ heartbeatMs: HEARTBEAT_MS });
});
afterEach(() => {
  for (const socket of opened.splice(0)) socket.terminate();
});
afterAll(() => server.close());

function connect(pathname: string, options: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(server.wsUrl + pathname, {
      ...options,
      headers: { cookie: server.cookie, origin: server.url },
    });
    opened.push(socket);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.each(['/ws', '/ws/pty'])('a socket on %s that answers the pings stays open', async (pathname) => {
  const socket = await connect(pathname);
  let pings = 0;
  socket.on('ping', () => (pings += 1));
  let closed = false;
  socket.on('close', () => (closed = true));

  // Long enough for many rounds: a socket whose answers were not heard would be cut at the second ping.
  await wait(HEARTBEAT_MS * 10);
  expect(pings).toBeGreaterThanOrEqual(3);
  expect(closed).toBe(false);
  expect(socket.readyState).toBe(WebSocket.OPEN);
});

test('a socket that stops answering is cut', async () => {
  const socket = await connect('/ws', { autoPong: false });
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
  // No close handshake: the peer is taken to be gone.
  expect(await closed).toBe(1006);
});
