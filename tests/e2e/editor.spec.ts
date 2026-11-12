import { expect, test, type Page } from '@playwright/test';
import { login, setTheme, shots, trackErrors } from './helpers';

let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = trackErrors(page);
  await login(page);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const FOLDER = 'Projects/tidewatch';

async function write(page: Page, file: string, contents: string | Buffer): Promise<void> {
  const response = await page.request.put(`/api/fs/write?path=${encodeURIComponent(file)}`, {
    data: contents,
    headers: { 'content-type': 'application/octet-stream' },
  });
  expect(response.ok()).toBe(true);
}

async function read(page: Page, file: string): Promise<string> {
  const response = await page.request.get(`/api/fs/read?path=${encodeURIComponent(file)}`);
  expect(response.ok()).toBe(true);
  return response.text();
}

const openEditor = (page: Page, params?: Record<string, unknown>) =>
  page.evaluate((p) => window.__specos!.openApp!('editor', p), params);

const frame = (page: Page, id: string) => page.getByTestId(`window-${id}`);
const app = (page: Page, id: string) => frame(page, id).getByTestId('app-editor');
const content = (page: Page, id: string) => frame(page, id).getByTestId('editor-content');
const saved = (page: Page, id: string) => frame(page, id).getByTestId('editor-saved');
const title = (page: Page, id: string) => frame(page, id).getByTestId('window-title');

/** The text of the buffer, read from CodeMirror's own state. */
const buffer = (page: Page, id: string) =>
  page.evaluate((windowId) => (window.__specos!.editors as Record<string, any>)[windowId].state.doc.toString(), id);

/** Opens a file and waits until its text is on screen and has the keyboard. */
async function openFile(page: Page, file: string): Promise<string> {
  const id = await openEditor(page, { path: file });
  await expect(app(page, id)).toBeVisible();
  await expect(content(page, id)).toBeFocused();
  return id;
}

/** Puts the cursor at the end of the given line (1-based). */
async function cursorTo(page: Page, id: string, line: number): Promise<void> {
  await page.evaluate(
    ([windowId, lineNumber]) => {
      const view = (window.__specos!.editors as Record<string, any>)[windowId as string];
      view.dispatch({ selection: { anchor: view.state.doc.line(lineNumber).to } });
      view.focus();
    },
    [id, line] as const,
  );
}

const TIDES_TS = `import { readFile } from 'node:fs/promises';

/** One reading from the harbour gauge. */
export interface Reading {
  at: Date;
  /** Metres above chart datum. */
  height: number;
  station: string;
}

const HIGH_WATER = 4.2;
const pattern = /^(\\d{4}-\\d{2}-\\d{2}T\\S+)\\s+(-?\\d+\\.\\d+)$/;

export async function loadReadings(file: string, station = 'north-pier'): Promise<Reading[]> {
  const lines = (await readFile(file, 'utf8')).split('\\n');
  const readings: Reading[] = [];
  for (const line of lines) {
    const match = pattern.exec(line.trim());
    if (!match) continue;
    readings.push({ at: new Date(match[1]!), height: Number(match[2]), station });
  }
  return readings;
}

export function nextHighWater(readings: Reading[], after = new Date()): Reading | undefined {
  return readings
    .filter((reading) => reading.at > after && reading.height >= HIGH_WATER)
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
}

export class TideTable {
  private readonly byDay = new Map<string, Reading[]>();

  constructor(readings: Reading[]) {
    for (const reading of readings) {
      const day = reading.at.toISOString().slice(0, 10);
      this.byDay.set(day, [...(this.byDay.get(day) ?? []), reading]);
    }
  }

  range(day: string): number | null {
    const heights = this.byDay.get(day)?.map((reading) => reading.height);
    return heights?.length ? Math.max(...heights) - Math.min(...heights) : null;
  }
}
`;

const NOTES_MD = `# Tidewatch

Reads the harbour gauge and says when the next **high water** is due.

## How it works

1. \`loadReadings\` parses the gauge log, one reading per line.
2. \`nextHighWater\` picks the first reading above 4.2 m.
3. \`TideTable\` groups readings by day and gives the *range*.

> The gauge reports metres above chart datum, not above the pier.

## Stations

| Station | Datum | Readings a day |
| --- | --- | --- |
| north-pier | 0.00 m | 144 |
| ferry-slip | 0.35 m | 96 |

\`\`\`ts
const table = new TideTable(await loadReadings('gauge.log'));
console.log(table.range('2026-03-14'));
\`\`\`

- [x] Parse the log
- [ ] Warn an hour before high water
`;

