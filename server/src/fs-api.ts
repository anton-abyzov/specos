import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ApiError,
  EntryKind,
  FsEntry,
  FsIndexResponse,
  FsListResponse,
  FsMkdirRequest,
  FsRenameRequest,
  OkResponse,
} from '../../shared/protocol';
import type { Ctx } from './context';
import { pathErrorResponse, resolveInHome, SCRATCH_PREFIX, toRel } from './paths';

/**
 * The file API: everything the desktop does to the home folder. Each path a
 * request names goes through resolveInHome first, so nothing here can reach a
 * file outside home, whether by "..", an absolute path or a symlink.
 */

const MAX_WRITE_BYTES = 32 * 1024 * 1024;
const INDEX_CAP = 5000;
/** Folders the index does not descend into: huge, and never what someone is looking for. */
const INDEX_SKIPPED = new Set(['.git', 'node_modules']);

// ---------------------------------------------------------------- errors

/** A refusal with its HTTP status, thrown from a route and turned into an ApiError by the scope's handler. */
class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What the file system said, in terms a client can act on. */
const ERRNO: Record<string, [status: number, code: string, message: string]> = {
  ENOENT: [404, 'not_found', 'No such file or folder'],
  ENOTDIR: [400, 'not_a_directory', 'A name in the path is a file, not a folder'],
  EISDIR: [400, 'is_directory', 'The path is a folder'],
  EEXIST: [409, 'conflict', 'Something with that name already exists'],
  ENOTEMPTY: [409, 'conflict', 'The folder is not empty'],
  EINVAL: [400, 'bad_request', 'The file system refused the operation'],
  ENAMETOOLONG: [400, 'bad_path', 'The name is too long'],
  EACCES: [403, 'forbidden', 'The server may not access that path'],
  EPERM: [403, 'forbidden', 'The server may not access that path'],
};

function toApiError(error: unknown): { status: number; body: ApiError } {
  const refused = pathErrorResponse(error);
  if (refused) return refused;
  if (error instanceof ApiFailure) return { status: error.status, body: { error: error.message, code: error.code } };
  const { code, statusCode, message } = error as FastifyError;
  const known = code === undefined ? undefined : ERRNO[code];
  if (known) return { status: known[0], body: { error: known[2], code: known[1] } };
  // Fastify's own refusals (body too large, malformed JSON) carry a status and a message written for clients.
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return { status: statusCode, body: { error: message, code: 'bad_request' } };
  }
  // Anything else may quote an absolute path, so the client only learns that it failed.
  return { status: 500, body: { error: 'The file operation failed', code: 'internal' } };
}

// ---------------------------------------------------------------- entries

function kindOf(stat: fs.Stats | fs.Dirent): EntryKind {
  if (stat.isSymbolicLink()) return 'symlink';
  return stat.isDirectory() ? 'dir' : 'file';
}

/** Describes a directory entry from its lstat, so a symlink is reported as itself and never followed. */
function toEntry(rel: string, stat: fs.Stats): FsEntry {
  const name = path.posix.basename(rel);
  const kind = kindOf(stat);
  return {
    name,
    path: rel,
    kind,
    size: kind === 'dir' ? 0 : stat.size,
    mtime: Math.round(stat.mtimeMs),
    ext: kind === 'dir' ? '' : path.posix.extname(name).slice(1).toLowerCase(),
    hidden: name.startsWith('.'),
  };
}

const naturalOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Folders first, then names the way a person sorts them: "b2" before "B10", case ignored. */
function compareEntries(a: FsEntry, b: FsEntry): number {
  const folders = Number(b.kind === 'dir') - Number(a.kind === 'dir');
  if (folders !== 0) return folders;
  // The plain comparison only settles names the collator calls equal ("a" and "A"), to keep the order stable.
  return naturalOrder.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

// ---------------------------------------------------------------- content types

const TEXT = 'text/plain; charset=utf-8';

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

// HTML is in this list on purpose: it is shown as source, never rendered in the desktop's origin.
const TEXT_EXTENSIONS = new Set(
  (
    'txt text md markdown mdx log csv tsv json jsonl json5 ndjson yaml yml toml ini cfg conf env properties lock ' +
    'html htm xhtml xml css scss sass less js mjs cjs jsx ts mts cts tsx vue svelte astro ' +
    'py rb php java kt kts swift c h cc cpp hpp cs go rs zig lua pl r sql graphql gql proto ' +
    'sh bash zsh fish ps1 bat cmd dockerfile makefile mk cmake gradle tf hcl nix ' +
    'diff patch tex rst adoc org srt vtt gitignore gitattributes editorconfig npmrc'
  ).split(' '),
);

/** Well known text files that have no extension to go by. */
const TEXT_NAMES = new Set(['readme', 'license', 'licence', 'makefile', 'dockerfile', 'changelog', 'authors', 'notice']);

function contentTypeOf(name: string): string {
  const lower = name.toLowerCase();
  // ".gitignore" has no extension as far as path.extname is concerned; its name without the dot says what it is.
  const ext = path.posix.extname(lower).slice(1) || (lower.startsWith('.') ? lower.slice(1) : '');
  if (IMAGE_TYPES[ext]) return IMAGE_TYPES[ext];
  if (TEXT_EXTENSIONS.has(ext) || TEXT_NAMES.has(lower)) return TEXT;
  return 'application/octet-stream';
}

/** RFC 5987 encoding, so any file name survives the header. */
function inlineDisposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `inline; filename*=UTF-8''${encoded}`;
}

// ---------------------------------------------------------------- index

/** Every path under home, nearest first, so a cap cuts off the deep end of big trees rather than whole folders. */
async function indexFolder(root: string): Promise<FsIndexResponse> {
  const entries: FsIndexResponse['entries'] = [];
  const queue = [''];
  // Reading the queue in order while appending to it is the breadth-first walk.
  for (let next = 0; next < queue.length; next++) {
    const folder = queue[next] as string;
    let children: fs.Dirent[];
    try {
      children = await fsp.readdir(path.join(root, folder), { withFileTypes: true });
    } catch {
      continue; // Removed while the walk was on its way, or not readable: either way nothing to offer.
    }
    children.sort((a, b) => naturalOrder.compare(a.name, b.name));
    for (const child of children) {
      if (INDEX_SKIPPED.has(child.name) || child.name.startsWith(SCRATCH_PREFIX)) continue;
      if (entries.length === INDEX_CAP) return { entries, truncated: true };
      const rel = folder === '' ? child.name : `${folder}/${child.name}`;
      entries.push({ name: child.name, path: rel, kind: kindOf(child) });
      // A Dirent for a symlink is not a directory, so links are listed but never walked into.
      if (child.isDirectory()) queue.push(rel);
    }
  }
  return { entries, truncated: false };
}

// ---------------------------------------------------------------- routes

type PathQuery = { path?: unknown };

/** A JSON body as an object whose fields are still unchecked; the path guard validates the paths themselves. */
function bodyOf<T>(request: FastifyRequest): Partial<Record<keyof T, unknown>> {
  const { body } = request;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiFailure(400, 'bad_request', 'The request needs a JSON object as its body');
  }
  return body as Partial<Record<keyof T, unknown>>;
}

