import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import type { ActivityDetail, ActivityEntry, ActivityListResponse, Actor, ApiError, ServerEvent } from '../../shared/protocol';
import { startTestServer, type TestServer } from './helpers';

/** The promise of the spec: a change on disk reaches the desktop within half a second. */
const DEADLINE_MS = 500;

let server: TestServer;
/** Every fs frame the events socket has delivered, in order, with the moment it arrived. */
let frames: Array<{ entry: ActivityEntry; receivedAt: number }>;
let socket: WebSocket;

/** Opens an events socket that collects fs frames from the moment it exists, and waits for its greeting. */
function openEvents(target: TestServer, into: typeof frames): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.wsUrl + '/ws', { headers: { cookie: target.cookie, origin: target.url } });
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      if (event.type === 'hello') resolve(ws);
      if (event.type === 'fs') into.push({ entry: event.entry, receivedAt: performance.now() });
    });
    ws.once('error', reject);
  });
}

beforeAll(async () => {
  server = await startTestServer();
  frames = [];
  socket = await openEvents(server, frames);
});
afterAll(async () => {
  socket.terminate();
  await server.close();
});
afterEach(() => server.specos.ctx.activity?.setActorResolver(() => undefined));

const inHome = (rel: string): string => path.join(server.home, rel);

/**
 * Waits for the fs frame of a change that is made after `since` (an index into
 * the frames) and fails when it takes longer than the deadline.
 */
async function frameFor(since: number, kind: ActivityEntry['kind'], rel: string, startedAt: number): Promise<ActivityEntry> {
  const find = () => frames.slice(since).find((frame) => frame.entry.kind === kind && frame.entry.path === rel);
  await expect
    .poll(find, { timeout: 2000, interval: 5, message: `no ${kind} frame for ${rel}` })
    .toBeDefined();
  const frame = find() as (typeof frames)[number];
  expect(frame.receivedAt - startedAt, `${kind} ${rel} took too long`).toBeLessThan(DEADLINE_MS);
  return frame.entry;
}

