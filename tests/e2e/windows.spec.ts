import { expect, test, type Page } from '@playwright/test';
import { login, shots, trackErrors } from './helpers';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Frame times are only worth asserting with the compositor a real browser has: hardware GL
// rather than the software rasteriser headless Chromium falls back to, and without the tracer
// taking a screenshot of every frame.
test.use({
  trace: 'off',
  launchOptions: {
    args: ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
  },
});

let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = trackErrors(page);
  await login(page);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const open = (page: Page, appId: string, params?: Record<string, unknown>) =>
  page.evaluate(([id, p]) => window.__specos!.openApp!(id as string, p as Record<string, unknown>), [appId, params] as const);

/** The window as the store knows it. */
const model = (page: Page, id: string) =>
  page.evaluate((windowId) => {
    const state = window.__specos!.windows!.getState();
    const win = state.windows[windowId];
    return win ? { bounds: win.bounds, mode: win.mode, z: win.z, focused: state.focusedId === windowId } : null;
  }, id);

/** The window as it is drawn: its frame, in the layer's coordinates (the layer starts under the 30px menu bar). */
const drawn = async (page: Page, id: string): Promise<Rect> => {
  const box = await page.getByTestId(`window-${id}`).boundingBox();
  if (!box) throw new Error(`window ${id} is not on screen`);
  return { x: box.x, y: box.y - 30, w: box.width, h: box.height };
};

/** Waits until the window is drawn where the store says it is and has stopped moving. */
const settled = async (page: Page, id: string): Promise<Rect> => {
  await expect
    .poll(async () => {
      const [bounds, box] = [(await model(page, id))!.bounds, await drawn(page, id)];
      return Math.max(Math.abs(bounds.x - box.x), Math.abs(bounds.y - box.y), Math.abs(bounds.w - box.w), Math.abs(bounds.h - box.h));
    })
    .toBeLessThanOrEqual(0.5);
  return (await model(page, id))!.bounds;
};

const viewport = (page: Page) => page.evaluate(() => window.__specos!.windows!.getState().viewport);

const titleBar = (page: Page, id: string) => page.getByTestId(`window-${id}`).getByTestId('window-titlebar');

/** A point on the title bar that is not on the window's controls. */
const grabPoint = async (page: Page, id: string) => {
  const box = (await titleBar(page, id).boundingBox())!;
  return { x: box.x + 120, y: box.y + box.height / 2 };
};

