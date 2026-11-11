import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from 'diff';
import type { FastifyInstance } from 'fastify';
import type {
  ActivityDetail,
  ActivityEntry,
  ActivityListResponse,
  Actor,
  ApiError,
  ChangeKind,
} from '../../shared/protocol';
import type { Ctx } from './context';
import { SCRATCH_PREFIX, toRel } from './paths';

/**
 * The activity journal: every change in the home folder, who made it and what
 * it changed. The watcher reports that a path changed; this module works out
 * the rest by keeping the last known text of each file and diffing against it.
 */

/** Says who is behind a change to a home relative path, or undefined for "not one of mine". */
export type ActorResolver = (relPath: string) => Actor | undefined;
/** Says which workspace contains a home relative path. */
export type WorkspaceResolver = (relPath: string) => string | undefined;

export interface ActivityService {
  /**
   * Journals one change. Resolves with the entry once it is stored and sent,
   * or with undefined when there was nothing to report (a write that left the
   * content as it was).
   */
  record(kind: ChangeKind, absPath: string): Promise<ActivityEntry | undefined>;
  /** The agents module names the agent whose workspace a path is in. Without a resolver every change is "me". */
  setActorResolver(resolver: ActorResolver): void;
  /** The workspaces module names the workspace a path is in. */
  setWorkspaceResolver(resolver: WorkspaceResolver): void;
  /** For the next `ms`, changes at or below `relPrefix` are the work of this merge and not of the user. */
  markMerge(relPrefix: string, actor: Actor, ms: number): void;
  /** Calls back for every new entry, in order. Returns the function that stops it. */
  onEntry(listener: (entry: ActivityEntry) => void): () => void;
  /** Settles when the files that were in home at start have been read, so their first change has a diff. */
  whenPrimed(): Promise<void>;
}

const RING_SIZE = 2000;
const JOURNAL_FILE = 'activity.jsonl';
/** The journal file is cut back to the ring once it holds this many lines, so it cannot grow without bound. */
const JOURNAL_COMPACT_LINES = RING_SIZE * 2;

const MAX_SNAPSHOT_BYTES = 256 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
/** All remembered text together. Past this the files that changed longest ago are forgotten first. */
const SNAPSHOT_BUDGET_CHARS = 64 * 1024 * 1024;
/** How many files are read ahead at start. A home with more gets diffs from the second change on. */
const PRIME_MAX_FILES = 5000;
/** A folder with more children than this is a data dump or a build output, not something to read ahead. */
const PRIME_MAX_FOLDER_ENTRIES = 2000;
const PRIME_SKIPPED = new Set(['.git', 'node_modules']);
/** Past this many differing lines the diff costs more than it tells; the entry is kept without one. */
const MAX_EDIT_LENGTH = 20_000;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

// ---------------------------------------------------------------- snapshots

/** The last known text of files in home, keyed by relative path, oldest use first. */
class SnapshotCache {
  private texts = new Map<string, string>();
  private chars = 0;

  get(rel: string): string | undefined {
    return this.texts.get(rel);
  }

  has(rel: string): boolean {
    return this.texts.has(rel);
  }

  set(rel: string, text: string): void {
    this.delete(rel);
    // Re-inserting moves the file to the young end of the map's order.
    this.texts.set(rel, text);
    this.chars += text.length;
    for (const [oldest, oldText] of this.texts) {
      if (this.chars <= SNAPSHOT_BUDGET_CHARS) break;
      this.texts.delete(oldest);
      this.chars -= oldText.length;
    }
  }

  delete(rel: string): void {
    const text = this.texts.get(rel);
    if (text === undefined) return;
    this.texts.delete(rel);
    this.chars -= text.length;
  }

  get full(): boolean {
    return this.chars >= SNAPSHOT_BUDGET_CHARS;
  }
}

/**
 * The text of a file, or undefined when there is no text to diff: missing,
 * not a regular file, too large or binary. A symlink is never followed, so a
 * link out of home cannot put an outside file into the journal.
 */
async function readText(abs: string): Promise<string | undefined> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return undefined; // Gone again already, a symlink, or not readable.
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return undefined;
    const bytes = await handle.readFile();
    // Checked after reading as well: the file may have grown since the stat.
    if (bytes.length > MAX_SNAPSHOT_BYTES) return undefined;
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return undefined;
    return bytes.toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------- diffs

interface TextDiff {
  patch: string;
  additions: number;
  deletions: number;
}

