import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  ActivityEntry,
  AgentEventsResponse,
  AgentInfo,
  AgentRunner,
  AgentsResponse,
  AgentStatus,
  AgentStreamEvent,
  AttachRequest,
  OkResponse,
  StartAgentRequest,
  TouchedFile,
  Workspace,
} from '../../shared/protocol';
import type { Ctx } from './context';
import { resolveInHome, toRel } from './paths';
import { detectRunner } from './probe';
import { runClaude } from './runners/claude';
import { runDemo } from './runners/demo';
import type { Run, RunnerEvent, RunOutcome, RunRequest } from './runners/runner';
import { bodyOf, refusalHandler, WorkspaceError } from './workspaces';

/**
 * Agent jobs: one prompt, one agent, one workspace. This module gives each
 * job its name, colour and private copy of a project, starts a runner in it,
 * keeps the stream of what the agent says and does, and notes which files it
 * touched. The runners do the work; everything here is the same for both.
 */

export interface AgentsService {
  /** Makes the job and its workspace and answers at once, with status 'starting'; the run goes on by itself. */
  start(request: StartAgentRequest): Promise<AgentInfo>;
  list(): AgentInfo[];
  get(id: string): AgentInfo | undefined;
  /** Ends a running job and resolves once it has. A finished job is returned as it is. */
  stop(id: string): Promise<AgentInfo>;
  /** Copies a home file into the job's workspace, under attachments/. */
  attach(id: string, relPath: string): Promise<AgentInfo>;
  /** Forgets a finished job. Its workspace stays. */
  remove(id: string): void;
  /** The stream events after number `since`, as far back as they are kept. */
  events(id: string, since: number): AgentStreamEvent[];
  /** Jobs that are starting or running. */
  runningCount(): number;
}

const REGISTRY_FILE = 'agents.json';
const MAX_JOBS = 50;
const MAX_EVENTS = 2000;
const MAX_PROMPT_CHARS = 20_000;
const ATTACHMENTS = 'attachments';
const PROJECTS = 'Projects';
const RUNNERS: readonly AgentRunner[] = ['claude', 'demo'];

/**
 * After a run ends well, how long the job stays 'running' so that the watcher can still report its last
 * writes. Without it the final edit of a quick agent would be missing from the files it touched.
 */
const SETTLE_MS = 250;

/** Trees, stones and tools: short, friendly, and easy to tell apart at a glance. */
const NAMES = [
  'Juniper', 'Basalt', 'Quill', 'Larch', 'Flint', 'Sable', 'Alder', 'Slate', 'Awl', 'Rowan',
  'Onyx', 'Chisel', 'Hazel', 'Garnet', 'Loom', 'Cedar', 'Jasper', 'Anvil', 'Willow', 'Agate',
  'Lathe', 'Aspen', 'Marble', 'Plumb', 'Birch', 'Quartz', 'Rasp', 'Linden', 'Opal', 'Trowel',
  'Maple', 'Shale', 'Mallet', 'Yew', 'Pumice', 'Gimlet', 'Elm', 'Granite', 'Bodkin', 'Hawthorn',
];

/** Each new agent's colour is this far round the wheel from the last: neighbours differ, and no two repeat soon. */
const GOLDEN_ANGLE = 137.508;
const FIRST_HUE = 28;

const refuse = (status: number, code: string, message: string): WorkspaceError => new WorkspaceError(status, code, message);
const badRequest = (message: string): WorkspaceError => refuse(400, 'bad_request', message);

const isFinished = (status: AgentStatus): boolean => status === 'done' || status === 'failed' || status === 'stopped';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- jobs

interface Job {
  /** Replaced on every change, never mutated, so what was handed out stays the snapshot it was. */
  info: AgentInfo;
  /** The latest stream events, at most MAX_EVENTS. Numbers go on counting past that. */
  events: AgentStreamEvent[];
  /** The runner's session, which a job that continues this one resumes. */
  sessionId?: string;
  run?: Run;
  stopRequested: boolean;
  /** Settles when the job has its final status. */
  ended: Promise<void>;
  /**
   * Home relative paths of the files that were in the workspace before the run. The watcher reports a fresh
   * clone file by file, a little late; an 'add' for one of these is the clone arriving, not the agent's work.
   */
  cloned: Set<string>;
}

/** What is kept on disk for each job. */
interface Stored {
  info: AgentInfo;
  events: AgentStreamEvent[];
  sessionId?: string;
}

