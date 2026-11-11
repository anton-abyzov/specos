import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type SpecOS } from '../../server/src/app';
import { SESSION_COOKIE } from '../../shared/protocol';
import type { Config } from '../../server/src/config';

export const TEST_TOKEN = 'test-token-0123456789';

export interface TestServer {
  specos: SpecOS;
  /** http://127.0.0.1:<port> */
  url: string;
  /** ws://127.0.0.1:<port> */
  wsUrl: string;
  token: string;
  /** Cookie header value that authenticates a request. */
  cookie: string;
  home: string;
  data: string;
  /** fetch with the session cookie already set. */
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/** Starts a real server on a random loopback port with a throwaway home folder. */
export async function startTestServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'specos-test-'));
  const home = path.join(base, 'home');
  const data = path.join(base, 'data');
  const specos = await buildApp({
    host: '127.0.0.1',
    port: 0,
    home,
    data,
    token: TEST_TOKEN,
    agent: 'demo',
    clientDist: path.join(base, 'no-client'),
    ...overrides,
  });
  const url = await specos.listen();
  const cookie = `${SESSION_COOKIE}=${TEST_TOKEN}`;
  return {
    specos,
    url,
    wsUrl: url.replace('http', 'ws'),
    token: TEST_TOKEN,
    cookie,
    home,
    data,
    fetch: (pathname, init = {}) =>
      fetch(url + pathname, {
        redirect: 'manual',
        ...init,
        headers: { cookie, origin: url, ...(init.headers as Record<string, string> | undefined) },
      }),
    async close() {
      await specos.close();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
