import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  ApiError,
  BenchmarkRequest,
  BenchmarkResult,
  CloneReport,
  CloneStrategy,
  CloneStrategyInfo,
  CreateWorkspaceRequest,
  OkResponse,
  ProjectsResponse,
  Workspace,
  WorkspacesResponse,
} from '../../shared/protocol';
import type { Ctx } from './context';
import { AS_SERVER, git } from './git';
import { pathErrorResponse, resolveInHome, toRel } from './paths';
import { detectCloneStrategy } from './probe';
import { ensureSampleProject, SAMPLE_PROJECT_NAME } from './sample-project';

/**
 * Workspaces: "give this agent its own copy". A project is a folder under
 * Projects/; a workspace is a private clone of it under Workspaces/, on its
 * own git branch, made the cheapest way the file system allows. This module
 * owns the registry of workspaces and the benchmark that times the clones.
 */

const PROJECTS = 'Projects';
const WORKSPACES = 'Workspaces';
const REGISTRY_FILE = 'workspaces.json';
const STRATEGIES: readonly CloneStrategy[] = ['reflink', 'worktree', 'copy'];

const BENCH_DEFAULT_COUNT = 10;
const BENCH_MAX_COUNT = 50;

export interface CreateWorkspaceOptions {
  /** Home relative path of a folder directly under Projects/. */
  project: string;
  /** Used in the folder name; the workspace id when omitted. */
  label?: string;
  agentId?: string;
  /** Overrides the strategy probed for this machine. */
  strategy?: CloneStrategy;
}

/** The parts of a workspace that change after it is made. */
export type WorkspaceChanges = Partial<Pick<Workspace, 'status' | 'baseRef' | 'agentId'>>;

export interface WorkspacesService {
  create(options: CreateWorkspaceOptions): Promise<Workspace>;
  list(): Workspace[];
  get(id: string): Workspace | undefined;
  /** Deletes the folder and its branch. False when there is no such workspace. */
  remove(id: string): Promise<boolean>;
  /** The workspace whose folder is, or contains, a home relative path. */
  findByPath(relPath: string): Workspace | undefined;
  setAgent(id: string, agentId: string): Workspace | undefined;
  /** Changes a workspace, saves it and announces it. Undefined when there is no such workspace. */
  update(id: string, changes: WorkspaceChanges): Workspace | undefined;
  /** How this machine clones, and why. */
  strategy(): Promise<CloneStrategyInfo>;
}

/** A refusal with its HTTP status, turned into an ApiError by the routes below. */
export class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

const badRequest = (message: string): WorkspaceError => new WorkspaceError(400, 'bad_request', message);

// ---------------------------------------------------------------- names

/** Lower case words joined by dashes: safe as a folder name, in a URL and in a branch name. */
function slug(text: string, fallback: string): string {
  const words = text.toLowerCase().match(/[a-z0-9]+/g);
  return words ? words.join('-').slice(0, 40).replace(/-$/, '') : fallback;
}

/** Eight hex digits: short enough to read in a branch name, and random enough for one machine. */
const newId = (): string => randomBytes(4).toString('hex');

// ---------------------------------------------------------------- projects

interface Project {
  name: string;
  /** Home relative, "Projects/<name>". */
  rel: string;
  abs: string;
}

/** Checks that a home relative path names a real folder directly under Projects/. */
async function projectAt(home: string, rel: unknown): Promise<Project> {
  if (typeof rel !== 'string') throw badRequest('A workspace needs the path of a project');
  const abs = resolveInHome(home, rel);
  const [top, name, ...deeper] = toRel(home, abs).split('/');
  if (top !== PROJECTS || !name || deeper.length > 0) {
    throw badRequest(`A project is a folder directly under ${PROJECTS}/`);
  }
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(abs);
  } catch {
    throw new WorkspaceError(404, 'not_found', 'There is no such project');
  }
  // A link that stays inside home passes the guard, but its clone would be a copy of the link, not of a project.
  if (!stat.isDirectory()) throw badRequest('A project must be a folder');
  return { name, rel: `${PROJECTS}/${name}`, abs };
}

