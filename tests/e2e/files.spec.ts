import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E_HOME, login, shots, trackErrors } from './helpers';

let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = trackErrors(page);
  await login(page);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------- seeding

const write = async (page: Page, file: string, contents: string | Buffer) => {
  const response = await page.request.put(`/api/fs/write?path=${encodeURIComponent(file)}`, { data: contents });
  expect(response.ok()).toBe(true);
};

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A small real PNG: a vermilion disc on a transparent ground, so the checkerboard has something to show. */
function png(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  const radius = Math.min(width, height) * 0.36;
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4;
      const distance = Math.hypot(x - width / 2, y - height / 2);
      const inside = distance < radius;
      const ring = !inside && distance < radius + 10;
      rows[at] = inside ? 228 : 27;
      rows[at + 1] = inside ? 71 : 26;
      rows[at + 2] = inside ? 43 : 23;
      rows[at + 3] = inside ? 255 : ring ? 150 : 0;
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

const README = `# Atlas

A field guide to the **survey** project, kept by the people and agents who work on it.

## What is here

- \`notes.txt\` holds the running notes
- \`logo.png\` is the mark
- [x] seeded by the test
- [ ] reviewed

Read more on [the project site](https://example.com/atlas).

<script>window.__pwned = true</script>
<img src="https://example.com/track.png" onerror="window.__pwned = true">

\`\`\`ts
export const scale = 1 / 25_000;
\`\`\`
`;

/** A project folder with a text file, a Markdown file, a picture and a folder of code. */
async function seed(page: Page, project: string): Promise<string> {
  const root = `Projects/${project}`;
  await write(page, `${root}/README.md`, README);
  await write(page, `${root}/notes.txt`, 'first line\nsecond line\nthird line\n');
  await write(page, `${root}/logo.png`, png(320, 200));
  await write(page, `${root}/src/main.ts`, "export const name = 'atlas';\n");
  return root;
}

// ---------------------------------------------------------------- reading the app

/** Opens a Files window and returns its app root. */
async function openFiles(page: Page, params: Record<string, unknown> = {}): Promise<Locator> {
  const id = await page.evaluate((p) => window.__specos!.openApp!('files', p), params);
  const app = page.getByTestId(`window-${id}`).getByTestId('app-files');
  await expect(app).toBeVisible();
  await expect(app).toBeFocused();
  return app;
}

const windowIdOf = (app: Locator) =>
  app.evaluate((element) => element.closest('[data-window-id]')!.getAttribute('data-window-id'));
const column = (app: Locator, folder: string) => app.locator(`[data-testid="files-column"][data-folder="${folder}"]`);
const row = (app: Locator, file: string) => app.locator(`[data-testid="files-row"][data-path="${file}"]`);
const columns = (app: Locator) =>
  app.getByTestId('files-column').evaluateAll((all) => all.map((element) => element.getAttribute('data-folder')));
const crumbs = (app: Locator) =>
  app.getByTestId('files-crumb').evaluateAll((all) => all.map((element) => element.getAttribute('data-path')));
const onDisk = (file: string) => fs.existsSync(path.join(E2E_HOME, file));

const windows = (page: Page) =>
  page.evaluate(() =>
    Object.values(window.__specos!.windows!.getState().windows).map(({ appId, params }) => ({ appId, params })),
  );

// ---------------------------------------------------------------- tests

test('columns open by click and by keyboard, and the breadcrumbs jump back', async ({ page }) => {
  const root = await seed(page, 'atlas');
  const app = await openFiles(page);

  // Home is one column; the sidebar lists the fixed places and the project, live.
  await expect.poll(() => columns(app)).toEqual(['']);
  await expect(row(app, 'Projects')).toBeVisible();
  await expect(app.getByTestId('files-place').first()).toHaveAttribute('data-current', 'true');
  await expect(app.getByTestId('files-projects').getByTestId('files-place')).toContainText(['atlas']);

  // A click on a folder opens it as the next column and describes it at the end.
  await row(app, 'Projects').click();
  await expect.poll(() => columns(app)).toEqual(['', 'Projects']);
  await expect(app.getByTestId('files-details-name')).toHaveText('Projects');
  await row(app, root).click();
  await expect.poll(() => columns(app)).toEqual(['', 'Projects', root]);
  await expect.poll(() => crumbs(app)).toEqual(['', 'Projects', root]);

  // Each column is 240 wide and they sit side by side.
  const boxes = await app.getByTestId('files-column').evaluateAll((all) =>
    all.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, w: box.width };
    }),
  );
  expect(boxes.map((box) => box.w)).toEqual([240, 240, 240]);
  expect(boxes[1]!.x - boxes[0]!.x).toBe(240);

  // Right steps into the folder: folders come first, then files by name.
  await page.keyboard.press('ArrowRight');
  await expect(app).toHaveAttribute('data-selected-path', `${root}/src`);
  await expect(column(app, root).getByTestId('files-row')).toHaveText(['src', 'logo.png', 'notes.txt', 'README.md']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(app).toHaveAttribute('data-selected-path', `${root}/notes.txt`);
  await expect(row(app, `${root}/notes.txt`)).toHaveAttribute('data-selected', 'active');
  await expect(row(app, root)).toHaveAttribute('data-selected', 'trail');

  // The last column describes the selected file.
  const details = app.getByTestId('files-details');
  await expect(details.getByTestId('files-details-name')).toHaveText('notes.txt');
  await expect(details.getByTestId('files-details-size')).toHaveText('34 B');
  await expect(details.getByTestId('files-details-path')).toHaveText(`${root}/notes.txt`);
  await expect(details.getByTestId('files-open-editor')).toBeVisible();
  await expect(details.getByTestId('files-peek')).toBeVisible();

  // Up, End, Home, and letters typed quickly select by name.
  await page.keyboard.press('ArrowUp');
  await expect(app).toHaveAttribute('data-selected-path', `${root}/logo.png`);
  await expect(details.getByTestId('files-thumb')).toBeVisible();
  await page.keyboard.press('End');
  await expect(app).toHaveAttribute('data-selected-path', `${root}/README.md`);
  await page.keyboard.press('Home');
  await expect(app).toHaveAttribute('data-selected-path', `${root}/src`);
  await page.keyboard.type('no');
  await expect(app).toHaveAttribute('data-selected-path', `${root}/notes.txt`);

  // Left and Backspace go up; the folder that was left stays selected.
  await page.keyboard.press('ArrowLeft');
  await expect(app).toHaveAttribute('data-folder', 'Projects');
  await expect(app).toHaveAttribute('data-selected-path', root);
  await page.keyboard.press('Backspace');
  await expect(app).toHaveAttribute('data-folder', '');
  await expect(app).toHaveAttribute('data-selected-path', 'Projects');

  // Enter goes down into a folder, and opens a text file in the Editor.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(app).toHaveAttribute('data-folder', root);
  await page.keyboard.press('Enter');
  await expect(app).toHaveAttribute('data-selected-path', `${root}/src/main.ts`);
  await page.keyboard.press('Enter');
  await expect.poll(() => windows(page)).toContainEqual({ appId: 'editor', params: { path: `${root}/src/main.ts` } });

  // Back in Files, the breadcrumbs jump: to the project, then all the way home.
  await page.evaluate((id) => window.__specos!.windows!.getState().focus(id!), await windowIdOf(app));
  await expect(app).toBeFocused();
  await expect.poll(() => crumbs(app)).toEqual(['', 'Projects', root, `${root}/src`]);
  await app.locator(`[data-testid="files-crumb"][data-path="${root}"]`).click();
  await expect(app).toHaveAttribute('data-folder', root);
  await expect.poll(() => columns(app)).toEqual(['', 'Projects', root]);
  await expect(app).toBeFocused();
  await app.locator('[data-testid="files-crumb"][data-path=""]').click();
  await expect.poll(() => columns(app)).toEqual(['']);

  // The sidebar goes straight to a project.
  await app.locator(`[data-testid="files-place"][data-path="${root}"]`).click();
  await expect(app).toHaveAttribute('data-folder', root);
  await expect(page.getByTestId(`window-${await windowIdOf(app)}`).getByTestId('window-title')).toHaveText('atlas');

  await page.keyboard.type('read');
  await expect(details.getByTestId('files-details-name')).toHaveText('README.md');
  await shots(page, 'T-17-files');
});

