import zlib from 'node:zlib';
import { expect, test, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { SHOTS, login, setTheme, shots, trackErrors } from './helpers';

/**
 * The polish pass: one realistic desktop, every screen photographed in both
 * themes, and the layout facts that must hold on all of them.
 */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PROJECT = 'Projects/harbor';
const MENUBAR = 30;
const SCREEN = { w: 1920, h: 1080 };

// ---------------------------------------------------------------- seeding

const README = `# Harbor

Tide predictions for the **north quay**, kept by the people and agents who work on it.

## What is here

- \`notes.md\` holds the running notes
- \`src/tides.ts\` is the harmonic model
- \`src/chart.ts\` draws the curve for a day
- \`docs/plan.md\` is what comes next

## Running it

\`\`\`sh
npm install
npm run predict -- --station north-quay --days 3
\`\`\`

> Heights are in metres above chart datum. Times are local.

| Constituent | Period (h) | Amplitude (m) |
| ----------- | ---------- | ------------- |
| M2          | 12.42      | 1.84          |
| S2          | 12.00      | 0.61          |
| K1          | 23.93      | 0.12          |
`;

const NOTES = `# Notes

- The gauge at the north quay reads 4 cm high since the March storm.
- Spring tides line up with the ferry timetable on the 14th.
- Ask the harbour office for the 2019 survey.
`;

const PLAN = `# Plan

1. Fit the model to last year's gauge readings.
2. Add the two shallow-water constituents.
3. Publish a three-day table every morning.
`;

const TIDES = `/** One tidal constituent: a cosine with its own speed, height and phase. */
export interface Constituent {
  name: string;
  /** Degrees per hour. */
  speed: number;
  /** Metres. */
  amplitude: number;
  /** Degrees, relative to the station's epoch. */
  phase: number;
}

export const NORTH_QUAY: Constituent[] = [
  { name: 'M2', speed: 28.9841, amplitude: 1.84, phase: 132 },
  { name: 'S2', speed: 30.0, amplitude: 0.61, phase: 171 },
  { name: 'N2', speed: 28.4397, amplitude: 0.36, phase: 109 },
  { name: 'K1', speed: 15.0411, amplitude: 0.12, phase: 14 },
];

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Height above chart datum, in metres, so many hours after the epoch. */
export function heightAt(hours: number, constituents = NORTH_QUAY, meanLevel = 2.9): number {
  let height = meanLevel;
  for (const { speed, amplitude, phase } of constituents) {
    height += amplitude * Math.cos(radians(speed * hours - phase));
  }
  return height;
}

/** The turning points of a day: every high and low water, to the minute. */
export function turningPoints(day: number, step = 1 / 60): Array<{ hours: number; height: number; kind: 'high' | 'low' }> {
  const points: Array<{ hours: number; height: number; kind: 'high' | 'low' }> = [];
  const start = day * 24;
  for (let hours = start + step; hours < start + 24; hours += step) {
    const [before, here, after] = [heightAt(hours - step), heightAt(hours), heightAt(hours + step)];
    if (here > before && here >= after) points.push({ hours, height: here, kind: 'high' });
    if (here < before && here <= after) points.push({ hours, height: here, kind: 'low' });
  }
  return points;
}
`;

const CHART = `import { heightAt } from './tides';

/** The curve of one day as an SVG path, 24 hours wide and 6 metres tall. */
export function dayPath(day: number, width = 720, height = 180): string {
  const steps = 96;
  const parts: string[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const hours = day * 24 + (index / steps) * 24;
    const x = (index / steps) * width;
    const y = height - (heightAt(hours) / 6) * height;
    parts.push(\`\${index === 0 ? 'M' : 'L'}\${x.toFixed(1)} \${y.toFixed(1)}\`);
  }
  return parts.join(' ');
}
`;

const CONFIG = `${JSON.stringify({ station: 'north-quay', datum: 'chart', days: 3, units: 'm', publishAt: '06:00' }, null, 2)}\n`;

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A small real PNG: a tide curve in vermilion over a transparent ground. */
function png(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4;
      const curve = height / 2 + Math.sin((x / width) * Math.PI * 4) * height * 0.28;
      const distance = Math.abs(y - curve);
      const below = y > curve;
      rows[at] = distance < 5 ? 228 : 56;
      rows[at + 1] = distance < 5 ? 71 : 128;
      rows[at + 2] = distance < 5 ? 43 : 146;
      rows[at + 3] = distance < 5 ? 255 : below ? 70 : 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function write(page: Page, file: string, contents: string | Buffer): Promise<void> {
  const response = await page.request.put(`/api/fs/write?path=${encodeURIComponent(file)}`, {
    data: contents,
    headers: { 'content-type': 'application/octet-stream' },
  });
  expect(response.ok(), `write ${file}`).toBe(true);
}

/** Stops and forgets every job earlier specs left on the shared server. */
async function clearAgents(page: Page): Promise<void> {
  const list = async (): Promise<Array<{ id: string; status: string }>> => (await (await page.request.get('/api/agents')).json()).agents;
  const active = (agent: { status: string }) => agent.status === 'starting' || agent.status === 'running';
  for (const agent of await list()) {
    if (active(agent)) await page.request.post(`/api/agents/${agent.id}/stop`);
  }
  await expect.poll(async () => (await list()).filter(active).length).toBe(0);
  for (const agent of await list()) await page.request.delete(`/api/agents/${agent.id}`);
}

// ---------------------------------------------------------------- driving the desktop

const open = (page: Page, appId: string, params?: Record<string, unknown>): Promise<string> =>
  page.evaluate(([id, p]) => window.__specos!.openApp!(id as string, p as Record<string, unknown>), [appId, params] as const);

const frame = (page: Page, id: string): Locator => page.getByTestId(`window-${id}`);

/** Waits until no window is travelling and every one is drawn where the store has it. */
async function settle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__specos!.windows!.getState();
          if (document.querySelector('.wm-frame[data-moving]')) return 'moving';
          for (const win of Object.values(state.windows)) {
            if (win.desktop !== state.desktop || win.mode === 'minimized') continue;
            const box = document.querySelector(`[data-window-id="${win.id}"] .window`)!.getBoundingClientRect();
            const off = Math.max(
              Math.abs(box.x - win.bounds.x),
              Math.abs(box.y - 30 - win.bounds.y),
              Math.abs(box.width - win.bounds.w),
              Math.abs(box.height - win.bounds.h),
            );
            if (off > 0.5) return `${win.id} is ${off}px off`;
          }
          return 'settled';
        }),
      { timeout: 8000 },
    )
    .toBe('settled');
  await page.waitForTimeout(250);
}