test('a file opens, is edited, saved with Ctrl+S and read back from disk', async ({ page }) => {
  const file = `${FOLDER}/log.txt`;
  await write(page, file, 'first line\nsecond line\n');
  const id = await openFile(page, file);

  expect(await buffer(page, id)).toBe('first line\nsecond line\n');
  await expect(title(page, id)).toHaveText('log.txt');
  await expect(saved(page, id)).toHaveText('Saved');
  await expect(frame(page, id).getByTestId('editor-path')).toHaveText(file);
  await expect(frame(page, id).getByTestId('editor-language')).toHaveText('Plain text');
  await expect(frame(page, id).locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: '2' })).toHaveCount(1);
  await expect(frame(page, id).locator('.cm-activeLine')).toHaveCount(1);

  await cursorTo(page, id, 2);
  await expect(frame(page, id).getByTestId('editor-cursor')).toHaveText('2:12');
  await page.keyboard.type(' and more');
  await expect(app(page, id)).toHaveAttribute('data-dirty', 'true');
  await expect(title(page, id)).toHaveText('● log.txt');
  await expect(saved(page, id)).toHaveText('Edited');
  // Nothing reaches the disk before the save.
  expect(await read(page, file)).toBe('first line\nsecond line\n');

  await page.keyboard.press('Control+s');
  await expect(saved(page, id)).toHaveText('Saved');
  await expect(title(page, id)).toHaveText('log.txt');
  await expect(app(page, id)).not.toHaveAttribute('data-dirty');
  expect(await read(page, file)).toBe('first line\nsecond line and more\n');

  // Its own save comes back through the watcher and is not taken for someone else's change.
  await page.waitForTimeout(600);
  await expect(app(page, id)).toHaveAttribute('data-reloads', '0');
  await expect(frame(page, id).getByTestId('editor-banner')).toHaveCount(0);

  // Tab indents with spaces, and typing back to the saved text is clean again.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('x');
  expect(await buffer(page, id)).toBe('first line\nsecond line and more\n  x\n');
  await expect(saved(page, id)).toHaveText('Edited');
  // The letter, the indent as one unit, the line break.
  for (let press = 0; press < 3; press += 1) await page.keyboard.press('Backspace');
  expect(await buffer(page, id)).toBe('first line\nsecond line and more\n');
  await expect(saved(page, id)).toHaveText('Saved');
  await expect(title(page, id)).toHaveText('log.txt');
});

test('a change from outside reloads a clean buffer in place and marks the changed lines', async ({ page }) => {
  const file = `${FOLDER}/plan.txt`;
  const lines = Array.from({ length: 120 }, (_, index) => `step ${index + 1}`);
  await write(page, file, `${lines.join('\n')}\n`);
  const id = await openFile(page, file);

  await cursorTo(page, id, 90);
  await page.evaluate((windowId) => {
    const view = (window.__specos!.editors as Record<string, any>)[windowId];
    view.scrollDOM.scrollTop = 1200;
  }, id);
  /** Where a line of text sits on the screen. */
  const topOf = (text: string) =>
    frame(page, id)
      .locator('.cm-line')
      .filter({ hasText: new RegExp(`^${text}$`) })
      .evaluate((element) => Math.round(element.getBoundingClientRect().top));
  await expect
    .poll(() => page.evaluate((windowId) => (window.__specos!.editors as Record<string, any>)[windowId].scrollDOM.scrollTop, id))
    .toBe(1200);
  await page.waitForTimeout(150);
  const before = { line80: await topOf('step 80'), line90: await topOf('step 90') };

  // Someone adds a line far above the view and rewrites one inside it.
  const changed = [...lines];
  changed[69] = 'step 70, rewritten by someone else';
  changed.splice(9, 0, 'a new step after 9');
  await write(page, file, `${changed.join('\n')}\n`);

  await expect(app(page, id)).toHaveAttribute('data-reloads', '1');
  expect(await buffer(page, id)).toBe(`${changed.join('\n')}\n`);
  await expect(frame(page, id).locator('.cm-line.cm-flash')).toHaveCount(1);
  await expect(frame(page, id).locator('.cm-line.cm-flash')).toHaveText('step 70, rewritten by someone else');
  // The buffer is still clean, and the view and the cursor stayed with their text.
  await expect(saved(page, id)).toHaveText('Saved');
  await expect(title(page, id)).toHaveText('plan.txt');
  const after = { line80: await topOf('step 80'), line90: await topOf('step 90') };
  expect(Math.abs(after.line80 - before.line80)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.line90 - before.line90)).toBeLessThanOrEqual(1);
  await expect(frame(page, id).getByTestId('editor-cursor')).toHaveText('91:8');
  await shots(page, 'T-19-editor-reloaded');
  // The mark fades and goes.
  await expect(frame(page, id).locator('.cm-line.cm-flash')).toHaveCount(0);
});

