import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PathError, pathErrorResponse, resolveInHome, toRel } from '../../server/src/paths';

/**
 * A home folder with one outside world next to it:
 *
 *   base/home/            the sandbox
 *   base/home-evil/       a sibling whose name starts with the home's name
 *   base/outside/         everything a request must never reach
 */
let base: string;
let home: string;
let outside: string;
let secret: string;

beforeAll(() => {
  // realpath, because the temp folder itself may sit behind a symlink (macOS) and the assertions compare paths.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'specos-paths-')));
  home = path.join(base, 'home');
  outside = path.join(base, 'outside');
  secret = path.join(outside, 'secret.txt');
  fs.mkdirSync(path.join(home, 'docs/deep'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'folder'), { recursive: true });
  fs.mkdirSync(path.join(base, 'home-evil'));
  fs.writeFileSync(path.join(home, 'docs/note.txt'), 'inside');
  fs.writeFileSync(secret, 'outside');
  fs.writeFileSync(path.join(outside, 'folder/inner.txt'), 'outside');
  fs.writeFileSync(path.join(base, 'home-evil/loot.txt'), 'outside');

  fs.symlinkSync('/etc', path.join(home, 'etc-link'));
  fs.symlinkSync(secret, path.join(home, 'secret-link'));
  fs.symlinkSync(outside, path.join(home, 'outside-dir'));
  fs.symlinkSync(path.join(outside, 'not-there.txt'), path.join(home, 'dangling'));
  fs.symlinkSync(path.join(base, 'home-evil'), path.join(home, 'sibling-link'));
  fs.symlinkSync(path.join(home, 'docs'), path.join(home, 'docs-link'));
  fs.symlinkSync('docs/note.txt', path.join(home, 'note-link'));
});

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

/** Runs the guard and returns the PathError it must throw. */
function refusal(rel: unknown, opts?: Parameters<typeof resolveInHome>[2]): PathError {
  try {
    resolveInHome(home, rel as string, opts);
  } catch (error) {
    if (error instanceof PathError) return error;
    throw error;
  }
  throw new Error(`Expected ${JSON.stringify(rel)} to be refused`);
}

describe('paths that climb out', () => {
  test('".." is refused as an escape', () => {
    expect(refusal('..')).toMatchObject({ code: 'path_escape', status: 403 });
  });

  test('"a/../../b" is refused as an escape', () => {
    expect(refusal('a/../../b')).toMatchObject({ code: 'path_escape', status: 403 });
  });

  test('"a/b/../../.." is refused as an escape', () => {
    expect(refusal('a/b/../../..')).toMatchObject({ code: 'path_escape', status: 403 });
  });

  test('a ".." segment is refused even when the path would end up inside home', () => {
    expect(refusal('docs/../docs/note.txt')).toMatchObject({ code: 'path_escape', status: 403 });
  });
});

describe('paths that are not relative', () => {
  test('"/etc/passwd" is refused as a bad path', () => {
    expect(refusal('/etc/passwd')).toMatchObject({ code: 'bad_path', status: 400 });
  });

  test('an absolute path inside home is still refused: only relative paths are accepted', () => {
    expect(refusal(path.join(home, 'docs/note.txt'))).toMatchObject({ code: 'bad_path', status: 400 });
  });

  test('a Windows drive or a backslash root is refused as a bad path', () => {
    expect(refusal('C:\\Windows\\system32')).toMatchObject({ code: 'bad_path', status: 400 });
    expect(refusal('c:/Windows')).toMatchObject({ code: 'bad_path', status: 400 });
    expect(refusal('\\\\server\\share')).toMatchObject({ code: 'bad_path', status: 400 });
  });
});

describe('input that is not a path at all', () => {
  test('"\\0" is refused as a bad path', () => {
    expect(refusal('\0')).toMatchObject({ code: 'bad_path', status: 400 });
    expect(refusal('docs/note.txt\0.png')).toMatchObject({ code: 'bad_path', status: 400 });
  });

  test('anything but a string is refused as a bad path', () => {
    for (const value of [undefined, null, 7, ['docs'], { path: 'docs' }]) {
      expect(refusal(value)).toMatchObject({ code: 'bad_path', status: 400 });
    }
  });
});