/** Gives a window its rectangle, in the windows layer's coordinates, and brings it forward. */
async function place(page: Page, id: string, rect: Rect): Promise<void> {
  await page.evaluate(
    ([windowId, bounds]) => {
      const store = window.__specos!.windows!.getState();
      store.setBounds(windowId as string, bounds as Rect);
      store.focus(windowId as string);
    },
    [id, rect] as const,
  );
  await settle(page);
}

/** Minimises every window but the given ones, so a screenshot shows them alone. */
async function only(page: Page, ...ids: string[]): Promise<void> {
  await page.evaluate((keep) => {
    const store = window.__specos!.windows!.getState();
    for (const win of Object.values(store.windows)) {
      if (keep.includes(win.id)) {
        if (win.mode === 'minimized') store.restore(win.id);
      } else if (win.mode !== 'minimized') {
        store.minimise(win.id);
      }
    }
    store.focus(keep[keep.length - 1]!);
  }, ids);
  await expect(page.locator('.wm-frame[data-mode="minimized"]:not([data-parked])')).toHaveCount(0);
  await settle(page);
}

/** Centres a rectangle of the given size in the space between the menu bar and the dock. */
const centred = (w: number, h: number): Rect => ({ x: Math.round((SCREEN.w - w) / 2), y: Math.round((962 - h) / 2), w, h });

// ---------------------------------------------------------------- the layout facts

