import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { detectCloneStrategy } from '../../server/src/probe';
import type { WorkspacesService } from '../../server/src/workspaces';
import type {
  ApiError,
  ActivityEntry,
  ActivityListResponse,
  BenchmarkResult,
  CloneStrategy,
  CloneStrategyInfo,
  ProjectsResponse,
  ServerEvent,
  Workspace,
  WorkspacesResponse,
} from '../../shared/protocol';
import { startTestServer, type TestServer } from './helpers';

let server: TestServer;
let workspaces: WorkspacesService;
/** What this machine's file system makes the default, probed the same way the server does. */
let probed: CloneStrategyInfo;

beforeAll(async () => {
  server = await startTestServer();
  workspaces = server.specos.ctx.workspaces as WorkspacesService;
  probed = await detectCloneStrategy(server.home);
});
afterAll(() => server.close());

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** The files of a project the tests can count: name and content. */
const NOTES = {
  'note.md': '# Note\n\nThe first line.\n',
  'ideas/list.txt': 'one\ntwo\nthree\n',
  'ideas/deep/sketch.txt': 'a sketch\n',
};

let projectCount = 0;
/** Makes a fresh project folder so no test depends on what another left behind. */
function makeProject(files: Record<string, string> = NOTES, target: { home: string } = server): { name: string; rel: string; abs: string } {
  const name = `notes-${++projectCount}`;
  const abs = path.join(target.home, 'Projects', name);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(abs, file)), { recursive: true });
    fs.writeFileSync(path.join(abs, file), content);
  }
  return { name, rel: `Projects/${name}`, abs };
}

const bytesOf = (files: Record<string, string>): number =>
  Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content), 0);

const inHome = (rel: string): string => path.join(server.home, rel);

async function post(pathname: string, body: unknown): Promise<Response> {
  return server.fetch(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function listed(target: TestServer = server): Promise<WorkspacesResponse> {
  const response = await target.fetch('/api/workspaces');
  expect(response.status).toBe(200);
  return (await response.json()) as WorkspacesResponse;
}

/** Collects every frame of an events socket from the moment it exists, and waits for its greeting. */
function openEvents(): Promise<{ socket: WebSocket; events: ServerEvent[] }> {
  return new Promise((resolve, reject) => {
    const events: ServerEvent[] = [];
    const socket = new WebSocket(server.wsUrl + '/ws', { headers: { cookie: server.cookie, origin: server.url } });
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      events.push(event);
      if (event.type === 'hello') resolve({ socket, events });
    });
    socket.once('error', reject);
  });
}

const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.terminate();
});

describe('folders and projects', () => {
  test('Projects and Workspaces exist from the start', () => {
    expect(fs.statSync(inHome('Projects')).isDirectory()).toBe(true);
    expect(fs.statSync(inHome('Workspaces')).isDirectory()).toBe(true);
  });

  test('GET /api/projects lists the folders directly under Projects', async () => {
    const project = makeProject();
    fs.writeFileSync(inHome('Projects/loose-file.txt'), 'not a project\n');

    const response = await server.fetch('/api/projects');
    expect(response.status).toBe(200);
    const { projects } = (await response.json()) as ProjectsResponse;

    expect(projects).toContainEqual({ name: project.name, path: project.rel });
    expect(projects.map((entry) => entry.name)).not.toContain('loose-file.txt');
    expect(projects.map((entry) => entry.path)).not.toContain(`${project.rel}/ideas`);
  });

  test('GET /api/workspaces says which strategy this machine uses and why', async () => {
    const { strategy } = await listed();

    expect(strategy).toEqual(probed);
    expect(strategy.reason.length).toBeGreaterThan(10);
  });
});

