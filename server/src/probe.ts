import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRunner, CloneStrategyInfo } from '../../shared/protocol';
import type { Config } from './config';
import { AS_SERVER, git } from './git';

/**
 * Facts about the machine that cannot change while the server runs: which file
 * system holds the home folder, whether it can clone files without copying
 * them, and which agent runner exists. Each is probed once and remembered.
 */

export interface MountInfo {
  /** File system type, for example "ext4". "unknown" when the platform cannot say. */
  type: string;
  device: string;
  mount: string;
}

export interface RunnerInfo {
  available: AgentRunner;
  claudeVersion?: string;
}

/** Runs a command and resolves with its stdout; rejects on a non-zero exit, a missing binary or a timeout. */
function run(command: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

/** Remembers the first result for each key; a probe is a fact about the machine, not about the moment. */
function oncePerKey<T>(probe: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const results = new Map<string, Promise<T>>();
  return (key) => {
    let result = results.get(key);
    if (!result) results.set(key, (result = probe(key)));
    return result;
  };
}

// ---------------------------------------------------------------- mount

async function mountFromFindmnt(dir: string): Promise<MountInfo> {
  const [type, device, ...mount] = (await run('findmnt', ['-no', 'FSTYPE,SOURCE,TARGET', '-T', dir])).trim().split(/\s+/);
  if (!type || !device || mount.length === 0) throw new Error('findmnt printed no mount');
  return { type, device, mount: mount.join(' ') };
}

/** /proc/mounts writes space, tab, newline and backslash inside a field as a three digit octal escape. */
const unescapeMountField = (field: string): string =>
  field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));

async function mountFromProc(dir: string): Promise<MountInfo> {
  const table = await fsp.readFile('/proc/mounts', 'utf8');
  let best: MountInfo | undefined;
  for (const line of table.split('\n')) {
    const [device, rawMount, type] = line.split(' ');
    if (!device || !rawMount || !type) continue;
    const mount = unescapeMountField(rawMount);
    const contains = mount === '/' || dir === mount || dir.startsWith(mount + '/');
    // Later lines win ties: a mount stacked on the same point shadows the earlier one.
    if (contains && (!best || mount.length >= best.mount.length)) best = { type, device: unescapeMountField(device), mount };
  }
  if (!best) throw new Error('no mount point contains the folder');
  return best;
}

/** The mount that holds an existing folder. */
export const findMount = oncePerKey(async (dir): Promise<MountInfo> => {
  const real = await fsp.realpath(dir);
  try {
    return await mountFromFindmnt(real);
  } catch {
    // No findmnt (minimal containers), fall through to the kernel's own table.
  }
  try {
    return await mountFromProc(real);
  } catch {
    return { type: 'unknown', device: '', mount: path.parse(real).root };
  }
});

// ---------------------------------------------------------------- clone strategy

/** Tries a real reflink copy inside the folder, because support depends on the file system and its options. */
async function reflinkWorks(dir: string): Promise<boolean> {
  const scratch = await fsp.mkdtemp(path.join(dir, '.specos-probe-'));
  try {
    const source = path.join(scratch, 'source');
    await fsp.writeFile(source, 'reflink probe\n');
    await run('cp', ['--reflink=always', source, path.join(scratch, 'clone')]);
    return true;
  } catch {
    return false;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

/** Test the operation in home: Git can exist while worktrees are disallowed there. */
async function worktreeWorks(home: string): Promise<boolean> {
  const scratch = await fsp.mkdtemp(path.join(home, '.specos-probe-'));
  const repository = path.join(scratch, 'repository');
  try {
    await fsp.mkdir(repository);
    await git(repository, ['init', '--quiet']);
    await git(repository, [...AS_SERVER, 'commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'Workspace capability probe']);
    await git(repository, ['worktree', 'add', '--quiet', '--detach', path.join(scratch, 'checkout'), 'HEAD']);
    return true;
  } catch {
    return false;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

/** How "give this agent its own copy" will clone a project that lives in this home folder. */
export const detectCloneStrategy = oncePerKey(async (home): Promise<CloneStrategyInfo> => {
  const [{ type }, reflinkSupported] = await Promise.all([findMount(home), reflinkWorks(home)]);
  if (reflinkSupported) {
    return { strategy: 'reflink', reflinkSupported, reason: `${type} supports reflinks, so workspaces are copy-on-write clones` };
  }
  if (os.platform() !== 'linux') {
    return {
      strategy: 'copy',
      reflinkSupported,
      reason: `Reflink copies of ${type} are not available on ${os.type()}, so workspaces are plain copies`,
    };
  }
  if (await worktreeWorks(home)) {
    return { strategy: 'worktree', reflinkSupported, reason: `${type} has no reflinks, so workspaces are git worktrees` };
  }
  return {
    strategy: 'copy',
    reflinkSupported,
    reason: `${type} has no reflinks and git worktrees are unavailable here, so workspaces are independent plain copies`,
  };
});

// ---------------------------------------------------------------- agent runner

/** First line of `claude --version`, or undefined when claude is not on PATH or does not answer in time. */
const claudeVersion = (): Promise<string | undefined> =>
  run('claude', ['--version'], 3000).then(
    (stdout) => stdout.trim().split('\n')[0] || undefined,
    () => undefined,
  );

const detectRunnerFor = oncePerKey(async (mode): Promise<RunnerInfo> => {
  if (mode === 'demo') return { available: 'demo' };
  const version = await claudeVersion();
  // Asking for claude outright is honoured even when it cannot be found; the job then fails with a clear error
  // instead of silently running the scripted agent.
  if (version === undefined) return { available: mode === 'claude' ? 'claude' : 'demo' };
  return { available: 'claude', claudeVersion: version };
});

/** Which runner agent jobs use: SPECOS_AGENT forces one, "auto" picks claude when it is on PATH. */
export const detectRunner = (config: Pick<Config, 'agent'>): Promise<RunnerInfo> => detectRunnerFor(config.agent);
