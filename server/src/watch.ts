import path from 'node:path';
import { watch } from 'chokidar';
import type { FastifyInstance } from 'fastify';
import type { ChangeKind } from '../../shared/protocol';
import type { Ctx } from './context';
import { SCRATCH_PREFIX } from './paths';

/**
 * The watch channel: one watcher on the home folder that hands every change
 * to the activity journal, whoever made it (the file API, the terminal, an
 * agent, another program). The journal turns it into the `fs` frame on the
 * events socket.
 */

const KINDS: ChangeKind[] = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'];
/** Never watched: git's own bookkeeping and dependency trees change by the thousand and are nobody's edits. */
const IGNORED_NAMES = new Set(['.git', 'node_modules']);

function isIgnored(rel: string): boolean {
  const names = rel.split(path.sep);
  // The server's own temp files (atomic writes, the reflink probe) are plumbing, not changes.
  return names.some((name) => IGNORED_NAMES.has(name)) || (names.at(-1) ?? '').startsWith(SCRATCH_PREFIX);
}

/** Resolves once the watcher has seen the whole tree, so no change after startup can be missed. */
export async function registerWatch(_app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { activity } = ctx;
  if (!activity) throw new Error('The watch module needs the activity journal: register activity before it');
  const { home } = ctx.config;

  const watcher = watch(home, {
    // Tested relative to home, so a home that itself lives below a folder named node_modules still works.
    ignored: (candidate) => isIgnored(path.relative(home, candidate)),
    ignoreInitial: true,
    // A link is reported as a link. Following one would watch, and journal, whatever it points to outside home.
    followSymlinks: false,
    // Events go out the moment the kernel reports them; the desktop shows a file while it is being written.
    awaitWriteFinish: false,
    // A save through temp file and rename is one change, not a delete and a create.
    atomic: true,
    ignorePermissionErrors: true,
  });

  for (const kind of KINDS) {
    watcher.on(kind, (changed) => {
      activity.record(kind, changed).catch((error: Error) => {
        console.error(`SpecOS could not journal a change: ${error.message}`);
      });
    });
  }
  // Without a listener an 'error' event would end the process. Running out of inotify watches is the usual one.
  watcher.on('error', (error) => {
    console.error(`SpecOS file watcher: ${error instanceof Error ? error.message : String(error)}`);
  });
  ctx.onClose(() => watcher.close());

  await new Promise<void>((resolve) => watcher.once('ready', resolve));
}
