import { expect, test, type Page } from '@playwright/test';
import { login, shots, trackErrors } from './helpers';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The screen below the 30px menu bar at 1920x1080, and what the window manager makes of it. */
const VIEW = { w: 1920, h: 1050 };
const GUTTER = 8;
/** The work area tiled and snapped windows share: inside the gutters, above the dock. */
const WORK: Rect = { x: 8, y: 8, w: 1904, h: 946 };
const LEFT_HALF: Rect = { x: 8, y: 8, w: 948, h: 946 };
const RIGHT_HALF: Rect = { x: 964, y: 8, w: 948, h: 946 };
const TOP_RIGHT: Rect = { x: 964, y: 8, w: 948, h: 469 };

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

/** Everything the store holds that a reload must bring back. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const state = window.__specos!.windows!.getState();
    return {
      desktop: state.desktop,
      focusedId: state.focusedId,
      tiling: state.tiling,
      windows: Object.values(state.windows)
        .map(({ id, appId, bounds, restoreBounds, mode, snapZone, desktop, z, tiled, params }) => ({
          id,
          appId,
          bounds,
          restoreBounds,
          mode,
          snapZone,
          desktop,
          z,
          tiled,
          params,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  });

const model = async (page: Page, id: string) => {
  const win = (await layout(page)).windows.find((entry) => entry.id === id);
  if (!win) throw new Error(`no window ${id}`);
  return win;
};

const frame = (page: Page, id: string) => page.getByTestId(`window-${id}`);

/** The window as it is drawn, in the layer's coordinates. */
const drawn = async (page: Page, id: string): Promise<Rect> => {
  const box = await frame(page, id).boundingBox();
  if (!box) throw new Error(`window ${id} is not on screen`);
  return { x: box.x, y: box.y - 30, w: box.width, h: box.height };
};

/** Waits for the spring to finish: the window is drawn where the store says it is. */
const settled = async (page: Page, id: string): Promise<Rect> => {
  await expect
    .poll(async () => {
      const [bounds, box] = [(await model(page, id)).bounds, await drawn(page, id)];
      return Math.max(Math.abs(bounds.x - box.x), Math.abs(bounds.y - box.y), Math.abs(bounds.w - box.w), Math.abs(bounds.h - box.h));
    })
    .toBeLessThanOrEqual(0.5);
  return (await model(page, id)).bounds;
};