/** Every window on screen lies inside the screen, below the menu bar, with its whole title readable. */
async function expectWindowsInOrder(page: Page): Promise<void> {
  const report = await page.evaluate(() => {
    const state = window.__specos!.windows!.getState();
    return Object.values(state.windows)
      .filter((win) => win.desktop === state.desktop && win.mode !== 'minimized')
      .map((win) => {
        const element = document.querySelector(`[data-window-id="${win.id}"]`)!;
        const box = element.querySelector('.window')!.getBoundingClientRect();
        const title = element.querySelector<HTMLElement>('[data-testid="window-title"]')!;
        const controls = element.querySelector('.window__controls')!.getBoundingClientRect();
        return {
          id: `${win.appId} ${win.id}`,
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          titleClipped: title.scrollWidth > title.clientWidth,
          titleHeight: element.querySelector('[data-testid="window-titlebar"]')!.getBoundingClientRect().height,
          controlsInside: controls.right <= box.right && controls.left >= box.left,
        };
      });
  });
  expect(report.length).toBeGreaterThan(0);
  for (const win of report) {
    expect(win.left, `${win.id} left`).toBeGreaterThanOrEqual(0);
    expect(win.top, `${win.id} top`).toBeGreaterThanOrEqual(MENUBAR);
    expect(win.right, `${win.id} right`).toBeLessThanOrEqual(SCREEN.w);
    expect(win.bottom, `${win.id} bottom`).toBeLessThanOrEqual(SCREEN.h);
    expect(win.titleClipped, `${win.id} title is cut`).toBe(false);
    expect(win.titleHeight, `${win.id} title bar height`).toBe(38);
    expect(win.controlsInside, `${win.id} window controls`).toBe(true);
  }
}

/** Nothing in the menu bar is wider than its box, and everything in it sits inside the bar. */
async function expectMenuBarFits(page: Page): Promise<void> {
  const report = await page.getByTestId('menubar').evaluate((bar) => {
    const bounds = bar.getBoundingClientRect();
    const problems: string[] = [];
    if (bar.scrollWidth > bar.clientWidth) problems.push(`the bar scrolls: ${bar.scrollWidth} in ${bar.clientWidth}`);
    for (const element of bar.querySelectorAll<HTMLElement>('*')) {
      if (element.closest('[role="menu"]') || element.closest('svg')) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      const name = element.getAttribute('data-testid') ?? element.className;
      // Text that does not fit its box. Decoration (a pulsing dot's halo) may reach outside its own.
      const hasText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== '');
      if (hasText && element.scrollWidth > element.clientWidth + 1) problems.push(`${name} overflows: ${element.scrollWidth} in ${element.clientWidth}`);
      if (box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5) problems.push(`${name} leaves the bar sideways`);
      if (box.top < bounds.top - 0.5 || box.bottom > bounds.bottom + 0.5) problems.push(`${name} leaves the bar: ${box.top} to ${box.bottom}`);
    }
    // The two halves of the bar never meet.
    const strip = bar.querySelector('.menu-strip')!.getBoundingClientRect();
    const status = bar.querySelector('.menubar__status')!.getBoundingClientRect();
    if (strip.right > status.left) problems.push('the menus run into the status items');
    return problems;
  });
  expect(report).toEqual([]);
}

/** The dock is centred, clear of the bottom edge and wholly on screen. */
async function expectDockCentred(page: Page): Promise<void> {
  const box = (await page.getByTestId('dock').boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - SCREEN.w / 2)).toBeLessThanOrEqual(1);
  expect(box.x).toBeGreaterThan(0);
  expect(box.y + box.height).toBeLessThan(SCREEN.h);
  expect(box.y + box.height).toBeGreaterThan(SCREEN.h - 24);
}

/** No element that is meant to show its whole text is cut off inside the given scope. */
async function expectNoClippedLabels(scope: Locator, selector: string): Promise<void> {
  const clipped = await scope.locator(selector).evaluateAll((elements) =>
    elements
      .filter((element) => (element as HTMLElement).offsetParent !== null && element.scrollWidth > element.clientWidth + 1)
      .map((element) => `${element.className}: ${element.textContent}`),
  );
  expect(clipped).toEqual([]);
}

// ---------------------------------------------------------------- the test

