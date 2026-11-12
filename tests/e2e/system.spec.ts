import { expect, test } from '@playwright/test';
import { login, shots, trackErrors } from './helpers';

interface WorkspaceList {
  workspaces: Array<{ name: string }>;
}

test('system shows this machine and times ten agent workspaces', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackErrors(page);
  const benchmarkCalls: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/system/benchmark')) {
      benchmarkCalls.push(request.postData() ?? '');
    }
  });
  await login(page);

  // ------------------------------------------------------------ the badge opens the window
  await page.getByTestId('system-badge').click();
  const app = page.getByTestId('app-system');
  await expect(app).toBeVisible();
  await expect(page.getByTestId('active-app-name')).toHaveText('System');

  // ------------------------------------------------------------ facts of the real machine
  const system = await (await page.request.get('/api/system')).json();
  expect(system.kernel).not.toBe('');
  await expect(app.getByTestId('system-kernel')).toHaveText(system.kernel);
  await expect(app.getByTestId('system-kernel-fact')).toHaveText(system.kernel);
  await expect(app.getByTestId('system-headline')).toHaveText(`${system.os.name} ${system.os.version}`);
  expect(system.fs.type).not.toBe('');
  await expect(app.getByTestId('system-fs-type')).toHaveText(system.fs.type);
  await expect(app.getByTestId('system-fs-device')).toHaveText(system.fs.device);
  await expect(app.getByTestId('system-fs-mount')).toHaveText(system.fs.mount);
  await expect(app.getByTestId('system-fs-free')).toHaveText(/^\d+(\.\d+)? (B|KB|MB|GB|TB) free$/);
  await expect(app.getByTestId('system-arch')).toHaveText(system.arch);
  await expect(app.getByTestId('system-hostname')).toHaveText(system.hostname);
  await expect(app.getByTestId('system-node')).toHaveText(system.node);
  await expect(app.getByTestId('system-home')).toHaveText(system.home);
  await expect(app.getByTestId('system-runner')).toHaveText('demo');
  await expect(app.getByTestId('system-clone-strategy')).toHaveText(system.clone.strategy);
  await expect(app.getByTestId('system-clone-reason')).toHaveText(system.clone.reason);
  await expect(app.getByTestId('system-uptime')).toHaveText(/^\d+ (d|h|min|s)/);

  // ------------------------------------------------------------ processor and memory are live
  await expect(app.getByTestId('system-cpu')).toHaveText(/^\d{1,3}%$/);
  await expect(app.getByTestId('system-memory')).toHaveText(/^\d{1,3}%$/);
  await expect(app.getByTestId('system-memory-used')).toHaveText(/used of/);
  const points = async (testId: string): Promise<number> =>
    Number(await app.getByTestId(testId).getAttribute('data-points'));
  const cpuPoints = await points('system-cpu-spark');
  const memoryPoints = await points('system-memory-spark');
  // A stats frame arrives every two seconds and adds a point to each line.
  await expect.poll(() => points('system-cpu-spark'), { timeout: 15_000 }).toBeGreaterThan(cpuPoints);
  await expect.poll(() => points('system-memory-spark'), { timeout: 15_000 }).toBeGreaterThan(memoryPoints);
  await expect.poll(() => points('system-cpu-spark'), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await expect(app.locator('[data-testid="system-cpu-spark"] polyline')).toHaveCount(1);

  // The case for Linux rests on this machine's own facts.
  await expect(app.getByTestId('ground-fs')).toContainText(system.fs.type);
  await expect(app.getByTestId('ground-clone')).toContainText(system.clone.strategy);
  await shots(page, 'T-23-system');

  // ------------------------------------------------------------ the benchmark
  await expect(app.getByTestId('bench-total')).toHaveCount(0);
  const run = app.getByTestId('bench-run');
  await expect(run).toHaveText('Create 10 agent workspaces');
  await expect(app.getByTestId('bench-count-10')).toHaveAttribute('aria-checked', 'true');
  // Two clicks in the same instant start one test.
  await run.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(app.getByTestId('bench-total')).toBeVisible({ timeout: 60_000 });
  expect(benchmarkCalls).toHaveLength(1);

  const bars = app.getByTestId('bench-bar');
  await expect(bars).toHaveCount(10);
  await expect(app.getByTestId('bench-bar-waiting')).toHaveCount(0);
  for (const bar of await bars.all()) {
    expect(Number(await bar.getAttribute('data-ms'))).toBeGreaterThan(0);
    expect(Number(await bar.getByTestId('bench-bar-ms').innerText())).toBeGreaterThan(0);
    expect((await bar.locator('.bench-bar__fill').boundingBox())!.height).toBeGreaterThanOrEqual(3);
  }
  await expect(app.getByTestId('bench-total')).toHaveText(/^\d+(\.\d+)? (ms|s)$/);
  expect(Number.parseFloat(await app.getByTestId('bench-total').innerText())).toBeGreaterThan(0);
  await expect(app.getByTestId('bench-average')).toHaveText(/^\d+(\.\d+)? (ms|s)$/);
  await expect(app.getByTestId('bench-median')).toHaveText(/^\d+(\.\d+)? (ms|s)$/);
  expect(Number(await app.getByTestId('bench-files').innerText())).toBeGreaterThan(0);
  await expect(app.getByTestId('bench-bytes')).toHaveText(/^\d+(\.\d+)? (B|KB|MB|GB)$/);
  await expect(app.getByTestId('bench-disk')).toHaveText(/^\d+(\.\d+)? (B|KB|MB|GB)$/);
  await expect(app.getByTestId('bench-strategy')).toHaveText(system.clone.strategy);
  await expect(app.getByTestId('bench-status')).toContainText('Measured');
  await expect(run).toBeEnabled();
  await expect(app.getByTestId('bench-error')).toHaveCount(0);

  // Nothing the test made is left behind.
  const after = (await (await page.request.get('/api/workspaces')).json()) as WorkspaceList;
  expect(after.workspaces.filter((workspace) => workspace.name.includes('bench'))).toEqual([]);
  // The last measured copy now backs the third argument.
  await expect(app.getByTestId('ground-clone')).toContainText('median of the last test');

  await run.scrollIntoViewIfNeeded();
  await app.getByTestId('bench-totals').scrollIntoViewIfNeeded();
  await shots(page, 'T-23-system-benchmark');

  // ------------------------------------------------------------ the result outlives a reload
  const total = await app.getByTestId('bench-total').innerText();
  await page.reload();
  await expect(page.getByTestId('desktop')).toBeVisible();
  await page.getByTestId('system-badge').click();
  await expect(app.getByTestId('bench-total')).toHaveText(total);
  await expect(app.getByTestId('bench-bar')).toHaveCount(10);

  // ------------------------------------------------------------ another count, run again
  await app.getByTestId('bench-count-5').click();
  await expect(run).toHaveText('Create 5 agent workspaces');
  await run.click();
  await expect(app.getByTestId('bench-status')).toHaveText(/, 5 \w+ copies of /, { timeout: 60_000 });
  await expect(app.getByTestId('bench-bar')).toHaveCount(5);
  await expect(app.getByTestId('bench-total')).toBeVisible();
  expect(benchmarkCalls).toHaveLength(2);
  expect(JSON.parse(benchmarkCalls[1]!)).toEqual({ count: 5 });

  // The app's own menu is in the menu bar.
  await page.getByTestId('menubar').getByText('Machine', { exact: true }).click();
  await expect(page.getByText('Create agent workspaces', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  expect(errors).toEqual([]);
});
