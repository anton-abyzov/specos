/**
 * Reads a unified diff into hunks the renderer can draw: every line with its
 * old and new number, changed pairs with the words that differ marked, and
 * long unchanged runs folded.
 */
import { diffWordsWithSpace } from 'diff';

export type LineKind = 'context' | 'add' | 'del';

export interface Segment {
  text: string;
  /** True for the words this side does not share with its pair. */
  changed: boolean;
}

export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
  /** Set on a changed line that was paired with its counterpart. */
  segments?: Segment[];
  /** The file's last line has no newline on this side. */
  noNewline?: boolean;
  /** Which change of the patch the line belongs to, counted from 0; absent on context lines. */
  change?: number;
}

export interface Hunk {
  header: string;
  /** What git prints after the second @@: usually the enclosing heading or function. */
  section: string;
  lines: DiffLine[];
}

export interface ParsedPatch {
  hunks: Hunk[];
  /** How many separate changes (runs of added and removed lines) the patch holds. */
  changes: number;
  additions: number;
  deletions: number;
  /** The widest line number, for the gutter. */
  maxLine: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Lines longer than this are compared as a whole; word marks in them would cost more than they tell. */
const MAX_WORD_DIFF_CHARS = 2000;
/** Below this share of common text a pair is two different lines, and marking nearly all of both says nothing. */
const MIN_COMMON_SHARE = 0.3;

function markWords(removed: DiffLine, added: DiffLine): void {
  if (removed.text.length > MAX_WORD_DIFF_CHARS || added.text.length > MAX_WORD_DIFF_CHARS) return;
  const parts = diffWordsWithSpace(removed.text, added.text);
  let common = 0;
  for (const part of parts) if (!part.added && !part.removed) common += part.value.trim().length;
  const longest = Math.max(removed.text.trim().length, added.text.trim().length);
  if (longest === 0 || common / longest < MIN_COMMON_SHARE) return;
  removed.segments = parts.filter((part) => !part.added).map((part) => ({ text: part.value, changed: part.removed === true }));
  added.segments = parts.filter((part) => !part.removed).map((part) => ({ text: part.value, changed: part.added === true }));
}

/** Pairs the removed lines of each change with the added lines that follow them, in order. */
function pairLines(lines: DiffLine[]): void {
  for (let index = 0; index < lines.length; ) {
    if (lines[index]!.kind !== 'del') {
      index += 1;
      continue;
    }
    let addsFrom = index;
    while (addsFrom < lines.length && lines[addsFrom]!.kind === 'del') addsFrom += 1;
    let end = addsFrom;
    while (end < lines.length && lines[end]!.kind === 'add') end += 1;
    const pairs = Math.min(addsFrom - index, end - addsFrom);
    for (let pair = 0; pair < pairs; pair += 1) markWords(lines[index + pair]!, lines[addsFrom + pair]!);
    index = end;
  }
}

export function parsePatch(patch: string): ParsedPatch {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let changes = 0;
  let inChange = false;
  let additions = 0;
  let deletions = 0;
  let maxLine = 1;

  const raw = patch.split('\n');
  if (raw.at(-1) === '') raw.pop();
  for (const line of raw) {
    const header = HUNK.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      current = { header: line.slice(0, line.indexOf('@@', 2) + 2), section: header[5] ?? '', lines: [] };
      hunks.push(current);
      inChange = false;
      continue;
    }
    // Everything before the first hunk is the file header (---, +++, or git's own lines).
    if (!current) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === '\\') {
      const previous = current.lines.at(-1);
      if (previous) previous.noNewline = true;
      continue;
    }
    if (mark === '+') {
      if (!inChange) changes += 1;
      inChange = true;
      additions += 1;
      current.lines.push({ kind: 'add', text, newNo, change: changes - 1 });
      maxLine = Math.max(maxLine, newNo);
      newNo += 1;
    } else if (mark === '-') {
      if (!inChange) changes += 1;
      inChange = true;
      deletions += 1;
      current.lines.push({ kind: 'del', text, oldNo, change: changes - 1 });
      maxLine = Math.max(maxLine, oldNo);
      oldNo += 1;
    } else {
      inChange = false;
      current.lines.push({ kind: 'context', text, oldNo, newNo });
      maxLine = Math.max(maxLine, oldNo, newNo);
      oldNo += 1;
      newNo += 1;
    }
  }
  for (const hunk of hunks) pairLines(hunk.lines);
  return { hunks, changes, additions, deletions, maxLine };
}

export type HunkItem = { type: 'line'; line: DiffLine } | { type: 'fold'; id: string; lines: DiffLine[] };

/** An unchanged run longer than this is folded down to its edges. */
const FOLD_OVER = 8;
/** Unchanged lines kept next to a change. */
const FOLD_KEEP = 3;

/** A hunk's lines with long unchanged runs folded: the lines next to a change stay, the middle collapses. */
export function foldHunk(hunk: Hunk, hunkIndex: number): HunkItem[] {
  const items: HunkItem[] = [];
  const { lines } = hunk;
  for (let index = 0; index < lines.length; ) {
    if (lines[index]!.kind !== 'context') {
      items.push({ type: 'line', line: lines[index]! });
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end]!.kind === 'context') end += 1;
    const run = lines.slice(index, end);
    if (run.length <= FOLD_OVER) {
      for (const line of run) items.push({ type: 'line', line });
    } else {
      // At the hunk's edges only the side that touches a change is worth keeping.
      const head = index === 0 ? 0 : FOLD_KEEP;
      const tail = end === lines.length ? 0 : FOLD_KEEP;
      for (const line of run.slice(0, head)) items.push({ type: 'line', line });
      items.push({ type: 'fold', id: `${hunkIndex}:${index}`, lines: run.slice(head, run.length - tail) });
      for (const line of run.slice(run.length - tail)) items.push({ type: 'line', line });
    }
    index = end;
  }
  return items;
}
