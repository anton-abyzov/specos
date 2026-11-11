import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { SystemInfo } from '../../shared/protocol';
import type { Config } from './config';
import type { Ctx } from './context';
import { detectCloneStrategy, detectRunner, findMount } from './probe';

/** NAME and VERSION_ID of the distribution; empty when the file is missing (not Linux, or a bare container). */
function readOsRelease(): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync('/etc/os-release', 'utf8');
  } catch {
    return {};
  }
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const [, key, value] = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()) ?? [];
    if (key && value !== undefined) fields[key] = value.replace(/^(["'])(.*)\1$/, '$2');
  }
  return fields;
}

const osRelease = readOsRelease();

/** Memory the kernel could hand out without swapping. os.freemem() ignores reclaimable cache, so it reads far too low. */
async function availableMemory(): Promise<number> {
  try {
    const kilobytes = /^MemAvailable:\s+(\d+) kB$/m.exec(await fsp.readFile('/proc/meminfo', 'utf8'))?.[1];
    if (kilobytes) return Number(kilobytes) * 1024;
  } catch {
    // Not Linux.
  }
  return os.freemem();
}

/** "7.0.0-42-generic" becomes "7.0": enough for a badge. */
const kernelSeries = (release: string): string => release.split('.').slice(0, 2).join('.');

/** Everything the System window and the menu bar badge show. Probed facts are cached; sizes and load are live. */
export async function systemInfo(config: Config): Promise<SystemInfo> {
  const [mount, space, clone, agentRunner, available] = await Promise.all([
    findMount(config.home),
    fsp.statfs(config.home),
    detectCloneStrategy(config.home),
    detectRunner(config),
    availableMemory(),
  ]);
  const cpus = os.cpus();
  const kernel = os.release();
  return {
    hostname: os.hostname(),
    os: {
      platform: os.platform(),
      name: osRelease.NAME ?? os.type(),
      version: osRelease.VERSION_ID ?? osRelease.VERSION ?? kernel,
    },
    kernel,
    arch: os.arch(),
    // bavail, not bfree: the blocks reserved for root are not space a workspace can use.
    fs: { ...mount, total: space.blocks * space.bsize, free: space.bavail * space.bsize },
    cpu: { model: cpus[0]?.model.trim() ?? 'unknown', cores: cpus.length, load: os.loadavg() as [number, number, number] },
    memory: { total: os.totalmem(), available },
    uptime: os.uptime(),
    node: process.version,
    home: config.home,
    clone,
    agentRunner,
    badge: `${os.type()} ${kernelSeries(kernel)} · ${mount.type}`,
  };
}

export function registerSystem(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/system', () => systemInfo(ctx.config));
}