test('windows open from the dock and the hook, and clicking one brings it to the front', async ({ page }) => {
  await page.getByTestId('dock-app-files').click();
  const files = page.locator('[data-app="files"]');
  await expect(files).toBeVisible();
  await expect(page.getByTestId('app-files')).toBeVisible();
  await expect(page.getByTestId('dock-app-files')).toHaveAttribute('data-running', 'true');
  await expect(page.getByTestId('active-app-name')).toHaveText('Files');
  const filesId = (await files.getAttribute('data-window-id'))!;

  const terminalId = await open(page, 'terminal');
  const editorId = await open(page, 'editor');
  await expect(page.locator('[data-window-id]')).toHaveCount(3);
  await expect(page.getByTestId('active-app-name')).toHaveText('Editor');
  for (const app of ['files', 'terminal', 'editor']) {
    await expect(page.getByTestId(`dock-app-${app}`)).toHaveAttribute('data-running', 'true');
  }

  // Each new window is in front of the ones before it, stepped down and right, and none is under the menu bar.
  const [a, b, c] = [await settled(page, filesId), await settled(page, terminalId), await settled(page, editorId)];
  const view = await viewport(page);
  for (const rect of [a, b, c]) {
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(view.w);
    expect(rect.y + rect.h).toBeLessThanOrEqual(view.h);
  }
  expect((await model(page, editorId))!.z).toBeGreaterThan((await model(page, terminalId))!.z);
  expect((await model(page, terminalId))!.z).toBeGreaterThan((await model(page, filesId))!.z);
  await expect(page.getByTestId(`window-${editorId}`)).toHaveAttribute('data-focused', 'true');

  // A singleton opens once: asking again focuses the window that is there.
  const chatId = await open(page, 'chat');
  expect(await open(page, 'chat')).toBe(chatId);
  await page.getByTestId(`window-${chatId}`).getByTestId('window-close').click();
  await expect(page.getByTestId(`window-${chatId}`)).toHaveCount(0);

  // Clicking a window behind raises it and gives it the focus; nothing moves.
  const before = await drawn(page, filesId);
  const grab = await grabPoint(page, filesId);
  await page.mouse.click(grab.x, grab.y);
  await expect(page.getByTestId(`window-${filesId}`)).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId(`window-${editorId}`)).not.toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('active-app-name')).toHaveText('Files');
  expect((await model(page, filesId))!.z).toBeGreaterThan((await model(page, editorId))!.z);
  expect(await drawn(page, filesId)).toEqual(before);
  // What is drawn on top at that point is now the Files window.
  const topmost = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-window-id]')?.getAttribute('data-window-id'),
    [grab.x, grab.y],
  );
  expect(topmost).toBe(filesId);

  // Ctrl+` walks through the windows.
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId(`window-${terminalId}`)).toHaveAttribute('data-focused', 'true');

  // A press on the bare desktop puts the desktop in front.
  await page.mouse.click(40, 600);
  await expect(page.getByTestId('active-app-name')).toHaveText('Desktop');

  // Spread the three out with real drags for the picture: Files behind, Terminal in front.
  for (const [windowId, dx, dy] of [
    [filesId, -330, -80],
    [editorId, 420, 40],
    [terminalId, 40, 250],
  ] as const) {
    await page.evaluate((target) => window.__specos!.windows!.getState().focus(target), windowId);
    const from = await grabPoint(page, windowId);
    const placed = await settled(page, windowId);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
    await page.mouse.up();
    expect(await settled(page, windowId)).toEqual({ ...placed, x: placed.x + dx, y: placed.y + dy });
  }
  await page.mouse.move(300, 940);
  await shots(page, 'T-14-windows');
});