test('every screen of a working desktop holds together in light and dark', async ({ page }) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(20_000);
  const errors = trackErrors(page);
  await login(page);
  await clearAgents(page);

  await write(page, `${PROJECT}/README.md`, README);
  await write(page, `${PROJECT}/notes.md`, NOTES);
  await write(page, `${PROJECT}/docs/plan.md`, PLAN);
  await write(page, `${PROJECT}/src/tides.ts`, TIDES);
  await write(page, `${PROJECT}/src/chart.ts`, CHART);
  await write(page, `${PROJECT}/config.json`, CONFIG);
  await write(page, `${PROJECT}/curve.png`, png(480, 280));

  // The bare desktop first: the shell on its own.
  await expectDockCentred(page);
  await expectMenuBarFits(page);
  await shots(page, 'T-24-empty-desktop');

  // ------------------------------------------------------------ Chat, with two agents at work
  const chatId = await open(page, 'chat');
  await place(page, chatId, centred(980, 760));
  const chat = page.getByTestId('app-chat');
  await page.keyboard.press('Control+p');
  await page.keyboard.type('harbor');
  await expect(chat.getByTestId('project-option').first()).toContainText('harbor');
  await page.keyboard.press('Enter');
  await expect(chat.getByTestId('project-chip')).toHaveText('harbor');
  await page.keyboard.type('Add a short summary of the tide model to notes.md');
  await page.keyboard.press('Enter');
  const replies = chat.getByTestId('chat-reply');
  await expect(replies).toHaveCount(1);
  await expect(replies.first()).toHaveAttribute('data-status', 'running');
  await page.keyboard.type('List the open questions in README.md');
  await page.keyboard.press('Enter');
  await expect(replies).toHaveCount(2);
  await expect(replies.nth(1)).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('agents-count')).toHaveText('2');
  // Both are well into their answers when the picture is taken.
  const written = (reply: Locator): Promise<number> =>
    reply.getByTestId('stream-text').evaluateAll((blocks) => blocks.reduce((sum, block) => sum + block.textContent!.length, 0));
  await expect.poll(() => written(replies.nth(1)), { timeout: 20_000 }).toBeGreaterThan(90);
  const [firstAgent, secondAgent] = [(await replies.first().getAttribute('data-job'))!, (await replies.nth(1).getAttribute('data-job'))!];
  await expectMenuBarFits(page);
  await shots(page, 'T-24-chat');

  // ------------------------------------------------------------ one agent's own window, live
  const agentId = await open(page, 'agent', { agentId: firstAgent });
  await only(page, agentId);
  await place(page, agentId, centred(820, 680));
  const agentWindow = frame(page, agentId).getByTestId('app-agent');
  await expect(agentWindow.getByTestId('stream-text').first()).toBeVisible();
  await shots(page, 'T-24-agent');

  for (const reply of [replies.first(), replies.nth(1)]) {
    await expect(reply).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  }

  // ------------------------------------------------------------ Agents
  const agentsId = await open(page, 'agents');
  await only(page, agentsId);
  await place(page, agentsId, centred(1040, 700));
  const agents = page.getByTestId('app-agents');
  await expect(agents.getByTestId('agent-card')).toHaveCount(2);
  await expect(agents.locator('[data-testid="agent-card"][data-status="done"]')).toHaveCount(2);
  await shots(page, 'T-24-agents');

  // ------------------------------------------------------------ Files and Peek
  const filesId = await open(page, 'files', { path: PROJECT, select: `${PROJECT}/README.md` });
  await only(page, filesId);
  await place(page, filesId, centred(1120, 680));
  const files = frame(page, filesId).getByTestId('app-files');
  await expect(files).toHaveAttribute('data-selected-path', `${PROJECT}/README.md`);
  await expect(files.getByTestId('files-details-name')).toHaveText('README.md');
  await expectNoClippedLabels(files, '.files-row__name');
  await shots(page, 'T-24-files');

  await files.focus();
  await page.keyboard.press('Space');
  const peek = page.getByTestId('peek');
  await expect(peek.getByTestId('peek-markdown')).toBeVisible();
  await page.waitForTimeout(500);
  const peekBox = (await peek.boundingBox())!;
  expect(Math.abs(peekBox.x + peekBox.width / 2 - SCREEN.w / 2)).toBeLessThanOrEqual(1);
  expect(peekBox.y).toBeGreaterThanOrEqual(MENUBAR);
  expect(peekBox.y + peekBox.height).toBeLessThanOrEqual(SCREEN.h);
  await shots(page, 'T-24-peek');
  // Peek follows the selection underneath it.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(files).toHaveAttribute('data-selected-path', `${PROJECT}/curve.png`);
  await expect(peek.getByTestId('peek-image')).toBeVisible();
  await expect(peek.getByTestId('peek-dimensions')).toHaveText('480 × 280');
  await page.waitForTimeout(400);
  await shots(page, 'T-24-peek-image');
  await page.keyboard.press('Escape');
  await expect(peek).toHaveCount(0);

  // ------------------------------------------------------------ Editor
  const editorId = await open(page, 'editor', { path: `${PROJECT}/src/tides.ts` });
  await only(page, editorId);
  await place(page, editorId, centred(1040, 760));
  const editor = frame(page, editorId).getByTestId('app-editor');
  await expect(editor).toHaveAttribute('data-language', /.+/);
  await expect(frame(page, editorId).getByTestId('editor-content')).toContainText('heightAt');
  await shots(page, 'T-24-editor');

  // ------------------------------------------------------------ Terminal, with output
  const terminalId = await open(page, 'terminal');
  await only(page, terminalId);
  await place(page, terminalId, centred(900, 560));
  const terminal = frame(page, terminalId).getByTestId('app-terminal');
  await expect(terminal).toHaveAttribute('data-phase', 'running');
  const screenText = () =>
    page.evaluate((id) => {
      const term = (window.__specos!.terminals as Record<string, any>)[id];
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let row = 0; row < buffer.length; row += 1) lines.push(buffer.getLine(row).translateToString(true));
      return lines.join('\n');
    }, terminalId);
  await expect.poll(async () => (await screenText()).trim().length).toBeGreaterThan(0);
  await expect(frame(page, terminalId).locator('.xterm-helper-textarea')).toBeFocused();
  for (const [command, marker] of [
    [`cd ${PROJECT} && ls -l`, 'README.md'],
    ['wc -l src/*.ts notes.md', 'total'],
    ['tail -n 3 ../../Workspaces/harbor-*/notes.md', /\(\d\/\d\)/],
  ] as const) {
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
    await expect.poll(screenText).toMatch(marker);
  }
  await page.waitForTimeout(300);
  await shots(page, 'T-24-terminal');

  // ------------------------------------------------------------ Activity, with a diff selected
  const activityId = await open(page, 'activity');
  await only(page, activityId);
  await place(page, activityId, centred(1200, 740));
  const activity = page.getByTestId('app-activity');
  const agentRow = activity.locator('[data-testid="activity-row"][data-actor="agent"]').filter({ hasText: 'notes.md' }).first();
  await agentRow.click();
  await expect(agentRow).toHaveAttribute('aria-selected', 'true');
  await expect(activity.getByTestId('diff-add').first()).toBeVisible();
  await shots(page, 'T-24-activity');

  // The workspace view of the same agent: every file it changed and the way back into the project.
  const workspaceId = (await (await page.request.get(`/api/agents/${firstAgent}`)).json()).workspace.id as string;
  await activity.getByTestId(`workspace-card-${workspaceId}`).click();
  await expect(activity.getByTestId('workspace-pane').getByTestId('diff-add').first()).toBeVisible();
  await shots(page, 'T-24-activity-workspace');

  // ------------------------------------------------------------ System, with a benchmark result
  const systemId = await open(page, 'system');
  await only(page, systemId);
  await place(page, systemId, centred(940, 880));
  const system = page.getByTestId('app-system');
  await expect(system.getByTestId('system-headline')).toBeVisible();
  await expect
    .poll(async () => Number(await system.getByTestId('system-cpu-spark').getAttribute('data-points')), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(5);
  await shots(page, 'T-24-system');
  await system.getByTestId('bench-run').click();
  await expect(system.getByTestId('bench-total')).toBeVisible({ timeout: 60_000 });
  await expect(system.getByTestId('bench-bar')).toHaveCount(10);
  await system.getByTestId('bench-totals').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shots(page, 'T-24-system-benchmark');
  // What the machine reports about changes is the user's and the agents' work, not the test's scratch copies.
  await expect(system.getByTestId('ground-fs')).not.toContainText('or more');

  // The benchmark's scratch copies are not the user's or an agent's work: they stay out of Activity.
  await only(page, activityId);
  await expect(activity.locator('[data-testid="activity-row"][data-path*="bench-"]')).toHaveCount(0);
  await expect(agentRow).toBeVisible();

  // ------------------------------------------------------------ the full desktop
  // Desktop 2 holds the overseeing apps; desktop 1 the working ones.
  await page.evaluate(
    ([agentsWin, activityWin, systemWin]) => {
      const store = window.__specos!.windows!.getState();
      for (const id of [agentsWin, activityWin, systemWin]) {
        store.restore(id!);
        store.moveToDesktop(id!, 1);
      }
      store.setBounds(agentsWin!, { x: 40, y: 32, w: 900, h: 560 });
      store.setBounds(activityWin!, { x: 620, y: 300, w: 1100, h: 640 });
      store.setBounds(systemWin!, { x: 1040, y: 24, w: 840, h: 700 });
      store.focus(activityWin!);
      store.setDesktop(0);
    },
    [agentsId, activityId, systemId] as const,
  );
  await page.evaluate(
    ([filesWin, editorWin, terminalWin, chatWin, agentWin]) => {
      const store = window.__specos!.windows!.getState();
      for (const id of [filesWin, editorWin, terminalWin, chatWin, agentWin]) store.restore(id!);
      store.setBounds(filesWin!, { x: 36, y: 28, w: 980, h: 560 });
      store.setBounds(terminalWin!, { x: 76, y: 470, w: 760, h: 460 });
      store.setBounds(agentWin!, { x: 1240, y: 36, w: 640, h: 520 });
      store.setBounds(chatWin!, { x: 1080, y: 330, w: 800, h: 610 });
      store.setBounds(editorWin!, { x: 420, y: 96, w: 900, h: 720 });
      for (const id of [filesWin, terminalWin, agentWin, chatWin, editorWin]) store.focus(id!);
    },
    [filesId, editorId, terminalId, chatId, agentId] as const,
  );
  await expect(page.locator('.wm-frame[data-mode="minimized"]')).toHaveCount(0);
  await settle(page);
  await page.waitForTimeout(600);
  await expectWindowsInOrder(page);
  await expectDockCentred(page);
  await expectMenuBarFits(page);
  await expect(page.getByTestId('active-app-name')).toHaveText('Editor');
  await shots(page, 'T-24-desktop');

  // ------------------------------------------------------------ an open menu
  await page.getByTestId('menu-app-file').click();
  const popup = page.getByTestId('menu-app-file-popup');
  await expect(popup).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  const popupBox = (await popup.boundingBox())!;
  expect(popupBox.y).toBeGreaterThanOrEqual(MENUBAR - 1);
  expect(popupBox.x).toBeGreaterThanOrEqual(0);
  await expectNoClippedLabels(popup, '.menu-popup__label');
  await shots(page, 'T-24-menu');
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);

  // ------------------------------------------------------------ the launcher with a query
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('launcher-input')).toBeFocused();
  await page.keyboard.type('harbor tides');
  await expect(page.locator('[data-testid="launcher-item"][data-key="file:Projects/harbor/src/tides.ts"]')).toBeVisible();
  await page.waitForTimeout(400);
  const launcherBox = (await page.getByTestId('launcher').locator('.launcher__field').boundingBox())!;
  expect(Math.abs(launcherBox.x + launcherBox.width / 2 - SCREEN.w / 2)).toBeLessThanOrEqual(1);
  await shots(page, 'T-24-launcher');
  // Escape clears the query first, then closes.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('launcher-input')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('launcher')).toHaveCount(0);

  // ------------------------------------------------------------ the overview
  await page.keyboard.press('F3');
  await expect(page.getByTestId('overview')).toBeVisible();
  await page.waitForTimeout(900);
  const tiles = await page.locator('[data-testid^="overview-tile-"]').evaluateAll((all) =>
    all.map((tile) => {
      const box = tile.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    }),
  );
  expect(tiles).toHaveLength(5);
  for (const tile of tiles) {
    expect(tile.left).toBeGreaterThanOrEqual(0);
    expect(tile.top).toBeGreaterThanOrEqual(0);
    expect(tile.right).toBeLessThanOrEqual(SCREEN.w);
    expect(tile.bottom).toBeLessThanOrEqual(SCREEN.h);
  }
  // No two pictures of windows overlap.
  for (let a = 0; a < tiles.length; a += 1) {
    for (let b = a + 1; b < tiles.length; b += 1) {
      const [one, two] = [tiles[a]!, tiles[b]!];
      const apart = one.right <= two.left || two.right <= one.left || one.bottom <= two.top || two.bottom <= one.top;
      expect(apart, `overview tiles ${a} and ${b} overlap`).toBe(true);
    }
  }
  await shots(page, 'T-24-overview');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('overview')).toHaveCount(0);
  await settle(page);

  // ------------------------------------------------------------ tiled
  await page.getByTestId('tiling-toggle').click();
  await settle(page);
  await page.waitForTimeout(600);
  await expectWindowsInOrder(page);
  const tiled = await page.evaluate(() => {
    const state = window.__specos!.windows!.getState();
    return Object.values(state.windows)
      .filter((win) => win.desktop === state.desktop)
      .map((win) => win.bounds);
  });
  expect(tiled).toHaveLength(5);
  for (const rect of tiled) {
    // Inside the gutters and above the dock.
    expect(rect.x).toBeGreaterThanOrEqual(8);
    expect(rect.y).toBeGreaterThanOrEqual(8);
    expect(rect.x + rect.w).toBeLessThanOrEqual(1912);
    expect(rect.y + rect.h).toBeLessThanOrEqual(954);
  }
  await shots(page, 'T-24-tiled');
  await page.getByTestId('tiling-toggle').click();
  await settle(page);

  // ------------------------------------------------------------ the second desktop
  await page.keyboard.press('Control+Alt+2');
  await expect(page.getByTestId('desktop-slot-2')).toHaveAttribute('data-current', 'true');
  await settle(page);
  await page.waitForTimeout(700);
  await expectWindowsInOrder(page);
  await expectMenuBarFits(page);
  await shots(page, 'T-24-desktop-2');

  // The shell opened at the start is still running: nothing on the way here ended its session.
  await expect(terminal).toHaveAttribute('data-phase', 'running');
  expect(errors).toEqual([]);
});