/** Lets the watcher report anything it still has, so a test can assert that nothing more came. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

async function detail(id: number): Promise<ActivityDetail> {
  const response = await server.fetch(`/api/activity/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ActivityDetail;
}

async function listActivity(query = ''): Promise<ActivityEntry[]> {
  const response = await server.fetch('/api/activity' + query);
  expect(response.status).toBe(200);
  return ((await response.json()) as ActivityListResponse).entries;
}

describe('changes reach the events socket', () => {
  test('a file written through the API arrives as one add within 500 ms, with its diff', async () => {
    const since = frames.length;
    const startedAt = performance.now();
    const response = await server.fetch('/api/fs/write?path=api-note.md', { method: 'PUT', body: '# Title\n\nfirst\n' });
    expect(response.status).toBe(200);

    const entry = await frameFor(since, 'add', 'api-note.md', startedAt);
    expect(entry).toMatchObject({
      kind: 'add',
      path: 'api-note.md',
      isDir: false,
      actor: { type: 'me' },
      additions: 3,
      deletions: 0,
      hasDiff: true,
    });
    expect(entry.id).toBeGreaterThan(0);
    expect(Math.abs(entry.at - Date.now())).toBeLessThan(5000);
    expect(entry.workspaceId).toBeUndefined();

    // The temp file of the atomic write is plumbing and never shows up.
    await settle();
    expect(frames.slice(since).map((frame) => frame.entry.path)).toEqual(['api-note.md']);
  });

  test('a file written with plain fs, as another program would, arrives within 500 ms', async () => {
    const since = frames.length;
    const startedAt = performance.now();
    fs.writeFileSync(inHome('outside-process.txt'), 'one\ntwo\n');

    const entry = await frameFor(since, 'add', 'outside-process.txt', startedAt);
    expect(entry).toMatchObject({ actor: { type: 'me' }, additions: 2, deletions: 0, hasDiff: true });
    expect((await detail(entry.id)).patch).toBe(
      ['--- /dev/null', '+++ b/outside-process.txt', '@@ -0,0 +1,2 @@', '+one', '+two', ''].join('\n'),
    );
  });

  test('a change has a correct patch and counts, through the API and through plain fs', async () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    let since = frames.length;
    fs.writeFileSync(inHome('story.txt'), lines.join('\n') + '\n');
    await frameFor(since, 'add', 'story.txt', performance.now());

    // An in-place write by another program: line 6 changes, a line is added at the end.
    since = frames.length;
    let startedAt = performance.now();
    const edited = [...lines.slice(0, 5), 'line six', ...lines.slice(6), 'line 13'];
    fs.writeFileSync(inHome('story.txt'), edited.join('\n') + '\n');
    const first = await frameFor(since, 'change', 'story.txt', startedAt);
    expect(first).toMatchObject({ additions: 2, deletions: 1, hasDiff: true, isDir: false });
    const firstDetail = await detail(first.id);
    expect(firstDetail).toMatchObject(first);
    expect(firstDetail.patch).toBe(
      [
        '--- a/story.txt',
        '+++ b/story.txt',
        '@@ -3,10 +3,11 @@',
        ' line 3',
        ' line 4',
        ' line 5',
        '-line 6',
        '+line six',
        ' line 7',
        ' line 8',
        ' line 9',
        ' line 10',
        ' line 11',
        ' line 12',
        '+line 13',
        '',
      ].join('\n'),
    );

    // An atomic write through the API is one change too, not a delete and a create.
    since = frames.length;
    startedAt = performance.now();
    const response = await server.fetch('/api/fs/write?path=story.txt', { method: 'PUT', body: edited.slice(2).join('\n') + '\n' });
    expect(response.status).toBe(200);
    const second = await frameFor(since, 'change', 'story.txt', startedAt);
    expect(second.id).toBeGreaterThan(first.id);
    expect(second).toMatchObject({ additions: 0, deletions: 2, hasDiff: true });
    expect((await detail(second.id)).patch).toBe(
      ['--- a/story.txt', '+++ b/story.txt', '@@ -1,5 +1,3 @@', '-line 1', '-line 2', ' line 3', ' line 4', ' line 5', ''].join('\n'),
    );
    await settle();
    expect(frames.slice(since).map((frame) => `${frame.entry.kind} ${frame.entry.path}`)).toEqual(['change story.txt']);
  });

  test('a write that leaves the content as it was is not reported', async () => {
    let since = frames.length;
    fs.writeFileSync(inHome('same.txt'), 'unchanged\n');
    await frameFor(since, 'add', 'same.txt', performance.now());

    since = frames.length;
    fs.writeFileSync(inHome('same.txt'), 'unchanged\n');
    await server.fetch('/api/fs/write?path=same.txt', { method: 'PUT', body: 'unchanged\n' });
    await settle();
    expect(frames.slice(since)).toEqual([]);
  });

  test('a delete arrives within 500 ms with everything removed in its patch', async () => {
    let since = frames.length;
    fs.writeFileSync(inHome('doomed.txt'), 'a\nb\nc\n');
    await frameFor(since, 'add', 'doomed.txt', performance.now());

    since = frames.length;
    let startedAt = performance.now();
    fs.rmSync(inHome('doomed.txt'));
    const entry = await frameFor(since, 'unlink', 'doomed.txt', startedAt);
    expect(entry).toMatchObject({ additions: 0, deletions: 3, hasDiff: true, isDir: false });
    expect((await detail(entry.id)).patch).toBe(
      ['--- a/doomed.txt', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-a', '-b', '-c', ''].join('\n'),
    );

    // Through the API as well.
    since = frames.length;
    fs.writeFileSync(inHome('doomed-too.txt'), 'x\n');
    await frameFor(since, 'add', 'doomed-too.txt', performance.now());
    startedAt = performance.now();
    expect((await server.fetch('/api/fs/delete?path=doomed-too.txt', { method: 'DELETE' })).status).toBe(200);
    expect(await frameFor(since, 'unlink', 'doomed-too.txt', startedAt)).toMatchObject({ deletions: 1 });
  });

  test('folders are reported as folders, and a new file in a new folder is seen', async () => {
    let since = frames.length;
    let startedAt = performance.now();
    fs.mkdirSync(inHome('Projects/notes'), { recursive: true });
    fs.writeFileSync(inHome('Projects/notes/idea.md'), 'idea\n');
    const folder = await frameFor(since, 'addDir', 'Projects/notes', startedAt);
    expect(folder).toMatchObject({ isDir: true, hasDiff: false });
    expect(folder.additions).toBeUndefined();
    expect((await detail(folder.id)).patch).toBe('');
    expect(await frameFor(since, 'add', 'Projects/notes/idea.md', startedAt)).toMatchObject({ additions: 1, hasDiff: true });

    since = frames.length;
    startedAt = performance.now();
    fs.rmSync(inHome('Projects'), { recursive: true });
    expect(await frameFor(since, 'unlinkDir', 'Projects/notes', startedAt)).toMatchObject({ isDir: true, hasDiff: false });
    expect(await frameFor(since, 'unlink', 'Projects/notes/idea.md', startedAt)).toMatchObject({ deletions: 1 });
  });

  test('binary and oversized files are journalled without a diff', async () => {
    const since = frames.length;
    const startedAt = performance.now();
    fs.writeFileSync(inHome('image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]));
    fs.writeFileSync(inHome('big.log'), 'x'.repeat(256 * 1024 + 1));
    for (const rel of ['image.png', 'big.log']) {
      const entry = await frameFor(since, 'add', rel, startedAt);
      expect(entry).toMatchObject({ hasDiff: false, isDir: false });
      expect(entry.additions).toBeUndefined();
      expect((await detail(entry.id)).patch).toBe('');
    }
  });

  test('.git, node_modules and the server\'s own temp files are not watched', async () => {
    const since = frames.length;
    fs.mkdirSync(inHome('repo/.git/objects'), { recursive: true });
    fs.mkdirSync(inHome('repo/node_modules/dep'), { recursive: true });
    fs.writeFileSync(inHome('repo/.git/HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(inHome('repo/node_modules/dep/index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(inHome('repo/.specos-probe-abc'), 'probe');
    fs.writeFileSync(inHome('repo/seen.txt'), 'seen\n');
    await frameFor(since, 'add', 'repo/seen.txt', performance.now());
    await settle();
    expect(frames.slice(since).map((frame) => frame.entry.path).sort()).toEqual(['repo', 'repo/seen.txt']);
  });

  test('a link out of home is reported as a link and never read into the journal', async () => {
    const outside = path.join(path.dirname(server.home), 'outside-secret.txt');
    fs.writeFileSync(outside, 'top secret\n');
    const since = frames.length;
    fs.symlinkSync(outside, inHome('leak'));
    const entry = await frameFor(since, 'add', 'leak', performance.now());
    expect(entry.hasDiff).toBe(false);
    expect((await detail(entry.id)).patch).toBe('');

    fs.writeFileSync(outside, 'top secret, edited\n');
    await settle();
    expect(frames.slice(since).map((frame) => frame.entry.path)).toEqual(['leak']);
  });
});

describe('who made the change', () => {
  const juniper: Actor = { type: 'agent', agentId: 'agent-1', name: 'Juniper', hue: 140 };

  test('a custom actor resolver labels an entry as an agent, and the workspace resolver names its workspace', async () => {
    const { activity } = server.specos.ctx;
    activity?.setActorResolver((rel) => (rel.startsWith('Workspaces/notes-juniper/') ? juniper : undefined));
    activity?.setWorkspaceResolver((rel) => (rel.startsWith('Workspaces/notes-juniper/') ? 'ws-1' : undefined));
    fs.mkdirSync(inHome('Workspaces/notes-juniper'), { recursive: true });

    const since = frames.length;
    const startedAt = performance.now();
    fs.writeFileSync(inHome('Workspaces/notes-juniper/note.md'), 'by the agent\n');
    fs.writeFileSync(inHome('mine.md'), 'by me\n');

    const agentEntry = await frameFor(since, 'add', 'Workspaces/notes-juniper/note.md', startedAt);
    expect(agentEntry.actor).toEqual(juniper);
    expect(agentEntry.workspaceId).toBe('ws-1');
    expect((await detail(agentEntry.id)).actor).toEqual(juniper);

    const myEntry = await frameFor(since, 'add', 'mine.md', startedAt);
    expect(myEntry.actor).toEqual({ type: 'me' });
    expect(myEntry.workspaceId).toBeUndefined();
  });

  test('markMerge labels changes below a prefix for a short window, then they are mine again', async () => {
    const { activity } = server.specos.ctx;
    const merge: Actor = { type: 'merge', agentId: 'agent-1', name: 'Juniper', hue: 140 };
    fs.mkdirSync(inHome('Projects/site'), { recursive: true });
    fs.mkdirSync(inHome('Projects/site-two'), { recursive: true });
    await settle();

    let since = frames.length;
    activity?.markMerge('Projects/site', merge, 400);
    fs.writeFileSync(inHome('Projects/site/index.md'), 'merged\n');
    fs.writeFileSync(inHome('Projects/site-two/index.md'), 'not merged\n');
    expect((await frameFor(since, 'add', 'Projects/site/index.md', performance.now())).actor).toEqual(merge);
    // A sibling whose name merely starts the same is not part of the merge.
    expect((await frameFor(since, 'add', 'Projects/site-two/index.md', performance.now())).actor).toEqual({ type: 'me' });

    await new Promise((resolve) => setTimeout(resolve, 450));
    since = frames.length;
    fs.writeFileSync(inHome('Projects/site/index.md'), 'edited by hand\n');
    expect((await frameFor(since, 'change', 'Projects/site/index.md', performance.now())).actor).toEqual({ type: 'me' });
  });

  test('onEntry hears every entry until it is switched off', async () => {
    const { activity } = server.specos.ctx;
    const heard: string[] = [];
    const stop = activity?.onEntry((entry) => heard.push(`${entry.kind} ${entry.path}`));

    let since = frames.length;
    fs.writeFileSync(inHome('heard.txt'), 'yes\n');
    await frameFor(since, 'add', 'heard.txt', performance.now());
    expect(heard).toEqual(['add heard.txt']);

    stop?.();
    since = frames.length;
    fs.writeFileSync(inHome('unheard.txt'), 'no\n');
    await frameFor(since, 'add', 'unheard.txt', performance.now());
    expect(heard).toEqual(['add heard.txt']);
  });
});

describe('GET /api/activity', () => {
  test('lists newest first, pages with before and limit, and matches what the socket sent', async () => {
    const since = frames.length;
    for (const name of ['p1.txt', 'p2.txt', 'p3.txt']) {
      const mark = frames.length;
      fs.writeFileSync(inHome(name), name + '\n');
      await frameFor(mark, 'add', name, performance.now());
    }
    const sent = frames.slice(since).map((frame) => frame.entry);

    const all = await listActivity();
    expect(all.length).toBe(frames.length);
    const ids = all.map((entry) => entry.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(ids.length);
    expect(all.slice(0, 3)).toEqual([...sent].reverse());

    expect(await listActivity('?limit=2')).toEqual(all.slice(0, 2));
    const newest = all[0] as ActivityEntry;
    expect(await listActivity(`?limit=2&before=${newest.id}`)).toEqual(all.slice(1, 3));
    expect(await listActivity('?before=1')).toEqual([]);
    // A limit above the maximum is capped, not refused.
    expect((await listActivity('?limit=100000')).length).toBe(all.length);
    // The list never carries patches.
    expect(all.every((entry) => !('patch' in entry))).toBe(true);
  });

  test('refuses a limit or before that is not a number, and an id that is not in the journal', async () => {
    for (const query of ['?limit=abc', '?limit=0', '?limit=-3', '?limit=1.5', '?before=soon']) {
      const response = await server.fetch('/api/activity' + query);
      expect([query, response.status, ((await response.json()) as ApiError).code]).toEqual([query, 400, 'bad_request']);
    }
    for (const id of ['999999', 'abc', '0']) {
      const response = await server.fetch('/api/activity/' + id);
      expect([id, response.status, ((await response.json()) as ApiError).code]).toEqual([id, 404, 'not_found']);
    }
  });

  test('needs the session like everything else', async () => {
    expect((await fetch(server.url + '/api/activity')).status).toBe(401);
    expect((await fetch(server.url + '/api/activity/1')).status).toBe(401);
  });
});

describe('the journal file', () => {
  test('is written as one JSON line per entry, without patches', async () => {
    const since = frames.length;
    fs.writeFileSync(inHome('journalled.txt'), 'kept\n');
    const entry = await frameFor(since, 'add', 'journalled.txt', performance.now());

    const journal = path.join(server.data, 'activity.jsonl');
    await expect.poll(() => fs.readFileSync(journal, 'utf8')).toContain('"journalled.txt"');
    const lines = fs.readFileSync(journal, 'utf8').trimEnd().split('\n');
    const stored = lines.map((line) => JSON.parse(line) as ActivityEntry);
    expect(stored.at(-1)).toEqual(entry);
    expect(stored.map((line) => line.id)).toEqual((await listActivity('?limit=1000')).map((line) => line.id).reverse());
    expect(lines.every((line) => !line.includes('"patch"'))).toBe(true);
  });

  test('ids continue after a restart on the same data folder, and old files still get a real diff', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'specos-restart-'));
    const folders = { home: path.join(base, 'home'), data: path.join(base, 'data') };
    try {
      const first = await startTestServer(folders);
      const firstFrames: typeof frames = [];
      const firstSocket = await openEvents(first, firstFrames);
      fs.writeFileSync(path.join(folders.home, 'kept.md'), 'one\ntwo\n');
      fs.writeFileSync(path.join(folders.home, 'other.md'), 'other\n');
      await expect.poll(() => firstFrames.length, { interval: 5 }).toBe(2);
      const before = ((await (await first.fetch('/api/activity')).json()) as ActivityListResponse).entries;
      expect(before.map((entry) => entry.id)).toEqual([2, 1]);
      firstSocket.terminate();
      await first.close();

      const second = await startTestServer(folders);
      const secondFrames: typeof frames = [];
      const secondSocket = await openEvents(second, secondFrames);
      try {
        // The earlier entries are back, in order, without the diffs that only lived in memory.
        const reloaded = ((await (await second.fetch('/api/activity')).json()) as ActivityListResponse).entries;
        expect(reloaded).toEqual(before.map((entry) => ({ ...entry, hasDiff: false })));
        const old = (await (await second.fetch('/api/activity/2')).json()) as ActivityDetail;
        expect(old).toMatchObject({ id: 2, patch: '', hasDiff: false });

        // The files that were already there are read at start, so their first change is a real diff.
        await second.specos.ctx.activity?.whenPrimed();
        expect(secondFrames).toEqual([]);
        fs.writeFileSync(path.join(folders.home, 'kept.md'), 'one\ntwo\nthree\n');
        await expect.poll(() => secondFrames.length, { interval: 5 }).toBe(1);
        const entry = (secondFrames[0] as (typeof frames)[number]).entry;
        expect(entry).toMatchObject({ id: 3, kind: 'change', path: 'kept.md', additions: 1, deletions: 0, hasDiff: true });
        const changed = (await (await second.fetch('/api/activity/3')).json()) as ActivityDetail;
        expect(changed.patch).toBe(['--- a/kept.md', '+++ b/kept.md', '@@ -1,2 +1,3 @@', ' one', ' two', '+three', ''].join('\n'));

        const journal = fs.readFileSync(path.join(folders.data, 'activity.jsonl'), 'utf8').trimEnd().split('\n');
        expect(journal.map((line) => (JSON.parse(line) as ActivityEntry).id)).toEqual([1, 2, 3]);
      } finally {
        secondSocket.terminate();
        await second.close();
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('a torn last line from a crash does not lose the entries before it', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'specos-torn-'));
    const folders = { home: path.join(base, 'home'), data: path.join(base, 'data') };
    fs.mkdirSync(folders.data, { recursive: true });
    const earlier: ActivityEntry = { id: 41, at: 1, kind: 'add', path: 'old.txt', isDir: false, actor: { type: 'me' }, hasDiff: true };
    fs.writeFileSync(path.join(folders.data, 'activity.jsonl'), JSON.stringify(earlier) + '\n{"id":42,"at":2,"ki');
    try {
      const restarted = await startTestServer(folders);
      try {
        const { entries } = (await (await restarted.fetch('/api/activity')).json()) as ActivityListResponse;
        expect(entries).toEqual([{ ...earlier, hasDiff: false }]);
        const entry = await restarted.specos.ctx.activity?.record('addDir', path.join(folders.home, 'made'));
        expect(entry?.id).toBe(42);
        // The new line starts on a line of its own, so the journal stays readable.
        const journal = fs.readFileSync(path.join(folders.data, 'activity.jsonl'), 'utf8').trimEnd().split('\n');
        expect(JSON.parse(journal.at(-1) as string)).toMatchObject({ id: 42, path: 'made' });
      } finally {
        await restarted.close();
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
