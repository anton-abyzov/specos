/**
 * What the launcher lists: the home view before anything is typed, and the
 * fuzzy search across apps, files, agents and actions once there is a query.
 * Pure functions over prepared targets; the component only renders the result.
 */
import fuzzysort, { type Prepared, type Result } from 'fuzzysort';
import type { AgentInfo } from '@shared/protocol';
import { DOCK_APPS, type AppDefinition } from '../../apps/registry';
import { isAgentActive } from '../../stores/agents';
import { SUGGESTED_ACTIONS, type LauncherAction } from './actions';
import { fold, type IndexedFile } from './file-index';

export type GroupId = 'apps' | 'files' | 'agents' | 'actions';

/** The order groups fall back to when their best matches score the same: apps first. */
const GROUP_ORDER: GroupId[] = ['apps', 'files', 'agents', 'actions'];
const GROUP_LABELS: Record<GroupId, string> = { apps: 'Apps', files: 'Files', agents: 'Agents', actions: 'Actions' };

export const MAX_PER_GROUP = 6;
export const MAX_TOTAL = 20;

/** Character positions to highlight in a piece of text. */
export type Marks = readonly number[];
const NO_MARKS: Marks = [];

interface ItemBase {
  /** Unique across groups; the selection and the DOM ids are built on it. */
  key: string;
  group: GroupId;
  title: string;
  titleMarks: Marks;
  /** The quieter text after the title: a description, a folder, the start of a prompt. */
  detail: string;
  detailMarks: Marks;
  score: number;
}

export type LauncherItem =
  | (ItemBase & { kind: 'app'; app: AppDefinition })
  | (ItemBase & { kind: 'file'; file: IndexedFile })
  | (ItemBase & { kind: 'agent'; agent: AgentInfo })
  | (ItemBase & { kind: 'action'; action: LauncherAction });

export interface Section {
  id: GroupId;
  label: string;
  /** How many there are in all; more than `items` when the group was cut to fit. */
  total: number;
  /** A grid of large icons, a row of chips, or one line per item. */
  layout: 'grid' | 'chips' | 'list';
  /** Lines can sit two abreast, where their order does not rank them. */
  columns: 1 | 2;
  items: LauncherItem[];
}

// ---------------------------------------------------------------- targets

interface AppTarget {
  app: AppDefinition;
  name: Prepared;
  description: Prepared;
}

export interface AgentTarget {
  agent: AgentInfo;
  name: Prepared;
  prompt: Prepared;
}

export interface ActionTarget {
  action: LauncherAction;
  title: Prepared;
  keywords: Prepared;
}

export interface Sources {
  files: IndexedFile[];
  agents: AgentTarget[];
  actions: ActionTarget[];
}

const APP_TARGETS: AppTarget[] = DOCK_APPS.map((app) => ({
  app,
  name: fuzzysort.prepare(app.name),
  description: fuzzysort.prepare(app.description),
}));

/** Agents newest first, so the job just started is the first one offered. */
export function agentTargets(agents: Record<string, AgentInfo>): AgentTarget[] {
  return Object.values(agents)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((agent) => ({ agent, name: fuzzysort.prepare(agent.name), prompt: fuzzysort.prepare(agent.prompt) }));
}

export function actionTargets(actions: LauncherAction[]): ActionTarget[] {
  return actions.map((action) => ({
    action,
    title: fuzzysort.prepare(action.title),
    keywords: fuzzysort.prepare(action.keywords),
  }));
}

// ---------------------------------------------------------------- items

const firstLine = (text: string): string => text.split('\n', 1)[0]!.trim();

const appItem = (app: AppDefinition, score = 0, titleMarks = NO_MARKS, detailMarks = NO_MARKS): LauncherItem => ({
  kind: 'app',
  key: `app:${app.id}`,
  group: 'apps',
  title: app.name,
  titleMarks,
  detail: app.description,
  detailMarks,
  score,
  app,
});

const agentItem = (agent: AgentInfo, score = 0, titleMarks = NO_MARKS, detailMarks = NO_MARKS): LauncherItem => ({
  kind: 'agent',
  key: `agent:${agent.id}`,
  group: 'agents',
  title: agent.name,
  titleMarks,
  detail: firstLine(agent.prompt),
  detailMarks,
  score,
  agent,
});