/**
 * Makes the project's current state a commit and returns it. The first time
 * this turns the folder into a repository; later it only commits when the
 * user has changed something since, so a workspace always starts from what
 * they see in the folder.
 */
async function commitBase(project: string): Promise<string> {
  // Looked for in the folder itself: home may sit inside another repository, which is not the project's.
  const isRepository = await fsp.lstat(path.join(project, '.git')).then(
    () => true,
    () => false,
  );
  if (!isRepository) await git(project, ['init', '--quiet', '--initial-branch=main']);

  const hasCommit = await git(project, ['rev-parse', '--quiet', '--verify', 'HEAD^{commit}']).then(
    () => true,
    () => false,
  );
  const pending = hasCommit && (await git(project, [...AS_SERVER, 'status', '--porcelain'])) !== '';
  if (!hasCommit || pending) {
    await git(project, [...AS_SERVER, 'add', '--all']);
    // The user's hooks are for their own commits; this one is bookkeeping and must not be vetoed or slowed.
    const message = hasCommit ? 'Save changes before a workspace' : 'Base for workspaces';
    await git(project, [...AS_SERVER, 'commit', '--quiet', '--allow-empty', '--no-verify', '--message', message]);
  }
  return git(project, ['rev-parse', 'HEAD']);
}

// ---------------------------------------------------------------- cloning

interface CloneJob {
  project: string;
  /** Absolute path of the workspace folder, which does not exist yet. */
  target: string;
  branch: string;
  baseRef: string;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, _stdout, stderr) =>
      error ? reject(new Error(`${command} failed: ${stderr.trim() || error.message}`)) : resolve(),
    );
  });
}

const startBranch = (job: CloneJob): Promise<string> => git(job.target, ['checkout', '--quiet', '-b', job.branch]);

const CLONERS: Record<CloneStrategy, (job: CloneJob) => Promise<unknown>> = {
  /** Copy-on-write: every file shares its blocks with the original until one side writes. Repository included. */
  async reflink(job) {
    await run('cp', ['-a', '--reflink=auto', '--', job.project, job.target]);
    await startBranch(job);
  },
  /** One repository, a second checkout: only the working files are written, history is shared. */
  worktree: (job) => git(job.project, ['worktree', 'add', '--quiet', '-b', job.branch, job.target, job.baseRef]),
  /** Works anywhere, costs the full size of the project every time. */
  async copy(job) {
    await fsp.cp(job.project, job.target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    await startBranch(job);
  },
};

/** Files and their logical size below a folder, without git's own data, which is not part of the project. */
async function measureTree(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const folders = [root];
  for (let next = 0; next < folders.length; next++) {
    const folder = folders[next] as string;
    const children = await fsp.readdir(folder, { withFileTypes: true });
    for (const child of children) {
      if (child.name === '.git') continue;
      const abs = path.join(folder, child.name);
      if (child.isDirectory()) {
        folders.push(abs);
        continue;
      }
      files++;
      bytes += (await fsp.lstat(abs)).size;
    }
  }
  return { files, bytes };
}

/** Clones and reports what it cost. Only the clone is timed, not the measuring around it. */
async function timedClone(home: string, strategy: CloneStrategy, job: CloneJob): Promise<CloneReport> {
  const before = await fsp.statfs(home);
  const started = process.hrtime.bigint();
  await CLONERS[strategy](job);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const after = await fsp.statfs(home);
  // Other programs write to the same disk, so the delta is an estimate; it can even come out below zero.
  const diskBytes = Math.max(0, (before.bfree - after.bfree) * before.bsize);
  return { strategy, ms, diskBytes, ...(await measureTree(job.target)) };
}

// ---------------------------------------------------------------- registry file

/** What is kept on disk for each workspace. */
interface Stored {
  workspace: Workspace;
  /** Made by the benchmark. One that is still here at start was orphaned by a crash and is removed. */
  benchmark?: true;
}

function isStored(value: unknown): value is Stored {
  const { workspace, benchmark } = (value ?? {}) as Partial<Stored>;
  if (typeof workspace !== 'object' || workspace === null) return false;
  if (benchmark !== undefined && benchmark !== true) return false;
  const { id, name, clone } = workspace;
  return (
    typeof id === 'string' &&
    /^[a-z0-9]+$/.test(id) &&
    typeof name === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(name) &&
    // Removal acts on these three, so they must be exactly what create() would have written.
    workspace.path === `${WORKSPACES}/${name}` &&
    workspace.branch === `agent/${id}` &&
    typeof workspace.project === 'string' &&
    /^Projects\/[^/]+$/.test(workspace.project) &&
    typeof workspace.baseRef === 'string' &&
    typeof workspace.createdAt === 'number' &&
    typeof clone === 'object' &&
    clone !== null &&
    STRATEGIES.includes(clone.strategy)
  );
}

function readRegistry(file: string): Stored[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { workspaces?: unknown };
    return Array.isArray(parsed.workspaces) ? parsed.workspaces.filter(isStored) : [];
  } catch {
    // First start, or a file cut short by a crash. The folders are still on disk; only the list is lost.
    return [];
  }
}

