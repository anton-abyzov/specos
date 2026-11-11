import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_HOME, login, shots, trackErrors } from './helpers';

let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = trackErrors(page);
  await login(page);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const launcher = (page: Page) => page.getByTestId('launcher');
const field = (page: Page) => page.getByTestId('launcher-input');
const items = (page: Page) => page.getByTestId('launcher-item');
const selected = (page: Page) => page.locator('[data-testid="launcher-item"][data-selected]');
const group = (page: Page, id: string) => page.getByTestId(`launcher-group-${id}`);

async function openLauncher(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(field(page)).toBeFocused();
}

const write = async (page: Page, file: string, contents: string) => {
  const response = await page.request.put(`/api/fs/write?path=${encodeURIComponent(file)}`, { data: contents });
  expect(response.ok()).toBe(true);
};

/** Every window the window manager holds, as the app and what it was opened with. */
const windows = (page: Page) =>
  page.evaluate(() =>
    Object.values(window.__specos!.windows!.getState().windows).map(({ appId, params }) => ({ appId, params })),
  );

const shell = (page: Page) =>
  page.evaluate(() => {
    const { launcherOpen, overviewOpen, tiling, desktop } = window.__specos!.stores!.shell.getState();
    return { launcherOpen, overviewOpen, tiling, desktop };
  });

