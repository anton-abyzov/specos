import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { SystemInfo, SystemStats } from '../../shared/protocol';
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

// ---------------------------------------------------------------- live stats

const STATS_INTERVAL_MS = 2000;

interface CpuTimes {
  busy: number;
  total: number;
}

/** Processor time since boot, summed over all cores. */
function readCpuTimes(): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    const all = times.user + times.nice + times.sys + times.irq + times.idle;
    busy += all - times.idle;
    total += all;
  }
  return { busy, total };
}

/**
 * Takes samples of CPU and memory use. The kernel only counts processor time
 * since boot, so load is the busy share of the time that passed between two
 * readings; each sample measures the stretch since the one before.
 */
function createSampler(agentsRunning: () => number) {
  let previous = readCpuTimes();
  return {
    /** Starts a fresh measuring window, so a long idle gap is not averaged into the next sample. */
    rebase(): void {
      previous = readCpuTimes();
    },
    async sample(): Promise<SystemStats> {
      const available = await availableMemory();
      const current = readCpuTimes();
      const elapsed = current.total - previous.total;
      const cpu = elapsed > 0 ? Math.min(1, Math.max(0, (current.busy - previous.busy) / elapsed)) : 0;
      previous = current;
      const memoryTotal = os.totalmem();
      const memoryUsed = Math.max(0, memoryTotal - available);
      return { at: Date.now(), cpu, memory: memoryUsed / memoryTotal, memoryUsed, memoryTotal, agentsRunning: agentsRunning() };
    },
  };
}

export function registerSystem(app: FastifyInstance, ctx: Ctx): void {
  const { sockets } = ctx;
  if (!sockets) throw new Error('The system module needs the socket registry: register ws before it');

  // Read through ctx on every sample, because the agents module registers after this one.
  const sampler = createSampler(() => ctx.agents?.runningCount() ?? 0);
  let latest: SystemStats | undefined;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    latest = await sampler.sample();
    ctx.bus.emit({ type: 'stats', stats: latest });
  };
  const stop = (): void => {
    clearInterval(timer);
    timer = undefined;
  };

  // Nobody reads the numbers when no desktop is open, so the server only measures while one is.
  const stopWatchingClients = sockets.onEventClients((count) => {
    if (count === 0) return stop();
    if (timer) return;
    sampler.rebase();
    timer = setInterval(() => void tick(), STATS_INTERVAL_MS);
  });
  ctx.onClose(() => {
    stopWatchingClients();
    stop();
  });

  app.get('/api/system', () => systemInfo(ctx.config));

  app.get('/api/system/stats', async (): Promise<SystemStats> => {
    // Between ticks the latest sample is current; without a desktop connected it is stale, so take one now.
    if (latest && Date.now() - latest.at < STATS_INTERVAL_MS) return latest;
    return (latest = await sampler.sample());
  });
}