test('the launcher contract: a path opens that folder, a path with select opens it with the file selected', async ({ page }) => {
  const root = await seed(page, 'atlas');

  const folder = await openFiles(page, { path: `${root}/src` });
  await expect(folder).toHaveAttribute('data-folder', `${root}/src`);
  await expect.poll(() => columns(folder)).toEqual(['', 'Projects', root, `${root}/src`]);
  await expect(row(folder, `${root}/src/main.ts`)).toBeVisible();
  // The newest column is scrolled into view.
  await expect(column(folder, `${root}/src`)).toBeInViewport({ ratio: 1 });

  const selected = await openFiles(page, { path: root, select: `${root}/logo.png` });
  await expect(selected).toHaveAttribute('data-folder', root);
  await expect(row(selected, `${root}/logo.png`)).toHaveAttribute('data-selected', 'active');
  await expect(selected.getByTestId('files-details-name')).toHaveText('logo.png');
  await expect(selected.getByTestId('files-details')).toBeInViewport({ ratio: 1 });
});

test('Space opens Peek with rendered Markdown, text and the picture, and it follows the selection', async ({ page }) => {
  const root = await seed(page, 'atlas');
  const app = await openFiles(page, { path: root, select: `${root}/README.md` });
  await expect(row(app, `${root}/README.md`)).toHaveAttribute('data-selected', 'active');
  const peek = page.getByTestId('peek');
  await expect(peek).toHaveCount(0);

  // Markdown is rendered, and nothing in the file can script the desktop.
  await page.keyboard.press('Space');
  await expect(peek).toBeVisible();
  await expect(peek.getByTestId('peek-title')).toHaveText('README.md');
  const markdown = peek.getByTestId('peek-markdown');
  await expect(markdown.locator('h1')).toHaveText('Atlas');
  await expect(markdown.locator('strong')).toHaveText('survey');
  await expect(markdown.locator('pre code')).toContainText('scale');
  const link = markdown.locator('a');
  await expect(link).toHaveAttribute('href', 'https://example.com/atlas');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(markdown.locator('script')).toHaveCount(0);
  await expect(markdown.locator('[onerror]')).toHaveCount(0);
  // A picture from somewhere else is never fetched.
  await expect(markdown.locator('img[src]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __pwned?: boolean }).__pwned)).toBeUndefined();

  // The panel sits in the middle of the screen and the window keeps the keyboard.
  // (Once the spring that carries it out of the row has settled.)
  const offCentre = async () => {
    const box = (await peek.boundingBox())!;
    return Math.max(Math.abs(box.x + box.width / 2 - 960), Math.abs(box.y + box.height / 2 - 540));
  };
  await expect.poll(offCentre).toBeLessThan(2);
  await page.mouse.move(1800, 900);
  await shots(page, 'T-17-peek-markdown');

  // Arrows move the selection underneath and Peek follows: text with line numbers.
  await page.keyboard.press('ArrowUp');
  await expect(app).toHaveAttribute('data-selected-path', `${root}/notes.txt`);
  await expect(peek.getByTestId('peek-title')).toHaveText('notes.txt');
  await expect(peek.locator('.peek__code')).toHaveText('first line\nsecond line\nthird line');
  await expect(peek.locator('.peek__gutter')).toHaveText('1\n2\n3');
  await expect(peek.getByTestId('peek-lines')).toHaveText('3 lines');

  // It updates while it is open when the file changes on disk.
  fs.appendFileSync(path.join(E2E_HOME, root, 'notes.txt'), 'written from outside\n');
  await expect(peek.locator('.peek__code')).toContainText('written from outside');
  await expect(peek.getByTestId('peek-lines')).toHaveText('4 lines');

  // The picture: fitted, with its size, loaded from the file API.
  await page.keyboard.press('ArrowUp');
  await expect(peek.getByTestId('peek-title')).toHaveText('logo.png');
  const image = peek.getByTestId('peek-image');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', /^\/api\/fs\/read\?path=Projects%2Fatlas%2Flogo\.png/);
  await expect(peek.getByTestId('peek-dimensions')).toHaveText('320 × 200');
  expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(320);
  await shots(page, 'T-17-peek-image');

  // A folder has nothing to peek at: the panel goes away. Space on a file brings it back, Space closes it.
  await page.keyboard.press('ArrowUp');
  await expect(app).toHaveAttribute('data-selected-path', `${root}/src`);
  await expect(peek).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(peek).toBeVisible();
  await page.keyboard.press('Space');
  await expect(peek).toHaveCount(0);

  // Enter on a picture opens Peek, Escape closes it, and the window has the keyboard again.
  await page.keyboard.press('Enter');
  await expect(peek.getByTestId('peek-image')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(peek).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(app).toHaveAttribute('data-selected-path', `${root}/notes.txt`);

  // From the details pane, and closed with its own button.
  await app.getByTestId('files-peek').click();
  await expect(peek.getByTestId('peek-title')).toHaveText('notes.txt');
  await peek.getByRole('button', { name: 'Close Peek' }).click();
  await expect(peek).toHaveCount(0);
});

test('a folder and a file are made from the keyboard, renamed and deleted', async ({ page }) => {
  const root = await seed(page, 'ledger');
  const app = await openFiles(page, { path: root });
  await expect(row(app, `${root}/notes.txt`)).toBeVisible();
  const input = app.getByTestId('files-name-input');

  // Ctrl+Shift+N: a new folder, named in place.
  await page.keyboard.press('Control+Shift+N');
  await expect(input).toBeFocused();
  await page.keyboard.type('drafts');
  await page.keyboard.press('Enter');
  await expect(row(app, `${root}/drafts`)).toHaveAttribute('data-selected', 'active');
  await expect(row(app, `${root}/drafts`)).toHaveAttribute('data-kind', 'dir');
  await expect.poll(() => onDisk(`${root}/drafts`)).toBe(true);
  await expect(app).toBeFocused();

  // Ctrl+N: a new file in the folder the keyboard is in.
  await page.keyboard.press('Control+N');
  await expect(input).toBeFocused();
  await page.keyboard.type('todo.txt');
  await page.keyboard.press('Enter');
  await expect(row(app, `${root}/todo.txt`)).toHaveAttribute('data-selected', 'active');
  await expect.poll(() => onDisk(`${root}/todo.txt`)).toBe(true);

  // Escape leaves without making anything.
  await page.keyboard.press('Control+N');
  await page.keyboard.type('never');
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  expect(onDisk(`${root}/never`)).toBe(false);

  // F2 renames in place; the name without its extension is selected, so typing replaces it.
  await page.keyboard.press('F2');
  await expect(input).toHaveValue('todo.txt');
  await page.keyboard.type('done');
  await expect(input).toHaveValue('done.txt');
  await page.keyboard.press('Enter');
  await expect(row(app, `${root}/done.txt`)).toHaveAttribute('data-selected', 'active');
  await expect(row(app, `${root}/todo.txt`)).toHaveCount(0);
  await expect.poll(() => onDisk(`${root}/done.txt`)).toBe(true);
  expect(onDisk(`${root}/todo.txt`)).toBe(false);

  // A name that is taken is refused and said so.
  await page.keyboard.press('F2');
  await input.fill('notes.txt');
  await page.keyboard.press('Enter');
  await expect(app.getByTestId('files-notice')).toContainText('already something named notes.txt');
  await expect(row(app, `${root}/done.txt`)).toBeVisible();

  // Delete asks in the row. Escape keeps the file; Delete then Enter removes it.
  await page.keyboard.press('Delete');
  await expect(row(app, `${root}/done.txt`).getByTestId('files-confirm')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(app.getByTestId('files-confirm')).toHaveCount(0);
  expect(onDisk(`${root}/done.txt`)).toBe(true);
  await page.keyboard.press('Delete');
  await page.keyboard.press('Enter');
  await expect(row(app, `${root}/done.txt`)).toHaveCount(0);
  await expect.poll(() => onDisk(`${root}/done.txt`)).toBe(false);
  // The selection moves to the row that took its place, so the keyboard keeps going.
  await expect(app).toHaveAttribute('data-selected-path', `${root}/logo.png`);

  // The folder goes the same way, with the mouse on the row's own button.
  await row(app, `${root}/drafts`).click();
  await page.keyboard.press('Delete');
  await app.getByTestId('files-confirm-delete').click();
  await expect(row(app, `${root}/drafts`)).toHaveCount(0);
  await expect.poll(() => onDisk(`${root}/drafts`)).toBe(false);
});

test('the context menu offers the same actions in the design language', async ({ page }) => {
  const root = await seed(page, 'ledger');
  const app = await openFiles(page, { path: root });
  const menu = page.getByTestId('files-menu');

  await row(app, `${root}/notes.txt`).click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(row(app, `${root}/notes.txt`)).toHaveAttribute('data-selected', 'active');
  await expect(menu.getByRole('menuitem')).toHaveText([
    /^Open/,
    /^Open in Editor/,
    /^Peek/,
    /^Rename/,
    /^Delete/,
    /^New file/,
    /^New folder/,
    /^Copy path/,
  ]);

  // Keyboard: arrows walk it, Escape closes it and gives the keyboard back.
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').first()).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(app).toBeFocused();

  // Peek from the menu.
  await row(app, `${root}/notes.txt`).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /^Peek/ }).click();
  await expect(page.getByTestId('peek').getByTestId('peek-title')).toHaveText('notes.txt');
  await page.keyboard.press('Escape');

  // Rename from the menu.
  await row(app, `${root}/notes.txt`).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /^Rename/ }).click();
  await expect(app.getByTestId('files-name-input')).toHaveValue('notes.txt');
  await page.keyboard.press('Escape');

  // Copy path says what it copied: the full path on this machine.
  await row(app, `${root}/notes.txt`).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /^Copy path/ }).click();
  await expect(app.getByTestId('files-notice')).toHaveText(`Copied ${path.join(E2E_HOME, root, 'notes.txt')}`);

  // On empty space the file actions are off and the new ones work in that folder.
  await column(app, root).click({ button: 'right', position: { x: 120, y: 400 } });
  await expect(menu.getByRole('menuitem', { name: /^Rename/ })).toHaveAttribute('aria-disabled', 'true');
  await menu.getByRole('menuitem', { name: /^New folder/ }).click();
  await page.keyboard.type('from-menu');
  await page.keyboard.press('Enter');
  await expect(row(app, `${root}/from-menu`)).toBeVisible();

  // The menu bar carries the same commands for the front window.
  await page.getByTestId('menu-app-file').click();
  await page.getByRole('menuitem', { name: /New file/ }).click();
  await expect(app.getByTestId('files-name-input')).toBeFocused();
  await page.keyboard.press('Escape');
});

