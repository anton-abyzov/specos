import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { WorkspacesService } from '../../server/src/workspaces';
import type {
  ActivityEntry,
  ActivityListResponse,
  ApiError,
  CloneStrategy,
  DiffFile,
  MergeResult,
  Workspace,
  WorkspaceDiff,
} from '../../shared/protocol';
import { startTestServer, type TestServer } from './helpers';

let server: TestServer;
let workspaces: WorkspacesService;

beforeAll(async () => {
  server = await startTestServer();
  workspaces = server.specos.ctx.workspaces as WorkspacesService;
});
afterAll(() => server.close());

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const NOTE = '# Note\n\nThe first line.\nThe second line.\nThe third line.\n';
const FILES = {
  'note.md': NOTE,
  'ideas/list.txt': 'one\ntwo\nthree\n',
  'ideas/keep.txt': 'kept as it is\n',
};

interface Fixture {
  project: string;
  workspace: Workspace;
  /** Absolute path of a file in the project. */
  inProject(file: string): string;
  /** Absolute path of a file in the workspace. */
  inWorkspace(file: string): string;
}

let projectCount = 0;
/** A fresh project with one workspace cloned from it, so no test depends on what another left behind. */
async function makeFixture(strategy: CloneStrategy): Promise<Fixture> {
  const name = `notes-${++projectCount}`;
  const abs = path.join(server.home, 'Projects', name);
  for (const [file, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(abs, file)), { recursive: true });
    fs.writeFileSync(path.join(abs, file), content);
  }
  const workspace = await workspaces.create({ project: `Projects/${name}`, label: 'Juniper', strategy });
  return {
    project: `Projects/${name}`,
    workspace,
    inProject: (file) => path.join(abs, file),
    inWorkspace: (file) => path.join(server.home, workspace.path, file),
  };
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');

async function diffOf(id: string): Promise<WorkspaceDiff> {
  const response = await server.fetch(`/api/workspaces/${id}/diff`);
  expect(response.status).toBe(200);
  return (await response.json()) as WorkspaceDiff;
}

const merge = (id: string): Promise<Response> => server.fetch(`/api/workspaces/${id}/merge`, { method: 'POST' });

async function mergeOk(id: string): Promise<MergeResult> {
  const response = await merge(id);
  expect(response.status).toBe(200);
  return (await response.json()) as MergeResult;
}

async function activity(): Promise<ActivityEntry[]> {
  const response = await server.fetch('/api/activity?limit=1000');
  return ((await response.json()) as ActivityListResponse).entries;
}

/** Polls until the journal has an entry that matches, because the watcher reports a little after the write. */
async function activityEntry(matches: (entry: ActivityEntry) => boolean): Promise<ActivityEntry> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = (await activity()).find(matches);
    if (found) return found;
    if (Date.now() > deadline) throw new Error('The journal never got the entry');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const byPath = (diff: WorkspaceDiff, file: string): DiffFile => {
  const found = diff.files.find((entry) => entry.path === file);
  if (!found) throw new Error(`${file} is not in the diff: ${diff.files.map((entry) => entry.path).join(', ')}`);
  return found;
};

describe('routes', () => {
  test('an unknown workspace has no diff and cannot be merged', async () => {
    for (const response of [await server.fetch('/api/workspaces/nope0000/diff'), await merge('nope0000')]) {
      expect(response.status).toBe(404);
      expect(((await response.json()) as ApiError).code).toBe('not_found');
    }
  });
});

