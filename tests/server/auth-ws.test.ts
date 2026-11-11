import os from 'node:os';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import WebSocket from 'ws';
import type { ServerEvent } from '../../shared/protocol';
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers';

let server: TestServer;
const opened: WebSocket[] = [];

beforeAll(async () => {
  server = await startTestServer();
});
afterEach(() => {
  for (const socket of opened.splice(0)) socket.terminate();
});
afterAll(() => server.close());

type Outcome = { opened: true; socket: WebSocket } | { opened: false; status: number };

/** Attempts an upgrade and reports whether a socket opened or which HTTP status refused it. */
function connect(pathname: string, headers: Record<string, string> = {}): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(server.wsUrl + pathname, { headers });
    opened.push(socket);
    socket.once('open', () => resolve({ opened: true, socket }));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve({ opened: false, status: response.statusCode ?? 0 });
    });
    socket.once('error', reject);
  });
}

/** Resolves with the first frame that matches, from the moment the socket exists. */
function nextEvent<T extends ServerEvent['type']>(
  socket: WebSocket,
  type: T,
): Promise<Extract<ServerEvent, { type: T }>> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      if (event.type !== type) return;
      socket.off('message', onMessage);
      resolve(event as Extract<ServerEvent, { type: T }>);
    };
    socket.on('message', onMessage);
  });
}

/** Opens an authenticated events socket and waits for its greeting. */
async function openEvents(): Promise<{ socket: WebSocket; hello: Extract<ServerEvent, { type: 'hello' }> }> {
  const socket = new WebSocket(server.wsUrl + '/ws', { headers: { cookie: server.cookie, origin: server.url } });
  opened.push(socket);
  const hello = await nextEvent(socket, 'hello');
  return { socket, hello };
}

test('an upgrade without a cookie is refused with 401 and never opens', async () => {
  expect(await connect('/ws')).toEqual({ opened: false, status: 401 });
});

test('an upgrade with a wrong cookie is refused with 401', async () => {
  expect(await connect('/ws', { cookie: 'specos_session=not-the-token' })).toEqual({ opened: false, status: 401 });
});

test('a token in the query string does not open a socket', async () => {
  expect(await connect(`/ws?token=${TEST_TOKEN}`)).toEqual({ opened: false, status: 401 });
});

test('an upgrade from a foreign Origin is refused with 403 even with the cookie', async () => {
  const outcome = await connect('/ws', { cookie: server.cookie, origin: 'http://evil.example' });
  expect(outcome).toEqual({ opened: false, status: 403 });
});

test('an upgrade to an unknown path is refused with 404', async () => {
  expect(await connect('/ws/nothing-here', { cookie: server.cookie })).toEqual({ opened: false, status: 404 });
  expect(await connect('/api/health', { cookie: server.cookie })).toEqual({ opened: false, status: 404 });
});

test('a refused upgrade leaves no socket behind on the server', async () => {
  await connect('/ws');
  await connect('/ws', { cookie: server.cookie, origin: 'http://evil.example' });
  expect(server.specos.ctx.sockets?.eventClients()).toBe(0);
});

test('a valid cookie opens the events socket, which greets with the system', async () => {
  const { socket, hello } = await openEvents();
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(hello.system.kernel).toBe(os.release());
  expect(hello.system.hostname).toBe(os.hostname());
  expect(hello.system.agentRunner.available).toBe('demo');
});

test('a socket without an Origin header is accepted when the cookie is valid', async () => {
  const outcome = await connect('/ws', { cookie: server.cookie });
  expect(outcome.opened).toBe(true);
});

test('an event emitted on the bus arrives on every events socket', async () => {
  const [first, second] = await Promise.all([openEvents(), openEvents()]);
  const arrivals = Promise.all([nextEvent(first.socket, 'agent-removed'), nextEvent(second.socket, 'agent-removed')]);
  server.specos.ctx.bus.emit({ type: 'agent-removed', id: 'juniper' });
  expect(await arrivals).toEqual([
    { type: 'agent-removed', id: 'juniper' },
    { type: 'agent-removed', id: 'juniper' },
  ]);
});

test('another module can add a guarded socket path', async () => {
  server.specos.ctx.sockets?.route('/ws/echo', (socket, request) => {
    socket.send(`hello ${request.url}`);
  });
  expect(await connect('/ws/echo?x=1')).toEqual({ opened: false, status: 401 });

  // Listening from the start: the greeting can arrive in the same turn as the open event.
  const socket = new WebSocket(server.wsUrl + '/ws/echo?x=1', { headers: { cookie: server.cookie } });
  opened.push(socket);
  const message = await new Promise<string>((resolve, reject) => {
    socket.once('message', (data) => resolve(data.toString()));
    socket.once('error', reject);
  });
  expect(message).toBe('hello /ws/echo?x=1');
});

test('closing the server closes its sockets', async () => {
  const other = await startTestServer();
  const socket = new WebSocket(other.wsUrl + '/ws', { headers: { cookie: other.cookie } });
  opened.push(socket);
  await nextEvent(socket, 'hello');
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
  await other.close();
  expect(await closed).toBe(1001);
});
