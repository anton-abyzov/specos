/**
 * The events socket (/ws): one stream of everything that happens on the
 * server. This module keeps it connected, lets code subscribe to frames by
 * type, and feeds the zustand stores that the rest of the client reads.
 */
import type { ServerEvent } from '@shared/protocol';
import { useActivityStore } from '../stores/activity';
import { useAgentsStore } from '../stores/agents';
import { useConnectionStore } from '../stores/connection';
import { useSystemStore } from '../stores/system';
import { useWorkspacesStore } from '../stores/workspaces';
import { api } from './api';

export type ServerEventType = ServerEvent['type'];
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;
type Handler<T extends ServerEventType> = (event: ServerEventOf<T>) => void;
/** How handlers are held: the map key guarantees each only sees its own frame type. */
type StoredHandler = (event: ServerEvent) => void;

const RETRY_MIN_MS = 400;
const RETRY_MAX_MS = 8000;

class EventsClient {
  private socket: WebSocket | null = null;
  private retryTimer: number | undefined;
  private retryDelay = RETRY_MIN_MS;
  private started = false;
  private readonly handlers = new Map<ServerEventType, Set<StoredHandler>>();

  /** Connects and stays connected. Safe to call more than once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  /** Closes the socket and stops reconnecting. */
  stop(): void {
    this.started = false;
    window.clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
  }

  /** Calls the handler for every frame of one type; returns the unsubscribe. */
  subscribe<T extends ServerEventType>(type: T, handler: Handler<T>): () => void {
    const stored = handler as unknown as StoredHandler;
    const set = this.handlers.get(type) ?? new Set();
    this.handlers.set(type, set);
    set.add(stored);
    return () => set.delete(stored);
  }

  private connect(): void {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    this.socket = socket;

    socket.addEventListener('message', (message) => {
      if (typeof message.data !== 'string') return;
      let event: ServerEvent;
      try {
        event = JSON.parse(message.data) as ServerEvent;
      } catch {
        return; // Not ours to understand; the next frame will be.
      }
      this.dispatch(event);
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.started) return;
      useConnectionStore.getState().setStatus('reconnecting');
      // Back off with jitter so a restarted server is not hit by every tab at once.
      const wait = this.retryDelay * (0.75 + Math.random() * 0.5);
      this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
      this.retryTimer = window.setTimeout(() => this.connect(), wait);
    });
  }

  private dispatch(event: ServerEvent): void {
    if (event.type === 'hello') {
      // hello is the server's first frame: the connection is good from here.
      this.retryDelay = RETRY_MIN_MS;
      useConnectionStore.getState().setStatus('open');
    }
    const handlers = this.handlers.get(event.type);
    if (!handlers) return;
    for (const handler of [...handlers]) handler(event);
  }
}

/** The one events socket of this page. */
export const events = new EventsClient();

/**
 * Frames missed while the socket was down are gone, so every (re)connect
 * reloads the list of jobs. A failure is left for the next reconnect: the
 * stores simply keep what they have.
 */
function reloadAgents(): void {
  api.agents.list().then(
    (response) => useAgentsStore.getState().replaceAll(response),
    () => undefined,
  );
}

/** Wires the socket to the stores and connects. Call once, before the first render. */
export function startEvents(): void {
  events.subscribe('hello', ({ system }) => {
    useSystemStore.getState().setInfo(system);
    reloadAgents();
    // The next stats frame can be two seconds away; ask once so the meters are never blank that long.
    api.system.stats().then(
      (stats) => {
        if (!useSystemStore.getState().stats) useSystemStore.getState().pushStats(stats);
      },
      () => undefined,
    );
  });
  events.subscribe('stats', ({ stats }) => useSystemStore.getState().pushStats(stats));
  events.subscribe('fs', ({ entry }) => useActivityStore.getState().push(entry));
  events.subscribe('agent', ({ agent }) => useAgentsStore.getState().upsert(agent));
  events.subscribe('agent-removed', ({ id }) => useAgentsStore.getState().remove(id));
  events.subscribe('agent-event', ({ id, event }) => useAgentsStore.getState().appendEvents(id, [event]));
  events.subscribe('workspace', ({ workspace }) => useWorkspacesStore.getState().upsert(workspace));
  events.subscribe('workspace-removed', ({ id }) => useWorkspacesStore.getState().remove(id));
  events.start();
}