test('dragging a window follows the pointer exactly at 60 frames a second', async ({ page }) => {
  await open(page, 'files');
  await open(page, 'terminal');
  const id = await open(page, 'editor');
  const start = await settled(page, id);
  const from = await grabPoint(page, id);
  const delta = { x: -260, y: 140 };

  // Frame times are sampled in the page for as long as the drag lasts.
  await page.evaluate(() => {
    const frames: number[] = [];
    const sample = (time: number) => {
      frames.push(time);
      if ((window as unknown as { sampling: boolean }).sampling) requestAnimationFrame(sample);
    };
    Object.assign(window, { sampling: true, frames });
    requestAnimationFrame(sample);
  });

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Pressing alone must not move anything.
  expect(await drawn(page, id)).toEqual(start);

  const steps = 30;
  let midway: Rect | null = null;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(from.x + (delta.x * step) / steps, from.y + (delta.y * step) / steps);
    await page.waitForTimeout(16);
    if (step === steps / 2) midway = await drawn(page, id);
  }
  // Mid-drag the window is under the pointer although the store has not heard of it yet.
  expect(Math.abs(midway!.x - (start.x + delta.x / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(midway!.y - (start.y + delta.y / 2))).toBeLessThanOrEqual(1);
  expect((await model(page, id))!.bounds).toEqual(start);
  // Text cannot be selected and the app cannot take the pointer while a window is held.
  expect(await page.evaluate(() => document.documentElement.dataset.wmGesture)).toBe('move');
  expect(
    await page.getByTestId(`window-${id}`).locator('.window__shield').evaluate((node) => getComputedStyle(node).display),
  ).toBe('block');

  const lastFrame = await drawn(page, id);
  await page.mouse.up();
  const frames = await page.evaluate(() => {
    Object.assign(window, { sampling: false });
    return (window as unknown as { frames: number[] }).frames;
  });

  // No jump at the end: what was committed is what the last frame showed.
  const committed = (await model(page, id))!.bounds;
  expect(await drawn(page, id)).toEqual(lastFrame);
  expect(committed).toEqual(lastFrame);
  expect(Math.abs(committed.x - (start.x + delta.x))).toBeLessThanOrEqual(1);
  expect(Math.abs(committed.y - (start.y + delta.y))).toBeLessThanOrEqual(1);
  expect(committed.w).toBe(start.w);
  expect(committed.h).toBe(start.h);
  expect(await page.evaluate(() => document.documentElement.dataset.wmGesture)).toBeUndefined();
  expect(await page.evaluate(() => getSelection()?.toString() ?? '')).toBe('');

  const intervals = frames.slice(1).map((time, index) => time - frames[index]!);
  expect(intervals.length).toBeGreaterThan(25);
  const sorted = [...intervals].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const slow = intervals.filter((interval) => interval > 34).length;
  console.log(`drag: ${intervals.length} frames, median ${median.toFixed(1)} ms, ${slow} over 34 ms`);
  expect(median).toBeLessThanOrEqual(18);
  expect(slow / intervals.length).toBeLessThanOrEqual(0.05);

  // The title bar can never slide under the menu bar: the pointer goes higher than the window can.
  const view = await viewport(page);
  let grab = await grabPoint(page, id);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x, 46, { steps: 6 });
  await page.mouse.up();
  const raised = await settled(page, id);
  expect(raised.y).toBe(0);
  expect((await model(page, id))!.mode).toBe('normal');

  // Nor can it leave the screen: pushed into the bottom-right, enough of the bar stays to grab it again.
  const bar = (await titleBar(page, id).boundingBox())!;
  await page.mouse.move(bar.x + 20, bar.y + 19);
  await page.mouse.down();
  await page.mouse.move(view.w - 100, view.h + 30 - 6, { steps: 6 });
  await page.mouse.up();
  const dropped = await settled(page, id);
  expect(dropped.x).toBe(view.w - 140);
  expect(dropped.y).toBe(view.h - 40);
  grab = await grabPoint(page, id);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x - 600, grab.y - 500, { steps: 6 });
  await page.mouse.up();
  expect(await settled(page, id)).toEqual({ ...dropped, x: dropped.x - 600, y: dropped.y - 500 });
});

test('a window resizes from its corner and its edge, never below its minimum size', async ({ page }) => {
  const id = await open(page, 'terminal');
  const start = await settled(page, id);
  const handle = (name: string) => page.getByTestId(`window-${id}`).locator(`[data-resize="${name}"]`);
  const centre = async (name: string) => {
    const box = (await handle(name).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  await expect(handle('se')).toHaveCSS('cursor', 'nwse-resize');
  await expect(handle('w')).toHaveCSS('cursor', 'ew-resize');
  await expect(handle('n')).toHaveCSS('cursor', 'ns-resize');
  await expect(page.getByTestId(`window-${id}`).locator('[data-resize]')).toHaveCount(8);

  // Bottom-right corner: width and height grow by the distance dragged; the top-left corner stays.
  let grip = await centre('se');
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 150, grip.y + 90, { steps: 12 });
  const live = await drawn(page, id);
  await page.mouse.up();
  const grown = await settled(page, id);
  expect(grown).toEqual({ x: start.x, y: start.y, w: start.w + 150, h: start.h + 90 });
  expect(live).toEqual(grown);

  // Left edge: the right edge stays put while the left one follows the pointer.
  grip = await centre('w');
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 120, grip.y + 30, { steps: 12 });
  await page.mouse.up();
  const narrowed = await settled(page, id);
  expect(narrowed).toEqual({ x: grown.x + 120, y: grown.y, w: grown.w - 120, h: grown.h });

  // Far past the minimum: Terminal stops at 420 by 260 and its right edge has not moved.
  grip = await centre('w');
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 2000, grip.y, { steps: 12 });
  await page.mouse.up();
  const narrowest = await settled(page, id);
  expect(narrowest.w).toBe(420);
  expect(narrowest.x + narrowest.w).toBe(narrowed.x + narrowed.w);

  grip = await centre('se');
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 2000, grip.y - 2000, { steps: 12 });
  await page.mouse.up();
  const smallest = await settled(page, id);
  expect(smallest).toEqual({ x: narrowest.x, y: narrowest.y, w: 420, h: 260 });

  // The top edge cannot be pulled under the menu bar.
  grip = await centre('n');
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x, -200, { steps: 12 });
  await page.mouse.up();
  const tall = await settled(page, id);
  expect(tall.y).toBe(0);
  expect(tall.y + tall.h).toBe(smallest.y + smallest.h);
});

