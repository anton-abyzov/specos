import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { ApiError, FsEntry, FsIndexResponse, FsListResponse } from '../../shared/protocol';
import { startTestServer, type TestServer } from './helpers';

let server: TestServer;
/** A folder next to home that no request may ever read or change. */
let outside: string;
let secret: string;

beforeAll(async () => {
  server = await startTestServer();
  outside = path.join(path.dirname(server.home), 'outside');
  secret = path.join(outside, 'secret.txt');
});
afterAll(() => server.close());

/** Every test starts from an empty home and a pristine outside folder. */
beforeEach(() => {
  for (const name of fs.readdirSync(server.home)) fs.rmSync(path.join(server.home, name), { recursive: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(secret, 'top secret');
});

const inHome = (rel: string): string => path.join(server.home, rel);
const q = (rel: string): string => `?path=${encodeURIComponent(rel)}`;

const list = (rel: string) => server.fetch('/api/fs/list' + q(rel));
const stat = (rel: string) => server.fetch('/api/fs/stat' + q(rel));
const read = (rel: string) => server.fetch('/api/fs/read' + q(rel));
const remove = (rel: string) => server.fetch('/api/fs/delete' + q(rel), { method: 'DELETE' });
const write = (rel: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
  server.fetch('/api/fs/write' + q(rel), { method: 'PUT', body, headers });
const post = (route: 'mkdir' | 'rename', body: unknown) =>
  server.fetch(`/api/fs/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function expectError(response: Response, status: number, code: string): Promise<void> {
  const body = (await response.json()) as ApiError;
  expect({ status: response.status, code: body.code }).toEqual({ status, code });
  expect(body.error).toEqual(expect.any(String));
  // An error never tells the client where home is on the server's disk.
  expect(body.error).not.toContain(path.dirname(server.home));
}

describe('list', () => {
  test('lists home with folders first, then names in natural order ignoring case', async () => {
    for (const folder of ['zeta', 'Alpha', '.config']) fs.mkdirSync(inHome(folder));
    for (const file of ['b10.txt', 'B2.txt', 'a.txt', 'b1.txt', '.env', 'Makefile']) fs.writeFileSync(inHome(file), file);

    const response = await list('');
    expect(response.status).toBe(200);
    const body = (await response.json()) as FsListResponse;
    expect(body.path).toBe('');
    expect(body.entries.map((entry) => entry.name)).toEqual([
      '.config',
      'Alpha',
      'zeta',
      '.env',
      'a.txt',
      'b1.txt',
      'B2.txt',
      'b10.txt',
      'Makefile',
    ]);
  });

  test('describes each entry: path, kind, size, mtime, extension and hidden', async () => {
    fs.mkdirSync(inHome('Projects/notes'), { recursive: true });
    fs.writeFileSync(inHome('Projects/Read Me.MD'), 'hello');
    fs.writeFileSync(inHome('Projects/.hidden'), '');
    const mtime = Math.round(fs.statSync(inHome('Projects/Read Me.MD')).mtimeMs);

    const body = (await (await list('Projects')).json()) as FsListResponse;
    expect(body.path).toBe('Projects');
    expect(body.entries).toEqual([
      { name: 'notes', path: 'Projects/notes', kind: 'dir', size: 0, mtime: expect.any(Number), ext: '', hidden: false },
      { name: '.hidden', path: 'Projects/.hidden', kind: 'file', size: 0, mtime: expect.any(Number), ext: '', hidden: true },
      { name: 'Read Me.MD', path: 'Projects/Read Me.MD', kind: 'file', size: 5, mtime, ext: 'md', hidden: false },
    ]);
  });

  test('home is the default, and a normalised path comes back', async () => {
    fs.mkdirSync(inHome('docs'));
    expect(((await (await server.fetch('/api/fs/list')).json()) as FsListResponse).entries).toHaveLength(1);
    expect(((await (await list('docs//./')).json()) as FsListResponse).path).toBe('docs');
  });

  test('reports a symlink as a symlink with the size of the link itself, wherever it points', async () => {
    fs.symlinkSync(secret, inHome('leak'));
    fs.symlinkSync(outside, inHome('leak-dir'));
    fs.writeFileSync(inHome('real.txt'), 'x'.repeat(1000));
    fs.symlinkSync('real.txt', inHome('inner'));

    const { entries } = (await (await list('')).json()) as FsListResponse;
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    expect(byName['leak']).toMatchObject({ kind: 'symlink', size: fs.lstatSync(inHome('leak')).size });
    expect(byName['leak-dir']).toMatchObject({ kind: 'symlink' });
    expect(byName['inner']).toMatchObject({ kind: 'symlink', size: 'real.txt'.length });
    // Not following also means an outside folder never sorts among the folders.
    expect(entries.map((entry) => entry.kind)).toEqual(['symlink', 'symlink', 'symlink', 'file']);
  });

  test('a missing folder is 404 and a file is 400', async () => {
    fs.writeFileSync(inHome('file.txt'), '');
    await expectError(await list('nope'), 404, 'not_found');
    await expectError(await list('file.txt'), 400, 'not_a_directory');
  });
});

describe('stat', () => {
  test('describes a file, a folder and home itself', async () => {
    fs.mkdirSync(inHome('docs'));
    fs.writeFileSync(inHome('docs/Photo.JPEG'), 'abc');
    expect(await (await stat('docs/Photo.JPEG')).json()).toMatchObject({
      name: 'Photo.JPEG',
      path: 'docs/Photo.JPEG',
      kind: 'file',
      size: 3,
      ext: 'jpeg',
      hidden: false,
    });
    expect(await (await stat('docs')).json()).toMatchObject({ name: 'docs', path: 'docs', kind: 'dir', ext: '' });
    expect(await (await stat('')).json()).toMatchObject({ name: '', path: '', kind: 'dir' });
  });

  test('describes a link that points outside as a link, without following it', async () => {
    fs.symlinkSync(secret, inHome('leak'));
    const entry = (await (await stat('leak')).json()) as FsEntry;
    expect(entry).toMatchObject({ kind: 'symlink', size: fs.lstatSync(inHome('leak')).size });
    expect(entry.size).not.toBe('top secret'.length);
  });

  test('a missing path is 404 and a missing parameter is 400', async () => {
    await expectError(await stat('nope.txt'), 404, 'not_found');
    await expectError(await server.fetch('/api/fs/stat'), 400, 'bad_path');
    await expectError(await server.fetch('/api/fs/stat?path=a&path=b'), 400, 'bad_path');
  });
});

describe('read', () => {
  test('streams the exact bytes with the hardening headers', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13]);
    fs.writeFileSync(inHome('blob.bin'), bytes);
    const response = await read('blob.bin');
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
    expect(response.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''blob.bin");
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('picks the content type from the extension', async () => {
    const expected: Record<string, string> = {
      'note.txt': 'text/plain; charset=utf-8',
      'README.md': 'text/plain; charset=utf-8',
      'app.TSX': 'text/plain; charset=utf-8',
      'data.json': 'text/plain; charset=utf-8',
      'script.py': 'text/plain; charset=utf-8',
      '.gitignore': 'text/plain; charset=utf-8',
      Makefile: 'text/plain; charset=utf-8',
      'photo.png': 'image/png',
      'photo.JPG': 'image/jpeg',
      'anim.gif': 'image/gif',
      'pic.webp': 'image/webp',
      'archive.zip': 'application/octet-stream',
      'noextension': 'application/octet-stream',
    };
    for (const [name, type] of Object.entries(expected)) {
      fs.writeFileSync(inHome(name), 'x');
      const response = await read(name);
      await response.arrayBuffer();
      expect([name, response.headers.get('content-type')]).toEqual([name, type]);
    }
  });

  test('never serves a type that would run script in the desktop origin', async () => {
    const page = '<!doctype html><script>parent.document.cookie</script>';
    fs.writeFileSync(inHome('page.html'), page);
    fs.writeFileSync(inHome('page.HTM'), page);
    fs.writeFileSync(inHome('drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    for (const name of ['page.html', 'page.HTM']) {
      const html = await read(name);
      expect(html.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(html.headers.get('content-security-policy')).toBe('sandbox');
      expect(await html.text()).toBe(page);
    }
    // An SVG must keep its type to show as an image; the sandbox is what stops its script.
    const svg = await read('drawing.svg');
    await svg.arrayBuffer();
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toBe('sandbox');
    expect(svg.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('encodes unicode names in the disposition header', async () => {
    fs.writeFileSync(inHome("заметка (1)'s.txt"), 'привет');
    const response = await read("заметка (1)'s.txt");
    expect(await response.text()).toBe('привет');
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^inline; filename\*=UTF-8''[A-Za-z0-9%.\-_~]+$/);
    expect(decodeURIComponent(disposition.split("''")[1] ?? '')).toBe("заметка (1)'s.txt");
  });

  test('reads through a link that stays inside home', async () => {
    fs.mkdirSync(inHome('docs'));
    fs.writeFileSync(inHome('docs/note.md'), '# hi');
    fs.symlinkSync('docs', inHome('shortcut'));
    expect(await (await read('shortcut/note.md')).text()).toBe('# hi');
  });

  test('a folder is 400, a missing file is 404, an empty file is an empty 200', async () => {
    fs.mkdirSync(inHome('docs'));
    fs.writeFileSync(inHome('empty.txt'), '');
    await expectError(await read('docs'), 400, 'is_directory');
    await expectError(await read(''), 400, 'is_directory');
    await expectError(await read('nope.txt'), 404, 'not_found');
    const empty = await read('empty.txt');
    expect([empty.status, await empty.text()]).toEqual([200, '']);
  });
});

describe('write', () => {
  test('creates a file and its parent folders and returns the entry', async () => {
    const response = await write('Projects/notes/todo.md', '- ship it\n', { 'content-type': 'text/markdown' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: 'todo.md',
      path: 'Projects/notes/todo.md',
      kind: 'file',
      size: 10,
      ext: 'md',
    });
    expect(fs.readFileSync(inHome('Projects/notes/todo.md'), 'utf8')).toBe('- ship it\n');
  });

  test('stores the body byte for byte whatever its content type', async () => {
    const binary = new Uint8Array(70_000).map((_, index) => (index * 31) % 256);
    expect((await write('blob.bin', binary, { 'content-type': 'application/octet-stream' })).status).toBe(200);
    expect(Buffer.from(binary).equals(fs.readFileSync(inHome('blob.bin')))).toBe(true);

    // JSON and form bodies are files like any other: stored as sent, never parsed, even when malformed.
    expect((await write('data.json', '{"a": 1,}', { 'content-type': 'application/json' })).status).toBe(200);
    expect(fs.readFileSync(inHome('data.json'), 'utf8')).toBe('{"a": 1,}');
    expect((await write('form.txt', 'a=1&b=2', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(200);
    expect(fs.readFileSync(inHome('form.txt'), 'utf8')).toBe('a=1&b=2');
    expect((await write('plain.txt', 'plain', { 'content-type': 'text/plain' })).status).toBe(200);
    expect(fs.readFileSync(inHome('plain.txt'), 'utf8')).toBe('plain');
  });

  test('accepts an empty body and a body without a content type', async () => {
    expect((await write('empty.txt', '')).status).toBe(200);
    expect(fs.readFileSync(inHome('empty.txt'), 'utf8')).toBe('');
    // A fetch with bytes sends no Content-Type at all.
    expect((await write('untyped.bin', new Uint8Array([1, 2, 3]))).status).toBe(200);
    expect([...fs.readFileSync(inHome('untyped.bin'))]).toEqual([1, 2, 3]);
  });

  test('replaces a file atomically: new inode, same mode, no temp file left behind', async () => {
    fs.mkdirSync(inHome('bin'));
    fs.writeFileSync(inHome('bin/run.sh'), '#!/bin/sh\necho old\n', { mode: 0o755 });
    const before = fs.statSync(inHome('bin/run.sh'));

    expect((await write('bin/run.sh', '#!/bin/sh\necho new\n')).status).toBe(200);
    const after = fs.statSync(inHome('bin/run.sh'));
    expect(fs.readFileSync(inHome('bin/run.sh'), 'utf8')).toBe('#!/bin/sh\necho new\n');
    // A rename over the target, not a write into it: a reader holding the old file keeps a complete old file.
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(inHome('bin'))).toEqual(['run.sh']);
  });

  test('writes through a link inside home without replacing the link', async () => {
    fs.writeFileSync(inHome('real.txt'), 'old');
    fs.symlinkSync('real.txt', inHome('alias.txt'));
    expect((await write('alias.txt', 'new')).status).toBe(200);
    expect(fs.lstatSync(inHome('alias.txt')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(inHome('real.txt'), 'utf8')).toBe('new');
  });

  test('refuses to write onto a folder or below a file', async () => {
    fs.mkdirSync(inHome('docs'));
    fs.writeFileSync(inHome('file.txt'), 'keep');
    await expectError(await write('docs', 'x'), 400, 'is_directory');
    await expectError(await write('', 'x'), 400, 'is_directory');
    await expectError(await write('file.txt/child.txt', 'x'), 400, 'not_a_directory');
    expect(fs.statSync(inHome('docs')).isDirectory()).toBe(true);
    expect(fs.readFileSync(inHome('file.txt'), 'utf8')).toBe('keep');
  });

  test('refuses a body over 32 MB and leaves nothing behind', async () => {
    const response = await write('huge.bin', new Uint8Array(32 * 1024 * 1024 + 1));
    expect(response.status).toBe(413);
    expect(((await response.json()) as ApiError).code).toBe('bad_request');
    expect(fs.readdirSync(server.home)).toEqual([]);
  });
});

describe('mkdir', () => {
  test('makes nested folders and is idempotent', async () => {
    const first = await post('mkdir', { path: 'Projects/notes/drafts' });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ name: 'drafts', path: 'Projects/notes/drafts', kind: 'dir' });
    fs.writeFileSync(inHome('Projects/notes/drafts/keep.txt'), 'keep');

    const again = await post('mkdir', { path: 'Projects/notes/drafts' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ path: 'Projects/notes/drafts', kind: 'dir' });
    expect(fs.readFileSync(inHome('Projects/notes/drafts/keep.txt'), 'utf8')).toBe('keep');
  });

  test('refuses a name taken by a file, and a body that is not an object with a path', async () => {
    fs.writeFileSync(inHome('taken'), 'file');
    await expectError(await post('mkdir', { path: 'taken' }), 409, 'conflict');
    await expectError(await post('mkdir', {}), 400, 'bad_path');
    await expectError(await post('mkdir', { path: 7 }), 400, 'bad_path');
    await expectError(await post('mkdir', ['a']), 400, 'bad_request');
    expect(fs.readFileSync(inHome('taken'), 'utf8')).toBe('file');
  });
});

describe('rename', () => {
  test('renames a file and moves a folder with its contents', async () => {
    fs.mkdirSync(inHome('drafts/deep'), { recursive: true });
    fs.writeFileSync(inHome('drafts/deep/a.txt'), 'a');
    fs.mkdirSync(inHome('archive'));
    fs.writeFileSync(inHome('old.txt'), 'content');

    const file = await post('rename', { from: 'old.txt', to: 'new.md' });
    expect(file.status).toBe(200);
    expect(await file.json()).toMatchObject({ name: 'new.md', path: 'new.md', kind: 'file', ext: 'md', size: 7 });
    expect(fs.existsSync(inHome('old.txt'))).toBe(false);

    const folder = await post('rename', { from: 'drafts', to: 'archive/drafts-2024' });
    expect(await folder.json()).toMatchObject({ path: 'archive/drafts-2024', kind: 'dir' });
    expect(fs.readFileSync(inHome('archive/drafts-2024/deep/a.txt'), 'utf8')).toBe('a');
  });

  test('refuses to overwrite an existing target with 409 and changes nothing', async () => {
    fs.writeFileSync(inHome('a.txt'), 'A');
    fs.writeFileSync(inHome('b.txt'), 'B');
    fs.mkdirSync(inHome('folder'));
    await expectError(await post('rename', { from: 'a.txt', to: 'b.txt' }), 409, 'conflict');
    await expectError(await post('rename', { from: 'a.txt', to: 'folder' }), 409, 'conflict');
    await expectError(await post('rename', { from: 'a.txt', to: 'a.txt' }), 409, 'conflict');
    expect(fs.readFileSync(inHome('a.txt'), 'utf8')).toBe('A');
    expect(fs.readFileSync(inHome('b.txt'), 'utf8')).toBe('B');
  });

  test('a dangling link at the target also counts as taken', async () => {
    fs.writeFileSync(inHome('a.txt'), 'A');
    fs.symlinkSync(path.join(outside, 'not-there.txt'), inHome('dangling'));
    await expectError(await post('rename', { from: 'a.txt', to: 'dangling' }), 409, 'conflict');
    expect(fs.lstatSync(inHome('dangling')).isSymbolicLink()).toBe(true);
  });

  test('a missing source is 404, a missing target folder is 404, home itself is 400', async () => {
    fs.writeFileSync(inHome('a.txt'), 'A');
    fs.mkdirSync(inHome('folder'));
    await expectError(await post('rename', { from: 'nope.txt', to: 'x.txt' }), 404, 'not_found');
    await expectError(await post('rename', { from: 'a.txt', to: 'no-folder/a.txt' }), 404, 'not_found');
    await expectError(await post('rename', { from: '', to: 'folder/home' }), 400, 'bad_request');
    await expectError(await post('rename', { from: 'folder', to: '' }), 400, 'bad_request');
    await expectError(await post('rename', { from: 'a.txt' }), 400, 'bad_path');
    expect(fs.readFileSync(inHome('a.txt'), 'utf8')).toBe('A');
  });
});

describe('delete', () => {
  test('deletes a file, and a folder with everything in it', async () => {
    fs.mkdirSync(inHome('project/src/deep'), { recursive: true });
    fs.writeFileSync(inHome('project/src/deep/a.ts'), 'a');
    fs.writeFileSync(inHome('single.txt'), 's');

    const file = await remove('single.txt');
    expect([file.status, await file.json()]).toEqual([200, { ok: true }]);
    expect(fs.existsSync(inHome('single.txt'))).toBe(false);

    expect(await (await remove('project')).json()).toEqual({ ok: true });
    expect(fs.existsSync(inHome('project'))).toBe(false);
  });

  test('refuses the home folder itself with 400', async () => {
    fs.writeFileSync(inHome('keep.txt'), 'keep');
    for (const rel of ['', '.', './', '//']) {
      const response = rel === '//' ? await server.fetch('/api/fs/delete?path=.%2F%2F.', { method: 'DELETE' }) : await remove(rel);
      await expectError(response, 400, 'bad_request');
    }
    expect(fs.readFileSync(inHome('keep.txt'), 'utf8')).toBe('keep');
  });

  test('a missing path is 404', async () => {
    await expectError(await remove('nope.txt'), 404, 'not_found');
  });

  test('removes links themselves, never what they point to, also inside a deleted folder', async () => {
    fs.mkdirSync(path.join(outside, 'folder'));
    fs.writeFileSync(path.join(outside, 'folder/inner.txt'), 'inner');
    fs.mkdirSync(inHome('box'));
    fs.symlinkSync(outside, inHome('box/out-dir'));
    fs.symlinkSync(secret, inHome('leak'));
    fs.symlinkSync(outside, inHome('out-dir'));

    expect((await remove('leak')).status).toBe(200);
    expect((await remove('out-dir')).status).toBe(200);
    expect((await remove('box')).status).toBe(200);
    expect(fs.readdirSync(server.home)).toEqual([]);
    expect(fs.readFileSync(secret, 'utf8')).toBe('top secret');
    expect(fs.readFileSync(path.join(outside, 'folder/inner.txt'), 'utf8')).toBe('inner');
  });
});

describe('index', () => {
  test('walks home breadth first and skips .git and node_modules', async () => {
    fs.mkdirSync(inHome('Projects/notes/.git/objects'), { recursive: true });
    fs.mkdirSync(inHome('Projects/notes/node_modules/left-pad'), { recursive: true });
    fs.mkdirSync(inHome('Projects/notes/src'), { recursive: true });
    fs.writeFileSync(inHome('Projects/notes/.git/HEAD'), 'ref');
    fs.writeFileSync(inHome('Projects/notes/node_modules/left-pad/index.js'), '');
    fs.writeFileSync(inHome('Projects/notes/src/main.ts'), '');
    fs.writeFileSync(inHome('Projects/notes/README.md'), '');
    fs.writeFileSync(inHome('welcome.txt'), '');
    fs.symlinkSync(outside, inHome('out-dir'));

    const response = await server.fetch('/api/fs/index');
    expect(response.status).toBe(200);
    const body = (await response.json()) as FsIndexResponse;
    expect(body.truncated).toBe(false);
    expect(body.entries).toEqual([
      // depth 1
      { name: 'out-dir', path: 'out-dir', kind: 'symlink' },
      { name: 'Projects', path: 'Projects', kind: 'dir' },
      { name: 'welcome.txt', path: 'welcome.txt', kind: 'file' },
      // depth 2
      { name: 'notes', path: 'Projects/notes', kind: 'dir' },
      // depth 3
      { name: 'README.md', path: 'Projects/notes/README.md', kind: 'file' },
      { name: 'src', path: 'Projects/notes/src', kind: 'dir' },
      // depth 4
      { name: 'main.ts', path: 'Projects/notes/src/main.ts', kind: 'file' },
    ]);
  });

  test('stops at 5000 entries and says so, keeping the shallow ones', async () => {
    fs.mkdirSync(inHome('bulk/deeper'), { recursive: true });
    for (let index = 0; index < 5010; index++) fs.writeFileSync(inHome(`bulk/file-${index}.txt`), '');
    fs.writeFileSync(inHome('top.txt'), '');

    const body = (await (await server.fetch('/api/fs/index')).json()) as FsIndexResponse;
    expect(body.truncated).toBe(true);
    expect(body.entries).toHaveLength(5000);
    expect(body.entries.slice(0, 2).map((entry) => entry.path)).toEqual(['bulk', 'top.txt']);
  });

  test('exactly 5000 entries is not truncated', async () => {
    for (let index = 0; index < 5000; index++) fs.writeFileSync(inHome(`file-${index}.txt`), '');
    const body = (await (await server.fetch('/api/fs/index')).json()) as FsIndexResponse;
    expect([body.entries.length, body.truncated]).toEqual([5000, false]);
  });
});

describe('escape attempts', () => {
  /** Everything outside home, by content, so any read-modify-create-delete out there shows up. */
  function outsideState(): Record<string, string> {
    const state: Record<string, string> = {};
    const walk = (folder: string): void => {
      for (const child of fs.readdirSync(folder, { withFileTypes: true })) {
        const abs = path.join(folder, child.name);
        if (child.isDirectory()) {
          state[abs] = '<dir>';
          walk(abs);
        } else state[abs] = fs.readFileSync(abs, 'utf8');
      }
    };
    walk(outside);
    return state;
  }

  let pristine: Record<string, string>;
  beforeEach(() => {
    fs.mkdirSync(path.join(outside, 'folder'));
    fs.writeFileSync(path.join(outside, 'folder/inner.txt'), 'inner');
    fs.symlinkSync(outside, inHome('out-dir'));
    fs.symlinkSync(secret, inHome('leak'));
    fs.symlinkSync(path.join(outside, 'new-via-dangling.txt'), inHome('dangling'));
    fs.writeFileSync(inHome('mine.txt'), 'mine');
    pristine = outsideState();
  });

  /** Paths that name the existing secret file, one per way out. */
  const toSecret = (): Record<string, string> => ({
    'dot-dot': '../outside/secret.txt',
    'dot-dot in the middle': 'a/../../outside/secret.txt',
    absolute: secret,
    'symlinked folder': 'out-dir/secret.txt',
  });
  /** Paths that name something new outside home. */
  const toNew = (): Record<string, string> => ({
    'dot-dot': '../outside/planted.txt',
    absolute: path.join(outside, 'planted.txt'),
    'symlinked folder': 'out-dir/planted.txt',
    'new folders below a symlinked folder': 'out-dir/a/b/planted.txt',
  });
  /** Paths that name the outside folder itself. */
  const toFolder = (): Record<string, string> => ({
    'dot-dot': '../outside',
    'dot-dot only': '..',
    absolute: outside,
    'absolute root': '/',
    'symlinked folder': 'out-dir',
    'folder below a symlinked folder': 'out-dir/folder',
  });

  async function expectRefused(label: string, response: Response): Promise<void> {
    const text = await response.text();
    expect([label, [400, 403].includes(response.status)]).toEqual([label, true]);
    expect([label, (JSON.parse(text) as ApiError).code]).toEqual([
      label,
      response.status === 403 ? 'path_escape' : 'bad_path',
    ]);
    expect(text).not.toContain('top secret');
    expect(text).not.toContain('inner');
    expect(outsideState()).toEqual(pristine);
  }

  test('list refuses every way out', async () => {
    for (const [label, rel] of Object.entries(toFolder())) await expectRefused(label, await list(rel));
  });

  test('stat refuses every way out', async () => {
    for (const [label, rel] of Object.entries(toSecret())) await expectRefused(label, await stat(rel));
    await expectRefused('NUL byte', await server.fetch('/api/fs/stat?path=mine.txt%00.png'));
  });

  test('read refuses every way out', async () => {
    const paths = { ...toSecret(), 'symlinked file': 'leak', 'dangling link': 'dangling' };
    for (const [label, rel] of Object.entries(paths)) await expectRefused(label, await read(rel));
    await expectRefused('NUL byte', await server.fetch('/api/fs/read?path=mine.txt%00'));
    await expectRefused('/etc/passwd', await read('/etc/passwd'));
  });

  test('write refuses every way out, over existing files and for new ones', async () => {
    const paths = { ...toSecret(), 'symlinked file': 'leak', 'dangling link': 'dangling' };
    for (const [label, rel] of Object.entries(paths)) await expectRefused(label, await write(rel, 'pwned'));
    for (const [label, rel] of Object.entries(toNew())) await expectRefused(label, await write(rel, 'pwned'));
  });

  test('mkdir refuses every way out', async () => {
    for (const [label, rel] of Object.entries(toNew())) await expectRefused(label, await post('mkdir', { path: rel }));
    await expectRefused('dangling link', await post('mkdir', { path: 'dangling' }));
  });

  test('rename refuses to move anything out of home', async () => {
    for (const [label, rel] of Object.entries({ ...toNew(), ...toSecret() })) {
      await expectRefused(label, await post('rename', { from: 'mine.txt', to: rel }));
    }
    expect(fs.readFileSync(inHome('mine.txt'), 'utf8')).toBe('mine');
  });

  test('rename refuses to move anything into home', async () => {
    for (const [label, rel] of Object.entries(toSecret())) {
      await expectRefused(label, await post('rename', { from: rel, to: 'stolen.txt' }));
    }
    for (const [label, rel] of Object.entries({ 'dot-dot': '../outside', absolute: outside, below: 'out-dir/folder' })) {
      await expectRefused(label, await post('rename', { from: rel, to: 'stolen' }));
    }
    expect(fs.existsSync(inHome('stolen.txt'))).toBe(false);
    expect(fs.existsSync(inHome('stolen'))).toBe(false);
  });

  test('delete refuses every way out', async () => {
    for (const [label, rel] of Object.entries(toSecret())) await expectRefused(label, await remove(rel));
    for (const [label, rel] of Object.entries({ 'dot-dot': '../outside', absolute: outside, below: 'out-dir/folder' })) {
      await expectRefused(label, await remove(rel));
    }
  });

  test('index lists a link out of home without walking into it', async () => {
    const { entries } = (await (await server.fetch('/api/fs/index')).json()) as FsIndexResponse;
    expect(entries.map((entry) => entry.path).sort()).toEqual(['dangling', 'leak', 'mine.txt', 'out-dir']);
    expect(outsideState()).toEqual(pristine);
  });
});