test('a change from outside while the buffer is dirty asks: reload, or keep mine', async ({ page }) => {
  const file = `${FOLDER}/draft.txt`;
  await write(page, file, 'the original\n');
  const id = await openFile(page, file);
  const banner = frame(page, id).getByTestId('editor-banner');

  await cursorTo(page, id, 1);
  await page.keyboard.type(' with my edit');
  await write(page, file, 'theirs, first time\n');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('changed on disk');
  // The buffer is untouched while the question stands.
  expect(await buffer(page, id)).toBe('the original with my edit\n');
  await shots(page, 'T-19-editor-banner');

  await frame(page, id).getByTestId('editor-keep').click();
  await expect(banner).toHaveCount(0);
  expect(await buffer(page, id)).toBe('the original with my edit\n');
  await expect(saved(page, id)).toHaveText('Edited');
  await expect(content(page, id)).toBeFocused();

  await write(page, file, 'theirs, second time\n');
  await expect(banner).toBeVisible();
  await frame(page, id).getByTestId('editor-reload').click();
  await expect(banner).toHaveCount(0);
  expect(await buffer(page, id)).toBe('theirs, second time\n');
  await expect(saved(page, id)).toHaveText('Saved');
  // The reload replaced the user's own text, so it can be undone.
  await content(page, id).click();
  await page.keyboard.press('Control+z');
  expect(await buffer(page, id)).toBe('the original with my edit\n');
});

test('a deleted file is reported and the buffer is kept', async ({ page }) => {
  const file = `${FOLDER}/scratch.txt`;
  await write(page, file, 'worth keeping\n');
  const id = await openFile(page, file);

  const removed = await page.request.delete(`/api/fs/delete?path=${encodeURIComponent(file)}`);
  expect(removed.ok()).toBe(true);
  const banner = frame(page, id).getByTestId('editor-banner');
  await expect(banner).toHaveAttribute('data-kind', 'deleted');
  await expect(banner).toContainText('deleted on disk');
  await expect(saved(page, id)).toHaveText('Deleted on disk');
  expect(await buffer(page, id)).toBe('worth keeping\n');

  // Saving writes it again.
  await frame(page, id).getByTestId('editor-save-again').click();
  await expect(banner).toHaveCount(0);
  await expect(saved(page, id)).toHaveText('Saved');
  expect(await read(page, file)).toBe('worth keeping\n');
});

test('a TypeScript file is highlighted, in both themes', async ({ page }) => {
  const file = `${FOLDER}/src/tides.ts`;
  await write(page, file, TIDES_TS);
  const id = await openFile(page, file);
  await page.evaluate((windowId) => {
    window.__specos!.windows!.getState().setBounds(windowId, { x: 400, y: 70, w: 1120, h: 860 });
  }, id);

  await expect(frame(page, id).getByTestId('editor-language')).toHaveText('TypeScript');
  const spans = frame(page, id).locator('.cm-line span[class]');
  await expect.poll(() => spans.count()).toBeGreaterThan(40);
  // A keyword, a string and a comment are three different colours, none of them the plain ink.
  const colourOf = (text: string) =>
    frame(page, id)
      .locator('.cm-line span[class]')
      .filter({ hasText: text })
      .first()
      .evaluate((element) => getComputedStyle(element).color);
  const ink = await content(page, id).evaluate((element) => getComputedStyle(element).color);
  const light = [await colourOf('export'), await colourOf("'node:fs/promises'"), await colourOf('One reading from')];
  expect(new Set([...light, ink]).size).toBe(4);

  // Brackets match at the cursor.
  await cursorTo(page, id, 14);
  await expect(frame(page, id).locator('.cm-matchingBracket')).toHaveCount(2);

  await setTheme(page, 'dark');
  const dark = [await colourOf('export'), await colourOf("'node:fs/promises'"), await colourOf('One reading from')];
  expect(new Set(dark).size).toBe(3);
  expect(dark).not.toEqual(light);
  const paper = await frame(page, id).locator('.cm-editor').evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(paper).toBe('rgb(24, 27, 33)');
  await setTheme(page, 'light');

  await cursorTo(page, id, 27);
  await shots(page, 'T-19-editor');
});