describe.each<CloneStrategy>(['worktree', 'copy'])('a %s workspace', (strategy) => {
  describe('diff', () => {
    test('an untouched workspace has an empty diff', async () => {
      const { workspace } = await makeFixture(strategy);

      expect(await diffOf(workspace.id)).toEqual({ workspaceId: workspace.id, files: [], additions: 0, deletions: 0 });
    });

    test('shows a modified, an added and a deleted file with their line counts', async () => {
      const { workspace, inWorkspace } = await makeFixture(strategy);
      fs.writeFileSync(inWorkspace('note.md'), NOTE.replace('The second line.', 'The second line, reworded.') + 'A fourth line.\n');
      fs.mkdirSync(inWorkspace('drafts'));
      fs.writeFileSync(inWorkspace('drafts/new.md'), 'alpha\nbeta\ngamma\n');
      fs.rmSync(inWorkspace('ideas/list.txt'));

      const diff = await diffOf(workspace.id);

      expect(diff.workspaceId).toBe(workspace.id);
      expect(diff.files.map((file) => file.path).sort()).toEqual(['drafts/new.md', 'ideas/list.txt', 'note.md']);
      expect(byPath(diff, 'note.md')).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
      expect(byPath(diff, 'drafts/new.md')).toMatchObject({ status: 'added', additions: 3, deletions: 0 });
      expect(byPath(diff, 'ideas/list.txt')).toMatchObject({ status: 'deleted', additions: 0, deletions: 3 });
      expect(diff.additions).toBe(5);
      expect(diff.deletions).toBe(4);
    });

    test('each file carries its own unified diff', async () => {
      const { workspace, inWorkspace } = await makeFixture(strategy);
      fs.writeFileSync(inWorkspace('note.md'), NOTE.replace('The second line.', 'The second line, reworded.'));
      fs.writeFileSync(inWorkspace('fresh.txt'), 'brand new\n');

      const diff = await diffOf(workspace.id);

      const note = byPath(diff, 'note.md').patch;
      expect(note.startsWith('--- a/note.md\n+++ b/note.md\n@@ ')).toBe(true);
      expect(note).toContain('\n-The second line.\n+The second line, reworded.\n');
      expect(note).not.toContain('fresh.txt');
      const fresh = byPath(diff, 'fresh.txt').patch;
      expect(fresh.startsWith('--- /dev/null\n+++ b/fresh.txt\n@@ ')).toBe(true);
      expect(fresh).toContain('\n+brand new\n');
    });

    test('a binary file is listed without a patch, and a moved file as renamed', async () => {
      const { workspace, inWorkspace } = await makeFixture(strategy);
      fs.writeFileSync(inWorkspace('pixel.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0xff, 0x00, 0x10]));
      fs.renameSync(inWorkspace('ideas/keep.txt'), inWorkspace('ideas/moved.txt'));

      const diff = await diffOf(workspace.id);

      expect(byPath(diff, 'pixel.bin')).toEqual({ path: 'pixel.bin', status: 'added', additions: 0, deletions: 0, patch: '' });
      expect(byPath(diff, 'ideas/moved.txt')).toMatchObject({ status: 'renamed', additions: 0, deletions: 0 });
      expect(diff.files).toHaveLength(2);
    });

    test('includes work the agent has already committed', async () => {
      const { workspace, inWorkspace } = await makeFixture(strategy);
      const folder = inWorkspace('');
      fs.appendFileSync(inWorkspace('note.md'), 'Committed by the agent.\n');
      git(folder, 'add', '--all');
      git(folder, '-c', 'user.name=Agent', '-c', 'user.email=agent@localhost', 'commit', '--quiet', '-m', 'Agent commit');
      fs.appendFileSync(inWorkspace('note.md'), 'Not committed yet.\n');

      const diff = await diffOf(workspace.id);

      expect(byPath(diff, 'note.md')).toMatchObject({ status: 'modified', additions: 2, deletions: 0 });
    });

    test("looking at the diff leaves the agent's working tree and index as they were", async () => {
      const { workspace, inWorkspace } = await makeFixture(strategy);
      const folder = inWorkspace('');
      fs.appendFileSync(inWorkspace('note.md'), 'Work in progress.\n');
      fs.writeFileSync(inWorkspace('untracked.txt'), 'not added\n');
      const before = git(folder, 'status', '--porcelain');
      expect(before).toContain('?? untracked.txt');

      await diffOf(workspace.id);

      expect(git(folder, 'status', '--porcelain')).toBe(before);
      expect(fs.readdirSync(server.data).filter((name) => name.includes('index'))).toEqual([]);
    });
  });

  describe('merge', () => {
    test('brings the change into the project file on disk', async () => {
      const { workspace, inWorkspace, inProject } = await makeFixture(strategy);
      fs.appendFileSync(inWorkspace('note.md'), 'Written by the agent.\n');
      fs.writeFileSync(inWorkspace('drafts.md'), 'a new file\n');
      fs.rmSync(inWorkspace('ideas/list.txt'));

      const result = await mergeOk(workspace.id);

      expect(result.merged).toBe(true);
      expect(result.conflicts).toEqual([]);
      expect([...result.files].sort()).toEqual(['drafts.md', 'ideas/list.txt', 'note.md']);
      expect(read(inProject('note.md'))).toBe(NOTE + 'Written by the agent.\n');
      expect(read(inProject('drafts.md'))).toBe('a new file\n');
      expect(fs.existsSync(inProject('ideas/list.txt'))).toBe(false);
      expect(read(inProject('ideas/keep.txt'))).toBe(FILES['ideas/keep.txt']);
    });

    test('records one merge commit with two parents and marks the workspace merged', async () => {
      const { workspace, inWorkspace, inProject } = await makeFixture(strategy);
      fs.appendFileSync(inWorkspace('note.md'), 'Written by the agent.\n');

      const result = await mergeOk(workspace.id);

      const project = inProject('');
      expect(result.commit).toBe(git(project, 'rev-parse', 'HEAD'));
      expect(git(project, 'log', '-1', '--format=%s')).toBe(`Merge ${workspace.name}`);
      expect(git(project, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2);
      expect(git(project, 'log', '-1', '--format=%an <%ae>')).toBe('SpecOS <specos@localhost>');
      expect(git(project, 'log', '-1', '--format=%s', 'HEAD^2')).toBe(`Work by ${workspace.name}`);
      expect(git(project, 'status', '--porcelain')).toBe('');
      expect(workspaces.get(workspace.id)?.status).toBe('merged');
    });

    test('a project edit to a different file made after the clone survives', async () => {
      const { workspace, inWorkspace, inProject } = await makeFixture(strategy);
      fs.appendFileSync(inWorkspace('note.md'), 'Written by the agent.\n');
      fs.writeFileSync(inProject('ideas/list.txt'), 'one\ntwo\nthree\nfour, added by me\n');
      fs.writeFileSync(inProject('mine.txt'), 'a file of my own\n');

      const result = await mergeOk(workspace.id);

      expect(result.merged).toBe(true);
      expect(result.files).toEqual(['note.md']);
      expect(read(inProject('note.md'))).toBe(NOTE + 'Written by the agent.\n');
      expect(read(inProject('ideas/list.txt'))).toBe('one\ntwo\nthree\nfour, added by me\n');
      expect(read(inProject('mine.txt'))).toBe('a file of my own\n');
      expect(git(inProject(''), 'log', '-1', '--format=%s', 'HEAD^1')).toBe('Save before merge');
    });

    test('edits to different parts of the same file are combined', async () => {
      const { workspace, inWorkspace, inProject } = await makeFixture(strategy);
      fs.writeFileSync(inWorkspace('note.md'), NOTE + 'Appended by the agent.\n');
      fs.writeFileSync(inProject('note.md'), NOTE.replace('# Note', '# My note'));

      const result = await mergeOk(workspace.id);

      expect(result.merged).toBe(true);
      expect(read(inProject('note.md'))).toBe(NOTE.replace('# Note', '# My note') + 'Appended by the agent.\n');
    });

    test('conflicting edits to the same line answer 409 and leave the project as the user had it', async () => {
      const { workspace, inWorkspace, inProject } = await makeFixture(strategy);
      const mine = NOTE.replace('The first line.', 'The first line, my way.');
      fs.writeFileSync(inWorkspace('note.md'), NOTE.replace('The first line.', 'The first line, the agent way.'));
      fs.writeFileSync(inWorkspace('other.md'), 'does not conflict\n');
      fs.writeFileSync(inProject('note.md'), mine);

      const response = await merge(workspace.id);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ merged: false, files: [], conflicts: ['note.md'] } satisfies MergeResult);
      expect(read(inProject('note.md'))).toBe(mine);
      expect(fs.existsSync(inProject('other.md'))).toBe(false);
      const project = inProject('');
      expect(git(project, 'status', '--porcelain')).toBe('');
      expect(fs.existsSync(path.join(project, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(git(project, 'log', '-1', '--format=%s')).toBe('Save before merge');
      expect(workspaces.get(workspace.id)?.status).toBe('conflict');
      // The agent's side is kept too, committed on its branch.
      expect(read(inWorkspace('note.md'))).toContain('the agent way');
    });

    test('a conflict can be settled and the workspace merged again', async () => {
      const { workspace, inWorkspace, inProject } = await makeFixture(strategy);
      const mine = NOTE.replace('The first line.', 'The first line, my way.');
      fs.writeFileSync(inWorkspace('note.md'), NOTE.replace('The first line.', 'The first line, the agent way.'));
      fs.writeFileSync(inProject('note.md'), mine);
      expect((await merge(workspace.id)).status).toBe(409);

      fs.writeFileSync(inProject('note.md'), NOTE.replace('The first line.', 'The first line, the agent way.'));
      const result = await mergeOk(workspace.id);

      expect(result.merged).toBe(true);
      expect(workspaces.get(workspace.id)?.status).toBe('merged');
      expect(read(inProject('note.md'))).toContain('the agent way');
    });

    test('an unchanged workspace merges to nothing', async () => {
      const { workspace, inProject } = await makeFixture(strategy);
      const head = git(inProject(''), 'rev-parse', 'HEAD');

      const result = await mergeOk(workspace.id);

      expect(result).toEqual({ merged: true, files: [], conflicts: [] });
      expect(git(inProject(''), 'rev-parse', 'HEAD')).toBe(head);
      expect(workspaces.get(workspace.id)?.status).toBe('merged');
    });

    test('merging twice brings only the newer work the second time', async () => {
      const { workspace, inWorkspace, inProject } = await makeFixture(strategy);
      fs.appendFileSync(inWorkspace('note.md'), 'First round.\n');
      await mergeOk(workspace.id);
      fs.writeFileSync(inWorkspace('second.md'), 'second round\n');

      const result = await mergeOk(workspace.id);

      expect(result.files).toEqual(['second.md']);
      expect(read(inProject('second.md'))).toBe('second round\n');
      expect(read(inProject('note.md'))).toBe(NOTE + 'First round.\n');
    });

    test('the journal attributes the change in the project to the merge', async () => {
      const { workspace, project, inWorkspace } = await makeFixture(strategy);
      fs.appendFileSync(inWorkspace('note.md'), 'Written by the agent.\n');

      await mergeOk(workspace.id);

      const entry = await activityEntry((candidate) => candidate.path === `${project}/note.md` && candidate.kind === 'change');
      expect(entry.actor).toEqual({ type: 'merge', agentId: '', name: workspace.name, hue: 200 });
      expect(entry.additions).toBe(1);
    });
  });
});
