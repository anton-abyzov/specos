import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { claudeArguments, claudeEnv, parseClaudeLine, runClaude } from '../../server/src/runners/claude';
import type { RunnerEvent, RunRequest } from '../../server/src/runners/runner';
import type {
  ActivityEntry,
  ActivityListResponse,
  AgentEventsResponse,
  AgentInfo,
  AgentsResponse,
  AgentStreamEvent,
  ApiError,
  MergeResult,
  ServerEvent,
  StartAgentRequest,
} from '../../shared/protocol';
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers';

/** The demo agent's pace in most tests: a whole run takes about a seventh of a second. */
const FAST = 50;
/** Slow enough that a test can act while the agent is still at work. */
const SLOW = 4;

/**
 * A stand-in for the claude CLI, so the runner is tested with a real process
 * and without a model. It speaks the same stream of JSON lines and picks its
 * behaviour from a word in the prompt.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
const say = (line) => process.stdout.write(JSON.stringify(line) + '\\n');
const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const resumed = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : undefined;
say({ type: 'system', subtype: 'init', session_id: resumed ? resumed + '+' : 'session-one', cwd: process.cwd() });
if (prompt.includes('fail')) {
  process.stderr.write('boom: out of credit\\n');
  process.exit(3);
}
if (prompt.includes('stubborn')) process.on('SIGTERM', () => {});
if (prompt.includes('hang') || prompt.includes('stubborn')) {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  say(delta('child ' + child.pid));
  setInterval(() => {}, 1000);
} else {
  const seen = {
    args,
    cwd: process.cwd(),
    env: Object.keys(process.env).filter((name) => /SPECOS|CLAUDE|LEAK/.test(name)).sort(),
  };
  fs.writeFileSync('made-by-claude.txt', 'hello\\n');
  say(delta('Hel'));
  say(delta('lo'));
  say({ type: 'assistant', message: { content: [
    { type: 'text', text: JSON.stringify(seen) },
    { type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: process.cwd() + '/made-by-claude.txt', content: 'hello' } },
  ] } });
  setTimeout(() => say({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, num_turns: 2, total_cost_usd: 0.0123, result: 'Hello' }), 150);
}
`;

let server: TestServer;
let slow: TestServer;
let scratch: string;
let fakeClaude: string;

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'specos-agents-'));
  fakeClaude = path.join(scratch, 'claude');
  fs.writeFileSync(fakeClaude, FAKE_CLAUDE, { mode: 0o755 });
  [server, slow] = await Promise.all([
    startTestServer({ demoSpeed: FAST, claudeCommand: fakeClaude }),
    startTestServer({ demoSpeed: SLOW }),
  ]);
});
afterAll(async () => {
  await Promise.all([server.close(), slow.close()]);
  fs.rmSync(scratch, { recursive: true, force: true });
});

const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.terminate();
});

// ---------------------------------------------------------------- helpers

const NOTE = '# Note\n\nThe first line.\n';

let projectCount = 0;
/** A fresh project with one note, so no test depends on what another left behind. */
function makeProject(target: TestServer = server): { rel: string; note: string } {
  const name = `notes-${++projectCount}`;
  const abs = path.join(target.home, 'Projects', name);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'note.md'), NOTE);
  return { rel: `Projects/${name}`, note: path.join(abs, 'note.md') };
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function startAgent(request: StartAgentRequest, target: TestServer = server): Promise<AgentInfo> {
  const response = await target.fetch('/api/agents', json(request));
  expect(response.status).toBe(201);
  return (await response.json()) as AgentInfo;
}

async function agent(id: string, target: TestServer = server): Promise<AgentInfo> {
  const response = await target.fetch(`/api/agents/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as AgentInfo;
}

async function eventsOf(id: string, since?: number, target: TestServer = server): Promise<AgentStreamEvent[]> {
  const response = await target.fetch(`/api/agents/${id}/events${since === undefined ? '' : `?since=${since}`}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as AgentEventsResponse).events;
}

/** Polls until `probe` returns something, because agents work in their own time. */
async function until<T>(probe: () => Promise<T | undefined | false> | T | undefined | false, what: string): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const found = await probe();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const ended = (id: string, target: TestServer = server): Promise<AgentInfo> =>
  until(async () => {
    const info = await agent(id, target);
    return info.endedAt !== undefined && info;
  }, `job ${id} to end`);

/** Collects every frame of an events socket from the moment it exists, and waits for its greeting. */
function openEvents(target: TestServer = server): Promise<ServerEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ServerEvent[] = [];
    const socket = new WebSocket(target.wsUrl + '/ws', { headers: { cookie: target.cookie, origin: target.url } });
    sockets.push(socket);
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      events.push(event);
      if (event.type === 'hello') resolve(events);
    });
    socket.once('error', reject);
  });
}

async function activity(target: TestServer = server): Promise<ActivityEntry[]> {
  const response = await target.fetch('/api/activity?limit=1000');
  return ((await response.json()) as ActivityListResponse).entries;
}

const inHome = (rel: string, target: TestServer = server): string => path.join(target.home, rel);
const read = (file: string): string => fs.readFileSync(file, 'utf8');
const linesBy = (name: string, text: string): string[] => text.split('\n').filter((line) => line.startsWith(`- ${name} (`));

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- starting