function isStored(value: unknown): value is Stored {
  const { info, events } = (value ?? {}) as Partial<Stored>;
  return (
    typeof info === 'object' &&
    info !== null &&
    typeof info.id === 'string' &&
    typeof info.name === 'string' &&
    typeof info.hue === 'number' &&
    typeof info.prompt === 'string' &&
    typeof info.startedAt === 'number' &&
    typeof info.workspace === 'object' &&
    info.workspace !== null &&
    Array.isArray(info.filesTouched) &&
    Array.isArray(info.attachments) &&
    Array.isArray(events)
  );
}

function readRegistry(file: string): { sequence: number; jobs: Stored[] } {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { sequence?: unknown; jobs?: unknown };
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs.filter(isStored) : [];
    return { sequence: typeof parsed.sequence === 'number' ? parsed.sequence : jobs.length, jobs };
  } catch {
    // First start, or a file cut short by a crash: the history is gone, the workspaces are not.
    return { sequence: 0, jobs: [] };
  }
}

/** Every file below a folder, as paths relative to `base`. Git's own data is not part of the work. */
async function filesBelow(folder: string, base: string): Promise<Set<string>> {
  const files = new Set<string>();
  const folders = [folder];
  for (let next = 0; next < folders.length; next++) {
    const current = folders[next] as string;
    const children = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.name === '.git') continue;
      const abs = path.join(current, child.name);
      if (child.isDirectory()) folders.push(abs);
      else files.add(toRel(base, abs));
    }
  }
  return files;
}

// ---------------------------------------------------------------- module

