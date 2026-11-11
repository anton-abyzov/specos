import { expect, test, type Page } from '@playwright/test';
import { login, setTheme, shots, trackErrors } from './helpers';

const DOCK_APPS = ['files', 'terminal', 'editor', 'chat', 'agents', 'activity', 'system'];

let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = trackErrors(page);
  await login(page);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const box = async (page: Page, testId: string) => {
  const bounds = await page.getByTestId(testId).boundingBox();
  if (!bounds) throw new Error(`${testId} is not on screen`);
  return bounds;
};

test('the menu bar shows live machine facts and the clock', async ({ page }) => {
  const menubar = page.getByTestId('menubar');
  await expect(menubar).toBeVisible();
  expect((await box(page, 'menubar')).height).toBe(30);

  // The badge comes from the real /api/system of this machine.
  const system = await (await page.request.get('/api/system')).json();
  await expect(page.getByTestId('system-badge')).toHaveText(/^Linux \d+\.\d+ · \w+/);
  await expect(page.getByTestId('system-badge')).toHaveText(system.badge);

  // CPU and memory arrive with the first stats frame.
  await expect(page.getByTestId('cpu-value')).toHaveText(/^\d{1,3}%$/);
  await expect(page.getByTestId('memory-value')).toHaveText(/^\d{1,3}%$/);
  const memory = Number.parseInt(await page.getByTestId('memory-value').innerText(), 10);
  expect(memory).toBeGreaterThan(0);
  expect(memory).toBeLessThanOrEqual(100);

  // Weekday, date and time, as the browser's own locale writes them.
  const expected = await page.evaluate(() => ({
    day: new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date()),
  }));
  await expect(page.getByTestId('clock-day')).toHaveText(expected.day);
  await expect(page.getByTestId('clock-time')).toHaveText(/^\d{2}:\d{2}$/);

  await expect(page.getByTestId('active-app-name')).toHaveText('Desktop');
  await expect(page.getByTestId('agents-count')).toHaveText('0');
  await expect(page.getByTestId('windows-layer')).toBeAttached();

  // The badge opens System.
  await page.getByTestId('system-badge').click();
  await expect(page.getByTestId('active-app-name')).toHaveText('System');
  await expect(page.getByTestId('dock-app-system')).toHaveAttribute('data-running', 'true');

  // A stats frame every 2 s must not move anything in the bar.
  const before = await box(page, 'clock');
  await page.waitForTimeout(2500);
  expect(await box(page, 'clock')).toEqual(before);

  await page.mouse.move(960, 500);
  await shots(page, 'T-13-shell');
});

