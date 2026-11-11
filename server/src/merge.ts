import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Actor, DiffFile, DiffStatus, MergeResult, Workspace, WorkspaceDiff } from '../../shared/protocol';
import type { Ctx } from './context';
import { AS_SERVER, git, GitError } from './git';
import { resolveInHome, SCRATCH_PREFIX } from './paths';
import { refusalHandler, WorkspaceError } from './workspaces';

/**
 * What a workspace changed, and bringing it back: the diff of a workspace
 * against the commit it was cloned from, and the merge of its branch into the
 * project it came from.
 */

/**
 * How long after a merge its file changes in the project still count as the merge's. The watcher reports a
 * deletion about 100 ms late and the journal reads every changed file, so this is generous on purpose.
 */
const MERGE_MARK_MS = 2000;
/** The colour of a merge whose workspace has no agent. */
const NEUTRAL_HUE = 200;

type MergeActor = Extract<Actor, { type: 'merge' }>;

// ---------------------------------------------------------------- diff

const STATUS_BY_LETTER: Record<string, DiffStatus> = { A: 'added', D: 'deleted', R: 'renamed' };

/** The changed paths of `git diff --raw -z`, in git's order. A rename is listed under its new path. */
function parseRaw(raw: string): Array<Pick<DiffFile, 'path' | 'status'>> {
  const fields = raw.split('\0');
  const files: Array<Pick<DiffFile, 'path' | 'status'>> = [];
  for (let index = 0; index + 1 < fields.length; ) {
    // ":100644 100644 <sha> <sha> M", then the path; a rename or copy has a second path, the new one.
    const letter = (fields[index] as string).split(' ').at(-1)?.[0] ?? 'M';
    const paths = letter === 'R' || letter === 'C' ? 2 : 1;
    files.push({ path: fields[index + paths] as string, status: STATUS_BY_LETTER[letter] ?? 'modified' });
    index += 1 + paths;
  }
  return files;
}

/**
 * One file's section of `git diff`, reduced to what the desktop shows: the patch from its `---` line on, and
 * the lines it adds and removes. A binary file, a pure rename and a change of mode have no such part.
 */
