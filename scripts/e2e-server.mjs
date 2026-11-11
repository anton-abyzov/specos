// Builds the client into its own folder and starts a server with a throwaway
// home, so several end-to-end runs can work side by side on different ports.
//   E2E_PORT=7391 node scripts/e2e-server.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.E2E_PORT ?? '7391';
const base = path.join(root, '.e2e');
const dist = path.join(base, `dist-${port}`);
// The home is not kept inside this repository: agent workspaces are git worktrees of the
// projects in it, and a checkout nested in another checkout is not always allowed to make one.
const sandbox = path.join(os.tmpdir(), `specos-e2e-${port}`);
const home = path.join(sandbox, 'home');
const data = path.join(sandbox, 'data');
const bin = (name) => path.join(root, 'node_modules/.bin', name);

fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });

if (process.env.E2E_SKIP_BUILD !== '1' || !fs.existsSync(dist)) {
  const build = spawnSync(bin('vite'), ['build', '--config', 'client/vite.config.ts', '--logLevel', 'warn'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SPECOS_OUT_DIR: dist },
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const server = spawn(bin('tsx'), ['server/src/main.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: port,
    SPECOS_HOME: home,
    SPECOS_DATA: data,
    SPECOS_TOKEN: process.env.E2E_TOKEN ?? 'e2e-token-0123456789',
    SPECOS_CLIENT_DIST: dist,
    SPECOS_AGENT: process.env.SPECOS_AGENT ?? 'demo',
  },
});
const stop = () => server.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('exit', (code) => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  process.exit(code ?? 0);
});