const actionItem = (action: LauncherAction, score = 0, titleMarks = NO_MARKS): LauncherItem => ({
  kind: 'action',
  key: `action:${action.id}`,
  group: 'actions',
  title: action.title,
  titleMarks,
  detail: '',
  detailMarks: NO_MARKS,
  score,
  action,
});

/**
 * A file matched by its name or by its whole path. The path match is split at
 * the last slash so the folder and the name each get their marks.
 */
function fileItem(file: IndexedFile, score: number, byName: Result | null, byPath: Result): LauncherItem {
  const nameStart = file.path.length - file.name.length;
  return {
    kind: 'file',
    key: `file:${file.path}`,
    group: 'files',
    title: file.name,
    titleMarks: byName
      ? byName.indexes
      : byPath.indexes.filter((index) => index >= nameStart).map((index) => index - nameStart),
    detail: file.folder === '' ? 'Home' : file.folder,
    detailMarks: byName ? NO_MARKS : byPath.indexes.filter((index) => index < file.folder.length),
    score,
    file,
  };
}

// ---------------------------------------------------------------- home

/** Before a query: the apps as a grid, the agents at work, and a few actions worth knowing. */
export function homeSections(sources: Sources): Section[] {
  const running = sources.agents.filter(({ agent }) => isAgentActive(agent));
  const suggested = SUGGESTED_ACTIONS.flatMap((id) => {
    const found = sources.actions.find(({ action }) => action.id === id);
    return found ? [actionItem(found.action)] : [];
  });
  const sections: Section[] = [
    {
      id: 'apps',
      label: 'Apps',
      total: DOCK_APPS.length,
      layout: 'grid',
      columns: 1,
      items: DOCK_APPS.map((app) => appItem(app)),
    },
    {
      id: 'agents',
      label: 'Agents at work',
      total: running.length,
      layout: 'chips',
      columns: 1,
      items: running.slice(0, MAX_PER_GROUP).map(({ agent }) => agentItem(agent)),
    },
    { id: 'actions', label: 'Actions', total: sources.actions.length, layout: 'list', columns: 2, items: suggested },
  ];
  return sections.filter((section) => section.items.length > 0);
}

// ---------------------------------------------------------------- search

/** A match in the main text counts in full; one in the supporting text a little less. */
const SECONDARY = 0.8;
/** Sparse, non-contiguous matches score low in fuzzysort; they are still what a fuzzy finder is for. */
const THRESHOLD = 0.15;

/**
 * True when the match is whole words or parts of words, not letters picked
 * from all over the text. A sentence contains nearly any short query as
 * scattered letters, so supporting text only counts when it matches like this.
 */
function isPhrase(result: Result, terms: number): boolean {
  let runs = 0;
  result.indexes.forEach((index, position) => {
    if (position === 0 || index !== result.indexes[position - 1]! + 1) runs += 1;
  });
  return runs > 0 && runs <= terms;
}

/** Scores an object by its main text (the first key) and its supporting text (the rest). */
const scorer = (query: string) => {
  const terms = query.split(/\s+/).length;
  return (results: ReadonlyArray<Result>): number =>
    Math.max(
      results[0]!.score,
      ...results.slice(1).map((result) => (isPhrase(result, terms) ? result.score * SECONDARY : 0)),
    );
};

/** The marks of supporting text, shown only when it is the reason the item was found. */
const supportMarks = (main: Result, support: Result): Marks => (main.score > 0 ? NO_MARKS : support.indexes);

/** How many files are scored for one keystroke, and how many of the best are then scored again by name. */
const FILES_SCORED = 800;
const FILE_POOL = 48;

/** True when the letters of `term` appear in `text` in that order. */
function inOrder(term: string, text: string): boolean {
  let from = 0;
  for (const letter of term) {
    const at = text.indexOf(letter, from);
    if (at < 0) return false;
    from = at + letter.length;
  }
  return true;
}

/**
 * Files are the one group that can be thousands long, and a keystroke has a
 * frame to spend. A plain scan first keeps the files that can match at all;
 * a short query keeps most of them, so only the first FILES_SCORED are scored
 * (the index lists the nearest folders first, which is the right bias). Those
 * are scored on one target each, the path, and only the best of them again by
 * name alone, where a match counts in full.
 */