test('Ctrl+F searches the buffer', async ({ page }) => {
  const file = `${FOLDER}/src/search.ts`;
  await write(page, file, TIDES_TS);
  const id = await openFile(page, file);

  await page.keyboard.press('Control+f');
  const field = frame(page, id).locator('.cm-search input[name=search]');
  await expect(field).toBeFocused();
  await page.keyboard.type('reading');
  await expect.poll(() => frame(page, id).locator('.cm-searchMatch').count()).toBeGreaterThan(5);
  await page.keyboard.press('Enter');
  await expect(frame(page, id).locator('.cm-searchMatch-selected')).toHaveCount(1);
  await shots(page, 'T-19-editor-search');
  await page.keyboard.press('Escape');
  await expect(frame(page, id).locator('.cm-search')).toHaveCount(0);
  await expect(content(page, id)).toBeFocused();
});

test('Markdown gets a rendered preview beside the text', async ({ page }) => {
  const file = `${FOLDER}/README.md`;
  await write(page, file, NOTES_MD);
  const id = await openFile(page, file);
  await page.evaluate((windowId) => {
    window.__specos!.windows!.getState().setBounds(windowId, { x: 300, y: 90, w: 1320, h: 800 });
  }, id);

  await expect(frame(page, id).getByTestId('editor-language')).toHaveText('Markdown');
  const toggle = frame(page, id).getByTestId('editor-preview-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  const preview = frame(page, id).getByTestId('editor-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('h1')).toHaveText('Tidewatch');
  await expect(preview.locator('table tbody tr')).toHaveCount(2);
  await expect(preview.locator('pre code')).toContainText('new TideTable');

  // The preview follows the buffer as it is typed, and what it renders is sanitised.
  await cursorTo(page, id, 3);
  await page.keyboard.type(' Typed <a href="javascript:window.pwned = 1" onclick="window.pwned = 1">just now</a>.<script>window.pwned = 1</script>');
  await expect(preview).toContainText('just now.');
  expect(await preview.locator('[onclick], script, [href^="javascript"]').count()).toBe(0);
  await preview.getByText('just now').click();
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  await cursorTo(page, id, 3);
  await page.keyboard.press('Control+z');
  await expect(preview).not.toContainText('just now.');

  await cursorTo(page, id, 5);
  await shots(page, 'T-19-editor-markdown');

  // The keyboard toggles it too.
  await page.keyboard.press('Control+Shift+V');
  await expect(preview).toHaveCount(0);
  // A file that is not Markdown has no toggle.
  await write(page, `${FOLDER}/plain.txt`, 'plain\n');
  const other = await openFile(page, `${FOLDER}/plain.txt`);
  await expect(frame(page, other).getByTestId('editor-preview-toggle')).toHaveCount(0);
});

test('closing a window with unsaved changes asks first', async ({ page }) => {
  const file = `${FOLDER}/unsaved.txt`;
  await write(page, file, 'on disk\n');
  const id = await openFile(page, file);
  const ask = frame(page, id).getByTestId('editor-ask');

  // A clean window just closes.
  const clean = await openFile(page, file);
  await frame(page, clean).getByTestId('window-close').click();
  await expect(frame(page, clean)).toHaveCount(0);

  await frame(page, id).getByTestId('window-titlebar').click({ position: { x: 200, y: 12 } });
  await cursorTo(page, id, 1);
  await page.keyboard.type(' plus mine');
  await frame(page, id).getByTestId('window-close').click();
  await expect(ask).toBeVisible();
  await expect(frame(page, id).getByTestId('editor-ask-save')).toBeFocused();
  await shots(page, 'T-19-editor-ask');

  // Escape cancels and the text is still there.
  await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect(frame(page, id)).toBeVisible();
  await expect(content(page, id)).toBeFocused();
  expect(await buffer(page, id)).toBe('on disk plus mine\n');

  // The window manager's own shortcut asks too; "Save and close" writes the file first.
  await page.keyboard.press('Control+w');
  await expect(ask).toBeVisible();
  await frame(page, id).getByTestId('editor-ask-save').click();
  await expect(frame(page, id)).toHaveCount(0);
  expect(await read(page, file)).toBe('on disk plus mine\n');

  // "Close without saving" leaves the file alone.
  const again = await openFile(page, file);
  await cursorTo(page, again, 1);
  await page.keyboard.type(' thrown away');
  await frame(page, again).getByTestId('window-close').click();
  await frame(page, again).getByTestId('editor-ask-discard').click();
  await expect(frame(page, again)).toHaveCount(0);
  expect(await read(page, file)).toBe('on disk plus mine\n');
});

