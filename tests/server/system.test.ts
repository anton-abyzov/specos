import fs from 'node:fs';
import os from 'node:os';
import { afterAll, beforeAll, expect, test } from 'vitest';
import WebSocket from 'ws';
import type { AgentsService } from '../../server/src/agents';
import { detectCloneStrategy, detectRunner, findMount } from '../../server/src/probe';
import type { ServerEvent, SystemInfo, SystemStats } from '../../shared/protocol';
import { startTestServer, type TestServer } from './helpers';

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

function expectFraction(value: number): void {
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(1);
}

test('GET /api/system describes the real machine', async () => {
  const response = await server.fetch('/api/system');
  expect(response.status).toBe(200);
  const info = (await response.json()) as SystemInfo;

  expect(info.hostname).toBe(os.hostname());
  expect(info.kernel).toBe(os.release());
  expect(info.arch).toBe(os.arch());
  expect(info.os.platform).toBe(os.platform());
  expect(info.os.name).not.toBe('');
  expect(info.os.version).not.toBe('');
  expect(info.node).toBe(process.version);
  expect(info.home).toBe(server.home);
  expect(info.uptime).toBeGreaterThan(0);

  expect(info.cpu.cores).toBe(os.cpus().length);
  expect(info.cpu.cores).toBeGreaterThan(0);
  expect(info.cpu.model).not.toBe('');
  expect(info.cpu.load).toHaveLength(3);

  expect(info.memory.total).toBe(os.totalmem());
  expect(info.memory.available).toBeGreaterThan(0);
  expect(info.memory.available).toBeLessThanOrEqual(info.memory.total);
});

test('the file system is the one that holds the home folder', async () => {
  const info = (await (await server.fetch('/api/system')).json()) as SystemInfo;
  expect(info.fs.type).not.toBe('');
  expect(info.fs.total).toBeGreaterThan(0);
  expect(info.fs.free).toBeGreaterThan(0);
  expect(info.fs.free).toBeLessThanOrEqual(info.fs.total);
  // The home folder lives under its mount point.
  const home = fs.realpathSync(server.home);
  expect(home === info.fs.mount || home.startsWith(info.fs.mount.replace(/\/$/, '') + '/')).toBe(true);
  expect(info.fs).toMatchObject(await findMount(server.home));
});

test('the badge is the OS type, the kernel series and the file system', async () => {
  const info = (await (await server.fetch('/api/system')).json()) as SystemInfo;
  expect(info.badge.startsWith(os.type())).toBe(true);
  const [major, minor] = os.release().split('.');
  expect(info.badge).toBe(`${os.type()} ${major}.${minor} · ${info.fs.type}`);
});

test('the clone strategy is probed in the home folder and explains itself', async () => {
  const info = (await (await server.fetch('/api/system')).json()) as SystemInfo;
  const clone = await detectCloneStrategy(server.home);
  expect(info.clone).toEqual(clone);

  expect(['reflink', 'worktree', 'copy']).toContain(clone.strategy);
  expect(clone.strategy === 'reflink').toBe(clone.reflinkSupported);
  // One honest sentence that names the file system.
  expect(clone.reason).toContain(info.fs.type);
  expect(clone.reason).not.toMatch(/[.\n]/);
  // The probe cleans up after itself. Projects/ and Workspaces/ are made at start and belong there.
  expect(fs.readdirSync(server.home).filter((name) => name.startsWith('.specos-'))).toEqual([]);
});

test('the demo setting forces the demo runner without looking for claude', async () => {
  expect(await detectRunner({ agent: 'demo' })).toEqual({ available: 'demo' });
  const info = (await (await server.fetch('/api/system')).json()) as SystemInfo;
  expect(info.agentRunner).toEqual({ available: 'demo' });
});

test('GET /api/system/stats returns a sample without any desktop connected', async () => {
  const stats = (await (await server.fetch('/api/system/stats')).json()) as SystemStats;
  expectFraction(stats.cpu);
  expectFraction(stats.memory);
  expect(stats.memoryTotal).toBe(os.totalmem());
  expect(stats.memoryUsed).toBeCloseTo(stats.memory * stats.memoryTotal, -3);
  expect(stats.agentsRunning).toBe(0);
  expect(Date.now() - stats.at).toBeLessThan(2000);
});

test('a connected desktop receives stats every tick, and the tick stops when it leaves', async () => {
  const { ctx } = server.specos;
  ctx.agents = { ...(ctx.agents as AgentsService), runningCount: () => 2 };
  const seen: SystemStats[] = [];
  const stopListening = ctx.bus.on((event) => {
    if (event.type === 'stats') seen.push(event.stats);
  });

  const socket = new WebSocket(server.wsUrl + '/ws', { headers: { cookie: server.cookie } });
  try {
    const connectedAt = Date.now();
    const stats = await new Promise<SystemStats>((resolve, reject) => {
      socket.on('message', (data) => {
        const event = JSON.parse(data.toString()) as ServerEvent;
        if (event.type === 'stats') resolve(event.stats);
      });
      socket.once('error', reject);
    });
    expect(Date.now() - connectedAt).toBeLessThan(3000);
    expectFraction(stats.cpu);
    expectFraction(stats.memory);
    expect(stats.memory).toBeGreaterThan(0);
    expect(stats.agentsRunning).toBe(2);

    // The latest sample is also what the endpoint serves between ticks.
    expect(await (await server.fetch('/api/system/stats')).json()).toEqual(stats);
  } finally {
    socket.terminate();
  }

  await expect.poll(() => ctx.sockets?.eventClients()).toBe(0);
  const before = seen.length;
  await new Promise((resolve) => setTimeout(resolve, 2300));
  expect(seen.length).toBe(before);
  stopListening();
});