describe('creating a workspace', () => {
  test('POST /api/workspaces clones the project and describes the result', async () => {
    const project = makeProject();

    const response = await post('/api/workspaces', { project: project.rel, label: 'Juniper' });
    expect(response.status).toBe(201);
    const workspace = (await response.json()) as Workspace;

    expect(workspace).toMatchObject({
      name: `${project.name}-juniper`,
      path: `Workspaces/${project.name}-juniper`,
      project: project.rel,
      branch: `agent/${workspace.id}`,
      status: 'active',
    });
    expect(workspace.id).toMatch(/^[a-z0-9]{6,12}$/);
    expect(workspace.createdAt).toBeGreaterThan(Date.now() - 10_000);
    expect(workspace.clone.strategy).toBe(probed.strategy);

    for (const [file, content] of Object.entries(NOTES)) {
      expect(fs.readFileSync(inHome(`${workspace.path}/${file}`), 'utf8'), file).toBe(content);
    }
    expect((await listed()).workspaces).toContainEqual(workspace);
  });

  test('the project becomes a git repository whose first commit is the base', async () => {
    const project = makeProject();
    expect(fs.existsSync(path.join(project.abs, '.git'))).toBe(false);

    const workspace = await workspaces.create({ project: project.rel });

    expect(git(project.abs, 'rev-parse', 'HEAD')).toBe(workspace.baseRef);
    expect(git(project.abs, 'log', '--format=%s|%an|%ae')).toBe('Base for workspaces|SpecOS|specos@localhost');
    expect(git(project.abs, 'branch', '--show-current')).toBe('main');
    expect(git(project.abs, 'status', '--porcelain')).toBe('');
    // The identity is passed per command; nothing is written to the repository's or the user's configuration.
    expect(fs.readFileSync(path.join(project.abs, '.git/config'), 'utf8')).not.toMatch(/SpecOS|specos@localhost/);

    expect(git(inHome(workspace.path), 'rev-parse', 'HEAD')).toBe(workspace.baseRef);
    expect(git(inHome(workspace.path), 'branch', '--show-current')).toBe(workspace.branch);
  });

  test('edits the user has not committed are part of the base, so the workspace starts from what they see', async () => {
    const project = makeProject();
    const first = await workspaces.create({ project: project.rel });

    fs.writeFileSync(path.join(project.abs, 'note.md'), '# Note\n\nRewritten since the first clone.\n');
    fs.writeFileSync(path.join(project.abs, 'new-file.txt'), 'brand new\n');
    const second = await workspaces.create({ project: project.rel });

    expect(second.baseRef).not.toBe(first.baseRef);
    expect(git(project.abs, 'rev-parse', 'HEAD')).toBe(second.baseRef);
    expect(git(project.abs, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(inHome(`${second.path}/note.md`), 'utf8')).toContain('Rewritten since the first clone.');
    expect(fs.readFileSync(inHome(`${second.path}/new-file.txt`), 'utf8')).toBe('brand new\n');
    // The earlier workspace is a snapshot of its own moment.
    expect(fs.readFileSync(inHome(`${first.path}/note.md`), 'utf8')).toBe(NOTES['note.md']);
    expect(fs.existsSync(inHome(`${first.path}/new-file.txt`))).toBe(false);
  });

  test('a clean project is not committed again', async () => {
    const project = makeProject();

    const first = await workspaces.create({ project: project.rel });
    const second = await workspaces.create({ project: project.rel });

    expect(second.baseRef).toBe(first.baseRef);
    expect(git(project.abs, 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  test('a project that already is a repository keeps its history and its own identity settings', async () => {
    const project = makeProject();
    git(project.abs, 'init', '-q', '-b', 'trunk');
    git(project.abs, 'add', '-A');
    const owner = ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.test', '-c', 'commit.gpgsign=false'];
    git(project.abs, ...owner, 'commit', '-q', '-m', 'Mine');
    const mine = git(project.abs, 'rev-parse', 'HEAD');

    const workspace = await workspaces.create({ project: project.rel });

    expect(workspace.baseRef).toBe(mine);
    expect(git(project.abs, 'branch', '--show-current')).toBe('trunk');
    expect(git(project.abs, 'log', '--format=%s')).toBe('Mine');
  });

  test('the clone report measures the clone', async () => {
    const project = makeProject();

    const { clone } = await workspaces.create({ project: project.rel });

    expect(clone.ms).toBeGreaterThan(0);
    expect(clone.ms).toBeLessThan(10_000);
    expect(clone.files).toBe(Object.keys(NOTES).length);
    expect(clone.bytes).toBe(bytesOf(NOTES));
    expect(clone.diskBytes).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(clone.diskBytes)).toBe(true);
  });

  test('names are slugged, and a name that is taken gets a number', async () => {
    const project = makeProject();

    const first = await workspaces.create({ project: project.rel, label: '  Blue / Heron!! ' });
    const second = await workspaces.create({ project: project.rel, label: 'blue heron' });
    const third = await workspaces.create({ project: project.rel, label: 'Blue Heron' });
    const unlabelled = await workspaces.create({ project: project.rel });

    expect(first.name).toBe(`${project.name}-blue-heron`);
    expect(second.name).toBe(`${project.name}-blue-heron-2`);
    expect(third.name).toBe(`${project.name}-blue-heron-3`);
    expect(unlabelled.name).toBe(`${project.name}-${unlabelled.id}`);
    expect(new Set([first.id, second.id, third.id, unlabelled.id]).size).toBe(4);
  });

  test('a folder someone put in Workspaces by hand is never cloned over', async () => {
    const project = makeProject();
    fs.mkdirSync(inHome(`Workspaces/${project.name}-fern`));
    fs.writeFileSync(inHome(`Workspaces/${project.name}-fern/mine.txt`), 'keep me\n');

    const workspace = await workspaces.create({ project: project.rel, label: 'fern' });

    expect(workspace.name).toBe(`${project.name}-fern-2`);
    expect(fs.readFileSync(inHome(`Workspaces/${project.name}-fern/mine.txt`), 'utf8')).toBe('keep me\n');
  });

  test('creating and removing are announced on the events socket', async () => {
    const { socket, events } = await openEvents();
    sockets.push(socket);
    const project = makeProject();

    const workspace = await workspaces.create({ project: project.rel, label: 'announced' });
    await expect
      .poll(() => events.find((event) => event.type === 'workspace' && event.workspace.id === workspace.id))
      .toEqual({ type: 'workspace', workspace });

    await workspaces.remove(workspace.id);
    await expect
      .poll(() => events.find((event) => event.type === 'workspace-removed'))
      .toEqual({ type: 'workspace-removed', id: workspace.id });
  });
});

describe.each<CloneStrategy>(['worktree', 'copy'])('the %s strategy, forced', (strategy) => {
  test('makes an independent copy of the project', async () => {
    const project = makeProject();
    const workspace = await workspaces.create({ project: project.rel, strategy });
    const copy = inHome(workspace.path);

    expect(workspace.clone.strategy).toBe(strategy);
    expect(workspace.clone.files).toBe(Object.keys(NOTES).length);
    expect(workspace.clone.bytes).toBe(bytesOf(NOTES));
    expect(workspace.clone.ms).toBeGreaterThan(0);

    fs.writeFileSync(path.join(copy, 'note.md'), 'changed by the agent\n');
    fs.writeFileSync(path.join(copy, 'agent-only.txt'), 'new in the workspace\n');
    expect(fs.readFileSync(path.join(project.abs, 'note.md'), 'utf8')).toBe(NOTES['note.md']);
    expect(fs.existsSync(path.join(project.abs, 'agent-only.txt'))).toBe(false);

    fs.writeFileSync(path.join(project.abs, 'ideas/list.txt'), 'changed by me\n');
    fs.rmSync(path.join(project.abs, 'ideas/deep'), { recursive: true });
    expect(fs.readFileSync(path.join(copy, 'ideas/list.txt'), 'utf8')).toBe(NOTES['ideas/list.txt']);
    expect(fs.readFileSync(path.join(copy, 'ideas/deep/sketch.txt'), 'utf8')).toBe(NOTES['ideas/deep/sketch.txt']);
  });

  test('puts the workspace on its own branch at the base', async () => {
    const project = makeProject();
    const workspace = await workspaces.create({ project: project.rel, strategy });
    const copy = inHome(workspace.path);

    expect(git(copy, 'branch', '--show-current')).toBe(`agent/${workspace.id}`);
    expect(git(copy, 'rev-parse', 'HEAD')).toBe(workspace.baseRef);
    expect(git(copy, 'status', '--porcelain')).toBe('');
    // The project itself stays on its own branch.
    expect(git(project.abs, 'branch', '--show-current')).toBe('main');
  });

  test('remove deletes the folder and the branch', async () => {
    const project = makeProject();
    const workspace = await workspaces.create({ project: project.rel, strategy });
    fs.writeFileSync(inHome(`${workspace.path}/unsaved.txt`), 'work in progress\n');

    expect(await workspaces.remove(workspace.id)).toBe(true);

    expect(fs.existsSync(inHome(workspace.path))).toBe(false);
    expect(workspaces.get(workspace.id)).toBeUndefined();
    expect(git(project.abs, 'branch', '--list', 'agent/*')).toBe('');
    expect(git(project.abs, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    // The project is left exactly as it was.
    expect(git(project.abs, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(project.abs, 'note.md'), 'utf8')).toBe(NOTES['note.md']);
  });
});

describe('the worktree strategy', () => {
  test('shares the project repository instead of copying it', async () => {
    const project = makeProject();
    const workspace = await workspaces.create({ project: project.rel, strategy: 'worktree' });

    // A worktree has a .git file that points at the project; a copy has a .git folder of its own.
    expect(fs.statSync(inHome(`${workspace.path}/.git`)).isFile()).toBe(true);
    expect(git(project.abs, 'branch', '--list', 'agent/*')).toContain(workspace.branch);
  });

  test('a workspace whose project is gone can still be removed', async () => {
    const project = makeProject();
    const workspace = await workspaces.create({ project: project.rel, strategy: 'worktree' });
    fs.rmSync(project.abs, { recursive: true });

    expect(await workspaces.remove(workspace.id)).toBe(true);
    expect(fs.existsSync(inHome(workspace.path))).toBe(false);
  });
});

describe('the reflink strategy', () => {
  // ext4 and other file systems without reflinks cannot run this; the probe decides, as it does for the server.
  test('clones copy-on-write where the file system can', async (context) => {
    if (!probed.reflinkSupported) return context.skip();
    const project = makeProject();
    const workspace = await workspaces.create({ project: project.rel, strategy: 'reflink' });
    const copy = inHome(workspace.path);

    expect(workspace.clone.strategy).toBe('reflink');
    expect(workspace.clone.files).toBe(Object.keys(NOTES).length);
    expect(git(copy, 'branch', '--show-current')).toBe(workspace.branch);

    fs.writeFileSync(path.join(copy, 'note.md'), 'changed by the agent\n');
    expect(fs.readFileSync(path.join(project.abs, 'note.md'), 'utf8')).toBe(NOTES['note.md']);

    expect(await workspaces.remove(workspace.id)).toBe(true);
    expect(fs.existsSync(copy)).toBe(false);
  });
});

describe('the registry', () => {
  test('get, list and findByPath agree', async () => {
    const project = makeProject();
    const workspace = await workspaces.create({ project: project.rel, label: 'finder' });

    expect(workspaces.get(workspace.id)).toEqual(workspace);
    expect(workspaces.list()).toContainEqual(workspace);
    expect(workspaces.findByPath(workspace.path)).toEqual(workspace);
    expect(workspaces.findByPath(`${workspace.path}/ideas/list.txt`)).toEqual(workspace);
    // A sibling whose name merely starts the same way is a different folder.
    expect(workspaces.findByPath(`${workspace.path}-other/file.txt`)).toBeUndefined();
    expect(workspaces.findByPath(`${project.rel}/note.md`)).toBeUndefined();
    expect(workspaces.findByPath('Workspaces')).toBeUndefined();
    expect(workspaces.findByPath('')).toBeUndefined();
  });

  test('setAgent and update change the workspace and announce it', async () => {
    const { socket, events } = await openEvents();
    sockets.push(socket);
    const project = makeProject();
    const workspace = await workspaces.create({ project: project.rel });

    expect(workspaces.setAgent(workspace.id, 'agent-7')).toEqual({ ...workspace, agentId: 'agent-7' });
    expect(workspaces.update(workspace.id, { status: 'merged' })).toEqual({ ...workspace, agentId: 'agent-7', status: 'merged' });
    expect(workspaces.get(workspace.id)).toEqual({ ...workspace, agentId: 'agent-7', status: 'merged' });
    await expect
      .poll(() => events.filter((event) => event.type === 'workspace' && event.workspace.id === workspace.id).length)
      .toBe(3);

    expect(workspaces.setAgent('no-such-id', 'agent-7')).toBeUndefined();
    expect(workspaces.update('no-such-id', { status: 'merged' })).toBeUndefined();
  });

  test('a workspace created for an agent carries its id', async () => {
    const project = makeProject();

    const workspace = await workspaces.create({ project: project.rel, agentId: 'agent-9' });

    expect(workspace.agentId).toBe('agent-9');
  });

  test('changes inside a workspace are journalled with its id', async () => {
    const activity = server.specos.ctx.activity;
    const project = makeProject();
    const workspace = await workspaces.create({ project: project.rel });

    const inside = await activity?.record('add', inHome(`${workspace.path}/journalled.txt`));
    const outside = await activity?.record('add', path.join(project.abs, 'journalled.txt'));

    expect(inside?.workspaceId).toBe(workspace.id);
    expect(outside).toBeDefined();
    expect(outside?.workspaceId).toBeUndefined();
  });

  test('survives a restart, without the workspaces whose folder is gone', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'specos-restart-'));
    const home = path.join(base, 'home');
    const data = path.join(base, 'data');
    try {
      const first = await startTestServer({ home, data });
      let kept: Workspace;
      let lost: Workspace;
      try {
        const project = makeProject(NOTES, { home });
        const service = first.specos.ctx.workspaces as WorkspacesService;
        kept = await service.create({ project: project.rel, label: 'kept', agentId: 'agent-1' });
        lost = await service.create({ project: project.rel, label: 'lost' });
        service.update(kept.id, { status: 'conflict' });
        kept = service.get(kept.id) as Workspace;
      } finally {
        await first.close();
      }
      expect(JSON.parse(fs.readFileSync(path.join(data, 'workspaces.json'), 'utf8'))).toBeTypeOf('object');
      fs.rmSync(path.join(home, lost.path), { recursive: true });

      const second = await startTestServer({ home, data });
      try {
        expect((await listed(second)).workspaces).toEqual([kept]);
        const service = second.specos.ctx.workspaces as WorkspacesService;
        expect(service.findByPath(`${kept.path}/note.md`)).toEqual(kept);
        // A reloaded workspace is as removable as a new one.
        expect(await service.remove(kept.id)).toBe(true);
        expect(fs.existsSync(path.join(home, kept.path))).toBe(false);
      } finally {
        await second.close();
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('a registry file that cannot be read starts an empty registry instead of stopping the server', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'specos-restart-'));
    const data = path.join(base, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'workspaces.json'), '{"workspaces": [{"id": 7}, "nonsense"');
    try {
      const restarted = await startTestServer({ home: path.join(base, 'home'), data });
      try {
        expect((await listed(restarted)).workspaces).toEqual([]);
      } finally {
        await restarted.close();
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('removing a workspace', () => {
  test('DELETE /api/workspaces/:id removes it, and a second time it is not found', async () => {
    const project = makeProject();
    const workspace = await workspaces.create({ project: project.rel });

    const removed = await server.fetch(`/api/workspaces/${workspace.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect(fs.existsSync(inHome(workspace.path))).toBe(false);
    expect((await listed()).workspaces.map((entry) => entry.id)).not.toContain(workspace.id);

    const again = await server.fetch(`/api/workspaces/${workspace.id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect(((await again.json()) as ApiError).code).toBe('not_found');
    expect(await workspaces.remove(workspace.id)).toBe(false);
  });

  test('a workspace folder replaced by a link is unlinked, and what it pointed to is left alone', async () => {
    const project = makeProject();
    const workspace = await workspaces.create({ project: project.rel, strategy: 'copy' });
    const precious = inHome('precious');
    fs.mkdirSync(precious);
    fs.writeFileSync(path.join(precious, 'keep.txt'), 'keep me\n');
    fs.rmSync(inHome(workspace.path), { recursive: true });
    fs.symlinkSync(precious, inHome(workspace.path));

    expect(await workspaces.remove(workspace.id)).toBe(true);

    expect(fs.existsSync(inHome(workspace.path))).toBe(false);
    expect(fs.readFileSync(path.join(precious, 'keep.txt'), 'utf8')).toBe('keep me\n');
  });
});

describe('refused projects', () => {
  test.each([
    ['climbs out of home', '../outside', 403, 'path_escape'],
    ['climbs out half way', 'Projects/../../etc', 403, 'path_escape'],
    ['is absolute', '/etc', 400, 'bad_path'],
    ['is outside Projects', 'Documents/notes', 400, 'bad_request'],
    ['is Projects itself', 'Projects', 400, 'bad_request'],
    ['is a folder inside a project', 'Projects/notes-1/ideas', 400, 'bad_request'],
    ['is a workspace', 'Workspaces/anything', 400, 'bad_request'],
    ['does not exist', 'Projects/no-such-project', 404, 'not_found'],
  ])('a project that %s is refused', async (_name, project, status, code) => {
    fs.mkdirSync(inHome('Documents/notes'), { recursive: true });
    const before = fs.readdirSync(inHome('Workspaces'));

    const response = await post('/api/workspaces', { project });

    expect(response.status).toBe(status);
    expect(((await response.json()) as ApiError).code).toBe(code);
    expect(fs.readdirSync(inHome('Workspaces'))).toEqual(before);
  });

  test('a project that is a link out of home is refused', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'specos-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours\n');
      fs.symlinkSync(outside, inHome('Projects/way-out'));

      const response = await post('/api/workspaces', { project: 'Projects/way-out' });

      expect(response.status).toBe(403);
      expect(((await response.json()) as ApiError).code).toBe('path_escape');
      expect(fs.existsSync(path.join(outside, '.git'))).toBe(false);
    } finally {
      fs.rmSync(inHome('Projects/way-out'), { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a project that is a file, or a body without a project, is refused', async () => {
    fs.writeFileSync(inHome('Projects/just-a-file'), 'text\n');

    expect((await post('/api/workspaces', { project: 'Projects/just-a-file' })).status).toBe(400);
    expect((await post('/api/workspaces', {})).status).toBe(400);
    expect((await post('/api/workspaces', { project: 7 })).status).toBe(400);
    expect((await post('/api/workspaces', { project: 'Projects/notes-1', label: 7 })).status).toBe(400);
  });

  test('the benchmark refuses the same projects', async () => {
    expect((await post('/api/system/benchmark', { project: '../outside' })).status).toBe(403);
    expect((await post('/api/system/benchmark', { project: 'Documents/notes' })).status).toBe(400);
    expect((await post('/api/system/benchmark', { project: 'Projects/no-such-project' })).status).toBe(404);
  });
});

describe('the clone benchmark', () => {
  const sample = (): string => inHome('Projects/sample-project');

  /** Every file below a folder, as paths relative to it, without git's own folder. */
  function filesBelow(root: string, folder = ''): string[] {
    return fs.readdirSync(path.join(root, folder), { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === '.git') return [];
      const rel = path.join(folder, entry.name);
      return entry.isDirectory() ? filesBelow(root, rel) : [rel];
    });
  }

  /** A digest of every file name and content below a folder. */
  function fingerprintOf(root: string): string {
    const hash = createHash('sha256');
    for (const file of filesBelow(root).sort()) {
      hash.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
    }
    return hash.digest('hex');
  }

  /** What an open desktop heard from the run that generated the sample project. */
  let heardWhileGenerating: Awaited<ReturnType<typeof openEvents>>['events'] = [];

  test('with count 3 it clones three times, streams each clone and leaves nothing behind', async () => {
    const { socket, events } = await openEvents();
    sockets.push(socket);
    heardWhileGenerating = events;
    const before = (await listed()).workspaces;

    const response = await post('/api/system/benchmark', { count: 3 });
    expect(response.status).toBe(200);
    const result = (await response.json()) as BenchmarkResult;

    // --- the result ---
    expect(result.count).toBe(3);
    expect(result.project).toBe('Projects/sample-project');
    expect(result.strategy).toBe(probed.strategy);
    expect(result.clones).toHaveLength(3);
    for (const clone of result.clones) {
      expect(clone.strategy).toBe(probed.strategy);
      expect(clone.ms).toBeGreaterThan(0);
      expect(clone.files).toBe(result.projectFiles);
      expect(clone.bytes).toBe(result.projectBytes);
      expect(clone.diskBytes).toBeGreaterThanOrEqual(0);
    }
    expect(result.totalMs).toBeCloseTo(result.clones.reduce((sum, clone) => sum + clone.ms, 0), 6);

    // --- the stream ---
    await expect.poll(() => events.some((event) => event.type === 'bench-done')).toBe(true);
    const frames = events.filter((event) => event.type === 'bench');
    expect(frames).toEqual(result.clones.map((clone, index) => ({ type: 'bench', id: result.id, index, count: 3, clone })));
    expect(events.filter((event) => event.type === 'bench-done')).toEqual([{ type: 'bench-done', result }]);
    // Each clone is reported as it finishes, before the result.
    const order = events.filter((event) => event.type === 'bench' || event.type === 'bench-done').map((event) => event.type);
    expect(order).toEqual(['bench', 'bench', 'bench', 'bench-done']);
    const made = events.flatMap((event) => (event.type === 'workspace' ? [event.workspace.name] : []));
    expect(made).toEqual(['sample-project-bench-1', 'sample-project-bench-2', 'sample-project-bench-3']);

    // --- nothing lingers ---
    expect((await listed()).workspaces).toEqual(before);
    expect(fs.readdirSync(inHome('Workspaces')).filter((name) => name.includes('bench'))).toEqual([]);
    expect(git(sample(), 'branch', '--list', 'agent/*')).toBe('');
    expect(git(sample(), 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  test('its scratch copies stay out of the journal, so it never pushes real changes out', async () => {
    fs.writeFileSync(inHome('kept.txt'), 'a real change\n');
    const journal = async (): Promise<ActivityEntry[]> => ((await (await server.fetch('/api/activity?limit=1000')).json()) as ActivityListResponse).entries;
    await expect.poll(async () => (await journal()).some((entry) => entry.path === 'kept.txt')).toBe(true);
    const { socket, events } = await openEvents();
    sockets.push(socket);

    expect((await post('/api/system/benchmark', { count: 2 })).status).toBe(200);
    // Long enough for the watcher to report everything the benchmark did.
    await new Promise((resolve) => setTimeout(resolve, 700));

    const entries = await journal();
    expect(entries.filter((entry) => entry.path.includes('-bench-'))).toEqual([]);
    expect(entries.some((entry) => entry.path === 'kept.txt')).toBe(true);
    // Open desktops hear the two folders come and go, and none of the files inside them.
    const heard = events.flatMap((event) => (event.type === 'fs' && event.entry.path.includes('-bench-') ? [event.entry] : []));
    expect(heard.length).toBeGreaterThan(0);
    for (const entry of heard) {
      expect(entry.path).toMatch(/^Workspaces\/sample-project-bench-\d+$/);
      expect(entry.isDir).toBe(true);
    }
  });

  test('the sample project is about 200 small files and says what it is', () => {
    const files = filesBelow(sample());
    const bytes = files.reduce((sum, file) => sum + fs.statSync(path.join(sample(), file)).size, 0);

    expect(files.length).toBeGreaterThanOrEqual(180);
    expect(files.length).toBeLessThanOrEqual(220);
    expect(bytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(new Set(files.map((file) => path.dirname(file))).size).toBeGreaterThanOrEqual(4);
    expect(fs.readFileSync(path.join(sample(), 'README.md'), 'utf8')).toMatch(/benchmark/i);
  });

  test('the sample project is generated once and is the same on every machine', async () => {
    const readme = path.join(sample(), 'README.md');
    const stamp = fs.statSync(readme).mtimeMs;
    const fingerprint = fingerprintOf(sample());

    const result = (await (await post('/api/system/benchmark', { count: 1 })).json()) as BenchmarkResult;

    expect(result.clones).toHaveLength(1);
    expect(fs.statSync(readme).mtimeMs).toBe(stamp);
    expect(fingerprintOf(sample())).toBe(fingerprint);
    // The content is computed, not random, so it is the same wherever and whenever it is generated.
    expect(fingerprint).toMatchInlineSnapshot(`"a426d7cc0c376da23ce8542df4ceeb6ab56ba0e661c4577e1f299c309a19513f"`);
  });

  test('the generated sample project is one line in the journal, and a later edit to it still has a diff', async () => {
    const journal = async (): Promise<ActivityEntry[]> => ((await (await server.fetch('/api/activity?limit=1000')).json()) as ActivityListResponse).entries;
    // The journal goes quiet about the project for two seconds after it appears.
    await new Promise((resolve) => setTimeout(resolve, 2100));

    const generated = (await journal()).filter((entry) => entry.path.startsWith('Projects/sample-project'));
    expect(generated.map((entry) => entry.path)).toEqual(['Projects/sample-project']);
    // Open desktops heard the same single thing, so a list of changes is the same before and after a reload.
    const heard = heardWhileGenerating.flatMap((event) => (event.type === 'fs' && event.entry.path.startsWith('Projects/sample-project') ? [event.entry.path] : []));
    expect(heard).toEqual(['Projects/sample-project']);

    const readme = path.join(sample(), 'README.md');
    const original = fs.readFileSync(readme, 'utf8');
    fs.writeFileSync(readme, original + '\nA line somebody wrote.\n');
    try {
      await expect
        .poll(async () => (await journal()).find((entry) => entry.path === 'Projects/sample-project/README.md'))
        .toMatchObject({ kind: 'change', hasDiff: true, additions: 2, deletions: 0 });
    } finally {
      fs.writeFileSync(readme, original);
    }
  });

  test('a named project is cloned instead of the sample', async () => {
    const project = makeProject();

    const response = await post('/api/system/benchmark', { count: 2, project: project.rel });
    expect(response.status).toBe(200);
    const result = (await response.json()) as BenchmarkResult;

    expect(result).toMatchObject({ project: project.rel, count: 2, projectFiles: Object.keys(NOTES).length, projectBytes: bytesOf(NOTES) });
    expect(result.clones).toHaveLength(2);
    expect(fs.readdirSync(inHome('Workspaces')).filter((name) => name.startsWith(`${project.name}-bench`))).toEqual([]);
  });

  test('the count defaults to 10 and is limited to 50', async () => {
    const project = makeProject({ 'only.txt': 'one small file\n' });

    const byDefault = (await (await post('/api/system/benchmark', { project: project.rel })).json()) as BenchmarkResult;
    expect(byDefault.count).toBe(10);
    expect(byDefault.clones).toHaveLength(10);

    for (const count of [51, 0, -1, 2.5, 'ten']) {
      const response = await post('/api/system/benchmark', { count, project: project.rel });
      expect(response.status, String(count)).toBe(400);
      expect(((await response.json()) as ApiError).code).toBe('bad_request');
    }
  });

  test('a second benchmark while one runs is refused', async () => {
    const project = makeProject();

    const [first, second] = await Promise.all([
      post('/api/system/benchmark', { count: 2, project: project.rel }),
      post('/api/system/benchmark', { count: 2, project: project.rel }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(fs.readdirSync(inHome('Workspaces')).filter((name) => name.startsWith(`${project.name}-bench`))).toEqual([]);
  });
});
