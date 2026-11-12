import { create } from 'zustand';
import type { ActivityEntry } from '@shared/protocol';

/** Entries kept in memory. The server's journal has the rest (api.activity.list). */
export const ACTIVITY_CAP = 500;

interface ActivityState {
  /** File changes, newest first, without duplicates. */
  entries: ActivityEntry[];
  /** Adds one live change ('fs' frames). It shows with the others of the same burst, a moment later. */
  push(entry: ActivityEntry): void;
  /** Merges a page loaded from the journal with what is already held. */
  merge(entries: ActivityEntry[]): void;
}

/** How long live changes are gathered before they are shown together. */
export const BURST_MS = 24;

/**
 * Gathers what arrives within one burst and hands it over together. Deleting a folder of a
 * thousand files is then one update for everything that shows changes, not a thousand.
 */
export function gathered<T>(deliver: (items: T[]) => void): (item: T) => void {
  let waiting: T[] = [];
  let timer: number | undefined;
  return (item) => {
    waiting.push(item);
    timer ??= window.setTimeout(() => {
      timer = undefined;
      const items = waiting;
      waiting = [];
      deliver(items);
    }, BURST_MS);
  };
}

export const useActivityStore = create<ActivityState>((set) => ({
  entries: [],
  push: gathered((arrived) =>
    set((state) => {
      const [entry] = arrived;
      // Ids only grow, so a live entry is almost always the newest.
      if (arrived.length === 1 && entry && (state.entries.length === 0 || entry.id > state.entries[0]!.id)) {
        return { entries: [entry, ...state.entries].slice(0, ACTIVITY_CAP) };
      }
      return { entries: mergeNewestFirst(state.entries, arrived) };
    }),
  ),
  merge: (entries) => set((state) => ({ entries: mergeNewestFirst(state.entries, entries) })),
}));

function mergeNewestFirst(held: ActivityEntry[], incoming: ActivityEntry[]): ActivityEntry[] {
  const byId = new Map(held.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, ACTIVITY_CAP);
}
