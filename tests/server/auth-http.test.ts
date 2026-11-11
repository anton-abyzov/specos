import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../../server/src/config';
import { SESSION_COOKIE } from '../../shared/protocol';
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers';

let server: TestServer;
let clientDist: string;

beforeAll(async () => {
  // A tiny built client, so static files are really served and really guarded.
  clientDist = fs.mkdtempSync(path.join(os.tmpdir(), 'specos-client-'));
  fs.mkdirSync(path.join(clientDist, 'assets'));
  fs.writeFileSync(path.join(clientDist, 'index.html'), '<!doctype html><title>SpecOS</title>');
  fs.writeFileSync(path.join(clientDist, 'assets', 'app.js'), 'console.log("specos")');
  server = await startTestServer({ clientDist });
});

afterAll(async () => {
  await server.close();
  fs.rmSync(clientDist, { recursive: true, force: true });
});

/** A request that carries nothing but what the test passes. */
function anonymous(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(server.url + pathname, { redirect: 'manual', ...init });
}

describe('without a session', () => {
  test.each(['/', '/api/health', '/assets/app.js', '/no/such/page'])('GET %s is 401', async (pathname) => {
    const response = await anonymous(pathname);
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ error: expect.any(String), code: 'unauthorized' });
  });

  test('a browser gets a small page that says where the URL comes from', async () => {
    const response = await anonymous('/', { headers: { accept: 'text/html,application/xhtml+xml' } });
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    const page = await response.text();
    expect(page).toMatch(/URL printed by the server/i);
    expect(page).not.toContain(TEST_TOKEN);
    expect(page).not.toMatch(/<script|src=|href=/i);
  });

  test('a wrong cookie is 401', async () => {
    const response = await anonymous('/api/health', { headers: { cookie: `${SESSION_COOKIE}=not-the-token` } });
    expect(response.status).toBe(401);
  });

  test('a cookie that only shares a prefix with the token is 401', async () => {
    const response = await anonymous('/api/health', {
      headers: { cookie: `${SESSION_COOKIE}=${TEST_TOKEN.slice(0, -1)}` },
    });
    expect(response.status).toBe(401);
  });

  test('a wrong token is 401 and sets no cookie', async () => {
    const response = await anonymous('/?token=wrong');
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  test('a token does not authorise a state-changing request', async () => {
    const response = await anonymous(`/api/health?token=${TEST_TOKEN}`, { method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('the first visit with the token', () => {
  test('sets an HttpOnly, SameSite=Strict cookie and redirects to a clean URL', async () => {
    const response = await anonymous(`/?token=${TEST_TOKEN}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=${TEST_TOKEN};`));
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Strict/i);
    expect(cookie).toMatch(/;\s*Path=\//i);
    // Plain HTTP on a LAN: a Secure cookie would never be sent back.
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  test('keeps the path and the other query parameters, and never echoes the token', async () => {
    const response = await anonymous(`/api/health?a=1&token=${TEST_TOKEN}&b=two%20words`);
    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).not.toContain(TEST_TOKEN);
    expect(location).not.toContain('token');
    const target = new URL(location, server.url);
    expect(target.pathname).toBe('/api/health');
    expect(Object.fromEntries(target.searchParams)).toEqual({ a: '1', b: 'two words' });
  });

  test('cannot be turned into a redirect to another site', async () => {
    for (const prefix of ['//evil.example/', '/%5Cevil.example/', '/\\evil.example/']) {
      const response = await anonymous(`${prefix}?token=${TEST_TOKEN}`);
      expect(response.status).toBe(302);
      const target = new URL(response.headers.get('location') ?? '', server.url);
      expect(target.origin).toBe(server.url);
    }
  });

  test('the cookie it sets then grants access', async () => {
    const first = await anonymous(`/?token=${TEST_TOKEN}`);
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];

    const api = await anonymous('/api/health', { headers: { cookie } });
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ ok: true });

    const page = await anonymous('/', { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>SpecOS</title>');

    const asset = await anonymous('/assets/app.js', { headers: { cookie } });
    expect(asset.status).toBe(200);
  });
});

describe('with a session', () => {
  test('an unknown path is an ordinary 404', async () => {
    const response = await server.fetch('/no/such/page');
    expect(response.status).toBe(404);
  });

  test('a POST from a foreign Origin is 403', async () => {
    const response = await server.fetch('/api/health', {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: expect.any(String), code: 'foreign_origin' });
  });

  test('a POST from an opaque Origin is 403', async () => {
    const response = await server.fetch('/api/health', { method: 'POST', headers: { origin: 'null' } });
    expect(response.status).toBe(403);
  });

  test('a POST from the same Origin passes the guard', async () => {
    // No such route, so the guard letting it through shows as 404 instead of 403.
    const response = await server.fetch('/api/health', { method: 'POST' });
    expect(response.status).toBe(404);
  });

  test('a GET is not subject to the Origin check', async () => {
    const response = await server.fetch('/api/health', { headers: { origin: 'http://evil.example' } });
    expect(response.status).toBe(200);
  });
});

describe('security headers', () => {
  test('are on API responses, which are never cached', async () => {
    const response = await server.fetch('/api/health');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('are on static files, refusals and the token redirect', async () => {
    const responses = await Promise.all([
      server.fetch('/assets/app.js'),
      anonymous('/'),
      anonymous(`/?token=${TEST_TOKEN}`),
      server.fetch('/no/such/page'),
    ]);
    for (const response of responses) {
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    }
    // Neither the refusal nor the response that carries the cookie may be stored.
    expect(responses[1].headers.get('cache-control')).toBe('no-store');
    expect(responses[2].headers.get('cache-control')).toBe('no-store');
  });
});

describe('configuration', () => {
  test('generates a different random token on every start when none is given', () => {
    const tokens = Array.from({ length: 5 }, () => loadConfig({}, {}).token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(32);
    }
  });

  test('uses SPECOS_TOKEN when it is set', () => {
    expect(loadConfig({}, { SPECOS_TOKEN: 'a-token-chosen-by-the-owner' }).token).toBe('a-token-chosen-by-the-owner');
  });

  test('binds every interface by default', () => {
    expect(loadConfig({}, {}).host).toBe('0.0.0.0');
  });
});

describe('the server process', () => {
  test('prints exactly one line, the URL with a token that opens a session', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'specos-main-'));
    const { SPECOS_TOKEN: _unset, HOST: _host, ...env } = process.env;
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/main.ts'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...env,
        PORT: '0',
        SPECOS_HOME: path.join(base, 'home'),
        SPECOS_DATA: path.join(base, 'data'),
        SPECOS_CLIENT_DIST: path.join(base, 'no-client'),
        SPECOS_AGENT: 'demo',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

    try {
      await expect.poll(() => stdout + stderr, { timeout: 15_000, interval: 50 }).toContain('\n');
      const line = /^SpecOS {2}http:\/\/(\d+\.\d+\.\d+\.\d+):(\d+)\/\?token=([A-Za-z0-9_-]{43,})\n$/.exec(stdout);
      expect(line, `stdout was ${JSON.stringify(stdout)}, stderr ${JSON.stringify(stderr)}`).not.toBeNull();
      const [, , port, token] = line!;

      const visit = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' });
      expect(visit.status).toBe(302);
      expect(visit.headers.get('location')).toBe('/');
      const refused = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
      expect(refused.status).toBe(401);
    } finally {
      child.kill('SIGTERM');
      await exited;
      fs.rmSync(base, { recursive: true, force: true });
    }
    // Nothing else was written before, between or after: the URL is the whole output.
    expect(stdout.split('\n').filter(Boolean)).toHaveLength(1);
    expect(stderr).toBe('');
  });
});