// ---------------------------------------------------------------- module

export async function registerWorkspaces(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { home, data } = ctx.config;
  const registryFile = path.join(data, REGISTRY_FILE);
  await fsp.mkdir(path.join(home, PROJECTS), { recursive: true });
  await fsp.mkdir(path.join(home, WORKSPACES), { recursive: true });

  const byId = new Map<string, Stored>();
  const idByName = new Map<string, string>();

  // --- saving: one write at a time, each a whole new file moved into place ---
  let saved: Promise<void> = Promise.resolve();
  function save(): void {
    const text = JSON.stringify({ workspaces: [...byId.values()] }, null, 2) + '\n';
    saved = saved
      .then(async () => {
        await fsp.writeFile(registryFile + '.tmp', text);
        await fsp.rename(registryFile + '.tmp', registryFile);
      })
      .catch((error: Error) => console.error(`SpecOS cannot save the workspace registry: ${error.message}`));
  }

  function store(stored: Stored): Workspace {
    byId.set(stored.workspace.id, stored);
    idByName.set(stored.workspace.name, stored.workspace.id);
    save();
    ctx.bus.emit({ type: 'workspace', workspace: stored.workspace });
    return stored.workspace;
  }

  // Creating and removing run one at a time: two git commands in one repository would fight over its lock,
  // and two creates could pick the same free name.
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  }

  /** The folder of a workspace. Refuses anything that is not a direct child of Workspaces/ inside home. */
  function folderOf(workspace: Workspace): string {
    if (workspace.path !== `${WORKSPACES}/${workspace.name}` || workspace.name.includes('/')) {
      throw new WorkspaceError(500, 'internal', 'The workspace has no folder of its own');
    }
    // The entry itself, not what it points to: a link put in its place is unlinked, its target left alone.
    return resolveInHome(home, workspace.path, { followLeaf: false });
  }

  /** Deletes a clone from disk, together with the branch a worktree left in its project. */
  async function deleteClone(workspace: Workspace): Promise<void> {
    const folder = folderOf(workspace);
    if (workspace.clone.strategy !== 'worktree') return fsp.rm(folder, { recursive: true, force: true });

    const project = resolveInHome(home, workspace.project);
    // Each step may find its work already done (the folder deleted by hand, the project gone); what matters is
    // the state afterwards, so a failure here is not a failure of the removal.
    const attempt = (args: string[]): Promise<unknown> => git(project, args).catch(() => undefined);
    await attempt(['worktree', 'remove', '--force', folder]);
    await fsp.rm(folder, { recursive: true, force: true });
    await attempt(['worktree', 'prune']);
    await attempt(['branch', '--delete', '--force', workspace.branch]);
  }

  /** A folder name nothing uses yet, neither a workspace nor something the user put there. */
  function freeName(wanted: string): string {
    const taken = (name: string): boolean => idByName.has(name) || fs.existsSync(path.join(home, WORKSPACES, name));
    if (!taken(wanted)) return wanted;
    for (let suffix = 2; ; suffix++) {
      if (!taken(`${wanted}-${suffix}`)) return `${wanted}-${suffix}`;
    }
  }

  function createNow(options: CreateWorkspaceOptions, benchmark: boolean): Promise<Workspace> {
    return exclusive(async () => {
      const project = await projectAt(home, options.project);
      const strategy = options.strategy ?? (await detectCloneStrategy(home)).strategy;
      const baseRef = await commitBase(project.abs);

      let id = newId();
      while (byId.has(id)) id = newId();
      const name = freeName(`${slug(project.name, 'project')}-${slug(options.label ?? '', id)}`);
      const workspace: Omit<Workspace, 'clone'> = {
        id,
        name,
        path: `${WORKSPACES}/${name}`,
        project: project.rel,
        branch: `agent/${id}`,
        baseRef,
        createdAt: Date.now(),
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        status: 'active',
      };
      const job: CloneJob = { project: project.abs, target: resolveInHome(home, workspace.path), branch: workspace.branch, baseRef };
      let clone: CloneReport;
      try {
        clone = await timedClone(home, strategy, job);
      } catch (error) {
        // Half a clone is worse than none: the name stays free and the project keeps no stray branch.
        await deleteClone({ ...workspace, clone: { strategy, ms: 0, bytes: 0, diskBytes: 0, files: 0 } }).catch(() => undefined);
        throw error;
      }
      return store({ workspace: { ...workspace, clone }, ...(benchmark ? { benchmark: true as const } : {}) });
    });
  }

  function change(id: string, changes: WorkspaceChanges): Workspace | undefined {
    const stored = byId.get(id);
    if (!stored) return undefined;
    // A new object each time, so a workspace handed out earlier stays the snapshot it was.
    return store({ ...stored, workspace: { ...stored.workspace, ...changes } });
  }

  const service: WorkspacesService = {
    create: (options) => createNow(options, false),
    list: () => [...byId.values()].map((stored) => stored.workspace),
    get: (id) => byId.get(id)?.workspace,
    remove: (id) =>
      exclusive(async () => {
        const stored = byId.get(id);
        if (!stored) return false;
        await deleteClone(stored.workspace);
        byId.delete(id);
        idByName.delete(stored.workspace.name);
        save();
        ctx.bus.emit({ type: 'workspace-removed', id });
        return true;
      }),
    findByPath(relPath) {
      const [top, name] = relPath.split('/');
      if (top !== WORKSPACES || !name) return undefined;
      const id = idByName.get(name);
      return id === undefined ? undefined : byId.get(id)?.workspace;
    },
    setAgent: (id, agentId) => change(id, { agentId }),
    update: change,
    strategy: () => detectCloneStrategy(home),
  };
  ctx.workspaces = service;
  // Who made a change is the agents module's to say; which workspace it happened in is known here.
  ctx.activity?.setWorkspaceResolver((rel) => service.findByPath(rel)?.id);
  ctx.onClose(async () => {
    await tail;
    await saved;
  });

  // --- reload: the registry of the last run, minus what is no longer on disk ---
  for (const stored of readRegistry(registryFile)) {
    const present = fs.existsSync(path.join(home, stored.workspace.path));
    if (!present || byId.has(stored.workspace.id) || idByName.has(stored.workspace.name)) continue;
    byId.set(stored.workspace.id, stored);
    idByName.set(stored.workspace.name, stored.workspace.id);
  }
  for (const stored of [...byId.values()]) {
    if (stored.benchmark) await service.remove(stored.workspace.id);
  }

  // --- benchmark ---
  let benchmarkRunning = false;

  async function benchmark(count: number, requested: unknown): Promise<BenchmarkResult> {
    if (requested === undefined) await ensureSampleProject(path.join(home, PROJECTS));
    const project = await projectAt(home, requested ?? `${PROJECTS}/${SAMPLE_PROJECT_NAME}`);
    const id = newId();
    const made: Workspace[] = [];
    try {
      for (let index = 0; index < count; index++) {
        const workspace = await createNow({ project: project.rel, label: `bench-${index + 1}` }, true);
        made.push(workspace);
        ctx.bus.emit({ type: 'bench', id, index, count, clone: workspace.clone });
      }
    } finally {
      // Also when a clone failed half way: the benchmark never leaves workspaces behind.
      for (const workspace of made) await service.remove(workspace.id);
    }
    const clones = made.map((workspace) => workspace.clone);
    const measured = await measureTree(project.abs);
    const result: BenchmarkResult = {
      id,
      strategy: (clones[0] as CloneReport).strategy,
      project: project.rel,
      count,
      totalMs: clones.reduce((sum, clone) => sum + clone.ms, 0),
      clones,
      projectFiles: measured.files,
      projectBytes: measured.bytes,
    };
    ctx.bus.emit({ type: 'bench-done', result });
    return result;
  }

  // --- routes, in a scope of their own so the error format applies to them only ---
  await app.register(async (api) => {
    api.setErrorHandler((error, _request, reply) => {
      const refused = pathErrorResponse(error);
      if (refused) return reply.code(refused.status).send(refused.body);
      if (error instanceof WorkspaceError) {
        return reply.code(error.status).send({ error: error.message, code: error.code } satisfies ApiError);
      }
      const { statusCode, message } = error as { statusCode?: number; message: string };
      // Fastify's own refusals (malformed JSON, a body too large) are written for clients.
      if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
        return reply.code(statusCode).send({ error: message, code: 'bad_request' } satisfies ApiError);
      }
      // A failed git or cp quotes absolute paths; the client only learns that it failed.
      console.error(`SpecOS workspace operation failed: ${message}`);
      return reply.code(500).send({ error: 'The workspace operation failed', code: 'internal' } satisfies ApiError);
    });

    /** The JSON body as an object with unchecked fields. A missing body is an empty object. */
    const bodyOf = <T>(body: unknown): Partial<Record<keyof T, unknown>> => {
      if (body === undefined || body === null) return {};
      if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('The request needs a JSON object as its body');
      return body as Partial<Record<keyof T, unknown>>;
    };

    api.get('/api/projects', async (): Promise<ProjectsResponse> => {
      const children = await fsp.readdir(path.join(home, PROJECTS), { withFileTypes: true });
      const names = children.filter((child) => child.isDirectory()).map((child) => child.name);
      return { projects: names.sort().map((name) => ({ name, path: `${PROJECTS}/${name}` })) };
    });

    api.get('/api/workspaces', async (): Promise<WorkspacesResponse> => {
      return { workspaces: service.list(), strategy: await service.strategy() };
    });

    api.post('/api/workspaces', async (request, reply): Promise<Workspace> => {
      const { project, label } = bodyOf<CreateWorkspaceRequest>(request.body);
      if (typeof project !== 'string') throw badRequest('A workspace needs the path of a project');
      if (label !== undefined && typeof label !== 'string') throw badRequest('A label must be text');
      const workspace = await service.create({ project, ...(label === undefined ? {} : { label }) });
      return reply.code(201).send(workspace);
    });

    api.delete('/api/workspaces/:id', async (request): Promise<OkResponse> => {
      const removed = await service.remove((request.params as { id: string }).id);
      if (!removed) throw new WorkspaceError(404, 'not_found', 'There is no such workspace');
      return { ok: true };
    });

    api.post('/api/system/benchmark', async (request): Promise<BenchmarkResult> => {
      const { count = BENCH_DEFAULT_COUNT, project } = bodyOf<BenchmarkRequest>(request.body);
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > BENCH_MAX_COUNT) {
        throw badRequest(`count must be a whole number from 1 to ${BENCH_MAX_COUNT}`);
      }
      // Two at once would time each other's disk writes rather than the clone.
      if (benchmarkRunning) throw new WorkspaceError(409, 'conflict', 'A benchmark is already running');
      benchmarkRunning = true;
      try {
        return await benchmark(count, project);
      } finally {
        benchmarkRunning = false;
      }
    });
  });
}