test('a file written from outside appears within a second, and a deleted one collapses away', async ({ page }) => {
  const root = await seed(page, 'tides');
  const app = await openFiles(page, { path: root });
  await expect(row(app, `${root}/notes.txt`)).toBeVisible();

  // Nothing reloads: the column element is the same one before and after.
  await column(app, root).evaluate((element) => ((element as HTMLElement).dataset.mark = 'kept'));

  fs.writeFileSync(path.join(E2E_HOME, root, 'outside.txt'), 'made by a shell\n');
  const added = row(app, `${root}/outside.txt`);
  await expect(added).toBeVisible({ timeout: 1000 });
  await expect(added).toHaveAttribute('data-fresh', 'me');
  await expect(column(app, root)).toHaveAttribute('data-mark', 'kept');
  await expect(column(app, root).getByTestId('files-row')).toHaveText(['src', 'logo.png', 'notes.txt', 'outside.txt', 'README.md']);

  // Its size arrives without a reload once the write has settled.
  await added.click();
  await expect(app.getByTestId('files-details-size')).toHaveText('16 B');

  // A change deeper in the tree marks the folders above it.
  fs.writeFileSync(path.join(E2E_HOME, root, 'src', 'deep.ts'), 'export {};\n');
  await expect(row(app, `${root}/src`).getByTestId('files-row-dot')).toBeVisible({ timeout: 1000 });
  await expect(row(app, root).getByTestId('files-row-dot')).toBeVisible();

  // A delete from outside takes the row away, and the selection moves on.
  fs.rmSync(path.join(E2E_HOME, root, 'outside.txt'));
  await expect(added).toHaveCount(0, { timeout: 2000 });
  await expect(app).toHaveAttribute('data-selected-path', `${root}/README.md`);
  await expect(column(app, root)).toHaveAttribute('data-mark', 'kept');
});