function fileMatches(query: string, files: IndexedFile[]): { total: number; items: LauncherItem[] } {
  const terms = fold(query).split(/\s+/);
  const candidates: IndexedFile[] = [];
  let total = 0;
  for (const file of files) {
    if (!terms.every((term) => inOrder(term, file.folded))) continue;
    total += 1;
    if (candidates.length < FILES_SCORED) candidates.push(file);
  }

  const pool = fuzzysort.go(query, candidates, {
    key: (file) => file.pathTarget,
    limit: FILE_POOL,
    threshold: THRESHOLD * SECONDARY,
  });
  const items = pool
    .map((byPath) => {
      const byName = fuzzysort.single(query, byPath.obj.nameTarget);
      const nameWins = byName !== null && byName.score >= byPath.score * SECONDARY;
      const score = nameWins ? byName.score : byPath.score * SECONDARY;
      return fileItem(byPath.obj, score, nameWins ? byName : null, byPath);
    })
    .filter((item) => item.score >= THRESHOLD)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, MAX_PER_GROUP);
  return { total: Math.max(total, items.length), items };
}

/** Best first; equal scores keep the order of the list they came from, so results do not shuffle between keystrokes. */
function ranked<T, H extends { score: number; obj: T }>(hits: ReadonlyArray<H>, list: ReadonlyArray<T>): H[] {
  return [...hits].sort((a, b) => b.score - a.score || list.indexOf(a.obj) - list.indexOf(b.obj));
}

function matches(query: string, sources: Sources): Section[] {
  const options = { limit: MAX_PER_GROUP, threshold: THRESHOLD, scoreFn: scorer(query) };
  const apps = fuzzysort.go(query, APP_TARGETS, {
    ...options,
    keys: [(target) => target.name, (target) => target.description],
  });
  const files = fileMatches(query, sources.files);
  const agents = fuzzysort.go(query, sources.agents, {
    ...options,
    keys: [(target) => target.name, (target) => target.prompt, (target) => target.agent.status],
  });
  const actions = fuzzysort.go(query, sources.actions, {
    ...options,
    keys: [(target) => target.title, (target) => target.keywords],
  });

  return [
    section(
      'apps',
      apps.total,
      ranked(apps, APP_TARGETS).map((hit) => appItem(hit.obj.app, hit.score, hit[0]!.indexes, supportMarks(hit[0]!, hit[1]!))),
    ),
    section('files', files.total, files.items),
    section(
      'agents',
      agents.total,
      ranked(agents, sources.agents).map((hit) => agentItem(hit.obj.agent, hit.score, hit[0]!.indexes, promptMarks(hit.obj.agent, hit[0]!, hit[1]!))),
    ),
    section(
      'actions',
      actions.total,
      ranked(actions, sources.actions).map((hit) => actionItem(hit.obj.action, hit.score, hit[0]!.indexes)),
    ),
  ];
}

const section = (id: GroupId, total: number, items: LauncherItem[]): Section => ({
  id,
  label: GROUP_LABELS[id],
  total,
  layout: 'list',
  columns: 1,
  items,
});

/** Marks inside the prompt's first line, which is all of the prompt a row shows. */
function promptMarks(agent: AgentInfo, byName: Result, byPrompt: Result): Marks {
  const shown = firstLine(agent.prompt);
  const offset = agent.prompt.indexOf(shown);
  return supportMarks(byName, byPrompt)
    .map((index) => index - offset)
    .filter((index) => index >= 0 && index < shown.length);
}

/**
 * The search: at most MAX_PER_GROUP per group and MAX_TOTAL in all, the
 * weakest matches dropped first. Groups are listed by their best match, and
 * in GROUP_ORDER when two groups tie.
 */
export function search(query: string, sources: Sources): Section[] {
  const groups = matches(query, sources);
  const rank = (id: GroupId) => GROUP_ORDER.indexOf(id);

  const kept = new Set(
    groups
      .flatMap((group) => group.items)
      .sort((a, b) => b.score - a.score || rank(a.group) - rank(b.group))
      .slice(0, MAX_TOTAL)
      .map((item) => item.key),
  );

  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => kept.has(item.key)) }))
    .filter((group) => group.items.length > 0)
    .sort((a, b) => b.items[0]!.score - a.items[0]!.score || rank(a.id) - rank(b.id));
}