export async function registerAgents(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { config } = ctx;
  const { home } = config;
  if (!ctx.workspaces) throw new Error('registerAgents needs the workspaces module registered first');
  const workspaces = ctx.workspaces;
  const registryFile = path.join(config.data, REGISTRY_FILE);

  /** In the order they were started. */
  const jobs = new Map<string, Job>();
  /** Names given to jobs that are still being set up and not in `jobs` yet. */
  const reservedNames = new Set<string>();
  /** How many agents have ever been named, which decides the next name and colour. */
  let sequence = 0;
  let closing = false;

  // --- saving: one write at a time, each a whole new file moved into place ---
  let saved: Promise<void> = Promise.resolve();
  function save(): void {
    const stored = [...jobs.values()].map(({ info, events, sessionId }): Stored => ({ info, events, ...(sessionId ? { sessionId } : {}) }));
    const text = JSON.stringify({ sequence, jobs: stored });
    saved = saved
      .then(async () => {
        await fsp.writeFile(registryFile + '.tmp', text);
        await fsp.rename(registryFile + '.tmp', registryFile);
      })
      .catch((error: Error) => console.error(`SpecOS cannot save the agent jobs: ${error.message}`));
  }

  // --- changes: every one of them is announced ---
  function change(job: Job, changes: Partial<AgentInfo>): AgentInfo {
    job.info = { ...job.info, ...changes };
    ctx.bus.emit({ type: 'agent', agent: job.info });
    return job.info;
  }

  function addEvent(job: Job, event: RunnerEvent): void {
    const numbered: AgentStreamEvent = { seq: job.info.events + 1, at: Date.now(), ...event };
    job.events.push(numbered);
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    // The count travels with the next announcement; the event itself is what the desktop needs now.
    job.info = { ...job.info, events: numbered.seq };
    ctx.bus.emit({ type: 'agent-event', id: job.info.id, event: numbered });
  }

  function forget(job: Job): void {
    jobs.delete(job.info.id);
    ctx.bus.emit({ type: 'agent-removed', id: job.info.id });
  }

  /** Keeps the list bounded by letting go of the oldest finished jobs. Running ones are never dropped. */
  function trim(): void {
    for (const job of jobs.values()) {
      if (jobs.size <= MAX_JOBS) return;
      if (isFinished(job.info.status)) forget(job);
    }
  }

  function known(id: string): Job {
    const job = jobs.get(id);
    if (!job) throw refuse(404, 'not_found', 'There is no such agent job');
    return job;
  }

  // --- identity ---
  function newId(): string {
    let id = randomBytes(4).toString('hex');
    while (jobs.has(id)) id = randomBytes(4).toString('hex');
    return id;
  }

  function nextIdentity(): { name: string; hue: number } {
    const taken = new Set([...reservedNames, ...[...jobs.values()].map((job) => job.info.name)]);
    const position = sequence++;
    // The list from where the last agent left off; once every name is out, a second round with a number.
    let name = '';
    for (let round = 1; name === ''; round++) {
      const candidates = NAMES.map((_, index) => NAMES[(position + index) % NAMES.length] as string);
      name = candidates.map((candidate) => (round === 1 ? candidate : `${candidate} ${round}`)).find((candidate) => !taken.has(candidate)) ?? '';
    }
    return { name, hue: Math.round(FIRST_HUE + position * GOLDEN_ANGLE) % 360 };
  }

  /** An empty project for a job that was started without one: a folder with a README, so there is something to clone. */
  async function makeScratchProject(agentName: string): Promise<string> {
    const wanted = `scratch-${agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    for (let suffix = 1; ; suffix++) {
      const name = suffix === 1 ? wanted : `${wanted}-${suffix}`;
      const abs = resolveInHome(home, `${PROJECTS}/${name}`);
      try {
        await fsp.mkdir(abs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      await fsp.writeFile(path.join(abs, 'README.md'), `# Scratch project of ${agentName}\n\nMade for an agent job that was started without a project.\n`);
      return `${PROJECTS}/${name}`;
    }
  }

  // --- attachments ---
  interface Attachment {
    /** Home relative path of the original. */
    rel: string;
    abs: string;
  }

  /** Checks that a home relative path names a file the server may read. */
  async function attachmentAt(rel: unknown): Promise<Attachment> {
    if (typeof rel !== 'string' || rel === '') throw badRequest('An attachment is the path of a file in the home folder');
    const abs = resolveInHome(home, rel);
    const stat = await fsp.stat(abs).catch(() => undefined);
    if (!stat) throw refuse(404, 'not_found', `There is no file at ${rel}`);
    if (!stat.isFile()) throw refuse(400, 'not_a_file', `${rel} is not a file`);
    return { rel: toRel(home, abs), abs };
  }

  /** Copies a file into the job's workspace and says so in the stream. Returns the copy's workspace relative path. */
  async function copyIn(job: Job, attachment: Attachment): Promise<string> {
    const name = path.basename(attachment.abs);
    const copyRel = `${job.info.workspace.path}/${ATTACHMENTS}/${name}`;
    // Through the guard again: the agent owns this folder and could have put a link where the copy goes.
    const copyAbs = resolveInHome(home, copyRel);
    await fsp.mkdir(path.dirname(copyAbs), { recursive: true });
    await fsp.copyFile(attachment.abs, copyAbs);
    addEvent(job, { kind: 'status', text: `attached ${name}`, path: copyRel });
    if (!job.info.attachments.includes(attachment.rel)) change(job, { attachments: [...job.info.attachments, attachment.rel] });
    return `${ATTACHMENTS}/${name}`;
  }

  // --- running ---
  function startRunner(runner: AgentRunner, request: RunRequest): Run {
    if (runner === 'demo') return runDemo(request, { speed: config.demoSpeed });
    return runClaude(request, { command: config.claudeCommand, extraArgs: config.claudeArgs, token: config.token });
  }

  function finish(job: Job, outcome: RunOutcome): void {
    const status: AgentStatus = outcome.exitCode === 0 ? 'done' : job.stopRequested ? 'stopped' : 'failed';
    const error = status === 'failed' ? (outcome.error ?? 'The agent ended without saying why') : undefined;
    if (status === 'stopped') addEvent(job, { kind: 'status', text: 'stopped' });
    if (error !== undefined) addEvent(job, { kind: 'error', text: error });
    delete job.run;
    change(job, { status, endedAt: Date.now(), exitCode: outcome.exitCode, ...(error === undefined ? {} : { error }) });
    save();
  }

  /** The life of a job after its request was answered: attachments, the run, and its final status. */
  async function carryOut(job: Job, attachments: Attachment[], resumeSession: string | undefined): Promise<void> {
    const workspace = job.info.workspace;
    const cwd = resolveInHome(home, workspace.path);
    const copies: string[] = [];
    for (const attachment of attachments) copies.push(await copyIn(job, attachment));
    job.cloned = await filesBelow(cwd, home);
    if (job.stopRequested) return finish(job, { exitCode: null });

    const run = startRunner(job.info.runner, {
      prompt: job.info.prompt,
      agentName: job.info.name,
      cwd,
      attachments: copies,
      ...(resumeSession === undefined ? {} : { resumeSession }),
      // A runner that is being stopped may still have output on its way; the user asked for silence.
      emit: (event) => {
        if (job.run === run && !job.stopRequested) addEvent(job, event);
      },
      onSession: (sessionId) => void (job.sessionId = sessionId),
    });
    job.run = run;
    addEvent(job, { kind: 'status', text: `started in ${workspace.path}` });
    change(job, { status: 'running' });
    save();

    const outcome = await run.finished;
    if (outcome.exitCode === 0 && !job.stopRequested) await sleep(SETTLE_MS);
    finish(job, outcome);
  }

  // --- the service ---
  async function start(request: StartAgentRequest): Promise<AgentInfo> {
    if (closing) throw refuse(409, 'conflict', 'The server is shutting down');
    const { prompt, project, continueFrom } = request;
    if (typeof prompt !== 'string' || prompt.trim() === '') throw badRequest('An agent job needs a prompt');
    if (prompt.length > MAX_PROMPT_CHARS) throw badRequest(`A prompt can be up to ${MAX_PROMPT_CHARS} characters`);
    if (project !== undefined && typeof project !== 'string') throw badRequest('project is the path of a folder under Projects/');
    if (continueFrom !== undefined && typeof continueFrom !== 'string') throw badRequest('continueFrom is the id of an earlier job');
    if (request.runner !== undefined && !RUNNERS.includes(request.runner)) throw badRequest('runner is "claude" or "demo"');
    if (request.attachments !== undefined && !Array.isArray(request.attachments)) throw badRequest('attachments is a list of paths');
    const attachments: Attachment[] = [];
    for (const rel of request.attachments ?? []) attachments.push(await attachmentAt(rel));
    const runner = request.runner ?? (await detectRunner(config)).available;

    const id = newId();
    let identity: { name: string; hue: number };
    let workspace: Workspace;
    let resumeSession: string | undefined;
    if (continueFrom === undefined) {
      identity = nextIdentity();
      reservedNames.add(identity.name);
      try {
        const from = project ?? (await makeScratchProject(identity.name));
        workspace = await workspaces.create({ project: from, label: identity.name, agentId: id });
      } finally {
        reservedNames.delete(identity.name);
      }
    } else {
      // A follow-up is the same agent picking its work up again: same name, same colour, same folder.
      const earlier = known(continueFrom);
      const current = workspaces.get(earlier.info.workspace.id);
      if (!current) throw refuse(409, 'conflict', 'The workspace of that job is gone');
      const busy = [...jobs.values()].some((job) => job.info.workspace.id === current.id && !isFinished(job.info.status));
      if (busy) throw refuse(409, 'conflict', 'An agent is still working in that workspace');
      identity = { name: earlier.info.name, hue: earlier.info.hue };
      workspace = workspaces.setAgent(current.id, id) ?? current;
      resumeSession = earlier.sessionId;
    }

    const job: Job = {
      info: {
        id,
        ...identity,
        prompt,
        status: 'starting',
        runner,
        startedAt: Date.now(),
        workspace,
        filesTouched: [],
        attachments: [],
        events: 0,
        ...(continueFrom === undefined ? {} : { continues: continueFrom }),
      },
      events: [],
      ...(resumeSession === undefined ? {} : { sessionId: resumeSession }),
      stopRequested: false,
      ended: Promise.resolve(),
      cloned: new Set(),
    };
    jobs.set(job.info.id, job);
    const answer = change(job, {});
    trim();
    save();
    job.ended = carryOut(job, attachments, resumeSession).catch((error: Error) => {
      // Nothing the runners report ends up here; this is the server failing to set the run up.
      console.error(`SpecOS agent job ${job.info.id} failed: ${error.message}`);
      finish(job, { exitCode: null, error: 'The job could not be started' });
    });
    return answer;
  }

  async function stop(id: string): Promise<AgentInfo> {
    const job = known(id);
    if (!isFinished(job.info.status)) {
      job.stopRequested = true;
      job.run?.stop();
      await job.ended;
    }
    return job.info;
  }

  const service: AgentsService = {
    start,
    list: () => [...jobs.values()].map((job) => job.info),
    get: (id) => jobs.get(id)?.info,
    stop,
    async attach(id, relPath) {
      const job = known(id);
      await copyIn(job, await attachmentAt(relPath));
      if (isFinished(job.info.status)) save();
      return job.info;
    },
    remove(id) {
      const job = known(id);
      if (!isFinished(job.info.status)) throw refuse(409, 'conflict', 'Stop the job before removing it');
      forget(job);
      save();
    },
    events: (id, since) => known(id).events.filter((event) => event.seq > since),
    runningCount: () => [...jobs.values()].filter((job) => !isFinished(job.info.status)).length,
  };
  ctx.agents = service;

  // --- reload: the history of the last run ---
  const registry = readRegistry(registryFile);
  sequence = registry.sequence;
  for (const stored of registry.jobs.slice(-MAX_JOBS)) {
    // Whatever was running when the server went down did not survive it.
    const interrupted: Partial<AgentInfo> = isFinished(stored.info.status)
      ? {}
      : { status: 'failed', error: 'server restarted', endedAt: Date.now(), exitCode: null };
    const workspace = workspaces.get(stored.info.workspace.id) ?? stored.info.workspace;
    jobs.set(stored.info.id, {
      info: { ...stored.info, ...interrupted, workspace },
      events: stored.events.slice(-MAX_EVENTS),
      ...(stored.sessionId === undefined ? {} : { sessionId: stored.sessionId }),
      stopRequested: false,
      ended: Promise.resolve(),
      cloned: new Set(),
    });
  }

  // --- what the rest of the server tells the jobs ---

  /** The job that is at work in a workspace right now. */
  const runningIn = (workspaceId: string): Job | undefined =>
    [...jobs.values()].find((job) => job.info.workspace.id === workspaceId && job.info.status === 'running');

  function noteChange(entry: ActivityEntry): void {
    if (entry.isDir || entry.workspaceId === undefined) return;
    const job = runningIn(entry.workspaceId);
    if (!job) return;
    // Seen once, a cloned file is like any other: deleting it and writing it again is the agent's doing.
    if (job.cloned.delete(entry.path) && entry.kind === 'add') return;
    const before = job.info.filesTouched.find((file) => file.path === entry.path);
    const touched: TouchedFile = { path: entry.path, kind: entry.kind, at: entry.at, count: (before?.count ?? 0) + 1 };
    addEvent(job, { kind: 'file', path: entry.path, change: entry.kind });
    change(job, { filesTouched: [...job.info.filesTouched.filter((file) => file !== before), touched] });
  }
  const stopListening = [
    ctx.activity?.onEntry(noteChange),
    // A job shows its workspace; when that is merged or handed to a follow-up, the job's copy follows.
    ctx.bus.on((event) => {
      if (event.type !== 'workspace') return;
      for (const job of jobs.values()) {
        if (job.info.workspace.id !== event.workspace.id) continue;
        change(job, { workspace: event.workspace });
        if (isFinished(job.info.status)) save();
      }
    }),
  ];

  // Whoever writes in a workspace is taken for its agent, also after the job has ended.
  ctx.activity?.setActorResolver((rel) => {
    const agentId = workspaces.findByPath(rel)?.agentId;
    const agent = agentId === undefined ? undefined : jobs.get(agentId)?.info;
    return agent && { type: 'agent', agentId: agent.id, name: agent.name, hue: agent.hue };
  });

  ctx.onClose(async () => {
    closing = true;
    for (const unsubscribe of stopListening) unsubscribe?.();
    await Promise.all([...jobs.keys()].map((id) => stop(id)));
    await saved;
  });

  // --- routes ---
  await app.register(async (api) => {
    api.setErrorHandler(refusalHandler('agent job'));
    const idOf = (request: { params: unknown }): string => (request.params as { id: string }).id;

    for (const url of ['/api/agents', '/agents']) {
      api.post(url, async (request, reply): Promise<AgentInfo> => {
        // start() checks every field itself, so the unchecked body can be handed over as it is.
        const body = bodyOf<StartAgentRequest>(request.body) as StartAgentRequest;
        return reply.code(201).send(await service.start(body));
      });
    }

    api.get('/api/agents', async (): Promise<AgentsResponse> => ({ agents: service.list(), runner: await detectRunner(config) }));

    api.get('/api/agents/:id', async (request): Promise<AgentInfo> => known(idOf(request)).info);

    api.get('/api/agents/:id/events', async (request): Promise<AgentEventsResponse> => {
      const { since = '0' } = request.query as { since?: unknown };
      if (typeof since !== 'string' || !/^\d+$/.test(since)) throw badRequest('since is the number of the last event already seen');
      return { events: service.events(idOf(request), Number(since)) };
    });

    api.post('/api/agents/:id/stop', (request): Promise<AgentInfo> => service.stop(idOf(request)));

    api.post('/api/agents/:id/attach', async (request): Promise<AgentInfo> => {
      const { path: relPath } = bodyOf<AttachRequest>(request.body);
      return service.attach(idOf(request), relPath as string);
    });

    api.delete('/api/agents/:id', async (request): Promise<OkResponse> => {
      service.remove(idOf(request));
      return { ok: true };
    });
  });
}
