/**
 * What the Files app knows about the disk: one listing per folder it has
 * shown, kept current by the 'fs' frames of the events socket, plus the marks
 * that make a change visible for a few seconds. Every Files window reads the
 * same store, so two windows on one folder never disagree.
 */
import { create } from 'zustand';
import type { ActivityEntry, Actor, ChangeKind, FsEntry } from '@shared/protocol';
import { api, ApiRequestError } from '../../lib/api';
import { events } from '../../lib/events';
import { useConnectionStore } from '../../stores/connection';
import { chainOf, compareEntries, isWithin, nameOf, parentOf } from './kinds';

/** How long a change stays marked on its row and on the folders above it. */
export const MARK_MS = 5000;
/** How long a deleted row takes to collapse before it leaves the listing. */
export const LEAVE_MS = 240;

export interface Listing {
  status: 'loading' | 'ready' | 'error';
  /** Sorted: folders first, then by name. */
  entries: FsEntry[];
  /** The server's code when the folder could not be listed, for example "not_found". */
  errorCode?: string;
  error?: string;
}

export interface Mark {
  at: number;
  actor: Actor;
  kind: ChangeKind;
}

interface FilesState {
  listings: Record<string, Listing>;
  /** The last change of a path, while it is fresh. */
  marks: Record<string, Mark>;
  /** Folders with a fresh change somewhere below them. */
  activity: Record<string, Mark>;
  /** Rows that are collapsing out after a delete. */
  leaving: Record<string, true>;
}

export const useFilesStore = create<FilesState>(() => ({ listings: {}, marks: {}, activity: {}, leaving: {} }));

const { getState: get, setState: set } = useFilesStore;

// ---------------------------------------------------------------- listings

const inFlight = new Map<string, Promise<void>>();

/** Lists a folder, keeping what is already shown until the answer arrives. */
export function loadFolder(path: string): Promise<void> {
  const running = inFlight.get(path);
  if (running) return running;
  if (!get().listings[path]) {
    set((state) => ({ listings: { ...state.listings, [path]: { status: 'loading', entries: [] } } }));
  }
  const request = api.fs
    .list(path)
    .then(
      (response) => {
        const entries = [...response.entries].sort(compareEntries);
        set((state) => ({ listings: { ...state.listings, [path]: { status: 'ready', entries } } }));
      },
      (error: unknown) => {
        const failure = error instanceof ApiRequestError ? error : null;
        set((state) => ({
          listings: {
            ...state.listings,
            [path]: {
              status: 'error',
              entries: [],
              errorCode: failure?.code ?? 'unknown',
              error: failure?.message ?? 'This folder could not be read.',
            },
          },
        }));
      },
    )
    .finally(() => inFlight.delete(path));
  inFlight.set(path, request);
  return request;
}

function withEntry(listing: Listing, entry: FsEntry): Listing {
  const others = listing.entries.filter((other) => other.path !== entry.path);
  return { ...listing, entries: [...others, entry].sort(compareEntries) };
}

function withoutLeaving(leaving: Record<string, true>, path: string): Record<string, true> {
  if (!(path in leaving)) return leaving;
  const { [path]: _gone, ...rest } = leaving;
  return rest;
}

/** Shows an entry the server just returned (a new file, a new folder) without waiting for its event. */
export function putEntry(entry: FsEntry): void {
  set((state) => {
    const listing = state.listings[parentOf(entry.path)];
    if (listing?.status !== 'ready') return state;
    return {
      listings: { ...state.listings, [parentOf(entry.path)]: withEntry(listing, entry) },
      leaving: withoutLeaving(state.leaving, entry.path),
    };
  });
}

/** Swaps a renamed or moved entry in place, so the row does not collapse and reappear. */
export function replaceEntry(from: string, entry: FsEntry): void {
  set((state) => {
    const listings = { ...state.listings };
    const source = listings[parentOf(from)];
    if (source?.status === 'ready') {
      listings[parentOf(from)] = { ...source, entries: source.entries.filter((other) => other.path !== from) };
    }
    const target = listings[parentOf(entry.path)];
    if (target?.status === 'ready') listings[parentOf(entry.path)] = withEntry(target, entry);
    // Listings below a renamed folder are keyed by the old path; they are read again under the new one.
    for (const key of Object.keys(listings)) if (key === from || key.startsWith(`${from}/`)) delete listings[key];
    return { listings };
  });
}

const leaveTimers = new Map<string, number>();

/** Starts the collapse of a deleted row; it leaves the listing when the collapse is over. */
export function removeEntry(path: string): void {
  const listing = get().listings[parentOf(path)];
  if (!listing?.entries.some((entry) => entry.path === path) || leaveTimers.has(path)) return;
  set((state) => ({ leaving: { ...state.leaving, [path]: true } }));
  leaveTimers.set(
    path,
    window.setTimeout(() => {
      leaveTimers.delete(path);
      set((state) => {
        // Re-created while it was collapsing: the row stays.
        if (!state.leaving[path]) return state;
        const listings = { ...state.listings };
        const parent = listings[parentOf(path)];
        if (parent) listings[parentOf(path)] = { ...parent, entries: parent.entries.filter((entry) => entry.path !== path) };
        for (const key of Object.keys(listings)) if (key === path || key.startsWith(`${path}/`)) delete listings[key];
        return { listings, leaving: withoutLeaving(state.leaving, path) };
      });
    }, LEAVE_MS),
  );
}

