/**
 * The timeline's model: journal entries become rows (a burst of saves to one
 * file by one author is one row), rows are filtered, and each gets a time
 * group. Pure functions, so the view only draws.
 */
import type { ActivityEntry, Actor, Workspace } from '@shared/protocol';

/** Saves to one file by one author this close together are one burst. */
export const BURST_MS = 5000;

export type Verb = 'created' | 'changed' | 'deleted' | 'merged' | 'cloned';

export interface Row {
  /** Id of the oldest entry: stable while newer saves join the burst. */
  key: number;
  /** The entries of the burst, newest first. */
  entries: ActivityEntry[];
  /** When the newest entry happened. */
  at: number;
  path: string;
  isDir: boolean;
  actor: Actor;
  verb: Verb;
  additions: number;
  deletions: number;
  /** True when at least one entry has line counts. */
  counted: boolean;
  workspaceId?: string;
  /** Set on the one row that stands for a whole clone: how many files the copy began with. */
  clonedFiles?: number;
}

export type AuthorFilter = 'all' | 'me' | { agentId: string };

export interface Filters {
  author: AuthorFilter;
  /** Only changes inside this workspace, and the merges that came out of it. */
  workspace: Workspace | null;
  /** Matched against the path, case insensitive. */
  query: string;
}

export const actorKey = (actor: Actor): string => (actor.type === 'me' ? 'me' : `${actor.type}:${actor.agentId}`);

export function matches(entry: Pick<ActivityEntry, 'path' | 'actor' | 'workspaceId'>, filters: Filters): boolean {
  const { author, workspace, query } = filters;
  if (author === 'me' && entry.actor.type !== 'me') return false;
  if (typeof author === 'object' && (entry.actor.type === 'me' || entry.actor.agentId !== author.agentId)) return false;
  if (workspace) {
    const inside = entry.workspaceId === workspace.id;
    const mergedFrom =
      entry.actor.type === 'merge' && workspace.agentId !== undefined && entry.actor.agentId === workspace.agentId;
    if (!inside && !mergedFrom) return false;
  }
  if (query && !entry.path.toLowerCase().includes(query.toLowerCase())) return false;
  return true;
}

function verbOf(entries: ActivityEntry[]): Verb {
  const newest = entries[0]!;
  const oldest = entries.at(-1)!;
  if (newest.kind === 'unlink' || newest.kind === 'unlinkDir') return 'deleted';
  if (newest.actor.type === 'merge') return 'merged';
  if (oldest.kind === 'add' || oldest.kind === 'addDir') return 'created';
  return 'changed';
}

function toRow(entries: ActivityEntry[]): Row {
  const newest = entries[0]!;
  let additions = 0;
  let deletions = 0;
  let counted = false;
  for (const entry of entries) {
    if (entry.additions === undefined && entry.deletions === undefined) continue;
    counted = true;
    additions += entry.additions ?? 0;
    deletions += entry.deletions ?? 0;
  }
  return {
    key: entries.at(-1)!.id,
    entries,
    at: newest.at,
    path: newest.path,
    isDir: newest.isDir,
    actor: newest.actor,
    verb: verbOf(entries),
    additions,
    deletions,
    counted,
    ...(newest.workspaceId === undefined ? {} : { workspaceId: newest.workspaceId }),
  };
}

/**
 * Rows from entries that are newest first. An entry joins the open burst of
 * its file and author when it is within BURST_MS of that burst's oldest save,
 * even if another file changed in between.
 */
export function toRows(entries: ActivityEntry[]): Row[] {
  const bursts: ActivityEntry[][] = [];
  const open = new Map<string, ActivityEntry[]>();
  for (const entry of entries) {
    const key = `${actorKey(entry.actor)}\n${entry.path}`;
    const burst = open.get(key);
    const oldest = burst?.at(-1);
    // A burst ends at the save that created the file, and a delete is always a row of its own.
    const sameStory = oldest !== undefined && oldest.kind === 'change' && entry.kind !== 'unlink';
    if (burst && oldest && sameStory && oldest.at - entry.at <= BURST_MS && !entry.isDir) {
      burst.push(entry);
    } else {
      const started = [entry];
      open.set(key, started);
      bursts.push(started);
    }
  }
  return bursts.map(toRow);
}

/** Files of a clone are reported one after another; a pause longer than this ends the clone. */
const CLONE_GAP_MS = 600;
/** The watcher can stamp the first file a moment before the workspace is registered. */
const CLONE_LEAD_MS = 250;

