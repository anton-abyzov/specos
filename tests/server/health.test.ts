import { afterAll, beforeAll, expect, test } from 'vitest';
import { startTestServer, type TestServer } from './helpers';

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

test('the server starts on a random port with a throwaway home', async () => {
  const response = await server.fetch('/api/health');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