test('the SpecOS menu opens, switches the theme and closes on Escape', async ({ page }) => {
  await setTheme(page, 'light');
  const trigger = page.getByTestId('menu-specos');
  const popup = page.getByTestId('menu-specos-popup');

  await trigger.click();
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('menuitem', { name: 'About SpecOS' })).toBeVisible();
  await expect(popup.getByRole('menuitemcheckbox', { name: 'Light appearance' })).toHaveAttribute('aria-checked', 'true');
  await expect(popup.getByRole('menuitem', { name: 'Open Launcher' })).toBeVisible();

  await popup.getByRole('menuitemcheckbox', { name: 'Dark appearance' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(popup).toBeHidden();

  // Hovering another title while a menu is open moves to that menu.
  await trigger.click();
  await expect(popup).toBeVisible();
  await page.getByTestId('menu-window').hover();
  await expect(page.getByTestId('menu-window-popup')).toBeVisible();
  await expect(popup).toBeHidden();
  await trigger.hover();
  await expect(popup).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();

  // Keyboard: arrows walk the items, Enter chooses one.
  await page.keyboard.press('ArrowDown');
  await expect(popup).toBeVisible();
  await expect(popup.locator('[data-active]')).toHaveText('About SpecOS');
  await page.keyboard.press('ArrowDown');
  await expect(popup.locator('[data-active]')).toHaveText('Light appearance');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(popup).toBeHidden();

  // Tiling is a checked item that reflects the shell.
  await trigger.click();
  await popup.getByRole('menuitemcheckbox', { name: 'Tile windows' }).click();
  await trigger.click();
  await expect(popup.getByRole('menuitemcheckbox', { name: 'Tile windows' })).toHaveAttribute('aria-checked', 'true');

  await shots(page, 'T-13-menu-open');
  await expect(popup).toBeVisible();

  // A click outside closes it.
  await page.mouse.click(960, 500);
  await expect(popup).toBeHidden();

  // The theme button in the bar does the same job as the menu.
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('the desktops switcher changes the current desktop', async ({ page }) => {
  const current = () => page.evaluate(() => window.__specos!.stores!.shell.getState().desktop);
  await expect(page.getByTestId('desktop-slot-1')).toHaveAttribute('aria-pressed', 'true');
  expect(await current()).toBe(0);

  await page.getByTestId('desktop-slot-3').click();
  await expect(page.getByTestId('desktop-slot-3')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('desktop-slot-1')).toHaveAttribute('aria-pressed', 'false');
  expect(await current()).toBe(2);

  await page.getByTestId('desktop-slot-4').click();
  expect(await current()).toBe(3);
  await page.getByTestId('desktop-slot-1').click();
  expect(await current()).toBe(0);
});

test('the dock shows seven apps, magnifies under the pointer and marks running apps', async ({ page }) => {
  const dock = page.getByTestId('dock');
  await expect(dock.locator('[data-testid^="dock-app-"]')).toHaveCount(7);
  for (const id of DOCK_APPS) await expect(page.getByTestId(`dock-app-${id}`)).toBeVisible();

  const resting = await box(page, 'dock-app-chat');
  expect(resting.width).toBeCloseTo(52, 0);

  // Hover the middle icon: it grows upward, its far neighbour does not.
  await page.mouse.move(resting.x + resting.width / 2, resting.y + resting.height / 2, { steps: 8 });
  await expect.poll(async () => (await box(page, 'dock-app-chat')).width).toBeGreaterThan(68);
  const middle = await box(page, 'dock-app-chat');
  const near = await box(page, 'dock-app-editor');
  const far = await box(page, 'dock-app-files');
  expect(middle.width).toBeLessThanOrEqual(52 * 1.35 + 0.5);
  expect(middle.width).toBeGreaterThan(near.width);
  expect(near.width).toBeGreaterThan(far.width);
  expect(far.width).toBeCloseTo(52, 0);
  // Grown from the baseline: the bottom edge has not moved.
  expect(middle.y + middle.height).toBeCloseTo(resting.y + resting.height, 0);
  expect(middle.y).toBeLessThan(resting.y);

  // Neighbours are pushed aside, not covered.
  const ordered = await Promise.all(DOCK_APPS.map((id) => box(page, `dock-app-${id}`)));
  for (let index = 1; index < ordered.length; index += 1) {
    expect(ordered[index]!.x).toBeGreaterThanOrEqual(ordered[index - 1]!.x + ordered[index - 1]!.width);
  }
  const menubar = await box(page, 'menubar');
  for (const icon of ordered) expect(icon.y).toBeGreaterThan(menubar.y + menubar.height);

  await expect(dock.getByRole('tooltip')).toHaveText('Chat');
  await shots(page, 'T-13-dock-hover');

  // The pointer leaves: everything settles back to its own size.
  await page.mouse.move(960, 400, { steps: 4 });
  await expect.poll(async () => (await box(page, 'dock-app-chat')).width).toBeCloseTo(52, 0);
  await expect(dock.getByRole('tooltip')).toHaveCount(0);

  // Click launches: the indicator appears and the menu bar names the app.
  await expect(page.getByTestId('dock-app-files')).not.toHaveAttribute('data-running', 'true');
  await page.getByTestId('dock-app-files').click();
  await expect(page.getByTestId('dock-app-files')).toHaveAttribute('data-running', 'true');
  await expect(page.getByTestId('active-app-name')).toHaveText('Files');

  // Keyboard: an icon takes focus and Enter activates it.
  await page.getByTestId('dock-app-terminal').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dock-app-terminal')).toHaveAttribute('data-running', 'true');
  await expect(page.getByTestId('active-app-name')).toHaveText('Terminal');
});

test('a running agent shows in the agents pill and the dock until it finishes', async ({ page }) => {
  test.setTimeout(120_000);
  await expect(page.getByTestId('agents-count')).toHaveText('0');
  await expect(page.locator('[data-testid^="dock-agent-"]')).toHaveCount(0);

  const response = await page.request.post('/api/agents', { data: { prompt: 'Write a haiku into notes.md' } });
  expect(response.ok()).toBe(true);
  const agent = await response.json();

  await expect(page.getByTestId('agents-count')).toHaveText('1');
  await expect(page.getByTestId('agents-pill')).toHaveAttribute('data-running', 'true');
  const icon = page.getByTestId(`dock-agent-${agent.id}`);
  await expect(icon).toBeVisible();
  await expect(icon).toHaveAccessibleName(new RegExp(agent.name));
  // The seven apps are still there, with the agent after them.
  await expect(page.locator('[data-testid^="dock-app-"]')).toHaveCount(7);
  expect((await box(page, `dock-agent-${agent.id}`)).x).toBeGreaterThan((await box(page, 'dock-app-system')).x);
  await shots(page, 'T-13-agent-running');

  // When the job ends the pill returns to 0 and, with no window open, the icon leaves the dock.
  await expect(page.getByTestId('agents-count')).toHaveText('0', { timeout: 90_000 });
  await expect(page.getByTestId('agents-pill')).not.toHaveAttribute('data-running', 'true');
  await expect(icon).toHaveCount(0);
});
