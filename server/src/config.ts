import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface Config {
  host: string;
  port: number;
  /** Absolute path of the sandboxed home folder. */
  home: string;
  /** Absolute path of server state (journal, registries). Never inside home. */
  data: string;
  /** Access token. Random per start unless SPECOS_TOKEN is set. */
  token: string;
  /** Absolute path of the built client. */
  clientDist: string;
  /** Which agent runner to use: auto picks claude when it is on PATH. */
  agent: 'auto' | 'claude' | 'demo';
  /** Extra flags for the claude runner. */
  claudeArgs: string[];
  /** Repository root. */
  root: string;
}

export function loadConfig(overrides: Partial<Config> = {}, env: NodeJS.ProcessEnv = process.env): Config {
  const agent = env.SPECOS_AGENT === 'claude' || env.SPECOS_AGENT === 'demo' ? env.SPECOS_AGENT : 'auto';
  return {
    host: env.HOST ?? '0.0.0.0',
    port: env.PORT ? Number(env.PORT) : 7300,
    home: path.resolve(env.SPECOS_HOME ?? path.join(root, 'home')),
    data: path.resolve(env.SPECOS_DATA ?? path.join(root, 'data')),
    token: env.SPECOS_TOKEN && env.SPECOS_TOKEN.length >= 8 ? env.SPECOS_TOKEN : randomBytes(32).toString('base64url'),
    clientDist: path.resolve(env.SPECOS_CLIENT_DIST ?? path.join(root, 'client/dist')),
    agent,
    claudeArgs: env.SPECOS_CLAUDE_ARGS ? env.SPECOS_CLAUDE_ARGS.split(' ').filter(Boolean) : [],
    root,
    ...overrides,
  };
}