// Each of these runs a whole job in a project of its own, so they can share the clock.
describe.concurrent('starting a job', () => {
  test('POST /agents answers at once with a job that is starting in its own workspace', async () => {
    const project = makeProject();

    const response = await server.fetch('/agents', json({ prompt: 'Add a summary to note.md', project: project.rel }));

    expect(response.status).toBe(201);
    const info = (await response.json()) as AgentInfo;
    expect(info).toMatchObject({
      prompt: 'Add a summary to note.md',
      status: 'starting',
      runner: 'demo',
      filesTouched: [],
      attachments: [],
      events: 0,
    });
    expect(info.id).toMatch(/^[0-9a-f]{8}$/);
    expect(info.name).toMatch(/^[A-Z][a-z]+$/);
    expect(Number.isInteger(info.hue) && info.hue >= 0 && info.hue < 360).toBe(true);
    expect(info.endedAt).toBeUndefined();
    expect(info.workspace.path).toBe(`Workspaces/${path.basename(project.rel)}-${info.name.toLowerCase()}`);
    expect(info.workspace).toMatchObject({ project: project.rel, agentId: info.id, status: 'active' });
    expect(fs.existsSync(inHome(`${info.workspace.path}/note.md`))).toBe(true);
    // Answered before the run: the note is still as the project has it.
    expect(read(inHome(`${info.workspace.path}/note.md`))).toBe(NOTE);

    expect((await ended(info.id)).status).toBe('done');
  });

  test('the job is listed, together with the runner this server uses', async () => {
    const info = await startAgent({ prompt: 'List me', project: makeProject().rel });

    const { agents, runner } = (await (await server.fetch('/api/agents')).json()) as AgentsResponse;

    expect(agents.map((entry) => entry.id)).toContain(info.id);
    expect(runner).toEqual({ available: 'demo' });
    await ended(info.id);
  });

  test('the list announces the names and colours the next jobs will get', async () => {
    const own = await startTestServer({ demoSpeed: FAST });
    try {
      const before = (await (await own.fetch('/api/agents')).json()) as AgentsResponse;
      expect(before.upcoming).toHaveLength(6);
      expect(new Set(before.upcoming!.map((identity) => identity.name)).size).toBe(6);

      const first = await startAgent({ prompt: 'First' }, own);
      const second = await startAgent({ prompt: 'Second' }, own);
      expect({ name: first.name, hue: first.hue }).toEqual(before.upcoming![0]);
      expect({ name: second.name, hue: second.hue }).toEqual(before.upcoming![1]);

      const after = (await (await own.fetch('/api/agents')).json()) as AgentsResponse;
      expect(after.upcoming![0]).toEqual(before.upcoming![2]);
      await ended(first.id, own);
      await ended(second.id, own);
    } finally {
      await own.close();
    }
  });

  test('without a project the agent gets an empty scratch project of its own', async () => {
    const info = await startAgent({ prompt: 'Think about names for a boat' });

    expect(info.workspace.project).toBe(`Projects/scratch-${info.name.toLowerCase()}`);
    expect(read(inHome(`${info.workspace.project}/README.md`))).toContain(info.name);
    const done = await ended(info.id);
    expect(done.status).toBe('done');
    // The first note in the workspace is the README, so that is where the agent writes.
    expect(linesBy(info.name, read(inHome(`${info.workspace.path}/README.md`))).length).toBeGreaterThanOrEqual(4);
    expect(linesBy(info.name, read(inHome(`${info.workspace.project}/README.md`)))).toEqual([]);
  });

  test('a workspace with no note at all gets NOTES.md', async () => {
    const name = `empty-${++projectCount}`;
    fs.mkdirSync(inHome(`Projects/${name}`));
    fs.writeFileSync(inHome(`Projects/${name}/data.json`), '{}\n');

    const info = await startAgent({ prompt: 'Write down what you find', project: `Projects/${name}` });
    const done = await ended(info.id);

    const notes = read(inHome(`${info.workspace.path}/NOTES.md`));
    expect(notes.startsWith(`# Notes by ${info.name}\n`)).toBe(true);
    expect(linesBy(info.name, notes).length).toBeGreaterThanOrEqual(4);
    expect(done.filesTouched.map((file) => file.path)).toEqual([`${info.workspace.path}/NOTES.md`]);
    expect(read(inHome(`${info.workspace.path}/data.json`))).toBe('{}\n');
  });

  test('a prompt of exactly 20000 characters is accepted', async () => {
    const info = await startAgent({ prompt: 'y'.repeat(20_000), project: makeProject().rel });

    expect((await ended(info.id)).status).toBe('done');
  });

});