const BENCH_PATH = /^Workspaces\/[^/]+-bench-\d+(?:-\d+)?(?:\/|$)/;

/** The benchmark makes and removes workspaces in milliseconds; thousands of files that nobody wrote. */
export const isBenchPath = (path: string): boolean => BENCH_PATH.test(path);

/**
 * Giving an agent its own copy puts every file of the project on disk again,
 * and the journal records each one. Nobody wrote those files, so they are
 * taken out of the entries and returned as one row per workspace.
 */
export function splitClones(entries: ActivityEntry[], workspaces: Workspace[]): { rest: ActivityEntry[]; clones: Row[] } {
  const byId = new Map<string, Workspace>(workspaces.map((workspace) => [workspace.id, workspace]));
  const candidates = new Map<string, ActivityEntry[]>();
  // By folder, not by the entry's workspace id: the first files land before the workspace is registered.
  const byFolder = new Map<string, Workspace>(workspaces.map((workspace) => [workspace.name, workspace]));
  for (const entry of entries) {
    if (entry.kind !== 'add' && entry.kind !== 'addDir') continue;
    const [top, folder] = entry.path.split('/', 2);
    const workspace = top === 'Workspaces' && folder !== undefined ? byFolder.get(folder) : undefined;
    if (!workspace) continue;
    const held = candidates.get(workspace.id);
    if (held) held.push(entry);
    else candidates.set(workspace.id, [entry]);
  }

  const taken = new Set<number>();
  const clones: Row[] = [];
  for (const [workspaceId, found] of candidates) {
    const workspace = byId.get(workspaceId)!;
    // Oldest first: the clone is the unbroken run of new files that starts when the workspace was made.
    const ordered = [...found].sort((a, b) => a.id - b.id);
    const run: ActivityEntry[] = [];
    let last = workspace.createdAt;
    for (const entry of ordered) {
      if (entry.at < workspace.createdAt - CLONE_LEAD_MS) continue;
      if (entry.at - last > CLONE_GAP_MS) break;
      run.push(entry);
      last = Math.max(last, entry.at);
    }
    if (run.length === 0) continue;
    for (const entry of run) taken.add(entry.id);
    const newest = run.at(-1)!;
    const files = run.filter((entry) => !entry.isDir).length;
    clones.push({
      key: run[0]!.id,
      entries: run.reverse(),
      at: newest.at,
      path: workspace.path,
      isDir: true,
      // The copy is the agent's even when its first files were reported before it was handed over.
      actor: run.find((entry) => entry.actor.type === 'agent')?.actor ?? newest.actor,
      verb: 'cloned',
      additions: 0,
      deletions: 0,
      counted: false,
      workspaceId,
      clonedFiles: files,
    });
  }
  return { rest: taken.size === 0 ? entries : entries.filter((entry) => !taken.has(entry.id)), clones };
}

/** Rows of single changes and clone rows in one list, newest first. */
export function mergeRows(rows: Row[], clones: Row[]): Row[] {
  if (clones.length === 0) return rows;
  return [...rows, ...clones].sort((a, b) => b.entries[0]!.id - a.entries[0]!.id);
}

export interface RowGroup {
  label: string;
  rows: Row[];
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const DAY_WITH_YEAR = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const SHORT_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** "Just now", then the hour for earlier today, then the day. */
export function groupLabel(at: number, now: number): string {
  if (now - at < 120_000) return 'Just now';
  const then = new Date(at);
  const today = new Date(now);
  if (sameDay(then, today)) return `Today, ${String(then.getHours()).padStart(2, '0')}:00`;
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(then, yesterday)) return 'Yesterday';
  return then.getFullYear() === today.getFullYear() ? DAY.format(then) : DAY_WITH_YEAR.format(then);
}

export function groupRows(rows: Row[], now: number): RowGroup[] {
  const groups: RowGroup[] = [];
  for (const row of rows) {
    const label = groupLabel(row.at, now);
    const last = groups.at(-1);
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

/** "now", "12 s ago", "3 min ago", "2 h ago", then the date. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return SHORT_DAY.format(new Date(at));
}

export const clockTime = (at: number): string => CLOCK.format(new Date(at));

export function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? { name: path, folder: '' } : { name: path.slice(slash + 1), folder: path.slice(0, slash + 1) };
}

export const parentOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};

/** The benchmark's workspaces live for milliseconds; they are not anyone's work to review. */
export const isBenchWorkspace = (workspace: Workspace): boolean => /-bench-\d+(-\d+)?$/.test(workspace.name);