test('a row an agent changes carries the agent tag while it runs', async ({ page }) => {
  const root = await seed(page, 'survey');
  await write(page, `${root}/plan.md`, '# Plan\n\nWalk the coast.\n');

  const started = await page.request.post('/api/agents', {
    data: { prompt: 'Add what you learn to README.md and plan.md', project: root, runner: 'demo' },
  });
  expect(started.status()).toBe(201);
  const agent = (await started.json()) as { id: string; name: string; workspace: { path: string; name: string } };

  const app = await openFiles(page, { path: agent.workspace.path });
  await expect(row(app, `${agent.workspace.path}/README.md`)).toBeVisible();

  // The sidebar lists the agent's copy with its name and a pulse while it works.
  const place = app.locator(`[data-testid="files-place"][data-path="${agent.workspace.path}"]`);
  await expect(place).toContainText(agent.workspace.name);
  await expect(place).toContainText(agent.name);
  await expect(place.locator('.files-place__agent')).toHaveAttribute('data-running', 'true');

  // The file the agent is writing shows its name, in its colour.
  const tag = app.getByTestId('files-row-tag').first();
  await expect(tag).toBeVisible({ timeout: 15_000 });
  await expect(tag).toHaveText(agent.name);
  const changed = app.locator('[data-testid="files-row"][data-fresh="agent"]').first();
  await expect(changed).toHaveAttribute('data-path', new RegExp(`^${agent.workspace.path}/(README|plan)\\.md$`));
  expect(await changed.evaluate((element) => getComputedStyle(element).getPropertyValue('--agent-solid'))).toContain('oklch');
  // Folders on the way down show that something changed inside.
  await expect(row(app, 'Workspaces').getByTestId('files-row-dot')).toBeVisible();

  await changed.click();
  await shots(page, 'T-17-agent-change');

  const stopped = await page.request.post(`/api/agents/${agent.id}/stop`);
  expect(stopped.ok()).toBe(true);
  await expect(place.locator('.files-place__agent')).not.toHaveAttribute('data-running', 'true');
});