describe('requests that are refused', () => {
  test.each([
    ['no prompt', {}, 400, 'bad_request'],
    ['an empty prompt', { prompt: '   ' }, 400, 'bad_request'],
    ['a prompt that is not text', { prompt: 42 }, 400, 'bad_request'],
    ['a prompt over 20000 characters', { prompt: 'x'.repeat(20_001) }, 400, 'bad_request'],
    ['an unknown runner', { prompt: 'hi', runner: 'gpt' }, 400, 'bad_request'],
    ['a project that does not exist', { prompt: 'hi', project: 'Projects/nowhere' }, 404, 'not_found'],
    ['a project outside Projects', { prompt: 'hi', project: 'Workspaces' }, 400, 'bad_request'],
    ['a project path that leaves home', { prompt: 'hi', project: '../outside' }, 403, 'path_escape'],
    ['attachments that are not a list', { prompt: 'hi', attachments: 'note.md' }, 400, 'bad_request'],
    ['an attachment that does not exist', { prompt: 'hi', attachments: ['nothing.txt'] }, 404, 'not_found'],
    ['an attachment that is a folder', { prompt: 'hi', attachments: ['Projects'] }, 400, 'not_a_file'],
    ['an attachment that leaves home', { prompt: 'hi', attachments: ['../../etc/passwd'] }, 403, 'path_escape'],
    ['a job to continue that does not exist', { prompt: 'hi', continueFrom: 'nope0000' }, 404, 'not_found'],
  ])('%s is refused', async (_what, body, status, code) => {
    const before = ((await (await server.fetch('/api/agents')).json()) as AgentsResponse).agents.length;

    const response = await server.fetch('/api/agents', json(body));

    expect(response.status).toBe(status);
    expect(((await response.json()) as ApiError).code).toBe(code);
    expect(((await (await server.fetch('/api/agents')).json()) as AgentsResponse).agents).toHaveLength(before);
  });

  test('both addresses are closed to a request without the session', async () => {
    for (const address of ['/agents', '/api/agents']) {
      const response = await fetch(server.url + address, json({ prompt: 'let me in' }));
      expect(response.status).toBe(401);
    }
  });

  test('an unknown job is 404 everywhere', async () => {
    const responses = await Promise.all([
      server.fetch('/api/agents/nope0000'),
      server.fetch('/api/agents/nope0000/events'),
      server.fetch('/api/agents/nope0000/stop', { method: 'POST' }),
      server.fetch('/api/agents/nope0000/attach', json({ path: 'x' })),
      server.fetch('/api/agents/nope0000', { method: 'DELETE' }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
  });
});

// ---------------------------------------------------------------- two agents

describe('two agents on the same project', () => {
  let project: { rel: string; note: string };
  let frames: ServerEvent[];
  let first: AgentInfo;
  let second: AgentInfo;

  beforeAll(async () => {
    project = makeProject();
    frames = await openEvents();
    const started = await Promise.all([
      startAgent({ prompt: 'Add a summary to note.md', project: project.rel }),
      startAgent({ prompt: 'List open questions in note.md', project: project.rel }),
    ]);
    [first, second] = (await Promise.all(started.map((info) => ended(info.id)))) as [AgentInfo, AgentInfo];
  });

  const streamOf = (id: string): AgentStreamEvent[] =>
    frames.flatMap((frame) => (frame.type === 'agent-event' && frame.id === id ? [frame.event] : []));

  test('they get different names, colours and workspaces', () => {
    expect(first.id).not.toBe(second.id);
    expect(first.name).not.toBe(second.name);
    expect(first.hue).not.toBe(second.hue);
    // Neighbours on the list are far apart on the colour wheel.
    const apart = Math.abs(first.hue - second.hue);
    expect(Math.min(apart, 360 - apart)).toBeGreaterThan(90);
    expect(first.workspace.id).not.toBe(second.workspace.id);
    expect(first.workspace.path).not.toBe(second.workspace.path);
    expect(first.workspace.path.startsWith('Workspaces/')).toBe(true);
    expect(second.workspace.path.startsWith('Workspaces/')).toBe(true);
  });

  test('both finish done, with the time and the exit code', () => {
    for (const info of [first, second]) {
      expect(info).toMatchObject({ status: 'done', exitCode: 0 });
      expect(info.endedAt).toBeGreaterThanOrEqual(info.startedAt);
      expect(info.error).toBeUndefined();
    }
  });

  test('each edits the note in its own workspace and the project keeps its copy', () => {
    const firstNote = read(inHome(`${first.workspace.path}/note.md`));
    const secondNote = read(inHome(`${second.workspace.path}/note.md`));

    for (const [info, note, other] of [[first, firstNote, second], [second, secondNote, first]] as const) {
      expect(note.startsWith(NOTE)).toBe(true);
      const lines = linesBy(info.name, note);
      expect(lines.length).toBeGreaterThanOrEqual(4);
      expect(lines.length).toBeLessThanOrEqual(6);
      expect(lines.every((line) => line.includes(info.prompt))).toBe(true);
      expect(linesBy(other.name, note)).toEqual([]);
    }
    expect(firstNote).not.toBe(secondNote);
    expect(read(project.note)).toBe(NOTE);
  });

  test('the reply arrives on the events socket as text, word by word', () => {
    for (const info of [first, second]) {
      const stream = streamOf(info.id);
      const chunks = stream.filter((event) => event.kind === 'text');
      expect(chunks.length).toBeGreaterThan(20);
      const messages = stream.filter((event) => event.kind === 'message');
      expect(messages).toHaveLength(2);
      // The chunks rebuild the messages; each message then states the whole block again.
      expect(chunks.map((chunk) => chunk.text).join('')).toBe(messages.map((message) => message.text + ' ').join(''));
      expect(messages[0]?.text).toContain(`I am ${info.name}`);
    }
  });

  test('the stream also carries tools, file changes and a result, numbered in order', () => {
    for (const info of [first, second]) {
      const stream = streamOf(info.id);
      expect(stream.map((event) => event.seq)).toEqual(stream.map((_, index) => index + 1));
      expect(stream.filter((event) => event.kind === 'tool').map((event) => `${event.tool} ${event.summary}`)).toEqual([
        'List files in the workspace',
        'Read note.md',
        'Edit note.md',
      ]);
      const files = stream.filter((event) => event.kind === 'file');
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((event) => event.path === `${info.workspace.path}/note.md` && event.change === 'change')).toBe(true);
      expect(stream.filter((event) => event.kind === 'result')).toHaveLength(1);
      expect(stream[0]).toMatchObject({ kind: 'status', text: `started in ${info.workspace.path}` });
      expect(info.events).toBe(stream.length);
    }
  });

  test('every change of state is announced: starting, running, done', () => {
    for (const info of [first, second]) {
      const statuses = frames.flatMap((frame) => (frame.type === 'agent' && frame.agent.id === info.id ? [frame.agent.status] : []));
      const inOrder = statuses.filter((status, index) => status !== statuses[index - 1]);
      expect(inOrder).toEqual(['starting', 'running', 'done']);
    }
  });

  test('filesTouched lists the edited file with a home relative path', () => {
    for (const info of [first, second]) {
      expect(info.filesTouched).toHaveLength(1);
      const [touched] = info.filesTouched;
      expect(touched).toMatchObject({ path: `${info.workspace.path}/note.md`, kind: 'change' });
      expect(touched?.count).toBeGreaterThanOrEqual(1);
      expect(touched?.at).toBeGreaterThanOrEqual(info.startedAt);
      expect(fs.existsSync(inHome(touched?.path ?? ''))).toBe(true);
    }
  });

  test('the journal names each agent as the author of its edits', async () => {
    const entries = await activity();
    for (const info of [first, second]) {
      const edits = entries.filter((entry) => entry.path === `${info.workspace.path}/note.md` && entry.kind === 'change');
      expect(edits.length).toBeGreaterThan(0);
      for (const edit of edits) {
        expect(edit.actor).toEqual({ type: 'agent', agentId: info.id, name: info.name, hue: info.hue });
        expect(edit.workspaceId).toBe(info.workspace.id);
      }
    }
  });

  test('events replay from any point with since', async () => {
    const all = await eventsOf(first.id);
    expect(all.map((event) => event.seq)).toEqual(all.map((_, index) => index + 1));
    expect(all).toEqual(streamOf(first.id));

    const tail = await eventsOf(first.id, 10);
    expect(tail).toEqual(all.slice(10));
    expect(await eventsOf(first.id, all.length)).toEqual([]);
    expect(await eventsOf(first.id, 0)).toEqual(all);

    const refused = await server.fetch(`/api/agents/${first.id}/events?since=soon`);
    expect(refused.status).toBe(400);
  });

  test("merging one back names the agent in the commit and in the project's journal", async () => {
    const response = await server.fetch(`/api/workspaces/${first.workspace.id}/merge`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(((await response.json()) as MergeResult).files).toEqual(['note.md']);
    expect(linesBy(first.name, read(project.note)).length).toBeGreaterThanOrEqual(4);
    const log = execFileSync('git', ['log', '--format=%s', '-3'], { cwd: inHome(project.rel), encoding: 'utf8' });
    expect(log).toContain(`Work by ${first.name}`);
    const entry = await until(
      async () => (await activity()).find((candidate) => candidate.path === `${project.rel}/note.md` && candidate.actor.type === 'merge'),
      'the merge in the journal',
    );
    expect(entry.actor).toEqual({ type: 'merge', agentId: first.id, name: first.name, hue: first.hue });
    // The job shows its workspace as it is now.
    expect((await agent(first.id)).workspace.status).toBe('merged');
    expect((await agent(second.id)).workspace.status).toBe('active');
  });
});

// ---------------------------------------------------------------- stopping

describe('stopping and removing', () => {
  test('stop ends a running job as stopped, and nothing follows', async () => {
    const project = makeProject(slow);
    const info = await startAgent({ prompt: 'Take your time with note.md', project: project.rel }, slow);
    await until(async () => (await eventsOf(info.id, 0, slow)).some((event) => event.kind === 'text'), 'the first words');

    const response = await slow.fetch(`/api/agents/${info.id}/stop`, { method: 'POST' });

    expect(response.status).toBe(200);
    const stopped = (await response.json()) as AgentInfo;
    expect(stopped).toMatchObject({ status: 'stopped', exitCode: null });
    expect(stopped.endedAt).toBeGreaterThanOrEqual(stopped.startedAt);
    const events = await eventsOf(info.id, 0, slow);
    expect(events.at(-1)).toMatchObject({ kind: 'status', text: 'stopped' });
    expect(events.some((event) => event.kind === 'result')).toBe(false);
    const note = read(inHome(`${info.workspace.path}/note.md`, slow));

    // Several times the pace at which the agent wrote: anything still scheduled would have shown by now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await eventsOf(info.id, 0, slow)).toEqual(events);
    expect(read(inHome(`${info.workspace.path}/note.md`, slow))).toBe(note);
    expect(await agent(info.id, slow)).toEqual(stopped);
    expect(slow.specos.ctx.agents?.runningCount()).toBe(0);
  });

  test('stopping a job that has ended leaves it as it is', async () => {
    const info = await startAgent({ prompt: 'Quick one', project: makeProject().rel });
    const done = await ended(info.id);

    const response = await server.fetch(`/api/agents/${info.id}/stop`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(done);
  });

  test('DELETE refuses a running job, and forgets a finished one without touching its workspace', async () => {
    const frames = await openEvents(slow);
    const info = await startAgent({ prompt: 'Still busy', project: makeProject(slow).rel }, slow);
    expect(slow.specos.ctx.agents?.runningCount()).toBe(1);

    const refused = await slow.fetch(`/api/agents/${info.id}`, { method: 'DELETE' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as ApiError).code).toBe('conflict');
    expect((await agent(info.id, slow)).endedAt).toBeUndefined();

    await slow.fetch(`/api/agents/${info.id}/stop`, { method: 'POST' });
    const removed = await slow.fetch(`/api/agents/${info.id}`, { method: 'DELETE' });

    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await slow.fetch(`/api/agents/${info.id}`)).status).toBe(404);
    expect(fs.existsSync(inHome(`${info.workspace.path}/note.md`, slow))).toBe(true);
    expect(slow.specos.ctx.workspaces?.get(info.workspace.id)).toBeDefined();
    await until(() => frames.some((frame) => frame.type === 'agent-removed' && frame.id === info.id), 'the removal on the socket');
  });

  test('no two listed agents share a name, except a follow-up and the job it continues', async () => {
    const listed = ((await (await server.fetch('/api/agents')).json()) as AgentsResponse).agents;
    const names = listed.filter((info) => info.continues === undefined).map((info) => info.name);

    expect(names.length).toBeGreaterThan(5);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------- attachments

describe('attachments', () => {
  test('a file given with the job is copied into the workspace before the run and worked on there', async () => {
    fs.writeFileSync(inHome('brief.md'), '# Brief\n\nMake it short.\n');
    const project = makeProject();

    const info = await startAgent({ prompt: 'Follow the brief', project: project.rel, attachments: ['brief.md'] });
    const done = await ended(info.id);

    expect(done.status).toBe('done');
    expect(done.attachments).toEqual(['brief.md']);
    const copy = `${info.workspace.path}/attachments/brief.md`;
    const events = await eventsOf(info.id);
    expect(events[0]).toMatchObject({ kind: 'status', text: 'attached brief.md', path: copy });
    expect(events[1]).toMatchObject({ kind: 'status', text: `started in ${info.workspace.path}` });
    // The attachment is the agent's first target, the note its second; the original is only read.
    expect(read(inHome(copy)).startsWith('# Brief\n\nMake it short.\n')).toBe(true);
    expect(linesBy(info.name, read(inHome(copy))).length).toBeGreaterThanOrEqual(4);
    expect(linesBy(info.name, read(inHome(`${info.workspace.path}/note.md`))).length).toBeGreaterThanOrEqual(4);
    expect(read(inHome('brief.md'))).toBe('# Brief\n\nMake it short.\n');
    expect(done.filesTouched.map((file) => file.path).sort()).toEqual([copy, `${info.workspace.path}/note.md`]);
  });

  test('POST attach copies a file into a running job and says so in the stream', async () => {
    fs.writeFileSync(inHome('late.txt', slow), 'arrived late\n');
    const info = await startAgent({ prompt: 'Start without it', project: makeProject(slow).rel }, slow);
    await until(async () => (await agent(info.id, slow)).status === 'running', 'the job to run');

    const response = await slow.fetch(`/api/agents/${info.id}/attach`, json({ path: 'late.txt' }));

    expect(response.status).toBe(200);
    const attached = (await response.json()) as AgentInfo;
    expect(attached.attachments).toEqual(['late.txt']);
    const copy = `${info.workspace.path}/attachments/late.txt`;
    expect(read(inHome(copy, slow))).toBe('arrived late\n');
    const events = await eventsOf(info.id, 0, slow);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'status', text: 'attached late.txt', path: copy }));
    await slow.fetch(`/api/agents/${info.id}/stop`, { method: 'POST' });
  });

  test('POST attach also works after the job has finished, and refuses what is not a file in home', async () => {
    fs.writeFileSync(inHome('after.txt'), 'for the follow-up\n');
    const info = await startAgent({ prompt: 'Finish first', project: makeProject().rel });
    const done = await ended(info.id);

    const response = await server.fetch(`/api/agents/${info.id}/attach`, json({ path: 'after.txt' }));

    expect(response.status).toBe(200);
    const attached = (await response.json()) as AgentInfo;
    expect(attached.attachments).toEqual(['after.txt']);
    expect(attached.status).toBe('done');
    expect(attached.events).toBe(done.events + 1);
    expect(read(inHome(`${info.workspace.path}/attachments/after.txt`))).toBe('for the follow-up\n');
    expect((await eventsOf(info.id)).at(-1)).toMatchObject({ kind: 'status', text: 'attached after.txt' });

    const refusals = await Promise.all([
      server.fetch(`/api/agents/${info.id}/attach`, json({ path: 'missing.txt' })),
      server.fetch(`/api/agents/${info.id}/attach`, json({ path: 'Projects' })),
      server.fetch(`/api/agents/${info.id}/attach`, json({ path: '../outside.txt' })),
      server.fetch(`/api/agents/${info.id}/attach`, json({})),
    ]);
    expect(refusals.map((refusal) => refusal.status)).toEqual([404, 400, 403, 400]);
    expect((await agent(info.id)).attachments).toEqual(['after.txt']);
  });
});

// ---------------------------------------------------------------- follow-ups

describe('continuing a job', () => {
  test('continueFrom reuses the workspace, the name and the colour of the earlier job', async () => {
    const project = makeProject();
    const earlier = await ended((await startAgent({ prompt: 'First pass over note.md', project: project.rel })).id);
    const noteFile = inHome(`${earlier.workspace.path}/note.md`);
    const afterFirst = linesBy(earlier.name, read(noteFile)).length;

    const info = await startAgent({ prompt: 'Second pass over note.md', continueFrom: earlier.id });
    const done = await ended(info.id);

    expect(info.id).not.toBe(earlier.id);
    expect(info).toMatchObject({ continues: earlier.id, name: earlier.name, hue: earlier.hue, status: 'starting' });
    expect(info.workspace).toMatchObject({ id: earlier.workspace.id, path: earlier.workspace.path, agentId: info.id });
    expect(done.status).toBe('done');
    const lines = linesBy(earlier.name, read(noteFile));
    expect(lines.length).toBeGreaterThan(afterFirst);
    expect(lines.some((line) => line.includes('First pass'))).toBe(true);
    expect(lines.some((line) => line.includes('Second pass'))).toBe(true);
    expect(done.filesTouched.map((file) => file.path)).toEqual([`${earlier.workspace.path}/note.md`]);
    // The edits of the follow-up are its own in the journal.
    const latest = (await activity()).find((entry) => entry.path === `${earlier.workspace.path}/note.md`);
    expect(latest?.actor).toMatchObject({ type: 'agent', agentId: info.id });
    expect(server.specos.ctx.workspaces?.list().filter((workspace) => workspace.project === project.rel)).toHaveLength(1);
  });

  test('a job that is still running cannot be continued', async () => {
    const info = await startAgent({ prompt: 'Busy', project: makeProject(slow).rel }, slow);

    const response = await slow.fetch('/api/agents', json({ prompt: 'More', continueFrom: info.id }));

    expect(response.status).toBe(409);
    expect(((await response.json()) as ApiError).code).toBe('conflict');
    await slow.fetch(`/api/agents/${info.id}/stop`, { method: 'POST' });
  });
});

// ---------------------------------------------------------------- restart

describe('after a restart', () => {
  test('finished jobs are still listed with their events, and an interrupted one has failed', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'specos-agents-restart-'));
    const places = { home: path.join(base, 'home'), data: path.join(base, 'data'), demoSpeed: FAST };
    let again: TestServer | undefined;
    const before = await startTestServer(places);
    try {
      fs.mkdirSync(path.join(places.home, 'Projects/notes'), { recursive: true });
      fs.writeFileSync(path.join(places.home, 'Projects/notes/note.md'), NOTE);
      const startedFirst = await startAgent({ prompt: 'Remember me', project: 'Projects/notes' }, before);
      const startedSecond = await startAgent({ prompt: 'Cut short', project: 'Projects/notes' }, before);
      const [done, other] = await Promise.all([ended(startedFirst.id, before), ended(startedSecond.id, before)]);
      const events = await eventsOf(done.id, 0, before);
      await before.close();

      // What a crash in the middle of the second job would have left on disk.
      const registryFile = path.join(places.data, 'agents.json');
      const registry = JSON.parse(read(registryFile)) as { jobs: Array<{ info: AgentInfo }> };
      const cut = registry.jobs.find((job) => job.info.id === other.id)?.info as AgentInfo;
      cut.status = 'running';
      delete cut.endedAt;
      delete cut.exitCode;
      fs.writeFileSync(registryFile, JSON.stringify(registry));

      again = await startTestServer(places);
      const { agents } = (await (await again.fetch('/api/agents')).json()) as AgentsResponse;

      expect(agents.map((info) => info.id)).toEqual([done.id, other.id]);
      expect(agents[0]).toEqual(done);
      expect(await eventsOf(done.id, 0, again)).toEqual(events);
      expect(agents[1]).toMatchObject({ status: 'failed', error: 'server restarted', exitCode: null });
      expect(agents[1]?.endedAt).toBeGreaterThanOrEqual(other.startedAt);
      expect(again.specos.ctx.agents?.runningCount()).toBe(0);

      // The next agent neither takes a listed name nor the colour next to it.
      const next = await startAgent({ prompt: 'After the restart', project: 'Projects/notes' }, again);
      expect([done.name, other.name]).not.toContain(next.name);
      expect([done.hue, other.hue]).not.toContain(next.hue);
      await ended(next.id, again);
    } finally {
      await (again ?? before).close().catch(() => undefined);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('shutting down stops the jobs that are running', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'specos-agents-shutdown-'));
    const places = { home: path.join(base, 'home'), data: path.join(base, 'data'), demoSpeed: SLOW };
    const running = await startTestServer(places);
    try {
      fs.mkdirSync(path.join(places.home, 'Projects/notes'), { recursive: true });
      fs.writeFileSync(path.join(places.home, 'Projects/notes/note.md'), NOTE);
      const info = await startAgent({ prompt: 'Interrupted by shutdown', project: 'Projects/notes' }, running);
      await until(async () => (await agent(info.id, running)).status === 'running', 'the job to run');

      await running.close();

      const registry = JSON.parse(read(path.join(places.data, 'agents.json'))) as { jobs: Array<{ info: AgentInfo }> };
      expect(registry.jobs.map((job) => job.info)).toEqual([expect.objectContaining({ id: info.id, status: 'stopped', exitCode: null })]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- claude: the parser

describe('the claude stream parser', () => {
  // Lines as `claude -p --output-format stream-json --verbose --include-partial-messages` writes them, shortened.
  const INIT =
    '{"type":"system","subtype":"init","cwd":"/home/u/Workspaces/notes-juniper","session_id":"5f2c8a61-0d2e-4f6b-9a57-1c1f0f1f3e11","tools":["Bash","Edit","Read"],"model":"claude-sonnet-4-5","permissionMode":"acceptEdits"}';
  const DELTA =
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I\'ll add"}},"session_id":"5f2c8a61","parent_tool_use_id":null}';
  const ASSISTANT_TEXT =
    '{"type":"assistant","message":{"id":"msg_01","type":"message","role":"assistant","content":[{"type":"text","text":"I\'ll add a summary to the note."}],"usage":{"input_tokens":4}},"session_id":"5f2c8a61"}';
  const RESULT =
    '{"type":"result","subtype":"success","is_error":false,"duration_ms":18342,"duration_api_ms":15200,"num_turns":4,"result":"Added a summary.","session_id":"5f2c8a61","total_cost_usd":0.04217}';
  const cwd = '/home/u/Workspaces/notes-juniper';
  const toolUse = (name: string, input: unknown): string =>
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name, input }] } });

  test('the opening line starts the session and gives its id', () => {
    expect(parseClaudeLine(INIT)).toEqual({
      events: [{ kind: 'status', text: 'session started' }],
      sessionId: '5f2c8a61-0d2e-4f6b-9a57-1c1f0f1f3e11',
    });
  });

  test('a text delta is a chunk of the reply', () => {
    expect(parseClaudeLine(DELTA)).toEqual({ events: [{ kind: 'text', text: "I'll add" }] });
  });

  test('a finished assistant message states its whole text', () => {
    expect(parseClaudeLine(ASSISTANT_TEXT)).toEqual({ events: [{ kind: 'message', text: "I'll add a summary to the note." }] });
  });

  test.each([
    ['Edit', { file_path: `${cwd}/docs/note.md`, old_string: 'a', new_string: 'b' }, 'docs/note.md'],
    ['Read', { file_path: '/etc/hostname' }, '/etc/hostname'],
    ['Bash', { command: 'npm test\n  -- --run', description: 'Run the tests' }, 'npm test -- --run'],
    ['Grep', { pattern: 'TODO', glob: '*.ts' }, 'TODO'],
    ['WebFetch', { url: 'https://example.com/a', prompt: 'summarise' }, 'https://example.com/a'],
    ['TodoWrite', { todos: [{ content: 'x' }] }, ''],
    ['Bash', { command: 'x'.repeat(400) }, 'x'.repeat(139) + '…'],
  ])('a %s call becomes a tool event with a one-line summary', (name, input, summary) => {
    expect(parseClaudeLine(toolUse(name, input), cwd)).toEqual({ events: [{ kind: 'tool', tool: name, summary }] });
  });

  test('text and tool calls of one message come out in their order', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hm' },
          { type: 'text', text: 'Reading first.' },
          { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: `${cwd}/note.md` } },
          { type: 'text', text: '  ' },
          { type: 'tool_use', id: 'b', name: 'Glob', input: { pattern: '**/*.md' } },
        ],
      },
    });

    expect(parseClaudeLine(line, cwd).events).toEqual([
      { kind: 'message', text: 'Reading first.' },
      { kind: 'tool', tool: 'Read', summary: 'note.md' },
      { kind: 'tool', tool: 'Glob', summary: '**/*.md' },
    ]);
  });

  test('the closing line sums the run up: time, turns and cost', () => {
    expect(parseClaudeLine(RESULT)).toEqual({ events: [{ kind: 'result', summary: '18.3 s · 4 turns · $0.0422' }] });
    expect(parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1}').events).toEqual([
      { kind: 'result', summary: '1 turn' },
    ]);
    expect(parseClaudeLine('{"type":"result","subtype":"success"}').events).toEqual([{ kind: 'result', summary: 'finished' }]);
  });

  test('a closing line that reports an error becomes an error event', () => {
    expect(parseClaudeLine('{"type":"result","subtype":"success","is_error":true,"result":"Credit balance is too low"}').events).toEqual([
      { kind: 'error', text: 'Credit balance is too low' },
    ]);
    expect(parseClaudeLine('{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":30}').events).toEqual([
      { kind: 'error', text: 'error max turns' },
    ]);
  });

  test.each([
    ['a tool result', '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"ok"}]}}'],
    ['a hook note', '{"type":"system","subtype":"hook_response","session_id":"5f2c8a61"}'],
    ['the start of a block', '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}'],
    ['a thinking delta', '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}}'],
    ['a tool input delta', '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"fi"}}}'],
    ['a kind from the future', '{"type":"telemetry","value":1}'],
    ['a line that is not JSON', 'Warning: something on stdout'],
    ['an empty line', ''],
    ['JSON that is not an object', '42'],
    ['null', 'null'],
    ['an assistant line without content', '{"type":"assistant","message":{}}'],
  ])('%s becomes nothing', (_what, line) => {
    expect(parseClaudeLine(line)).toEqual({ events: [] });
  });
});

