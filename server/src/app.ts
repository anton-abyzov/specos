import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { loadConfig, type Config } from './config';
import { EventBus, type Ctx } from './context';

export interface SpecOS {
  app: FastifyInstance;
  ctx: Ctx;
  config: Config;
  /** Starts listening and returns the base URL (without the token). */
  listen(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Builds the server without listening, so tests can start it on a random port.
 * Modules register in order: access control first, then APIs, then static files.
 */
export async function buildApp(overrides: Partial<Config> = {}): Promise<SpecOS> {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.home, { recursive: true });
  fs.mkdirSync(config.data, { recursive: true });

  const closers: Array<() => void | Promise<void>> = [];
  const ctx: Ctx = {
    config,
    bus: new EventBus(),
    onClose: (fn) => void closers.push(fn),
  };

  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  // --- modules register here, access control first ---

  app.get('/api/health', async () => ({ ok: true }));

  if (fs.existsSync(config.clientDist)) {
    await app.register(fastifyStatic, { root: config.clientDist, wildcard: false });
  }

  return {
    app,
    ctx,
    config,
    async listen() {
      await app.listen({ host: config.host, port: config.port });
      const address = app.server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      return `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`;
    },
    async close() {
      for (const fn of closers.reverse()) await fn();
      await app.close();
    },
  };
}