// ---------------------------------------------------------------- live changes

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const refineTimers = new Map<string, number>();
const refineWanted = new Map<string, Set<string>>();

/**
 * The event says a path changed, not its size or type. Once the writes have settled the folder is
 * listed once for all of its changed rows; a listing never fails for a file that is gone again,
 * where asking for the file itself would.
 */
function refine(path: string): void {
  const parent = parentOf(path);
  const wanted = refineWanted.get(parent) ?? new Set<string>();
  wanted.add(path);
  refineWanted.set(parent, wanted);
  window.clearTimeout(refineTimers.get(parent));
  refineTimers.set(
    parent,
    window.setTimeout(() => {
      refineTimers.delete(parent);
      refineWanted.delete(parent);
      const { listings, leaving } = get();
      // The folder itself is on its way out, or no longer shown: nothing to bring up to date.
      if (listings[parent]?.status !== 'ready' || chainOf(parent).some((folder) => leaving[folder])) return;
      api.fs.list(parent).then(
        (response) => {
          for (const entry of response.entries) {
            if (!wanted.has(entry.path) || get().leaving[entry.path]) continue;
            if (get().listings[parent]?.entries.some((other) => other.path === entry.path)) putEntry(entry);
          }
        },
        () => undefined, // The folder went away meanwhile; its own event removes it.
      );
    }, 120),
  );
}

let queue: ActivityEntry[] = [];
let flushTimer: number | undefined;
let pruneTimer: number | undefined;

function schedulePrune(): void {
  window.clearTimeout(pruneTimer);
  const { marks, activity } = get();
  let oldest = Infinity;
  for (const mark of Object.values(marks)) oldest = Math.min(oldest, mark.at);
  for (const mark of Object.values(activity)) oldest = Math.min(oldest, mark.at);
  if (oldest === Infinity) return;
  pruneTimer = window.setTimeout(prune, Math.max(50, oldest + MARK_MS - Date.now()));
}

function prune(): void {
  const cutoff = Date.now() - MARK_MS;
  const fresh = (record: Record<string, Mark>) => {
    const kept = Object.entries(record).filter(([, mark]) => mark.at > cutoff);
    return kept.length === Object.keys(record).length ? record : Object.fromEntries(kept);
  };
  set((state) => ({ marks: fresh(state.marks), activity: fresh(state.activity) }));
  schedulePrune();
}

/** Applies a burst of changes in one store update, so a clone of 200 files renders once. */
function flush(): void {
  flushTimer = undefined;
  const batch = queue;
  queue = [];
  const removed: string[] = [];
  set((state) => {
    const listings = { ...state.listings };
    const marks = { ...state.marks };
    const activity = { ...state.activity };
    let leaving = state.leaving;
    for (const change of batch) {
      const { path, kind } = change;
      const parent = parentOf(path);
      const listing = listings[parent];
      // Marks follow the clock of this page, so they expire on time whatever the server's clock says.
      const mark: Mark = { at: Date.now(), actor: change.actor, kind };
      for (const folder of chainOf(parent)) if (folder) activity[folder] = mark;

      if (kind === 'unlink' || kind === 'unlinkDir') {
        delete marks[path];
        if (listing?.entries.some((entry) => entry.path === path)) removed.push(path);
        continue;
      }
      marks[path] = mark;
      if (listing?.status !== 'ready') continue;
      const held = listing.entries.find((entry) => entry.path === path);
      const name = nameOf(path);
      listings[parent] = withEntry(listing, {
        name,
        path,
        kind: held?.kind ?? (change.isDir ? 'dir' : 'file'),
        size: held?.size ?? 0,
        mtime: change.at,
        ext: change.isDir ? '' : extOf(name),
        hidden: name.startsWith('.'),
      });
      leaving = withoutLeaving(leaving, path);
      refine(path);
    }
    return { listings, marks, activity, leaving };
  });
  for (const path of removed) removeEntry(path);
  schedulePrune();
}

events.subscribe('fs', ({ entry }) => {
  queue.push(entry);
  flushTimer ??= window.setTimeout(flush, 24);
});

// Changes made while the socket was down were never announced: read every shown folder again.
let greeted = useConnectionStore.getState().status !== 'connecting';
events.subscribe('hello', () => {
  if (greeted) for (const path of Object.keys(get().listings)) void loadFolder(path);
  greeted = true;
});

// ---------------------------------------------------------------- reading

const NO_ENTRIES: FsEntry[] = [];

export const useListing = (path: string): Listing | undefined => useFilesStore((state) => state.listings[path]);

/** The entry at a path, when its folder has been listed. */
export function findEntry(path: string | null): FsEntry | undefined {
  if (!path) return undefined;
  return get().listings[parentOf(path)]?.entries.find((entry) => entry.path === path);
}

export const useEntry = (path: string | null): FsEntry | undefined =>
  useFilesStore((state) =>
    path ? state.listings[parentOf(path)]?.entries.find((entry) => entry.path === path) : undefined,
  );

/** Rows a person can move through: listed, not collapsing, and not hidden unless asked for. */
export function visibleEntries(folder: string, showHidden: boolean, keep?: string | null): FsEntry[] {
  const state = get();
  const entries = state.listings[folder]?.entries ?? NO_ENTRIES;
  return entries.filter(
    (entry) => !state.leaving[entry.path] && (showHidden || !entry.hidden || (!!keep && isWithin(keep, entry.path))),
  );
}