describe('symlinks that leave home', () => {
  test('a symlink to /etc is refused', () => {
    expect(refusal('etc-link')).toMatchObject({ code: 'path_escape', status: 403 });
    expect(refusal('etc-link/passwd')).toMatchObject({ code: 'path_escape', status: 403 });
  });

  test('a symlink to a file outside is refused', () => {
    expect(refusal('secret-link')).toMatchObject({ code: 'path_escape', status: 403 });
  });

  test('a nested path through an escaping symlink folder is refused', () => {
    expect(refusal('outside-dir/folder/inner.txt')).toMatchObject({ code: 'path_escape', status: 403 });
  });

  test('creating a new file under an escaping symlink folder is refused', () => {
    expect(refusal('outside-dir/new.txt')).toMatchObject({ code: 'path_escape', status: 403 });
    expect(refusal('outside-dir/new-folder/deeper/new.txt')).toMatchObject({ code: 'path_escape', status: 403 });
  });

  test('writing through a dangling symlink is refused', () => {
    expect(refusal('dangling')).toMatchObject({ code: 'path_escape', status: 403 });
    expect(refusal('dangling/child.txt')).toMatchObject({ code: 'path_escape', status: 403 });
    expect(fs.existsSync(path.join(outside, 'not-there.txt'))).toBe(false);
  });

  test('a sibling folder that shares the home prefix (home-evil next to home) is refused', () => {
    expect(refusal('sibling-link')).toMatchObject({ code: 'path_escape', status: 403 });
    expect(refusal('sibling-link/loot.txt')).toMatchObject({ code: 'path_escape', status: 403 });
  });

  test('the link itself may be addressed without following it, so it can be listed, renamed or removed', () => {
    expect(resolveInHome(home, 'etc-link', { followLeaf: false })).toBe(path.join(home, 'etc-link'));
    expect(resolveInHome(home, 'dangling', { followLeaf: false })).toBe(path.join(home, 'dangling'));
    // Only the last component is exempt: the folders on the way are still followed and checked.
    expect(refusal('outside-dir/secret.txt', { followLeaf: false })).toMatchObject({ code: 'path_escape' });
  });
});

describe('paths that stay inside', () => {
  test('the empty string is home', () => {
    expect(resolveInHome(home, '')).toBe(home);
    expect(resolveInHome(home, '.')).toBe(home);
    expect(resolveInHome(home, './')).toBe(home);
  });

  test('an existing file and a file that does not exist yet both resolve', () => {
    expect(resolveInHome(home, 'docs/note.txt')).toBe(path.join(home, 'docs/note.txt'));
    expect(resolveInHome(home, 'docs/new/folder/file.txt')).toBe(path.join(home, 'docs/new/folder/file.txt'));
  });

  test('duplicate slashes and "." segments collapse', () => {
    expect(resolveInHome(home, 'docs//deep/./')).toBe(path.join(home, 'docs/deep'));
  });

  test('a symlink that stays inside home is allowed', () => {
    expect(resolveInHome(home, 'docs-link/note.txt')).toBe(path.join(home, 'docs-link/note.txt'));
    expect(resolveInHome(home, 'docs-link/new.txt')).toBe(path.join(home, 'docs-link/new.txt'));
    expect(resolveInHome(home, 'note-link')).toBe(path.join(home, 'note-link'));
  });

  test('unicode and spaces are allowed', () => {
    const rel = 'Мои заметки/日本語 ノート/café notes 🚀.md';
    expect(resolveInHome(home, rel)).toBe(path.join(home, rel));
  });

  test('a backslash is an ordinary character in a name', () => {
    expect(resolveInHome(home, 'docs/a\\b.txt')).toBe(path.join(home, 'docs', 'a\\b.txt'));
  });

  test('a path below a regular file resolves, and the file system reports the real problem later', () => {
    expect(resolveInHome(home, 'docs/note.txt/child')).toBe(path.join(home, 'docs/note.txt/child'));
  });

  test('a home folder that is itself reached through a symlink still works', () => {
    const alias = path.join(base, 'home-alias');
    fs.symlinkSync(home, alias);
    expect(resolveInHome(alias, 'docs/note.txt')).toBe(path.join(home, 'docs/note.txt'));
    expect(() => resolveInHome(alias, 'outside-dir/secret.txt')).toThrow(PathError);
  });
});

describe('toRel', () => {
  test('gives the POSIX path relative to home, and "" for home itself', () => {
    expect(toRel(home, home)).toBe('');
    expect(toRel(home, path.join(home, 'docs', 'deep'))).toBe('docs/deep');
    expect(toRel(home, resolveInHome(home, 'docs//note.txt'))).toBe('docs/note.txt');
  });

  test('refuses a path outside home, the sibling prefix included', () => {
    expect(() => toRel(home, secret)).toThrow(PathError);
    expect(() => toRel(home, path.join(base, 'home-evil/loot.txt'))).toThrow(PathError);
  });
});

describe('pathErrorResponse', () => {
  test('turns a PathError into its status and a JSON ApiError', () => {
    expect(pathErrorResponse(refusal('..'))).toEqual({
      status: 403,
      body: { error: expect.any(String), code: 'path_escape' },
    });
    expect(pathErrorResponse(refusal('/etc/passwd'))).toEqual({
      status: 400,
      body: { error: expect.any(String), code: 'bad_path' },
    });
  });

  test('never repeats the absolute location of home to the caller', () => {
    for (const rel of ['..', '/etc/passwd', 'etc-link', 'outside-dir/new.txt', 'dangling']) {
      expect(pathErrorResponse(refusal(rel))?.body.error).not.toContain(base);
    }
  });

  test('leaves every other error alone', () => {
    expect(pathErrorResponse(new Error('disk on fire'))).toBeUndefined();
  });
});