/** A unified diff with three lines of context, or undefined when the texts are equal or too far apart. */
function diffTexts(rel: string, before: string | null, after: string | null): TextDiff | undefined {
  // The way git names a side that does not exist, which every diff viewer understands.
  const oldName = before === null ? '/dev/null' : `a/${rel}`;
  const newName = after === null ? '/dev/null' : `b/${rel}`;
  const patch = structuredPatch(oldName, newName, before ?? '', after ?? '', undefined, undefined, {
    context: 3,
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (!patch || patch.hunks.length === 0) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
  }
  return { patch: formatPatch(patch, FILE_HEADERS_ONLY), additions, deletions };
}

// ---------------------------------------------------------------- journal file

interface Recorded {
  entry: ActivityEntry;
  patch: string;
}

function isEntry(value: unknown): value is ActivityEntry {
  const entry = value as Partial<ActivityEntry> | null;
  return (
    typeof entry === 'object' &&
    entry !== null &&
    Number.isSafeInteger(entry.id) &&
    typeof entry.at === 'number' &&
    typeof entry.kind === 'string' &&
    typeof entry.path === 'string' &&
    typeof entry.actor === 'object' &&
    entry.actor !== null
  );
}

/**
 * Reads the newest entries of an earlier run, so the timeline survives a
 * restart and ids go on from where they stopped. Patches are not kept on
 * disk, so these entries come back without a diff.
 */
function loadJournal(file: string): ActivityEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // First start.
  }
  const lines = text.split('\n').filter((line) => line !== '');
  const entries: ActivityEntry[] = [];
  for (const line of lines.slice(-RING_SIZE)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) entries.push({ ...parsed, hasDiff: false });
    } catch {
      // A line cut short by a crash. The entries around it are still good.
    }
  }
  if (lines.length >= JOURNAL_COMPACT_LINES) {
    const compact = `${file}.compact`;
    fs.writeFileSync(compact, lines.slice(-RING_SIZE).join('\n') + '\n');
    fs.renameSync(compact, file);
  } else if (text !== '' && !text.endsWith('\n')) {
    // The torn line is closed off, so the next entry does not get glued onto it.
    fs.appendFileSync(file, '\n');
  }
  return entries;
}

// ---------------------------------------------------------------- service

const isAtOrBelow = (rel: string, prefix: string): boolean =>
  prefix === '' || rel === prefix || rel.startsWith(prefix + '/');