async function statIfExists(abs: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.stat(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function lstatIfExists(abs: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.lstat(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function registerFsApi(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { home } = ctx.config;

  /** For operations that open the path: the last component is followed, so it must lead somewhere inside home. */
  const opened = (rel: unknown): string => resolveInHome(home, rel as string);
  /** For operations on the directory entry itself: a link is addressed as a link, wherever it points. */
  const named = (rel: unknown): string => resolveInHome(home, rel as string, { followLeaf: false });
  const entryAt = async (abs: string): Promise<FsEntry> => toEntry(toRel(home, abs), await fsp.lstat(abs));

  // A scope of its own, so the error format and the raw body parser below apply to these routes only.
  await app.register(async (api) => {
    api.setErrorHandler((error, _request, reply) => {
      const { status, body } = toApiError(error);
      return reply.code(status).send(body);
    });

    api.get('/api/fs/list', async (request): Promise<FsListResponse> => {
      const abs = opened((request.query as PathQuery).path ?? '');
      const names = await fsp.readdir(abs);
      const entries = await Promise.all(
        names.map(async (name) => {
          // A file can vanish between the listing and its lstat; it is simply no longer part of the folder.
          const stat = await lstatIfExists(path.join(abs, name));
          return stat && toEntry(toRel(home, path.join(abs, name)), stat);
        }),
      );
      return { path: toRel(home, abs), entries: entries.filter((entry) => entry !== undefined).sort(compareEntries) };
    });

    api.get('/api/fs/stat', async (request): Promise<FsEntry> => entryAt(named((request.query as PathQuery).path)));

    api.get('/api/fs/read', async (request, reply: FastifyReply) => {
      const abs = opened((request.query as PathQuery).path);
      // Non-blocking, so a FIFO someone left in home answers "not a file" instead of hanging the request.
      const handle = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      let stat: fs.Stats;
      try {
        // Checked on the open handle, so it is the very file that is streamed.
        stat = await handle.stat();
        if (stat.isDirectory()) throw new ApiFailure(400, 'is_directory', 'A folder cannot be read as a file');
        if (!stat.isFile()) throw new ApiFailure(400, 'not_a_file', 'Only regular files can be read');
      } catch (error) {
        await handle.close();
        throw error;
      }
      // A file in home is untrusted content. The type is never guessed by the browser, HTML arrives as plain
      // text, and the sandbox gives whatever is rendered (an SVG) an opaque origin where scripts do not run.
      return reply
        .header('content-type', contentTypeOf(path.basename(abs)))
        .header('content-length', stat.size)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', 'sandbox')
        .header('content-disposition', inlineDisposition(path.basename(abs)))
        .send(handle.createReadStream());
    });

    api.post('/api/fs/mkdir', async (request): Promise<FsEntry> => {
      const abs = opened(bodyOf<FsMkdirRequest>(request).path);
      // Recursive mkdir succeeds when the folder is already there, which is what makes this idempotent.
      await fsp.mkdir(abs, { recursive: true });
      return entryAt(abs);
    });

    api.post('/api/fs/rename', async (request): Promise<FsEntry> => {
      const body = bodyOf<FsRenameRequest>(request);
      const from = named(body.from);
      const to = named(body.to);
      if (toRel(home, from) === '' || toRel(home, to) === '') {
        throw new ApiFailure(400, 'bad_request', 'The home folder cannot be renamed or replaced');
      }
      await fsp.lstat(from); // 404 for a missing source before the target is judged.
      // rename(2) silently replaces the target. There is one user, so checking first is enough to make that explicit.
      if (await lstatIfExists(to)) throw new ApiFailure(409, 'conflict', 'Something with that name already exists');
      await fsp.rename(from, to);
      return entryAt(to);
    });

    api.delete('/api/fs/delete', async (request): Promise<OkResponse> => {
      const abs = named((request.query as PathQuery).path);
      if (toRel(home, abs) === '') throw new ApiFailure(400, 'bad_request', 'The home folder cannot be deleted');
      // rm removes a symlink itself and never what it points to, also inside a folder it clears recursively.
      await fsp.rm(abs, { recursive: true });
      return { ok: true };
    });

    api.get('/api/fs/index', (): Promise<FsIndexResponse> => indexFolder(resolveInHome(home, '')));

    // Uploads are bytes whatever their Content-Type says, JSON included, so this route replaces every parser.
    await api.register(async (raw) => {
      raw.removeAllContentTypeParsers();
      raw.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_WRITE_BYTES }, (_request, body, done) =>
        done(null, body),
      );

      raw.put('/api/fs/write', { bodyLimit: MAX_WRITE_BYTES }, async (request): Promise<FsEntry> => {
        const abs = opened((request.query as PathQuery).path);
        // An empty upload has no body to parse and arrives as undefined.
        const content = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

        const existing = await statIfExists(abs);
        if (existing?.isDirectory()) throw new ApiFailure(400, 'is_directory', 'A folder cannot be written as a file');
        // Through a link (inside home, or the guard had refused) the file it names is replaced, not the link.
        const target = existing ? await fsp.realpath(abs) : abs;
        if (!existing) await fsp.mkdir(path.dirname(abs), { recursive: true });

        // Written next to the target and renamed over it: a reader sees the old file or the new one, never half.
        const temp = path.join(path.dirname(target), `${SCRATCH_PREFIX}write-${randomBytes(6).toString('hex')}`);
        try {
          await fsp.writeFile(temp, content, { flag: 'wx' });
          // The new inode would otherwise drop the executable bit of a script that is being edited.
          if (existing) await fsp.chmod(temp, existing.mode & 0o7777);
          await fsp.rename(temp, target);
        } catch (error) {
          await fsp.rm(temp, { force: true });
          throw error;
        }
        return entryAt(abs);
      });
    });
  });
}
