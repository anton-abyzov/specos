import { defineConfig } from '@playwright/test';

// E2E_PORT lets several runs work side by side. Everything is headless.
const port = Number(process.env.E2E_PORT ?? 7391);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `.e2e/report-${port}` }]],
  // Per port, so runs side by side never delete each other's traces.
  outputDir: `.e2e/results-${port}`,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    viewport: { width: 1920, height: 1080 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { E2E_PORT: String(port) },
  },
});
