import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerEvent } from '../../shared/protocol';
import { hasSession, originMatchesHost } from './auth';
import type { Ctx } from './context';
import { systemInfo } from './system';

export type SocketHandler = (socket: WebSocket, request: IncomingMessage) => void;

/** How other modules add socket paths and learn whether anyone is watching the desktop. */
export interface SocketRegistry {
  /** Serves a path. Access is checked before the handler ever sees a socket. */
  route(path: string, handler: SocketHandler): void;
  /** Events sockets that are connected and greeted. */
  eventClients(): number;
  /** Calls back with the new count whenever an events socket connects or leaves. */
  onEventClients(listener: (count: number) => void): () => void;
}

const EVENTS_PATH = '/ws';
const HEARTBEAT_MS = 30_000;
/** How long a socket gets to answer the closing handshake on shutdown before it is cut. */
const CLOSE_GRACE_MS = 1000;
/** Frames from the desktop are keystrokes and resizes; nothing legitimate comes close to this. */
const MAX_FRAME_BYTES = 1024 * 1024;

const REFUSALS = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' } as const;

/** Answers the upgrade with a plain HTTP error and hangs up, so no WebSocket ever exists. */
function refuse(socket: Duplex, status: keyof typeof REFUSALS): void {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${REFUSALS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function closeGracefully(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const cut = setTimeout(() => socket.terminate(), CLOSE_GRACE_MS);
    socket.once('close', () => {
      clearTimeout(cut);
      resolve();
    });
    socket.close(1001, 'Server shutting down');
  });
}

export function registerWs(app: FastifyInstance, ctx: Ctx): void {
  const { token } = ctx.config;
  const routes = new Map<string, SocketHandler>();
  // noServer: the upgrade is ours to accept or refuse, ws only speaks the protocol afterwards.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());
    const pathname = (request.url ?? '').split('?', 1)[0] ?? '';
    const handler = routes.get(pathname);
    if (!handler) return refuse(socket, 404);
    // Only the cookie counts. A token in the query string would end up in proxy and browser logs, and the
    // desktop never needs it: the page that opens the socket already has the session.
    if (!hasSession(request.headers, token)) return refuse(socket, 401);
    // Browsers do not apply the same-origin policy to WebSockets, so the Origin check is done here.
    if (!originMatchesHost(request.headers)) return refuse(socket, 403);
    wss.handleUpgrade(request, socket, head, (client) => {
      // A protocol error from the peer must end that socket, not the process.
      client.on('error', () => client.terminate());
      handler(client, request);
    });
  };
  app.server.on('upgrade', onUpgrade);

  // --- heartbeat: a laptop that went to sleep never says goodbye ---
  const unanswered = new WeakSet<WebSocket>();
  wss.on('connection', (client) => client.on('pong', () => unanswered.delete(client)));
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (unanswered.has(client)) {
        client.terminate();
        continue;
      }
      unanswered.add(client);
      client.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // --- the events socket: one stream of everything that happens, for every open desktop ---
  const eventClients = new Set<WebSocket>();
  const countListeners = new Set<(count: number) => void>();
  const announceCount = (): void => {
    for (const listener of countListeners) listener(eventClients.size);
  };

  routes.set(EVENTS_PATH, (client) => {
    client.on('close', () => {
      if (eventClients.delete(client)) announceCount();
    });
    void systemInfo(ctx.config).then(
      (system) => {
        if (client.readyState !== WebSocket.OPEN) return;
        client.send(JSON.stringify({ type: 'hello', system } satisfies ServerEvent));
        // Joins the stream only now, so hello is always the first frame a desktop reads.
        eventClients.add(client);
        announceCount();
      },
      () => client.close(1011, 'System information is unavailable'),
    );
  });

  const stopForwarding = ctx.bus.on((event) => {
    if (eventClients.size === 0) return;
    const frame = JSON.stringify(event);
    for (const client of eventClients) {
      if (client.readyState === WebSocket.OPEN) client.send(frame);
    }
  });

  ctx.sockets = {
    route(path, handler) {
      if (routes.has(path)) throw new Error(`Socket path ${path} is already served`);
      routes.set(path, handler);
    },
    eventClients: () => eventClients.size,
    onEventClients(listener) {
      countListeners.add(listener);
      return () => countListeners.delete(listener);
    },
  };

  ctx.onClose(async () => {
    clearInterval(heartbeat);
    stopForwarding();
    app.server.off('upgrade', onUpgrade);
    // The HTTP server waits for every connection, upgraded ones included, so they are closed here first.
    await Promise.all([...wss.clients].map(closeGracefully));
    wss.close();
  });
}