/** Presses on a window's title bar, clear of its controls, and returns where. */
const grab = async (page: Page, id: string) => {
  const box = (await frame(page, id).getByTestId('window-titlebar').boundingBox())!;
  const point = { x: box.x + 110, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return point;
};

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const area = (rect: Rect) => rect.w * rect.h;

test('a window snaps to halves and quarters at the screen edges and comes away at its own size', async ({ page }) => {
  await open(page, 'activity');
  const id = await open(page, 'files');
  const own = await settled(page, id);
  const preview = page.getByTestId('drop-preview');

  // Towards the left edge: no preview until the pointer is nearly there.
  await grab(page, id);
  await page.mouse.move(300, 420, { steps: 10 });
  await expect(preview).toHaveCount(0);
  await page.mouse.move(6, 420, { steps: 10 });
  await expect(preview).toBeVisible();
  await expect
    .poll(async () => {
      const box = (await preview.boundingBox())!;
      return [Math.round(box.x), Math.round(box.y - 30), Math.round(box.width), Math.round(box.height)];
    })
    .toEqual([LEFT_HALF.x, LEFT_HALF.y, LEFT_HALF.w, LEFT_HALF.h]);
  await expect(preview).toContainText('948 × 946');
  await shots(page, 'T-15-snap-preview');
  // Until release the store still has the window where it was.
  expect((await model(page, id)).mode).toBe('normal');

  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  expect(await settled(page, id)).toEqual(LEFT_HALF);
  expect(await model(page, id)).toMatchObject({ mode: 'snapped', snapZone: 'left', restoreBounds: own });

  // The top-right corner is a quarter, and the preview follows the pointer from zone to zone.
  await grab(page, id);
  await page.mouse.move(1915, 500, { steps: 12 });
  await expect
    .poll(async () => Math.round((await preview.boundingBox())!.height))
    .toBe(RIGHT_HALF.h);
  await page.mouse.move(1890, 60, { steps: 8 });
  await expect
    .poll(async () => Math.round((await preview.boundingBox())!.height))
    .toBe(TOP_RIGHT.h);
  await page.mouse.up();
  expect(await settled(page, id)).toEqual(TOP_RIGHT);
  expect(await model(page, id)).toMatchObject({ mode: 'snapped', snapZone: 'top-right', restoreBounds: own });

  // Dragged away, it returns to its own size and stays under the pointer.
  const held = await grab(page, id);
  await page.mouse.move(held.x - 500, held.y + 260, { steps: 12 });
  await page.waitForTimeout(260);
  const carried = await drawn(page, id);
  expect(carried.w).toBe(own.w);
  expect(carried.h).toBe(own.h);
  const pointer = { x: held.x - 500, y: held.y + 260 - 30 };
  expect(pointer.x).toBeGreaterThan(carried.x);
  expect(pointer.x).toBeLessThan(carried.x + carried.w);
  expect(pointer.y).toBeGreaterThanOrEqual(carried.y);
  expect(pointer.y).toBeLessThanOrEqual(carried.y + 38);
  await page.mouse.up();
  const free = await settled(page, id);
  expect(free).toEqual(carried);
  expect(await model(page, id)).toMatchObject({ mode: 'normal', snapZone: null, restoreBounds: null });

  // The keyboard: halves, full screen, and back.
  await page.keyboard.press('Control+Alt+ArrowRight');
  expect(await settled(page, id)).toEqual(RIGHT_HALF);
  await page.keyboard.press('Control+Alt+ArrowLeft');
  expect(await settled(page, id)).toEqual(LEFT_HALF);
  await page.keyboard.press('Control+Alt+ArrowUp');
  expect(await settled(page, id)).toEqual({ x: 0, y: 0, ...VIEW });
  expect((await model(page, id)).mode).toBe('fullscreen');
  await page.keyboard.press('Control+Alt+ArrowDown');
  expect(await settled(page, id)).toEqual(free);
  expect(await model(page, id)).toMatchObject({ mode: 'normal', restoreBounds: null });

  // The top edge means full screen.
  await grab(page, id);
  await page.mouse.move(900, 34, { steps: 10 });
  await expect
    .poll(async () => Math.round((await preview.boundingBox())!.width))
    .toBe(VIEW.w);
  await page.mouse.up();
  expect(await settled(page, id)).toEqual({ x: 0, y: 0, ...VIEW });
  expect(await model(page, id)).toMatchObject({ mode: 'fullscreen', restoreBounds: free });
});

test('tiling arranges every window of a desktop and gives their places back when turned off', async ({ page }) => {
  const ids = [await open(page, 'files'), await open(page, 'terminal'), await open(page, 'editor')];
  const before = [];
  for (const id of ids) before.push(await settled(page, id));

  await page.getByTestId('tiling-toggle').click();
  await expect(page.getByTestId('tiling-toggle')).toHaveAttribute('aria-pressed', 'true');
  const tiled = [];
  for (const id of ids) tiled.push(await settled(page, id));

  // Three windows: a main area on the left, about 58% wide, and two stacked on the right.
  expect(tiled[0]).toEqual({ x: 8, y: 8, w: 1100, h: 946 });
  expect(tiled[1]).toEqual({ x: 1116, y: 8, w: 796, h: 469 });
  expect(tiled[2]).toEqual({ x: 1116, y: 485, w: 796, h: 469 });
  const covers = (rects: Rect[]) => {
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(WORK.x);
      expect(rect.y).toBeGreaterThanOrEqual(WORK.y);
      expect(rect.x + rect.w).toBeLessThanOrEqual(WORK.x + WORK.w);
      expect(rect.y + rect.h).toBeLessThanOrEqual(WORK.y + WORK.h);
    }
    rects.forEach((a, i) => rects.slice(i + 1).forEach((b) => expect(overlap(a, b)).toBe(false)));
    // Grown by half a gutter on every side, the tiles fill the work area exactly: nothing is left over but gutters.
    const grown = rects.map((rect) => ({ x: rect.x - 4, y: rect.y - 4, w: rect.w + GUTTER, h: rect.h + GUTTER }));
    expect(grown.reduce((sum, rect) => sum + area(rect), 0)).toBe((WORK.w + GUTTER) * (WORK.h + GUTTER));
  };
  covers(tiled);
  await expect(frame(page, ids[0]!).locator('[data-resize]')).toHaveCount(0);
  await page.mouse.move(300, 1040);
  await shots(page, 'T-15-tiled');

  // A fourth window joins the stack; six make a grid; closing them tiles the rest again.
  const extra = [await open(page, 'chat')];
  for (const id of [...ids, ...extra]) await settled(page, id);
  let now = (await layout(page)).windows.map((win) => win.bounds);
  expect(now).toHaveLength(4);
  covers(now);
  expect(now.filter((rect) => rect.x === 1116)).toHaveLength(3);

  extra.push(await open(page, 'agents'), await open(page, 'system'));
  for (const id of [...ids, ...extra]) await settled(page, id);
  now = (await layout(page)).windows.map((win) => win.bounds);
  covers(now);
  expect(new Set(now.map((rect) => rect.x)).size).toBe(3);
  expect(new Set(now.map((rect) => rect.y)).size).toBe(2);

  // Minimising one takes it out of the arrangement; restoring puts it back.
  await page.keyboard.press('Control+m');
  await expect(frame(page, extra[2]!)).toBeHidden();
  for (const id of [...ids, ...extra.slice(0, 2)]) await settled(page, id);
  covers((await layout(page)).windows.filter((win) => win.mode !== 'minimized').map((win) => win.bounds));
  await page.getByTestId('dock-app-system').click();
  for (const id of [...ids, ...extra]) await settled(page, id);
  covers((await layout(page)).windows.map((win) => win.bounds));

  for (const id of extra) await frame(page, id).getByTestId('window-close').click();
  for (const id of ids) await settled(page, id);
  expect([(await model(page, ids[0]!)).bounds, (await model(page, ids[1]!)).bounds, (await model(page, ids[2]!)).bounds]).toEqual(tiled);

  // Dropping one tile on another swaps them.
  await grab(page, ids[2]!);
  await page.mouse.move(500, 500, { steps: 12 });
  await expect(page.getByTestId('drop-preview')).toBeVisible();
  await page.mouse.up();
  expect(await settled(page, ids[2]!)).toEqual(tiled[0]);
  expect(await settled(page, ids[0]!)).toEqual(tiled[2]);
  expect(await settled(page, ids[1]!)).toEqual(tiled[1]);

  // A tile dropped on no other tile goes back to its place.
  await grab(page, ids[1]!);
  await page.mouse.move(1500, 1000, { steps: 8 });
  await page.mouse.up();
  expect(await settled(page, ids[1]!)).toEqual(tiled[1]);

  // Each desktop tiles on its own.
  expect((await layout(page)).tiling).toEqual([true, false, false, false]);

  // Off again (the shortcut this time): every window is back where it was before.
  await page.keyboard.press('Control+Alt+t');
  await expect(page.getByTestId('tiling-toggle')).toHaveAttribute('aria-pressed', 'false');
  for (const [index, id] of ids.entries()) {
    expect(await settled(page, id)).toEqual(before[index]);
    expect(await model(page, id)).toMatchObject({ mode: 'normal', tiled: false, restoreBounds: null });
  }
  await expect(frame(page, ids[0]!).locator('[data-resize]')).toHaveCount(8);
});