test('binary files and files over 2 MB get a message instead of loading', async ({ page }) => {
  await write(page, `${FOLDER}/chart.bin`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff, 0xfe]));
  const binary = await openEditor(page, { path: `${FOLDER}/chart.bin` });
  const refusedBinary = frame(page, binary).getByTestId('editor-refused');
  await expect(refusedBinary).toHaveAttribute('data-reason', 'binary');
  await expect(refusedBinary).toContainText('Not a text file');
  await expect(frame(page, binary).locator('.cm-editor')).toHaveCount(0);

  await write(page, `${FOLDER}/gauge-2019.log`, Buffer.alloc(2 * 1024 * 1024 + 4096, 'a'));
  const large = await openEditor(page, { path: `${FOLDER}/gauge-2019.log` });
  const refusedLarge = frame(page, large).getByTestId('editor-refused');
  await expect(refusedLarge).toHaveAttribute('data-reason', 'large');
  await expect(refusedLarge).toContainText('2.0 MB');
  await expect(frame(page, large).locator('.cm-editor')).toHaveCount(0);
  await shots(page, 'T-19-editor-refused');

  // A folder is not a file either.
  const folder = await openEditor(page, { path: FOLDER });
  await expect(frame(page, folder).getByTestId('editor-refused')).toHaveAttribute('data-reason', 'folder');
});

test('with no file the window lists recent files and opens the launcher', async ({ page }) => {
  const empty = await openEditor(page);
  const state = frame(page, empty).getByTestId('editor-empty');
  await expect(state).toBeVisible();
  await expect(state).toContainText('Nothing yet');
  await expect(frame(page, empty).getByTestId('window-title')).toHaveText('Editor');
  await shots(page, 'T-19-editor-empty');

  // Files that were opened are listed, newest first.
  await write(page, `${FOLDER}/one.txt`, 'one\n');
  await write(page, `${FOLDER}/src/two.ts`, 'export const two = 2;\n');
  for (const file of [`${FOLDER}/one.txt`, `${FOLDER}/src/two.ts`]) {
    const opened = await openFile(page, file);
    await frame(page, opened).getByTestId('window-close').click();
    await expect(frame(page, opened)).toHaveCount(0);
  }
  await frame(page, empty).getByTestId('window-close').click();
  const id = await openEditor(page);
  const recent = frame(page, id).getByTestId('editor-recent');
  await expect(recent).toHaveCount(2);
  await expect(recent.first()).toContainText('two.ts');
  await shots(page, 'T-19-editor-recent');

  // "Open…" uses the launcher; the chosen file takes this window's place.
  await frame(page, id).getByTestId('editor-open').click();
  await expect(page.getByTestId('launcher-input')).toBeFocused();
  await page.keyboard.type('one.txt');
  await expect(page.locator('[data-testid="launcher-item"][data-key="file:Projects/tidewatch/one.txt"]')).toBeVisible();
  await page.locator('[data-testid="launcher-item"][data-key="file:Projects/tidewatch/one.txt"]').click();
  await expect(page.locator('[data-app="editor"]').getByTestId('editor-path')).toHaveText(`${FOLDER}/one.txt`);
  await expect(frame(page, id)).toHaveCount(0);

  // A recent file opens in the window it was picked in.
  const next = await openEditor(page);
  await frame(page, next).getByTestId('editor-recent').filter({ hasText: 'two.ts' }).click();
  await expect(app(page, next)).toBeVisible();
  expect(await buffer(page, next)).toBe('export const two = 2;\n');
  await expect(title(page, next)).toHaveText('two.ts');
});

test('the menus act on the editor in front', async ({ page }) => {
  const file = `${FOLDER}/menu.txt`;
  await write(page, file, 'from the menu\n');
  const id = await openFile(page, file);
  await cursorTo(page, id, 1);
  await page.keyboard.type(' bar');

  await page.getByTestId('menu-app-file').click();
  await page.getByRole('menuitem', { name: 'Save' }).click();
  await expect(saved(page, id)).toHaveText('Saved');
  expect(await read(page, file)).toBe('from the menu bar\n');

  await page.getByTestId('menu-app-edit').click();
  await page.getByRole('menuitem', { name: 'Find and replace' }).click();
  await expect(frame(page, id).locator('.cm-search input[name=search]')).toBeFocused();
});