function readSection(section: string): Pick<DiffFile, 'patch' | 'additions' | 'deletions'> {
  const start = section.search(/^--- /m);
  const firstHunk = section.search(/^@@ /m);
  if (start === -1 || firstHunk === -1) return { patch: '', additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of section.slice(firstHunk).split('\n')) {
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { patch: section.slice(start), additions, deletions };
}

/** Splits the output of `git diff` into one section per file. Lines of content never start a line with "diff". */
const splitSections = (patch: string): string[] => (patch === '' ? [] : patch.split(/^(?=diff --git )/m));

// ---------------------------------------------------------------- git steps

/** Commits everything in a folder, tracked or not, when there is anything to commit. */
async function commitAll(folder: string, message: string): Promise<void> {
  if ((await git(folder, [...AS_SERVER, 'status', '--porcelain'])) === '') return;
  await git(folder, [...AS_SERVER, 'add', '--all']);
  // The owner's hooks are for their own commits; this one is bookkeeping and must not be vetoed.
  await git(folder, [...AS_SERVER, 'commit', '--quiet', '--allow-empty', '--no-verify', '--message', message]);
}

/** True when a commit is already part of the history of what is checked out. */
async function isMerged(project: string, commit: string): Promise<boolean> {
  try {
    await git(project, ['merge-base', '--is-ancestor', commit, 'HEAD']);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return false;
    throw error;
  }
}

const nulSeparated = (text: string): string[] => text.split('\0').filter(Boolean);

/**
 * The paths that would conflict when a commit is merged into what is checked out. Worked out in git's object
 * store alone, so finding a conflict never puts markers into the user's files, not even for a moment.
 */
async function conflictsWith(project: string, commit: string): Promise<string[]> {
  try {
    await git(project, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', 'HEAD', commit]);
    return [];
  } catch (error) {
    if (!(error instanceof GitError) || error.exitCode !== 1) throw error;
    // The tree it wrote comes first, then each path that could not be merged.
    return nulSeparated(error.stdout).slice(1);
  }
}

// ---------------------------------------------------------------- module

export async function registerMerge(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { home, data } = ctx.config;
  if (!ctx.workspaces) throw new Error('registerMerge needs the workspaces module registered first');
  const workspaces = ctx.workspaces;

  /** The workspace with this id, with its folder and its project's. Both must still be on disk. */
  async function locate(id: string): Promise<{ workspace: Workspace; folder: string; project: string }> {
    const workspace = workspaces.get(id);
    if (!workspace) throw new WorkspaceError(404, 'not_found', 'There is no such workspace');
    const folder = resolveInHome(home, workspace.path);
    const project = resolveInHome(home, workspace.project);
    for (const [what, abs] of [['workspace', folder], ['project', project]] as const) {
      const isFolder = await fsp.stat(abs).then((stat) => stat.isDirectory(), () => false);
      if (!isFolder) throw new WorkspaceError(409, 'conflict', `The folder of the ${what} is gone`);
    }
    return { workspace, folder, project };
  }

  /**
   * Everything the workspace changed since it was cloned, committed or not. The files are staged into an
   * index of this request's own, so the agent's index and working tree are read and never written.
   */
  async function diff(id: string): Promise<WorkspaceDiff> {
    const { workspace, folder } = await locate(id);
    const index = path.join(data, `${SCRATCH_PREFIX}diff-index-${randomBytes(6).toString('hex')}`);
    const ownIndex = { GIT_INDEX_FILE: index };
    try {
      // Starting from the agent's index means only files changed since are read again.
      const agentIndex = path.resolve(folder, await git(folder, ['rev-parse', '--git-path', 'index']));
      await fsp.copyFile(agentIndex, index).catch(() => undefined);
      await git(folder, [...AS_SERVER, 'add', '--all'], ownIndex);

      const against = ['--cached', '--find-renames', '--no-color', '--no-ext-diff', '--no-textconv', workspace.baseRef];
      const [raw, patch] = await Promise.all([
        git(folder, ['diff', '--raw', '-z', ...against], ownIndex),
        git(folder, ['diff', '--patch', ...against], ownIndex),
      ]);
      const sections = splitSections(patch);
      // Both listings are in the same order, one section per path.
      const files = parseRaw(raw).map((file, position): DiffFile => ({ ...file, ...readSection(sections[position] ?? '') }));
      return {
        workspaceId: workspace.id,
        files,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      };
    } finally {
      await fsp.rm(index, { force: true });
      await fsp.rm(index + '.lock', { force: true });
    }
  }

  /** Who the journal names for the file changes of a merge: the workspace's agent, or the workspace itself. */
  function actorOf(workspace: Workspace): MergeActor {
    // Asked through ctx at the time of the merge, because the agents module registers after this one.
    const agent = workspace.agentId === undefined ? undefined : ctx.agents?.get(workspace.agentId);
    if (agent) return { type: 'merge', agentId: agent.id, name: agent.name, hue: agent.hue };
    return { type: 'merge', agentId: workspace.agentId ?? '', name: workspace.name, hue: NEUTRAL_HUE };
  }

  async function mergeNow(id: string): Promise<MergeResult> {
    const { workspace, folder, project } = await locate(id);
    const actor = actorOf(workspace);
    const done = (status: 'merged' | 'conflict', result: MergeResult): MergeResult => {
      workspaces.update(workspace.id, { status });
      return result;
    };

    await commitAll(folder, `Work by ${actor.name}`);
    const work = await git(folder, ['rev-parse', 'HEAD']);
    // A worktree commits straight into the project's repository; the other clones are repositories of their own.
    if (workspace.clone.strategy !== 'worktree') await git(project, ['fetch', '--quiet', '--no-tags', folder, 'HEAD']);
    if (await isMerged(project, work)) return done('merged', { merged: true, files: [], conflicts: [] });

    // The user's edits become a commit of their own first, so the merge can neither lose nor overwrite them.
    await commitAll(project, 'Save before merge');
    const conflicts = await conflictsWith(project, work);
    if (conflicts.length > 0) return done('conflict', { merged: false, files: [], conflicts });

    ctx.activity?.markMerge(workspace.project, actor, MERGE_MARK_MS);
    const before = await git(project, ['rev-parse', 'HEAD']);
    try {
      await git(project, [...AS_SERVER, 'merge', '--no-ff', '--no-verify', '--quiet', '--message', `Merge ${workspace.name}`, work]);
    } catch (error) {
      // Not a conflict (those were ruled out above): for example a file git ignores is in the way. Whatever
      // git began is undone, so the project is back at the commit it was on.
      await git(project, ['merge', '--abort']).catch(() => undefined);
      throw error;
    }
    const commit = await git(project, ['rev-parse', 'HEAD']);
    const files = nulSeparated(await git(project, ['diff', '--name-only', '-z', before, commit]));
    return done('merged', { merged: true, commit, files, conflicts: [] });
  }

  await app.register(async (api) => {
    api.setErrorHandler(refusalHandler('merge'));

    api.get('/api/workspaces/:id/diff', (request): Promise<WorkspaceDiff> => diff((request.params as { id: string }).id));

    api.post('/api/workspaces/:id/merge', async (request, reply): Promise<MergeResult> => {
      const { id } = request.params as { id: string };
      // One at a time, and never while a clone commits in the same project.
      const result = await workspaces.exclusive(() => mergeNow(id));
      return reply.code(result.merged ? 200 : 409).send(result);
    });
  });
}