// ---------------------------------------------------------------- claude: the process

describe('the claude command line and environment', () => {
  test('the prompt and the fixed flags come first, then the extra ones, then the session to resume', () => {
    expect(claudeArguments('Fix it', ['--model', 'opus'])).toEqual([
      '-p', 'Fix it', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', 'acceptEdits', '--model', 'opus',
    ]);
    expect(claudeArguments('More', [], 'abc-123').slice(-2)).toEqual(['--resume', 'abc-123']);
  });

  test('the environment loses the token, the SpecOS settings and the marks of a Claude Code session', () => {
    const env = claudeEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        ANTHROPIC_API_KEY: 'sk-key',
        SPECOS_TOKEN: 'secret-token-value',
        SPECOS_HOME: '/srv/home',
        LEAKY_URL: 'http://host/?token=secret-token-value',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SESSION_ID: 'abc',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        CLAUDE_CONFIG_DIR: '/home/u/.claude',
        UNSET: undefined,
      },
      'secret-token-value',
    );

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      ANTHROPIC_API_KEY: 'sk-key',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CONFIG_DIR: '/home/u/.claude',
    });
  });
});

describe('the claude runner, against a stand-in process', () => {
  interface Seen {
    events: RunnerEvent[];
    sessions: string[];
    request: RunRequest;
  }
  function requestFor(prompt: string, resumeSession?: string): Seen {
    const cwd = fs.mkdtempSync(path.join(scratch, 'run-'));
    const seen: Seen = { events: [], sessions: [], request: undefined as unknown as RunRequest };
    seen.request = {
      prompt,
      agentName: 'Juniper',
      cwd,
      attachments: [],
      ...(resumeSession === undefined ? {} : { resumeSession }),
      emit: (event) => void seen.events.push(event),
      onSession: (id) => void seen.sessions.push(id),
    };
    return seen;
  }
  const options = () => ({ command: fakeClaude, extraArgs: ['--model', 'test'], token: TEST_TOKEN });

  /** Variables a Claude Code session and a SpecOS server would have set around the server. */
  const PLANTED = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', SPECOS_TOKEN: TEST_TOKEN, LEAK_OF_TOKEN: `x-${TEST_TOKEN}` };
  const original = Object.fromEntries(Object.keys(PLANTED).map((name) => [name, process.env[name]]));
  beforeAll(() => void Object.assign(process.env, PLANTED));
  afterAll(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test('runs in the workspace with the documented flags and a cleaned environment, and streams what it says', async () => {
    const seen = requestFor('Say hello');

    const outcome = await runClaude(seen.request, options()).finished;

    expect(outcome).toEqual({ exitCode: 0 });
    expect(seen.sessions).toEqual(['session-one']);
    expect(seen.events.map((event) => event.kind)).toEqual(['status', 'text', 'text', 'message', 'tool', 'result']);
    expect(seen.events.filter((event) => event.kind === 'text').map((event) => event.text).join('')).toBe('Hello');
    expect(seen.events[4]).toEqual({ kind: 'tool', tool: 'Write', summary: 'made-by-claude.txt' });
    expect(seen.events[5]).toEqual({ kind: 'result', summary: '1.2 s · 2 turns · $0.0123' });

    const process_ = JSON.parse(seen.events[3]?.text ?? '') as { args: string[]; cwd: string; env: string[] };
    expect(process_.args).toEqual(claudeArguments('Say hello', ['--model', 'test']));
    expect(fs.realpathSync(process_.cwd)).toBe(fs.realpathSync(seen.request.cwd));
    expect(process_.env.filter((name) => /^(SPECOS|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|LEAK)/.test(name))).toEqual([]);
    expect(read(path.join(seen.request.cwd, 'made-by-claude.txt'))).toBe('hello\n');
  });

  test('resumes the session of the job it continues', async () => {
    const seen = requestFor('Go on', 'session-one');

    await runClaude(seen.request, options()).finished;

    expect(seen.sessions).toEqual(['session-one+']);
    const process_ = JSON.parse(seen.events.find((event) => event.kind === 'message')?.text ?? '') as { args: string[] };
    expect(process_.args.slice(-2)).toEqual(['--resume', 'session-one']);
  });

  test('a non-zero exit reports the code and the end of stderr', async () => {
    const seen = requestFor('Please fail');

    const outcome = await runClaude(seen.request, options()).finished;

    expect(outcome).toEqual({ exitCode: 3, error: 'boom: out of credit' });
  });

  test('a missing executable is an outcome, not a crash', async () => {
    const seen = requestFor('Anyone there');

    const outcome = await runClaude(seen.request, { ...options(), command: path.join(scratch, 'no-such-claude') }).finished;

    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain('claude could not be started');
    expect(seen.events).toEqual([]);
  });

  /** The pid of the `sleep` the stand-in started, which it reports in its only text chunk. */
  const childOf = (seen: Seen): Promise<number> =>
    until(() => Number(seen.events.find((event) => event.kind === 'text')?.text?.replace('child ', '')) || undefined, 'the child process');

  test('stop ends the process and everything it started', async () => {
    const seen = requestFor('Please hang');
    const run = runClaude(seen.request, options());
    const child = await childOf(seen);
    expect(isAlive(child)).toBe(true);

    const asked = Date.now();
    run.stop();
    run.stop();
    const outcome = await run.finished;

    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain('SIGTERM');
    expect(Date.now() - asked).toBeLessThan(1000);
    await until(() => !isAlive(child), 'the child process to be gone');
  });

  test('a process that ignores the polite signal is killed after the grace period', async () => {
    const seen = requestFor('Be stubborn');
    const run = runClaude(seen.request, { ...options(), killAfterMs: 150 });
    const child = await childOf(seen);

    const asked = Date.now();
    run.stop();
    const outcome = await run.finished;

    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain('SIGKILL');
    expect(Date.now() - asked).toBeGreaterThanOrEqual(140);
    await until(() => !isAlive(child), 'the child process to be gone');
  });
});

describe('a job on the claude runner', () => {
  test('streams the run, notes the file it made and keeps the session for a follow-up', async () => {
    const project = makeProject();

    const info = await startAgent({ prompt: 'Say hello', project: project.rel, runner: 'claude' });
    expect(info).toMatchObject({ status: 'starting', runner: 'claude' });
    const done = await ended(info.id);

    expect(done).toMatchObject({ status: 'done', exitCode: 0 });
    const events = await eventsOf(info.id);
    expect(events.filter((event) => event.kind !== 'file').map((event) => event.kind)).toEqual([
      'status', 'status', 'text', 'text', 'message', 'tool', 'result',
    ]);
    expect(events[1]).toMatchObject({ kind: 'status', text: 'session started' });
    const made = `${info.workspace.path}/made-by-claude.txt`;
    expect(done.filesTouched).toEqual([expect.objectContaining({ path: made, kind: 'add', count: 1 })]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'file', path: made, change: 'add' }));
    const process_ = JSON.parse(events.find((event) => event.kind === 'message')?.text ?? '') as { cwd: string };
    expect(fs.realpathSync(process_.cwd)).toBe(fs.realpathSync(inHome(info.workspace.path)));
    // The session is the server's to remember, not the desktop's to see.
    expect(JSON.stringify(done)).not.toContain('session-one');

    const followUp = await startAgent({ prompt: 'Go on', continueFrom: info.id, runner: 'claude' });
    await ended(followUp.id);
    const said = (await eventsOf(followUp.id)).find((event) => event.kind === 'message')?.text ?? '';
    expect((JSON.parse(said) as { args: string[] }).args.slice(-2)).toEqual(['--resume', 'session-one']);
  });

  test('a run that exits with an error fails the job with what claude wrote', async () => {
    const info = await startAgent({ prompt: 'Please fail', project: makeProject().rel, runner: 'claude' });

    const done = await ended(info.id);

    expect(done).toMatchObject({ status: 'failed', exitCode: 3, error: 'boom: out of credit' });
    expect((await eventsOf(info.id)).at(-1)).toMatchObject({ kind: 'error', text: 'boom: out of credit' });
  });

  test('stop ends the process of a running job', async () => {
    const info = await startAgent({ prompt: 'Please hang', project: makeProject().rel, runner: 'claude' });
    const child = await until(
      async () => Number((await eventsOf(info.id)).find((event) => event.kind === 'text')?.text?.replace('child ', '')) || undefined,
      'the child process',
    );

    const response = await server.fetch(`/api/agents/${info.id}/stop`, { method: 'POST' });

    expect((await response.json()) as AgentInfo).toMatchObject({ status: 'stopped', exitCode: null });
    await until(() => !isAlive(child), 'the child process to be gone');
  });
});
