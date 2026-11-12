/**
 * The workspace benchmark as the desktop sees it: one run at a time, drawn
 * from the 'bench' frames whoever started it (this window, the menu bar or the
 * launcher), and the last finished result kept across reloads.
 */
import { create } from 'zustand';
import type { BenchmarkResult, CloneReport } from '@shared/protocol';
import { api, ApiRequestError } from '../../lib/api';
import { events } from '../../lib/events';

export const BENCH_COUNTS = [5, 10, 25] as const;
export type BenchCount = (typeof BENCH_COUNTS)[number];

const STORAGE_KEY = 'specos.system.bench.v1';

export interface BenchRun {
  /** The server's id for the run; null until its first frame arrives. */
  id: string | null;
  count: number;
  /** Clone reports by index; a hole is a clone whose frame has not arrived. */
  clones: Array<CloneReport | undefined>;
}

export interface BenchRecord {
  result: BenchmarkResult;
  /** When the run finished, milliseconds since the epoch. */
  at: number;
}

interface BenchState {
  count: BenchCount;
  running: BenchRun | null;
  last: BenchRecord | null;
  error: string | null;
  setCount(count: BenchCount): void;
  /** Starts a run with the chosen count; does nothing while one is running. */
  start(): void;
}

function isCloneReport(value: unknown): value is CloneReport {
  const clone = value as Partial<CloneReport> | null;
  return (
    typeof clone === 'object' &&
    clone !== null &&
    typeof clone.ms === 'number' &&
    typeof clone.bytes === 'number' &&
    typeof clone.diskBytes === 'number' &&
    typeof clone.files === 'number' &&
    typeof clone.strategy === 'string'
  );
}

function readStored(): BenchRecord | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    const record = parsed as Partial<BenchRecord> | null;
    const result = record?.result;
    if (
      typeof record?.at !== 'number' ||
      typeof result !== 'object' ||
      result === null ||
      typeof result.totalMs !== 'number' ||
      typeof result.strategy !== 'string' ||
      typeof result.project !== 'string' ||
      !Array.isArray(result.clones) ||
      result.clones.length === 0 ||
      !result.clones.every(isCloneReport)
    ) {
      return null;
    }
    return { result, at: record.at };
  } catch {
    return null;
  }
}

function store(record: BenchRecord): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage is full or switched off: the result still shows until the page is closed.
  }
}

export const useBench = create<BenchState>((set, get) => ({
  count: 10,
  running: null,
  last: readStored(),
  error: null,

  setCount: (count) => set({ count }),

  start() {
    if (get().running) return;
    const { count } = get();
    set({ running: { id: null, count, clones: [] }, error: null });
    api.system.benchmark({ count }).then(finish, (error: unknown) => {
      // Another window got there first: its frames are already being drawn.
      if (error instanceof ApiRequestError && error.status === 409 && get().running?.id) return;
      set({
        running: null,
        error:
          error instanceof ApiRequestError && error.status === 409
            ? 'A test is already running. Its result will show here when it ends.'
            : error instanceof ApiRequestError
              ? error.message
              : 'The test did not finish.',
      });
    });
  },
}));

function finish(result: BenchmarkResult): void {
  const { last } = useBench.getState();
  // The answer and the 'bench-done' frame both carry the result; the first one in is kept.
  if (last?.result.id === result.id) {
    useBench.setState({ running: null });
    return;
  }
  const record = { result, at: Date.now() };
  store(record);
  useBench.setState({ running: null, last: record, error: null });
}

events.subscribe('bench', ({ id, index, count, clone }) => {
  useBench.setState((state) => {
    const held = state.running;
    // A frame of a run that is not ours yet (started elsewhere) opens it here too.
    const run: BenchRun = held && (held.id === null || held.id === id) ? held : { id, count, clones: [] };
    const clones = run.clones.slice();
    clones[index] = clone;
    return { running: { id, count, clones }, error: null };
  });
});
events.subscribe('bench-done', ({ result }) => finish(result));

// ---------------------------------------------------------------- figures

export interface BenchSummary {
  totalMs: number;
  averageMs: number;
  medianMs: number;
  /** Files and logical bytes of one clone. */
  files: number;
  bytes: number;
  /** New disk blocks used by all clones together. */
  diskBytes: number;
}

export function summarise(result: BenchmarkResult): BenchSummary {
  const times = result.clones.map((clone) => clone.ms).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const medianMs = times.length % 2 === 1 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2;
  return {
    totalMs: result.totalMs,
    averageMs: result.totalMs / result.clones.length,
    medianMs,
    files: result.clones[0]!.files,
    bytes: result.clones[0]!.bytes,
    diskBytes: result.clones.reduce((sum, clone) => sum + clone.diskBytes, 0),
  };
}