test('giving an agent its own copy reports how the clone went', async ({ page }) => {
  const root = await seed(page, 'harbour');
  const app = await openFiles(page, { path: 'Projects', select: root });
  await expect(app.getByTestId('files-details-name')).toHaveText('harbour');

  await app.getByTestId('files-copy-for-agent').click();
  const report = app.getByTestId('files-clone-report');
  await expect(report).toBeVisible();
  await expect(report.getByTestId('files-clone-strategy')).toHaveText(/^(reflink|worktree|copy)$/);
  await expect(report.getByTestId('files-clone-ms')).toHaveText(/^[\d.]+ (ms|s)$/);
  await expect(report.getByTestId('files-clone-bytes')).toHaveText(/^[\d.]+ (B|KB|MB)$/);
  await expect(report.getByTestId('files-clone-files')).toHaveText(/^[1-9]\d*$/);

  // The copy is a real folder, listed in the sidebar, and one click away.
  const link = app.getByTestId('files-clone-open');
  const copy = (await link.textContent())!;
  expect(copy).toMatch(/^Workspaces\/harbour-/);
  expect(onDisk(`${copy}/README.md`)).toBe(true);
  await expect(app.locator(`[data-testid="files-place"][data-path="${copy}"]`)).toBeVisible();
  await link.click();
  await expect(app).toHaveAttribute('data-selected-path', copy);
  await expect(app.getByTestId('files-workspace')).toContainText('Projects/harbour');
  await expect(row(app, `${copy}/README.md`)).toBeVisible();
});