test('the shortcuts open the launcher with the field focused, and Escape gives the focus back', async ({ page }) => {
  await expect(launcher(page)).toHaveCount(0);

  // Focus starts on a dock icon, so there is somewhere for it to return to.
  await page.getByTestId('dock-app-files').focus();
  await page.keyboard.press('Control+k');
  await expect(launcher(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue('');

  await page.keyboard.press('Escape');
  await expect(launcher(page)).toHaveCount(0);
  await expect(page.getByTestId('dock-app-files')).toBeFocused();

  // Ctrl+Space opens it, and the same key closes it again.
  await page.keyboard.press('Control+Space');
  await expect(field(page)).toBeFocused();
  await page.keyboard.press('Control+Space');
  await expect(launcher(page)).toHaveCount(0);

  // The Cmd forms of both shortcuts.
  await page.keyboard.press('Meta+k');
  await expect(field(page)).toBeFocused();
  await page.keyboard.press('Meta+Space');
  await expect(launcher(page)).toHaveCount(0);

  // From the menu bar, and closed by a click on empty space.
  await page.getByTestId('launcher-button').click();
  await expect(field(page)).toBeFocused();
  await page.mouse.click(120, 700);
  await expect(launcher(page)).toHaveCount(0);

  // From the SpecOS menu.
  await page.getByTestId('menu-specos').click();
  await page.getByRole('menuitem', { name: /Open Launcher/ }).click();
  await expect(field(page)).toBeFocused();
});

test('before a query it shows the apps as a grid and a few actions, and the arrows move the selection', async ({ page }) => {
  // Two windows behind it, so the screenshots show the desk blurring through.
  await page.evaluate(() => {
    window.__specos!.openApp!('files');
    window.__specos!.openApp!('activity');
  });
  await openLauncher(page);

  const apps = group(page, 'apps').getByTestId('launcher-item');
  await expect(apps).toHaveCount(7);
  await expect(apps.first()).toContainText('Files');
  await expect(group(page, 'actions').getByTestId('launcher-item')).toHaveCount(6);
  await expect(page.getByTestId('launcher-status')).toContainText('indexed');

  // The first app is selected; the arrows walk the flat list and wrap at both ends.
  await expect(selected(page)).toHaveAttribute('data-key', 'app:files');
  await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toHaveAttribute('data-key', 'app:terminal');
  await page.keyboard.press('ArrowRight');
  await expect(selected(page)).toHaveAttribute('data-key', 'app:editor');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(selected(page)).toHaveAttribute('data-key', 'app:files');
  await page.keyboard.press('ArrowUp');
  await expect(selected(page)).toHaveAttribute('data-kind', 'action');
  await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toHaveAttribute('data-key', 'app:files');

  // Tab goes to the first result of the next group.
  await page.keyboard.press('Tab');
  await expect(selected(page)).toHaveAttribute('data-key', 'action:new-terminal');
  await expect(field(page)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(selected(page)).toHaveAttribute('data-key', 'app:files');

  // Hovering selects, and the keyboard stays in the field.
  await apps.nth(3).hover();
  await expect(selected(page)).toHaveAttribute('data-key', 'app:chat');
  await expect(field(page)).toBeFocused();

  // The field and the first heading sit where the design puts them: upper third, one column.
  const input = (await field(page).boundingBox())!;
  expect(input.y).toBeGreaterThan(120);
  expect(input.y + input.height).toBeLessThan(360);

  await page.mouse.move(200, 600);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await shots(page, 'T-16-launcher-empty');
});

test('typing "ter" selects Terminal and Enter opens a Terminal window', async ({ page }) => {
  await openLauncher(page);
  await page.keyboard.type('ter');

  await expect(items(page).first()).toHaveAttribute('data-key', 'app:terminal');
  await expect(selected(page)).toHaveAttribute('data-key', 'app:terminal');
  // The matched letters are marked.
  await expect(selected(page).locator('mark')).toHaveText('Ter');
  await expect(page.getByTestId('launcher-count-apps')).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(launcher(page)).toHaveCount(0);
  await expect(page.locator('[data-testid^="window-w-"][data-app="terminal"]')).toBeVisible();
  await expect(page.getByTestId('active-app-name')).toHaveText('Terminal');

  // An app that is already running is brought to the front, not opened twice.
  await page.evaluate(() => window.__specos!.openApp!('system'));
  await openLauncher(page);
  await page.keyboard.type('ter');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('active-app-name')).toHaveText('Terminal');
  expect((await windows(page)).filter((entry) => entry.appId === 'terminal')).toHaveLength(1);
});

test('a fuzzy, non-contiguous query finds a file, and Enter opens it where it belongs', async ({ page }) => {
  await write(page, 'Documents/quarterly-report.md', '# Quarterly report\n');
  await write(page, 'Projects/atlas/src/geometry.ts', 'export const unit = 1;\n');
  await write(page, 'Pictures/contour-map.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');

  await openLauncher(page);
  // The index is fetched when the launcher opens; the files written above are in it.
  await expect(page.getByTestId('launcher-status')).toHaveText(/^[3-9] files indexed|^\d\d+ files indexed/);

  await page.keyboard.type('qrtrep');
  const report = group(page, 'files').getByTestId('launcher-item').first();
  await expect(report).toHaveAttribute('data-key', 'file:Documents/quarterly-report.md');
  await expect(report).toContainText('quarterly-report.md');
  await expect(report).toContainText('Documents');
  // Six typed letters, six marked letters, in more than one run.
  expect((await report.locator('mark').allTextContents()).join('')).toBe('qrtrep');
  expect(await report.locator('mark').count()).toBeGreaterThan(1);

  // Text opens in the Editor.
  await expect(selected(page)).toHaveAttribute('data-key', 'file:Documents/quarterly-report.md');
  await page.keyboard.press('Enter');
  await expect(launcher(page)).toHaveCount(0);
  expect(await windows(page)).toContainEqual({ appId: 'editor', params: { path: 'Documents/quarterly-report.md' } });

  // A path can be searched across its folders; a folder opens in Files.
  await openLauncher(page);
  await page.keyboard.type('atl/geo');
  await expect(selected(page)).toHaveAttribute('data-key', 'file:Projects/atlas/src/geometry.ts');
  await page.keyboard.press('Escape');
  await expect(field(page)).toHaveValue('');
  await expect(launcher(page)).toBeVisible();
  await page.keyboard.type('atlas');
  await expect(selected(page)).toHaveAttribute('data-key', 'file:Projects/atlas');
  await page.keyboard.press('Enter');
  expect(await windows(page)).toContainEqual({ appId: 'files', params: { path: 'Projects/atlas' } });

  // An image opens in Files with the file selected; Ctrl+Enter sends it to the Editor instead.
  await openLauncher(page);
  await page.keyboard.type('contmap');
  await expect(selected(page)).toHaveAttribute('data-key', 'file:Pictures/contour-map.svg');
  await page.keyboard.press('Enter');
  expect(await windows(page)).toContainEqual({
    appId: 'files',
    params: { path: 'Pictures', select: 'Pictures/contour-map.svg' },
  });
  await openLauncher(page);
  await page.keyboard.type('contmap');
  await page.keyboard.press('Control+Enter');
  expect(await windows(page)).toContainEqual({ appId: 'editor', params: { path: 'Pictures/contour-map.svg' } });

  // A file that appears while the launcher is open is found without reopening it.
  await openLauncher(page);
  await write(page, 'Documents/zebra-crossing.txt', 'stripes\n');
  await page.keyboard.type('zbrcros');
  await expect(selected(page)).toHaveAttribute('data-key', 'file:Documents/zebra-crossing.txt');

  // Nothing to find says so.
  await field(page).fill('qqqxxzz');
  await expect(page.getByTestId('launcher-empty')).toBeVisible();
  await expect(items(page)).toHaveCount(0);
});

test('actions run: the theme, tiling, desktops, and a new project folder', async ({ page }) => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await openLauncher(page);
  await page.keyboard.type('dark');
  await expect(selected(page)).toHaveAttribute('data-key', 'action:theme');
  await expect(selected(page)).toContainText('Dark theme');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(launcher(page)).toHaveCount(0);

  // The same action now offers the way back.
  await openLauncher(page);
  await page.keyboard.type('light theme');
  await expect(selected(page)).toContainText('Light theme');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  expect((await shell(page)).tiling).toBe(false);
  await openLauncher(page);
  await page.keyboard.type('tiling');
  await expect(selected(page)).toHaveAttribute('data-key', 'action:toggle-tiling');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tiling-toggle')).toHaveAttribute('aria-pressed', 'true');
  expect((await shell(page)).tiling).toBe(true);
  await openLauncher(page);
  await page.keyboard.type('tiling');
  await selected(page).click();
  await expect(page.getByTestId('tiling-toggle')).toHaveAttribute('aria-pressed', 'false');

  await openLauncher(page);
  await page.keyboard.type('desktop 3');
  await expect(selected(page)).toHaveAttribute('data-key', 'action:desktop-3');
  await page.keyboard.press('Enter');
  expect((await shell(page)).desktop).toBe(2);

  // "New project folder..." turns the field into a name prompt.
  await openLauncher(page);
  await page.keyboard.type('new proj');
  await expect(selected(page)).toHaveAttribute('data-key', 'action:new-project');
  await page.keyboard.press('Enter');
  await expect(launcher(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue('');
  await expect(field(page)).toHaveAccessibleName('Name of the new project folder');

  // A name that cannot be a folder is refused in place.
  await page.keyboard.type('a/b');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('slash');
  await shots(page, 'T-16-launcher-new-project');
  await field(page).fill('lighthouse');
  await page.keyboard.press('Enter');
  await expect(launcher(page)).toHaveCount(0);
  expect(await windows(page)).toContainEqual({ appId: 'files', params: { path: 'Projects/lighthouse' } });
  const stat = await page.request.get('/api/fs/stat?path=Projects/lighthouse');
  expect((await stat.json()).kind).toBe('dir');

  // Escape leaves the prompt first, then closes.
  await openLauncher(page);
  await page.keyboard.type('new proj');
  await page.keyboard.press('Enter');
  await page.keyboard.type('lighthouse');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('already exists');
  await page.keyboard.press('Escape');
  await expect(field(page)).toHaveAccessibleName(/Search/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(launcher(page)).toHaveCount(0);
});

test('while it is open the other global shortcuts do not fire', async ({ page }) => {
  await page.evaluate(() => window.__specos!.openApp!('system'));
  await openLauncher(page);

  await page.keyboard.press('F3');
  await page.keyboard.press('Control+Alt+t');
  await page.keyboard.press('Control+Alt+2');
  await page.keyboard.press('Control+m');
  expect(await shell(page)).toEqual({ launcherOpen: true, overviewOpen: false, tiling: false, desktop: 0 });
  await expect(page.locator('[data-testid^="window-w-"][data-app="system"]')).toHaveAttribute('data-mode', 'normal');
  await expect(field(page)).toBeFocused();

  // Closed again, they work.
  await page.keyboard.press('Escape');
  await page.keyboard.press('F3');
  await expect(page.getByTestId('overview')).toBeVisible();
  // And the launcher takes over from the overview.
  await page.keyboard.press('Control+k');
  await expect(field(page)).toBeFocused();
  await expect(page.getByTestId('overview')).toHaveCount(0);
});

test('a running agent is found by its name and opens in its own window', async ({ page }) => {
  test.setTimeout(120_000);
  const response = await page.request.post('/api/agents', {
    data: { prompt: 'Write a haiku about contour lines into notes.md', runner: 'demo' },
  });
  expect(response.ok()).toBe(true);
  const agent = await response.json();
  await expect(page.getByTestId(`dock-agent-${agent.id}`)).toBeVisible();

  // Before a query the agent at work has its own row.
  await openLauncher(page);
  await expect(group(page, 'agents').getByTestId('launcher-item')).toContainText(agent.name);
  await page.mouse.move(200, 600);
  await shots(page, 'T-16-launcher-agents');

  await page.keyboard.type(String(agent.name).toLowerCase());
  const row = group(page, 'agents').getByTestId('launcher-item').first();
  await expect(row).toHaveAttribute('data-key', `agent:${agent.id}`);
  await expect(row).toContainText(agent.name);
  await expect(row).toContainText('Write a haiku');

  // A query that reaches every group, for the screenshots.
  await field(page).fill('te');
  for (const id of ['apps', 'files', 'agents', 'actions']) await expect(group(page, id)).toBeVisible();
  expect(await items(page).count()).toBeLessThanOrEqual(20);
  for (const id of ['apps', 'files', 'agents', 'actions']) {
    expect(await group(page, id).getByTestId('launcher-item').count()).toBeLessThanOrEqual(6);
  }
  await page.mouse.move(200, 600);
  await page.keyboard.press('ArrowDown');
  await shots(page, 'T-16-launcher-search');

  await field(page).fill(String(agent.name).toLowerCase());
  await expect(selected(page)).toHaveAttribute('data-key', `agent:${agent.id}`);
  await page.keyboard.press('Enter');
  await expect(launcher(page)).toHaveCount(0);
  expect(await windows(page)).toContainEqual({ appId: 'agent', params: { agentId: agent.id } });
});

test('results follow every keystroke within a frame with 5000 files indexed', async ({ page }) => {
  test.setTimeout(180_000);
  // Written straight to disk: five thousand requests would only test the file API.
  const words = ['survey', 'contour', 'ledger', 'harbour', 'meridian', 'quarry', 'lantern', 'trellis', 'granite', 'osprey'];
  for (let folder = 0; folder < 50; folder += 1) {
    const dir = path.join(E2E_HOME, 'Archive', `batch-${String(folder).padStart(2, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let file = 0; file < 100; file += 1) {
      fs.writeFileSync(path.join(dir, `${words[file % 10]}-${words[(file + folder) % 10]}-${folder}-${file}.md`), '');
    }
  }
  await expect
    .poll(async () => (await (await page.request.get('/api/fs/index')).json()).entries.length, { timeout: 60_000 })
    .toBe(5000);

  await openLauncher(page);
  await expect(page.getByTestId('launcher-status')).toHaveText('5,000 files and more indexed', { timeout: 30_000 });

  // Each keystroke: the time from the input event to the results being in the document.
  const timings = await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="launcher-input"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const spent: number[] = [];
    const typed = ['s', 'su', 'sur', 'surv', 'survq', 'survqu', 'survqua', 'osp', 'osprgr', 'b4', 'b49', 'lntrn'];
    // Typed twice over, as someone who searches, clears the field and searches again.
    for (const query of [...typed, '', ...typed]) {
      const before = performance.now();
      setValue.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Reading the layout forces whatever the keystroke rendered to be laid out now.
      document.querySelector('[data-testid="launcher-results"]')!.getBoundingClientRect();
      spent.push(performance.now() - before);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return spent;
  });
  console.log(`keystroke to results, ms: ${timings.map((ms) => ms.toFixed(1)).join(' ')}`);
  // A frame at 60 Hz is 16.7 ms. The typical keystroke must fit inside one; a single slow
  // one (the first after opening, or a collection pause) may not take more than three.
  const median = [...timings].sort((a, b) => a - b)[Math.floor(timings.length / 2)]!;
  expect(median).toBeLessThan(16);
  expect(Math.max(...timings)).toBeLessThan(50);

  await expect(field(page)).toHaveValue('lntrn');
  await expect(group(page, 'files').getByTestId('launcher-item')).toHaveCount(6);
  await expect(page.getByTestId('launcher-count-files')).toContainText('6 of');

  // The selection stays in view as it moves down a list longer than the screen.
  await field(page).fill('e');
  const count = await items(page).count();
  expect(count).toBeGreaterThan(12);
  for (let step = 0; step < count - 1; step += 1) await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toBeInViewport({ ratio: 1 });
  await expect(items(page).last()).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(items(page).first()).toHaveAttribute('data-selected', 'true');
  await expect(selected(page)).toBeInViewport({ ratio: 1 });
});