test('four desktops keep their own windows and switch with a slide', async ({ page }) => {
  const first = await open(page, 'files');
  await expect(frame(page, first)).toBeVisible();
  await expect(page.getByTestId('desktop-slot-1')).toHaveAttribute('data-occupied', 'true');
  await expect(page.getByTestId('desktop-slot-2')).not.toHaveAttribute('data-occupied', 'true');

  // Desktop 2 is empty.
  await page.keyboard.press('Control+2');
  await expect(page.getByTestId('desktop-slot-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(frame(page, first)).toBeHidden();
  await expect(page.getByTestId('active-app-name')).toHaveText('Desktop');
  expect((await layout(page)).desktop).toBe(1);

  // A window opened here belongs here.
  const second = await open(page, 'terminal');
  await expect(frame(page, second)).toBeVisible();
  expect((await model(page, second)).desktop).toBe(1);
  await expect(page.getByTestId('desktop-slot-2')).toHaveAttribute('data-occupied', 'true');
  const there = await settled(page, second);

  await page.keyboard.press('Control+1');
  await expect(frame(page, second)).toBeHidden();
  await expect(frame(page, first)).toBeVisible();
  await expect(page.getByTestId('active-app-name')).toHaveText('Files');
  // Hidden, not unmounted: the app inside keeps its state.
  await expect(frame(page, second).getByTestId('app-terminal')).toBeAttached();

  await page.keyboard.press('Control+2');
  await expect(frame(page, second)).toBeVisible();
  await expect(frame(page, first)).toBeHidden();
  await expect(page.getByTestId('active-app-name')).toHaveText('Terminal');
  expect(await settled(page, second)).toEqual(there);

  // Browsers keep Ctrl+number for tabs, so Ctrl+Alt+number works too, and so does the menu bar.
  await page.keyboard.press('Control+Alt+4');
  expect((await layout(page)).desktop).toBe(3);
  await page.getByTestId('desktop-slot-2').click();
  await expect(frame(page, second)).toBeVisible();

  // Ctrl+Shift+Alt+number sends the front window to another desktop without remounting it.
  await frame(page, second).evaluate((node) => ((node as HTMLElement).dataset.kept = 'yes'));
  await page.keyboard.press('Control+Shift+Alt+3');
  expect((await model(page, second)).desktop).toBe(2);
  await expect(frame(page, second)).toBeHidden();
  await expect(page.getByTestId('desktop-slot-2')).not.toHaveAttribute('data-occupied', 'true');
  await expect(page.getByTestId('desktop-slot-3')).toHaveAttribute('data-occupied', 'true');
  await page.keyboard.press('Control+3');
  await expect(frame(page, second)).toBeVisible();
  await expect(frame(page, second)).toHaveAttribute('data-kept', 'yes');
  expect(await settled(page, second)).toEqual(there);

  // Mid-slide both desktops are on screen, travelling in the direction of the switch.
  await page.keyboard.press('Control+1');
  const stage = page.locator('.wm-stage');
  const offsets: number[] = [];
  for (let sample = 0; sample < 4; sample += 1) {
    offsets.push((await stage.boundingBox())!.x);
    await page.waitForTimeout(30);
  }
  expect(offsets[0]).toBeLessThan(0);
  expect(offsets[0]).toBeGreaterThanOrEqual(-2 * VIEW.w);
  expect(offsets[3]).toBeGreaterThan(offsets[0]!);
  expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  await expect.poll(async () => (await stage.boundingBox())!.x).toBe(0);
  await expect(frame(page, first)).toBeVisible();
  await expect(frame(page, second)).toBeHidden();
});

test('the overview shows every window of the desktop and focuses the one that is picked', async ({ page }) => {
  const ids: string[] = [];
  for (const app of ['files', 'terminal', 'editor', 'chat', 'agents', 'activity', 'system']) ids.push(await open(page, app));
  // One of the seven is minimised: it sits in the smaller row.
  await page.keyboard.press('Control+m');
  await expect(frame(page, ids[6]!)).toBeHidden();
  const before = await layout(page);

  await page.keyboard.press('F3');
  const overview = page.getByTestId('overview');
  await expect(overview).toBeVisible();
  await expect(page.getByTestId('overview-backdrop')).toBeVisible();
  const tiles = overview.locator('[data-testid^="overview-tile-"]');
  await expect(tiles).toHaveCount(7);
  await expect(overview.locator('[data-minimized]')).toHaveCount(1);
  await expect(page.getByTestId(`overview-tile-${ids[6]}`)).toHaveAttribute('data-minimized', 'true');
  for (const [index, id] of ids.entries()) {
    await expect(page.getByTestId(`overview-tile-${id}`)).toContainText(
      ['Files', 'Terminal', 'Editor', 'Chat', 'Agents', 'Activity', 'System'][index]!,
    );
  }

  // The live windows travel into their tiles: each is drawn exactly under its target, and no two overlap.
  const scaled = (id: string) => frame(page, id).locator('.window');
  const boxOf = async (id: string): Promise<Rect> => {
    const box = (await scaled(id).boundingBox())!;
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  };
  const targetOf = async (id: string): Promise<Rect> => {
    const box = (await page.getByTestId(`overview-tile-${id}`).boundingBox())!;
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  };
  for (const id of ids) {
    await expect
      .poll(async () => {
        const [window, target] = [await boxOf(id), await targetOf(id)];
        return Math.max(Math.abs(window.x - target.x), Math.abs(window.y - target.y), Math.abs(window.w - target.w), Math.abs(window.h - target.h));
      })
      .toBeLessThanOrEqual(1);
  }
  const placed = [];
  for (const id of ids) placed.push(await targetOf(id));
  placed.forEach((a, i) => placed.slice(i + 1).forEach((b) => expect(overlap(a, b)).toBe(false)));
  for (const rect of placed) {
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(1920);
    expect(rect.y + rect.h).toBeLessThanOrEqual(1080);
  }
  // The store has not moved anything: the overview is a view, not a layout.
  expect(await layout(page)).toEqual(before);

  // The strip shows the four desktops with a small plan of each.
  await expect(overview.locator('[data-testid^="overview-desktop-"]')).toHaveCount(4);
  await expect(page.getByTestId('overview-desktop-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('overview-desktop-1').locator('.overview__mini')).toHaveCount(6);
  await expect(page.getByTestId('overview-desktop-2').locator('.overview__mini')).toHaveCount(0);

  // Arrow keys move the selection.
  await page.mouse.move(960, 1070);
  const selected = () => overview.locator('[data-selected]').getAttribute('data-testid');
  const start = await selected();
  expect(start).toBe(`overview-tile-${ids[5]}`);
  await page.keyboard.press('ArrowLeft');
  expect(await selected()).toBe(`overview-tile-${ids[4]}`);
  await page.keyboard.press('ArrowUp');
  const above = await selected();
  expect(above).not.toBe(`overview-tile-${ids[4]}`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await selected()).toBe(`overview-tile-${ids[6]}`);
  await page.keyboard.press('ArrowUp');
  await shots(page, 'T-15-overview');

  // Clicking a window focuses it and everything travels back to where it was.
  await page.getByTestId(`overview-tile-${ids[1]}`).click();
  await expect(overview).toHaveCount(0);
  await expect(frame(page, ids[1]!)).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('active-app-name')).toHaveText('Terminal');
  for (const id of ids.slice(0, 6)) {
    expect(await settled(page, id)).toEqual(before.windows.find((win) => win.id === id)!.bounds);
    await expect.poll(async () => (await boxOf(id)).w).toBe(before.windows.find((win) => win.id === id)!.bounds.w);
  }
  await expect(frame(page, ids[6]!)).toBeHidden();

  // Enter opens the selection, a minimised window included.
  await page.keyboard.press('F3');
  await expect(overview).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await selected()).toBe(`overview-tile-${ids[6]}`);
  await page.keyboard.press('Enter');
  await expect(overview).toHaveCount(0);
  await expect(frame(page, ids[6]!)).toBeVisible();
  await expect(frame(page, ids[6]!)).toHaveAttribute('data-focused', 'true');
  expect((await model(page, ids[6]!)).mode).toBe('normal');

  // Dragging a window onto a desktop in the strip moves it there.
  await page.keyboard.press('F3');
  const tile = (await page.getByTestId(`overview-tile-${ids[0]}`).boundingBox())!;
  const slot = (await page.getByTestId('overview-desktop-3').boundingBox())!;
  await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
  await page.mouse.down();
  await page.mouse.move(slot.x + slot.width / 2, slot.y + 40, { steps: 14 });
  await expect(page.getByTestId('overview-ghost')).toBeVisible();
  await expect(page.getByTestId('overview-desktop-3')).toHaveAttribute('data-drop', 'true');
  await page.mouse.up();
  await expect(overview).toBeVisible();
  expect((await model(page, ids[0]!)).desktop).toBe(2);
  await expect(tiles).toHaveCount(6);
  await expect(page.getByTestId('overview-desktop-3').locator('.overview__mini')).toHaveCount(1);

  // The strip switches desktops without leaving the overview.
  await page.getByTestId('overview-desktop-3').click();
  await expect(page.getByTestId('overview-desktop-3')).toHaveAttribute('aria-pressed', 'true');
  await expect(tiles).toHaveCount(1);
  await page.getByTestId('overview-desktop-4').click();
  await expect(page.getByTestId('overview-empty')).toBeVisible();

  // Escape leaves, and so does F3.
  await page.keyboard.press('Escape');
  await expect(overview).toHaveCount(0);
  await page.keyboard.press('F3');
  await expect(overview).toBeVisible();
  await page.keyboard.press('F3');
  await expect(overview).toHaveCount(0);
  expect((await layout(page)).desktop).toBe(3);
});

test('the layout comes back after a reload, without an opening animation', async ({ page }) => {
  // A desk with a bit of everything: a snapped window, a moved one, a minimised one, a tiled second desktop.
  const files = await open(page, 'files');
  await page.keyboard.press('Control+Alt+ArrowLeft');
  const editor = await open(page, 'editor', { path: 'Projects/notes.md' });
  const held = await grab(page, editor);
  await page.mouse.move(held.x + 380, held.y + 90, { steps: 8 });
  await page.mouse.up();
  const activity = await open(page, 'activity');
  await page.keyboard.press('Control+m');
  await page.keyboard.press('Control+2');
  const terminal = await open(page, 'terminal');
  const system = await open(page, 'system');
  await page.keyboard.press('Control+Alt+t');
  for (const id of [terminal, system]) await settled(page, id);
  await page.keyboard.press('Control+1');
  await frame(page, files).getByTestId('window-titlebar').click({ position: { x: 200, y: 19 } });
  await expect(frame(page, files)).toHaveAttribute('data-focused', 'true');

  const saved = await layout(page);
  expect(saved.windows).toHaveLength(5);
  expect(saved.focusedId).toBe(files);
  expect(saved.tiling).toEqual([false, true, false, false]);
  expect(saved.windows.find((win) => win.id === files)).toMatchObject({ mode: 'snapped', snapZone: 'left', bounds: LEFT_HALF });
  expect(saved.windows.find((win) => win.id === activity)).toMatchObject({ mode: 'minimized' });

  // From the first frame of the new page: was any window ever drawn part-way through an opening animation?
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { openingFrames: seen });
    const watch = () => {
      for (const node of document.querySelectorAll<HTMLElement>('.wm-frame:not([data-parked]) .window')) {
        const style = getComputedStyle(node);
        if (style.opacity !== '1' || (style.transform !== 'none' && style.transform !== 'matrix(1, 0, 0, 1, 0, 0)')) {
          seen.push(`${style.opacity} ${style.transform}`);
        }
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });

  await page.reload();
  await expect(page.getByTestId('desktop')).toBeVisible();
  await expect(frame(page, files)).toBeVisible();
  expect(await layout(page)).toEqual(saved);
  expect(await drawn(page, files)).toEqual(LEFT_HALF);
  expect(await drawn(page, editor)).toEqual(saved.windows.find((win) => win.id === editor)!.bounds);
  await expect(frame(page, files)).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('active-app-name')).toHaveText('Files');
  await expect(frame(page, activity)).toBeHidden();
  await expect(frame(page, terminal)).toBeHidden();
  await expect(page.getByTestId('dock-app-activity')).toHaveAttribute('data-running', 'true');
  await expect(page.getByTestId('desktop-slot-2')).toHaveAttribute('data-occupied', 'true');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as unknown as { openingFrames: string[] }).openingFrames)).toEqual([]);

  // What was restored is still live: the minimised window returns, the second desktop is still tiled.
  await page.getByTestId('dock-app-activity').click();
  await expect(frame(page, activity)).toBeVisible();
  await page.keyboard.press('Control+2');
  await expect(frame(page, terminal)).toBeVisible();
  await expect(page.getByTestId('tiling-toggle')).toHaveAttribute('aria-pressed', 'true');
  // A new window gets an id no restored window has.
  const chat = await open(page, 'chat');
  expect([files, editor, activity, terminal, system]).not.toContain(chat);
  await frame(page, chat).getByTestId('window-close').click();
  await page.keyboard.press('Control+1');

  // On a smaller screen the windows are brought into view.
  await page.setViewportSize({ width: 1180, height: 700 });
  await expect.poll(async () => (await layout(page)).windows.find((win) => win.id === editor)!.bounds.x).toBeLessThan(1180 - 900 + 1);
  for (const win of (await layout(page)).windows.filter((entry) => entry.desktop === 0)) {
    expect(win.bounds.x).toBeGreaterThanOrEqual(0);
    expect(win.bounds.y).toBeGreaterThanOrEqual(0);
    expect(win.bounds.x + win.bounds.w).toBeLessThanOrEqual(1180);
    expect(win.bounds.y + win.bounds.h).toBeLessThanOrEqual(670);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  // Let the save that the resize caused land first, so it does not overwrite what is edited next.
  await page.waitForTimeout(500);

  // A saved layout that cannot be trusted in places still opens: bad windows are dropped, odd params are kept as they are.
  await page.evaluate(() => {
    const key = 'specos.windows.v1';
    const stored = JSON.parse(localStorage.getItem(key)!);
    stored.windows.push({ ...stored.windows[0], id: 'w-90', appId: 'no-such-app' });
    stored.windows.push({ ...stored.windows[0], id: 'w-91', bounds: { x: 'left', y: 0, w: 10, h: 10 } });
    stored.windows.push({ ...stored.windows[0], id: 'w-92', appId: 'agent', mode: 'normal', snapZone: null, restoreBounds: null, params: { agentId: 'gone-agent', extra: [1, { deep: true }] } });
    localStorage.setItem(key, JSON.stringify(stored));
  });
  await page.reload();
  await expect(page.getByTestId('desktop')).toBeVisible();
  const reopened = await layout(page);
  expect(reopened.windows.map((win) => win.id)).not.toContain('w-90');
  expect(reopened.windows.map((win) => win.id)).not.toContain('w-91');
  expect(reopened.windows.find((win) => win.id === 'w-92')).toMatchObject({ appId: 'agent', params: { agentId: 'gone-agent' } });
  await expect(frame(page, 'w-92')).toBeVisible();
  await expect(frame(page, 'w-92').getByTestId('app-agent')).toBeVisible();
});