test('a window minimises to the dock, goes full screen and closes', async ({ page }) => {
  const id = await open(page, 'activity');
  const frame = page.getByTestId(`window-${id}`);
  const start = await settled(page, id);
  const icon = page.getByTestId('dock-app-activity');

  // Minimise: the window flies to its icon and is gone; the app is still running.
  await frame.getByTestId('window-minimise').click();
  await expect(frame).toBeHidden();
  expect((await model(page, id))!.mode).toBe('minimized');
  await expect(icon).toHaveAttribute('data-running', 'true');
  await expect(page.getByTestId('active-app-name')).toHaveText('Desktop');

  // The dock icon brings it back to the same place.
  await icon.click();
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('data-focused', 'true');
  expect(await settled(page, id)).toEqual(start);
  await expect.poll(() => frame.locator('.window').evaluate((node) => getComputedStyle(node).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);

  // The keyboard does the same.
  await page.keyboard.press('Control+m');
  await expect(frame).toBeHidden();
  await icon.click();
  await expect(frame).toBeVisible();

  // Full screen fills everything below the menu bar, and the dock steps aside.
  const view = await viewport(page);
  await frame.getByTestId('window-fullscreen').click();
  await expect(frame).toHaveAttribute('data-mode', 'fullscreen');
  expect(await settled(page, id)).toEqual({ x: 0, y: 0, w: view.w, h: view.h });
  expect(view).toEqual({ w: 1920, h: 1050 });
  await expect(page.getByTestId('dock')).toHaveAttribute('data-tucked', 'true');
  await expect(frame.locator('[data-resize]')).toHaveCount(0);

  // Escape leaves it, exactly back where the window was.
  await page.keyboard.press('Escape');
  await expect(frame).toHaveAttribute('data-mode', 'normal');
  expect(await settled(page, id)).toEqual(start);
  await expect(page.getByTestId('dock')).not.toHaveAttribute('data-tucked', 'true');

  // A double click on the title bar toggles it too.
  await titleBar(page, id).dblclick({ position: { x: 160, y: 18 } });
  await expect(frame).toHaveAttribute('data-mode', 'fullscreen');
  expect(await settled(page, id)).toEqual({ x: 0, y: 0, w: view.w, h: view.h });
  await titleBar(page, id).dblclick({ position: { x: 160, y: 18 } });
  expect(await settled(page, id)).toEqual(start);
  expect((await model(page, id))!.mode).toBe('normal');

  // The Window menu acts on the front window.
  await page.getByTestId('menu-window').click();
  await page.getByTestId('menu-window-popup').getByRole('menuitem', { name: 'Minimise' }).click();
  await expect(frame).toBeHidden();
  await icon.click();
  await expect(frame).toBeVisible();

  // Close removes the window and the dock indicator.
  await frame.getByTestId('window-close').click();
  await expect(frame).toHaveCount(0);
  await expect(icon).not.toHaveAttribute('data-running', 'true');
  await expect(page.getByTestId('active-app-name')).toHaveText('Desktop');
  expect(await model(page, id)).toBeNull();

  // Ctrl+W closes the front window where the browser hands the key to the page.
  const other = await open(page, 'system');
  await expect(page.getByTestId(`window-${other}`)).toBeVisible();
  await page.keyboard.press('Control+w');
  await expect(page.getByTestId(`window-${other}`)).toHaveCount(0);
});
