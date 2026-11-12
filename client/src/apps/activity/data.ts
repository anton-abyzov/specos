/**
 * What the Activity app holds beyond the shared stores: the journal as far
 * back as the user has paged, each workspace's diff and merge outcome, and the
 * patches of the changes that were opened.
 */
import { create } from 'zustand';
import type { ActivityDetail, ActivityEntry, MergeResult, WorkspaceDiff } from '@shared/protocol';
import { api, ApiRequestError } from '../../lib/api';
import { events } from '../../lib/events';
import { gathered, useActivityStore } from '../../stores/activity';
import { useWorkspacesStore } from '../../stores/workspaces';

// ---------------------------------------------------------------- journal

const PAGE = 200;
/** Entries kept while paging back; far more than anyone reads in one sitting. */
const JOURNAL_CAP = 5000;

interface JournalState {
  /** Newest first, without duplicates. */
  entries: ActivityEntry[];
  /** idle until the first page is asked for. */
  status: 'idle' | 'loading' | 'ready' | 'failed';
  /** True while the journal may hold entries older than the ones here. */
  hasOlder: boolean;
  loadingOlder: boolean;
  error: string | null;
  loadFirst(): void;
  loadOlder(): void;
}

function mergeEntries(held: ActivityEntry[], incoming: ActivityEntry[]): ActivityEntry[] {
  if (incoming.length === 0) return held;
  // A live entry is almost always simply the newest.
  if (incoming.length === 1 && (held.length === 0 || incoming[0]!.id > held[0]!.id)) {
    return [incoming[0]!, ...held].slice(0, JOURNAL_CAP);
  }
  const byId = new Map(held.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, JOURNAL_CAP);
}

const messageOf = (error: unknown): string =>
  error instanceof ApiRequestError ? error.message : 'The request did not finish.';

export const useJournal = create<JournalState>((set, get) => ({
  // Whatever arrived over the socket before this window was first opened.
  entries: useActivityStore.getState().entries,
  status: 'idle',
  hasOlder: false,
  loadingOlder: false,
  error: null,

  loadFirst() {
    if (get().status === 'loading') return;
    set((state) => ({ status: state.status === 'ready' ? 'ready' : 'loading', error: null }));
    api.activity.list({ limit: PAGE }).then(
      ({ entries }) =>
        set((state) => ({
          entries: mergeEntries(state.entries, entries),
          status: 'ready',
          hasOlder: state.hasOlder || entries.length === PAGE,
        })),
      (error: unknown) => set((state) => ({ status: state.status === 'ready' ? 'ready' : 'failed', error: messageOf(error) })),
    );
  },

  loadOlder() {
    const { entries, loadingOlder } = get();
    const oldest = entries.at(-1);
    if (loadingOlder || !oldest) return;
    set({ loadingOlder: true, error: null });
    api.activity.list({ limit: PAGE, before: oldest.id }).then(
      (page) =>
        set((state) => ({
          entries: mergeEntries(state.entries, page.entries),
          hasOlder: page.entries.length === PAGE,
          loadingOlder: false,
        })),
      (error: unknown) => set({ loadingOlder: false, error: messageOf(error) }),
    );
  },
}));

const addLive = gathered<ActivityEntry>((arrived) => useJournal.setState((state) => ({ entries: mergeEntries(state.entries, arrived) })));
events.subscribe('fs', ({ entry }) => addLive(entry));
// Frames missed while the socket was down are in the journal: read its newest page again.
events.subscribe('hello', () => {
  if (useJournal.getState().status !== 'idle') useJournal.getState().loadFirst();
});

// ---------------------------------------------------------------- patches

const details = new Map<number, Promise<ActivityDetail>>();

/** The patch of one journal entry. Entries never change, so each is fetched once. */
export function loadDetail(id: number): Promise<ActivityDetail> {
  let held = details.get(id);
  if (!held) {
    held = api.activity.detail(id);
    details.set(id, held);
    // A failure is not kept: the next look asks again.
    held.catch(() => details.delete(id));
  }
  return held;
}

// ---------------------------------------------------------------- workspaces

export interface WorkspaceReview {
  diff?: WorkspaceDiff;
  /** True until the first answer. Later reloads keep showing the diff they replace. */
  loading: boolean;
  error?: string;
  merging: boolean;
  /** The answer of the last merge made from this window. */
  merge?: MergeResult;
  mergeError?: string;
}

const EMPTY_REVIEW: WorkspaceReview = { loading: true, merging: false };

interface ReviewsState {
  reviews: Record<string, WorkspaceReview>;
}

export const useReviews = create<ReviewsState>(() => ({ reviews: {} }));

export const reviewOf = (state: ReviewsState, id: string | undefined): WorkspaceReview =>
  (id ? state.reviews[id] : undefined) ?? EMPTY_REVIEW;

function patchReview(id: string, changes: Partial<WorkspaceReview>): void {
  useReviews.setState((state) => ({
    reviews: { ...state.reviews, [id]: { ...(state.reviews[id] ?? EMPTY_REVIEW), ...changes } },
  }));
}

const inFlight = new Set<string>();
const stale = new Set<string>();

export function loadWorkspaceDiff(id: string): void {
  if (inFlight.has(id)) {
    // Something changed while the answer was on its way: ask once more when it lands.
    stale.add(id);
    return;
  }
  inFlight.add(id);
  api.workspaces
    .diff(id)
    .then(
      (diff) => patchReview(id, { diff, loading: false, error: undefined }),
      (error: unknown) => patchReview(id, { loading: false, error: messageOf(error) }),
    )
    .finally(() => {
      inFlight.delete(id);
      if (stale.delete(id)) loadWorkspaceDiff(id);
    });
}

/** Workspaces some part of the window is showing; only their diffs follow the file system. */
const watched = new Map<string, number>();
const timers = new Map<string, number>();

function reloadSoon(id: string): void {
  if (!watched.has(id) || timers.has(id)) return;
  // An agent writes in bursts: one reload after the burst, not one per line.
  timers.set(
    id,
    window.setTimeout(() => {
      timers.delete(id);
      loadWorkspaceDiff(id);
    }, 400),
  );
}

/** Keeps a workspace's diff current while something shows it; returns the release. */
export function watchWorkspace(id: string): () => void {
  watched.set(id, (watched.get(id) ?? 0) + 1);
  loadWorkspaceDiff(id);
  return () => {
    const left = (watched.get(id) ?? 1) - 1;
    if (left <= 0) watched.delete(id);
    else watched.set(id, left);
  };
}

events.subscribe('fs', ({ entry }) => {
  if (entry.workspaceId) reloadSoon(entry.workspaceId);
});
events.subscribe('workspace', ({ workspace }) => reloadSoon(workspace.id));

export async function mergeWorkspace(id: string): Promise<void> {
  if (reviewOf(useReviews.getState(), id).merging) return;
  patchReview(id, { merging: true, mergeError: undefined });
  try {
    const merge = await api.workspaces.merge(id);
    patchReview(id, { merging: false, merge });
  } catch (error) {
    patchReview(id, { merging: false, mergeError: messageOf(error) });
  }
}

/** Workspaces made before this page connected are not in the store yet. */
export function loadWorkspaces(): void {
  api.workspaces.list().then(
    (response) => useWorkspacesStore.getState().replaceAll(response),
    () => undefined,
  );
}