test('windows, desktops, the launcher and Peek move without a jump or a flash', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackErrors(page);
  await login(page);
  await write(page, `${PROJECT}/README.md`, README);
  await setTheme(page, 'dark');

  /**
   * Samples one element's opacity and rectangle on every frame, from the moment
   * `selector` first matches, for the given number of frames.
   */
  const record = (selector: string, frames: number) =>
    page.evaluate(
      ([target, count]) =>
        new Promise<Array<{ opacity: number; x: number; y: number; w: number; h: number }>>((resolve) => {
          const samples: Array<{ opacity: number; x: number; y: number; w: number; h: number }> = [];
          const started = performance.now();
          const tick = () => {
            const element = document.querySelector(target as string);
            if (element) {
              const box = element.getBoundingClientRect();
              samples.push({ opacity: Number(getComputedStyle(element).opacity), x: box.x, y: box.y, w: box.width, h: box.height });
            }
            // An element that leaves the page stops giving samples: two seconds is the longest any of this takes.
            if (samples.length >= (count as number) || performance.now() - started > 2000) resolve(samples);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      [selector, frames] as const,
    );

  /**
   * One movement in one direction: the value never turns back (beyond a spring's settling)
   * and it is seen on the way, not only at the start and the end.
   */
  /** The value never goes the wrong way; `direction` 1 means it only rises. */
  const expectNoFlash = (what: string, values: number[], direction: 1 | -1, samples = 6): void => {
    expect(values.length, `${what} was sampled`).toBeGreaterThanOrEqual(samples);
    for (let index = 1; index < values.length; index += 1) {
      expect((values[index - 1]! - values[index]!) * direction, `${what} flickers at frame ${index}`).toBeLessThanOrEqual(0.01);
    }
  };

  const expectOneMovement = (what: string, values: number[], direction: 1 | -1, seen = 3): void => {
    const [low, high] = [Math.min(...values), Math.max(...values)];
    const span = high - low;
    expect(span, `${what} moves`).toBeGreaterThan(1);
    for (let index = 1; index < values.length; index += 1) {
      const back = (values[index - 1]! - values[index]!) * direction;
      expect(back, `${what} turns back at frame ${index}`).toBeLessThanOrEqual(span * 0.02 + 0.5);
    }
    const onTheWay = new Set(values.filter((value) => value > low + span * 0.05 && value < high - span * 0.05).map((value) => Math.round(value)));
    expect(onTheWay.size, `${what} is seen on the way`).toBeGreaterThanOrEqual(seen);
  };

  // ------------------------------------------------------------ a window opens
  const opening = record('.wm-frame[data-app="files"] .window', 40);
  const filesId = await open(page, 'files', { path: PROJECT, select: `${PROJECT}/README.md` });
  await page.waitForTimeout(60);
  await page.screenshot({ path: path.join(SHOTS, 'T-24-motion-open-dark.png') });
  const openFrames = await opening;
  // It fades in once and never dims again on the way.
  expectNoFlash('the opening window', openFrames.map((sample) => sample.opacity), 1);
  expect(openFrames[0]!.opacity).toBeLessThan(0.9);
  expect(openFrames.at(-1)!.opacity).toBeGreaterThan(0.99);
  expectOneMovement('the opening window', openFrames.map((sample) => sample.w), 1);
  await settle(page);

  // ------------------------------------------------------------ Peek rises from the row
  await frame(page, filesId).getByTestId('app-files').focus();
  const rising = record('[data-testid="peek"]', 36);
  await page.keyboard.press('Space');
  await page.waitForTimeout(70);
  await page.screenshot({ path: path.join(SHOTS, 'T-24-motion-peek-dark.png') });
  const peekFrames = await rising;
  expectNoFlash('Peek', peekFrames.map((sample) => sample.opacity), 1);
  // A short rise: the panel only grows by a few per cent.
  expectOneMovement('Peek', peekFrames.map((sample) => sample.w), 1, 2);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('peek')).toHaveCount(0);

  // ------------------------------------------------------------ minimise flies to the dock and back
  const flying = record(`[data-window-id="${filesId}"] .window`, 30);
  await frame(page, filesId).getByTestId('window-minimise').click();
  await page.waitForTimeout(90);
  await page.screenshot({ path: path.join(SHOTS, 'T-24-motion-minimise-dark.png') });
  const flight = await flying;
  // It shrinks all the way without growing back.
  expectOneMovement('the minimising window', flight.map((sample) => sample.w), -1);
  await expect(frame(page, filesId)).toHaveAttribute('data-parked', 'true');
  await page.getByTestId('dock-app-files').click();
  await settle(page);

  // ------------------------------------------------------------ the desktops slide
  const sliding = record(`[data-window-id="${filesId}"]`, 36);
  await page.keyboard.press('Control+Alt+2');
  await page.waitForTimeout(90);
  await page.screenshot({ path: path.join(SHOTS, 'T-24-motion-slide-dark.png') });
  const slide = await sliding;
  // The window leaves to the left in one movement.
  expectOneMovement('the sliding desktop', slide.map((sample) => sample.x), -1);
  await page.keyboard.press('Control+Alt+1');
  await settle(page);

  // ------------------------------------------------------------ the launcher
  const [fading, dropping] = [record('.launcher', 30), record('.launcher__field', 30)];
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(60);
  await page.screenshot({ path: path.join(SHOTS, 'T-24-motion-launcher-dark.png') });
  expectNoFlash('the launcher', (await fading).map((sample) => sample.opacity), 1);
  // The field drops into place from just above.
  expectOneMovement('the launcher field', (await dropping).map((sample) => sample.y), 1, 1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('launcher')).toHaveCount(0);

  // ------------------------------------------------------------ a window closes
  const leaving = record(`[data-window-id="${filesId}"] .window`, 12);
  await frame(page, filesId).getByTestId('window-close').click();
  await page.waitForTimeout(50);
  await page.screenshot({ path: path.join(SHOTS, 'T-24-motion-close-dark.png') });
  const close = await leaving;
  expectNoFlash('the closing window', close.map((sample) => sample.opacity), -1, 3);
  await expect(frame(page, filesId)).toHaveCount(0);

  expect(errors).toEqual([]);
});
