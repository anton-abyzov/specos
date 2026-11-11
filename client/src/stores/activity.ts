import { create } from 'zustand';
import type { ActivityEntry } from '@shared/protocol';

/** Entries kept in memory. The server's journal has the rest (api.activity.list). */
export const ACTIVITY_CAP = 500;

interface ActivityState {
  /** File changes, newest first, without duplicates. */
  entries: ActivityEntry[];
  /** Adds one live change ('fs' frames). */
  push(entry: ActivityEntry): void;
  /** Merges a page loaded from the journal with what is already held. */
  merge(entries: ActivityEntry[]): void;
}

export const useActivityStore = create<ActivityState>((set) => ({
  entries: [],
  push: (entry) =>
    set((state) => {
      // Ids only grow, so a live entry is almost always the newest.
      if (state.entries.length === 0 || entry.id > state.entries[0]!.id) {
        return { entries: [entry, ...state.entries].slice(0, ACTIVITY_CAP) };
      }
      return { entries: mergeNewestFirst(state.entries, [entry]) };
    }),
  merge: (entries) => set((state) => ({ entries: mergeNewestFirst(state.entries, entries) })),
}));

function mergeNewestFirst(held: ActivityEntry[], incoming: ActivityEntry[]): ActivityEntry[] {
  const byId = new Map(held.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, ACTIVITY_CAP);
}