test('dragging a file onto a folder moves it, and the drag carries the home path', async ({ page }) => {
  const root = await seed(page, 'quarry');
  const app = await openFiles(page, { path: root });
  await expect(row(app, `${root}/notes.txt`)).toBeVisible();

  // What another window (an agent's) will read from the drag.
  await page.evaluate(() => {
    document.addEventListener('dragstart', (event) => {
      (window as { __drag?: unknown }).__drag = {
        types: [...event.dataTransfer!.types],
        path: event.dataTransfer!.getData('application/x-specos-path'),
        text: event.dataTransfer!.getData('text/plain'),
      };
    });
  });

  await row(app, `${root}/notes.txt`).dragTo(row(app, `${root}/src`));

  expect(await page.evaluate(() => (window as { __drag?: unknown }).__drag)).toEqual({
    types: expect.arrayContaining(['application/x-specos-path', 'text/plain']),
    path: `${root}/notes.txt`,
    text: `${root}/notes.txt`,
  });
  await expect(row(app, `${root}/notes.txt`)).toHaveCount(0);
  await expect.poll(() => onDisk(`${root}/src/notes.txt`)).toBe(true);
  expect(onDisk(`${root}/notes.txt`)).toBe(false);
  await expect(page.locator('.files-drag')).toHaveCount(0);

  // It is in the folder it was dropped on.
  await row(app, `${root}/src`).click();
  await expect(column(app, `${root}/src`).getByTestId('files-row')).toHaveText(['main.ts', 'notes.txt']);

  // Dropping it on a column's empty space moves it into that column's folder.
  await row(app, `${root}/src/notes.txt`).dragTo(column(app, root), { targetPosition: { x: 120, y: 420 } });
  await expect(row(app, `${root}/notes.txt`)).toBeVisible();
  await expect.poll(() => onDisk(`${root}/notes.txt`)).toBe(true);
});