export function registerActivity(app: FastifyInstance, ctx: Ctx): void {
  const { home, data } = ctx.config;
  const journalFile = path.join(data, JOURNAL_FILE);

  const ring: Recorded[] = loadJournal(journalFile).map((entry) => ({ entry, patch: '' }));
  let nextId = (ring.at(-1)?.entry.id ?? 0) + 1;

  const snapshots = new SnapshotCache();
  const listeners = new Set<(entry: ActivityEntry) => void>();
  let merges: Array<{ prefix: string; actor: Actor; until: number }> = [];
  let resolveActor: ActorResolver = () => undefined;
  let resolveWorkspace: WorkspaceResolver = () => undefined;
  let journalFailed = false;

  function actorOf(rel: string): Actor {
    const now = Date.now();
    merges = merges.filter((merge) => merge.until > now);
    return resolveActor(rel) ?? merges.find((merge) => isAtOrBelow(rel, merge.prefix))?.actor ?? { type: 'me' };
  }

  /**
   * What a change did to the text of a file. `skip` means the write left the
   * content as it was, which is not a change anyone needs to see.
   */
  async function textChange(kind: ChangeKind, rel: string, abs: string): Promise<TextDiff | 'skip' | undefined> {
    if (kind === 'addDir' || kind === 'unlinkDir') return undefined;
    const before = snapshots.get(rel);
    if (kind === 'unlink') {
      snapshots.delete(rel);
      return before === undefined ? undefined : diffTexts(rel, before, null);
    }
    const after = await readText(abs);
    if (after === undefined) {
      snapshots.delete(rel);
      return undefined;
    }
    snapshots.set(rel, after);
    if (before === undefined) {
      // A file seen for the first time. When it was just created, everything in it is new; when it was here
      // all along but never read (too many files, or it was binary until now), there is nothing to compare with.
      return kind === 'add' ? diffTexts(rel, null, after) : undefined;
    }
    if (before === after) return 'skip';
    return diffTexts(rel, before, after);
  }

  async function journal(entry: ActivityEntry): Promise<void> {
    try {
      await fsp.appendFile(journalFile, JSON.stringify(entry) + '\n');
      journalFailed = false;
    } catch (error) {
      // The desktop keeps working from memory. Said once per outage, not once per file change.
      if (!journalFailed) console.error(`SpecOS cannot write the activity journal: ${(error as Error).message}`);
      journalFailed = true;
    }
  }

  async function recordNow(kind: ChangeKind, abs: string): Promise<ActivityEntry | undefined> {
    const rel = toRel(home, abs);
    const change = await textChange(kind, rel, abs);
    if (change === 'skip') return undefined;

    const workspaceId = resolveWorkspace(rel);
    const entry: ActivityEntry = {
      id: nextId++,
      at: Date.now(),
      kind,
      path: rel,
      isDir: kind === 'addDir' || kind === 'unlinkDir',
      actor: actorOf(rel),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(change ? { additions: change.additions, deletions: change.deletions } : {}),
      hasDiff: change !== undefined,
    };
    ring.push({ entry, patch: change?.patch ?? '' });
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

    ctx.bus.emit({ type: 'fs', entry });
    for (const listener of listeners) listener(entry);
    await journal(entry);
    return entry;
  }

  // One change at a time: ids follow the order of events, and each diff sees the snapshot the one before left.
  let queue: Promise<unknown> = Promise.resolve();
  function record(kind: ChangeKind, absPath: string): Promise<ActivityEntry | undefined> {
    const result = queue.then(() => recordNow(kind, absPath));
    // A path that cannot be journalled must not stop the changes queued behind it.
    queue = result.catch(() => undefined);
    return result;
  }

  // --- reading ahead: without this the first edit of an existing file would have nothing to diff against ---
  let closing = false;
  async function prime(): Promise<void> {
    const folders = [home];
    let files = 0;
    for (let next = 0; next < folders.length; next++) {
      const folder = folders[next] as string;
      let children: fs.Dirent[];
      try {
        children = await fsp.readdir(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      if (children.length > PRIME_MAX_FOLDER_ENTRIES) continue;
      for (const child of children) {
        if (closing || files >= PRIME_MAX_FILES || snapshots.full) return;
        if (PRIME_SKIPPED.has(child.name) || child.name.startsWith(SCRATCH_PREFIX)) continue;
        const abs = path.join(folder, child.name);
        if (child.isDirectory()) folders.push(abs);
        if (!child.isFile()) continue;
        const rel = toRel(home, abs);
        const text = await readText(abs);
        // A change that arrived while this file was being read already stored something newer.
        if (text !== undefined && !snapshots.has(rel)) snapshots.set(rel, text);
        files++;
      }
    }
  }
  const primed = prime();

  ctx.activity = {
    record,
    setActorResolver: (resolver) => void (resolveActor = resolver),
    setWorkspaceResolver: (resolver) => void (resolveWorkspace = resolver),
    markMerge(relPrefix, actor, ms) {
      merges.push({ prefix: relPrefix, actor, until: Date.now() + ms });
    },
    onEntry(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    whenPrimed: () => primed,
  };

  ctx.onClose(async () => {
    closing = true;
    // Everything already reported reaches the journal file before the process goes.
    await Promise.all([primed, queue]);
  });

  app.get('/api/activity', async (request, reply): Promise<ActivityListResponse | ApiError> => {
    const query = request.query as { limit?: unknown; before?: unknown };
    const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
    const before = query.before === undefined ? Infinity : Number(query.before);
    if (!Number.isInteger(limit) || limit < 1 || Number.isNaN(before)) {
      return reply.code(400).send({ error: 'limit and before must be whole numbers', code: 'bad_request' });
    }
    const entries: ActivityEntry[] = [];
    const wanted = Math.min(limit, MAX_LIMIT);
    for (let index = ring.length - 1; index >= 0 && entries.length < wanted; index--) {
      const { entry } = ring[index] as Recorded;
      if (entry.id < before) entries.push(entry);
    }
    return { entries };
  });

  app.get('/api/activity/:id', async (request, reply): Promise<ActivityDetail | ApiError> => {
    const id = Number((request.params as { id: string }).id);
    const found = ring.find((recorded) => recorded.entry.id === id);
    if (!found) {
      return reply.code(404).send({ error: 'That change is no longer in the journal', code: 'not_found' });
    }
    return { ...found.entry, patch: found.patch };
  });
}
