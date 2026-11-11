import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export const E2E_TOKEN = process.env.E2E_TOKEN ?? 'e2e-token-0123456789';
const port = process.env.E2E_PORT ?? '7391';

/** The throwaway home folder of the server this run talks to (see scripts/e2e-server.mjs). */
export const E2E_HOME = path.join(os.tmpdir(), `specos-e2e-${port}`, 'home');

/** Where per-task screenshots go (ignored by git). */
export const SHOTS = path.resolve(
  import.meta.dirname,
  '../../.specweave/increments/0001-specos-browser-desktop-for-ai-agent-work/reports/artifacts',
);

/** Console errors and page errors seen so far; assert it is empty at the end of a test. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

/** First visit with the token, then wait for the desktop. */
export async function login(page: Page): Promise<void> {
  await page.goto(`/?token=${E2E_TOKEN}`);
  await expect(page.getByTestId('desktop')).toBeVisible();
}

export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((t) => window.__specos?.setTheme?.(t), theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/**
 * Saves <name>-light.png and <name>-dark.png at the current viewport (1920x1080),
 * then leaves the page in the light theme.
 */
export async function shots(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}
