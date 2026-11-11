import fs from 'node:fs';
import path from 'node:path';
import type { ApiError } from '../../shared/protocol';

/**
 * The home folder guard. Every path a request names goes through
 * resolveInHome before the file system sees it.
 *
 * Two things can carry a request out of home: the text of the path ("..", an
 * absolute path) and a symlink on disk. The text is checked first and never
 * touches the disk. Symlinks are checked by resolving the deepest part of the
 * path that exists and requiring the result to be home or inside it, which
 * covers reading through a link, writing through one and creating something
 * new below one.
 */

export type PathErrorCode = 'path_escape' | 'bad_path';

const STATUS: Record<PathErrorCode, 400 | 403> = { bad_path: 400, path_escape: 403 };

/** A refused path. The message is safe to show: it never contains an absolute location. */
export class PathError extends Error {
  readonly status: 400 | 403;

  constructor(
    readonly code: PathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PathError';
    this.status = STATUS[code];
  }
}

export interface ResolveOptions {
  /**
   * Whether the last component is followed when it is a symlink. True by
   * default, which suits everything that opens the path. Operations that act
   * on the directory entry itself (lstat, rename, remove) pass false, so a
   * link that points out of home can still be seen and removed. The folders
   * on the way to it are checked either way.
   */
  followLeaf?: boolean;
}

const escape = (message: string): PathError => new PathError('path_escape', message);
const bad = (message: string): PathError => new PathError('bad_path', message);

/** Home never moves while the server runs, so its real path is resolved once per folder. */
const realHomes = new Map<string, string>();

function realHome(home: string): string {
  let real = realHomes.get(home);
  if (real === undefined) {
    real = fs.realpathSync(home);
    realHomes.set(home, real);
  }
  return real;
}

/** True for the folder itself and for anything below it. The separator keeps "/home-evil" out of "/home". */
function isInside(folder: string, candidate: string): boolean {
  return candidate === folder || candidate.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);
}

/** Splits a relative path into its names, or throws when the text alone is unacceptable. */
function segmentsOf(rel: unknown): string[] {
  if (typeof rel !== 'string') throw bad('A path must be a string');
  if (rel.includes('\0')) throw bad('A path cannot contain a NUL byte');
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[a-zA-Z]:/.test(rel)) {
    throw bad('Paths are relative to the home folder and cannot be absolute');
  }
  // Empty names come from doubled or trailing slashes and "." names the folder itself; neither moves anywhere.
  const segments = rel.split('/').filter((segment) => segment !== '' && segment !== '.');
  // Refused outright, without working out where it would land: a correct client never needs "..".
  if (segments.includes('..')) throw escape('A path cannot contain ".."');
  return segments;
}

type Existing = { real: string } | 'missing';

/** Where a path really is when it exists, following every symlink in it. */
function locate(candidate: string): Existing {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    // ENOTDIR: a name on the way is a regular file. Nothing exists here, and the file below is checked next.
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    throw escape('The path cannot be checked');
  }
  try {
    return { real: fs.realpathSync(candidate) };
  } catch {
    // A dangling link (or a loop): opening it for writing would create the target wherever the link points.
    throw escape(stat.isSymbolicLink() ? 'The path is a link with no target' : 'The path cannot be checked');
  }
}

/**
 * Turns a home relative path into an absolute one, or throws a PathError.
 * The result is the path as named, below the real home folder; symlinks in it
 * are verified but not rewritten, so a link is still a link to the caller.
 */
export function resolveInHome(home: string, rel: string, opts: ResolveOptions = {}): string {
  const segments = segmentsOf(rel);
  const root = realHome(home);
  const resolved = path.join(root, ...segments);

  const followLeaf = opts.followLeaf ?? true;
  let probe = followLeaf || segments.length === 0 ? resolved : path.dirname(resolved);
  // Walks up to the deepest part that exists. It ends at home at the latest, which buildApp creates.
  for (;;) {
    const existing = locate(probe);
    if (existing !== 'missing') {
      if (!isInside(root, existing.real)) throw escape('The path leads out of the home folder');
      return resolved;
    }
    if (probe === root) throw escape('The home folder is missing');
    probe = path.dirname(probe);
  }
}

/** The home relative POSIX path of an absolute one, "" for home itself. Throws when it is not in home. */
export function toRel(home: string, abs: string): string {
  // The watcher reports paths below home as configured; the guard returns them below the real home.
  const root = [home, realHome(home)].find((folder) => isInside(folder, abs));
  if (root === undefined) throw escape('The path is outside the home folder');
  return path.relative(root, abs).split(path.sep).join('/');
}

/** The HTTP answer for a refused path, for a route or an error handler. Undefined for any other error. */
export function pathErrorResponse(error: unknown): { status: 400 | 403; body: ApiError } | undefined {
  if (!(error instanceof PathError)) return undefined;
  return { status: error.status, body: { error: error.message, code: error.code } };
}
