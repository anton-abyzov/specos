import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_HOME, login, shots, trackErrors } from './helpers';

const PROJECT = 'Projects/meridian';
const NOTE = `${PROJECT}/notes.md`;
const CONFIG = `${PROJECT}/config.json`;

const NOTE_TEXT = ['# Atlas', '', 'Notes for the atlas project.', ''].join('\n');
const CONFIG_BEFORE = ['{', '  "name": "atlas",', '  "scale": 1', '}', ''].join('\n');
// One line replaced and two added: +3 −1.
const CONFIG_AFTER = ['{', '  "name": "atlas",', '  "scale": 2,', '  "grid": true,', '  "units": "km"', '}', ''].join('\n');

async function write(page: Page, file: string, text: string): Promise<void> {
  const response = await page.request.put(`/api/fs/write?path=${encodeURIComponent(file)}`, {
    data: text,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
  expect(response.ok(), `write ${file}`).toBe(true);
}

interface StartedAgent {
  id: string;
  name: string;
  workspace: { id: string; name: string; path: string };
}

async function startAgent(page: Page, prompt: string): Promise<StartedAgent> {
  const response = await page.request.post('/api/agents', { data: { prompt, project: PROJECT, runner: 'demo' } });
  expect(response.ok(), 'start agent').toBe(true);
  return (await response.json()) as StartedAgent;
}

async function waitUntilDone(page: Page, agent: StartedAgent): Promise<void> {
  await expect
    .poll(async () => (await (await page.request.get(`/api/agents/${agent.id}`)).json()).status, { timeout: 60_000 })
    .toBe('done');
}

const onDisk = (file: string): string => fs.readFileSync(path.join(E2E_HOME, file), 'utf8');

test('activity shows who changed what, the diff, and merges an agent back', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackErrors(page);
  await login(page);

  await write(page, NOTE, NOTE_TEXT);
  await write(page, CONFIG, CONFIG_BEFORE);
  // Enough rows to scroll, in files the demo agent leaves alone.
  for (let index = 1; index <= 26; index += 1) {
    await write(page, `${PROJECT}/src/part-${String(index).padStart(2, '0')}.ts`, `export const part${index} = ${index};\n`);
  }

  await page.getByTestId('dock-app-activity').click();
  const app = page.getByTestId('app-activity');
  await expect(app).toBeVisible();
  const rows = app.getByTestId('activity-row');
  // What was written before the window opened comes from the journal.
  await expect(rows.filter({ hasText: 'notes.md' }).first()).toHaveAttribute('data-actor', 'me');
  // The newest row opened by itself.
  await expect(app.getByTestId('entry-pane')).toBeVisible();

  // ------------------------------------------------------------ live rows by an agent
  const first = await startAgent(page, 'Add a short plan to notes.md');
  const agentRows = app.locator('[data-testid="activity-row"][data-actor="agent"]');
  const agentNote = agentRows.filter({ hasText: 'notes.md' }).first();
  await expect(agentNote).toBeVisible({ timeout: 30_000 });
  await expect(agentNote.getByTestId('row-author')).toHaveText(first.name);
  await expect(agentNote).toHaveAttribute('data-path', `${first.workspace.path}/notes.md`);
  await expect(app.getByTestId(`filter-agent-${first.id}`)).toHaveText(first.name);
  await expect(app.getByTestId(`workspace-card-${first.workspace.id}`)).toContainText(first.name);

  // Select it: the diff shows the lines the agent added.
  await agentNote.click();
  await expect(agentNote).toHaveAttribute('aria-selected', 'true');
  await expect(app.getByTestId('entry-file')).toHaveText('notes.md');
  const added = app.getByTestId('diff-add');
  await expect(added.first()).toContainText(`- ${first.name} (1/`);

  // Keyboard: Enter moves to the diff, J steps to its first change, arrows walk the rows.
  await page.keyboard.press('Enter');
  await expect(app.getByTestId('diff-scroll')).toBeFocused();
  await page.keyboard.press('j');
  await expect(app.locator('.diff__line[data-active]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowDown');
  await expect(agentNote).toHaveAttribute('aria-selected', 'false');
  await expect(app.locator('[data-testid="activity-row"][aria-selected="true"]')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect(agentNote).toHaveAttribute('aria-selected', 'true');

  // ------------------------------------------------------------ filters
  await app.getByTestId('filter-me').click();
  await expect(agentRows).toHaveCount(0);
  await expect(rows.first()).toHaveAttribute('data-actor', 'me');
  await app.getByTestId(`filter-agent-${first.id}`).click();
  await expect(app.locator('[data-testid="activity-row"][data-actor="me"]')).toHaveCount(0);
  await expect(agentRows.first()).toBeVisible();
  await app.getByTestId('filter-all').click();
  await app.getByTestId('activity-search').fill('part-07');
  await expect(rows).toHaveCount(1);
  await app.getByTestId('activity-search').fill('no-such-file');
  await expect(app.getByText('No changes match')).toBeVisible();
  await app.getByTestId('clear-filters').click();
  await expect(agentNote).toBeVisible();

  // ------------------------------------------------------------ the user's own edit
  await waitUntilDone(page, first);
  await write(page, CONFIG, CONFIG_AFTER);
  const myEdit = app.locator(`[data-testid="activity-row"][data-actor="me"][data-verb="changed"][data-path="${CONFIG}"]`);
  await expect(myEdit).toBeVisible();
  await expect(myEdit.getByTestId('row-author')).toHaveText('Me');
  await expect(myEdit.getByTestId('counts')).toHaveText('+3−1');
  await myEdit.click();
  await expect(app.getByTestId('diff-add')).toHaveCount(3);
  await expect(app.getByTestId('diff-del')).toHaveCount(1);
  // The replaced line is paired with its new version and only the changed word is marked.
  await expect(app.locator('.diff__line[data-kind="del"] .diff__word')).toHaveText('1');

  // ------------------------------------------------------------ new rows do not move what is being read
  const list = app.getByTestId('activity-list');
  await list.evaluate((element) => {
    element.scrollTop = 240;
  });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
  const countBefore = await rows.count();
  await write(page, `${PROJECT}/later.txt`, 'written while scrolled away\n');
  await expect(app.getByTestId('new-pill')).toHaveText('1 new');
  expect(await rows.count()).toBe(countBefore);
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
  await app.getByTestId('new-pill').click();
  await expect(app.getByTestId('new-pill')).toHaveCount(0);
  await expect(rows.first()).toHaveAttribute('data-path', `${PROJECT}/later.txt`);

  await agentNote.click();
  await expect(added.first()).toBeVisible();
  await shots(page, 'T-22-activity-diff');

  // ------------------------------------------------------------ workspace mode and merge
  await app.getByTestId(`workspace-card-${first.workspace.id}`).click();
  const pane = app.getByTestId('workspace-pane');
  await expect(pane).toBeVisible();
  await expect(pane.getByTestId('workspace-status')).toHaveText('active');
  const files = pane.getByTestId('workspace-file');
  await expect(files.filter({ hasText: 'notes.md' })).toHaveAttribute('data-status', 'modified');
  await expect(pane.getByTestId('diff-add').first()).toContainText(`- ${first.name} (1/`);
  await expect(pane.getByTestId('workspace-totals')).toContainText('1 file changed');

  await pane.getByTestId('merge-button').click();
  await expect(pane.getByTestId('merge-result')).toBeVisible();
  await expect(pane.getByTestId('merge-commit')).toHaveText(/^[0-9a-f]{8}$/);
  await expect(pane.getByTestId('merge-files')).toContainText('notes.md');
  await expect(pane.getByTestId('workspace-status')).toHaveText('merged');
  expect(onDisk(NOTE)).toContain(`- ${first.name} (1/`);
  // The user's own edit survived the merge.
  expect(onDisk(CONFIG)).toBe(CONFIG_AFTER);
  const mergeRow = app.locator(`[data-testid="activity-row"][data-actor="merge"][data-path="${NOTE}"]`);
  await expect(mergeRow).toBeVisible();
  await expect(mergeRow).toContainText(`${first.name}merged`);
  await shots(page, 'T-22-activity-workspace');

  // ------------------------------------------------------------ a conflict leaves the project alone
  const second = await startAgent(page, 'Add open questions to notes.md');
  await waitUntilDone(page, second);
  // The user rewrites the end of the same note in the project before merging.
  const mine = onDisk(NOTE).trimEnd().split('\n');
  mine[mine.length - 1] = '- Me: this line was rewritten by hand';
  const conflicting = `${mine.join('\n')}\n- Me: and this one was added by hand\n`;
  await write(page, NOTE, conflicting);

  await app.getByTestId('workspace-filter').selectOption(second.workspace.id);
  await expect(pane).toHaveAttribute('data-workspace', second.workspace.id);
  await expect(pane.getByTestId('diff-add').first()).toContainText(`- ${second.name} (1/`);
  // With the workspace filter on, the timeline holds only that workspace's changes.
  await expect(app.locator('[data-testid="activity-row"][data-actor="me"]')).toHaveCount(0);

  // M asks first; Enter on the confirmation merges.
  await pane.getByTestId('workspace-totals').click();
  await page.keyboard.press('m');
  await expect(pane.getByTestId('merge-confirm')).toBeVisible();
  await expect(pane.getByTestId('merge-confirm-yes')).toBeFocused();
  await page.keyboard.press('Enter');
  const conflict = pane.getByTestId('merge-conflict');
  await expect(conflict).toBeVisible();
  await expect(conflict.getByTestId('conflict-file')).toHaveCount(1);
  await expect(conflict.getByTestId('conflict-file')).toContainText('notes.md');
  await expect(conflict.getByTestId('open-project-version')).toBeVisible();
  await expect(conflict.getByTestId('open-agent-version')).toContainText(second.name);
  await expect(pane.getByTestId('workspace-status')).toHaveText('conflict');
  await expect(pane.getByTestId('merge-result')).toHaveCount(0);
  expect(onDisk(NOTE)).toBe(conflicting);
  await shots(page, 'T-22-activity-conflict');

  expect(errors).toEqual([]);
});
