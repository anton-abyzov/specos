import type { ServerEvent } from '../../shared/protocol';
import type { Config } from './config';

type Listener = (event: ServerEvent) => void;

/** In-process fan-out of everything the events socket sends. */
export class EventBus {
  private listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/**
 * Shared by every server module. A module that owns a service adds it here as
 * an optional field (activity, workspaces, agents) and assigns it in register().
 */
export interface Ctx {
  config: Config;
  bus: EventBus;
  /** Run on shutdown, in reverse order of registration. */
  onClose(fn: () => void | Promise<void>): void;
}
