import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_HOME, login, shots, trackErrors } from './helpers';

test('create a project, run two agents from Chat, inspect and merge one', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackErrors(page);
  await login(page);
  await page.evaluate(() => window.__specos!.openApp!('files', { path: 'Projects' }));
  const files = page.getByTestId('app-files');
  await expect(files).toBeVisible();
  await files.focus();
  await page.keyboard.press('Control+Shift+N');
  await files.getByTestId('files-name-input').fill('scenario');
  await page.keyboard.press('Enter');
  const folder = files.locator('[data-testid="files-row"][data-path="Projects/scenario"]');
  await expect(folder).toBeVisible();
  await folder.dblclick();
  await page.keyboard.press('Control+n');
  await files.getByTestId('files-name-input').fill('note.md');
  await page.keyboard.press('Enter');
  const note = files.locator('[data-testid="files-row"][data-path="Projects/scenario/note.md"]');
  await expect(note).toBeVisible();
  await note.dblclick();
  const editor = page.getByTestId('app-editor');
  await expect(editor).toBeVisible();
  await editor.locator('.cm-content').click();
  await page.keyboard.type('# Shared note\n\nOriginal project text.\n');
  await page.keyboard.press('Control+s');
  await expect(editor.getByTestId('editor-saved')).toHaveText('Saved');
  const original = fs.readFileSync(path.join(E2E_HOME, 'Projects/scenario/note.md'), 'utf8');
  expect(original).toContain('Original project text.');

  await page.getByTestId('dock-app-chat').click();
  const chat = page.getByTestId('app-chat');
  await page.keyboard.press('Control+p');
  await chat.getByTestId('project-picker-input').fill('scenario');
  await page.keyboard.press('Enter');
  for (const prompt of ['Add a plan to note.md', 'Add questions to note.md']) {
    await chat.getByTestId('chat-input').fill(prompt);
    await page.keyboard.press('Enter');
  }
  const replies = chat.getByTestId('chat-reply');
  await expect(replies).toHaveCount(2);
  for (const reply of [replies.nth(0), replies.nth(1)]) {
    await expect(reply).toHaveAttribute('data-status', 'running');
    await expect(reply.getByTestId('stream-text').first()).not.toBeEmpty();
  }
  const jobs = (await (await page.request.get('/api/agents')).json()).agents.filter((a: any) => a.workspace.project === 'Projects/scenario');
  expect(jobs).toHaveLength(2);
  expect(jobs[0].workspace.path).not.toBe(jobs[1].workspace.path);
  const read = (rel: string) => fs.readFileSync(path.join(E2E_HOME, rel), 'utf8');
  for (const job of jobs) {
    await expect.poll(() => read(`${job.workspace.path}/note.md`)).toContain(job.name);
  }
  expect(read('Projects/scenario/note.md')).toBe(original);
  await shots(page, 'T-25-two-agents');
  for (const reply of [replies.nth(0), replies.nth(1)]) {
    await expect(reply).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  }

  await page.getByTestId('dock-app-activity').click();
  const activity = page.getByTestId('app-activity');
  for (const job of jobs) {
    await expect(activity.locator(`[data-testid="activity-row"][data-path="${job.workspace.path}/note.md"]`).first()).toHaveAttribute('data-actor', 'agent');
  }
  await activity.getByTestId(`workspace-card-${jobs[0].workspace.id}`).click();
  const pane = activity.getByTestId('workspace-pane');
  await expect(pane.getByTestId('diff-add').first()).toContainText(jobs[0].name);
  await shots(page, 'T-25-diff');
  await pane.getByTestId('merge-button').click();
  await expect(pane.getByTestId('merge-result')).toBeVisible();
  expect(read('Projects/scenario/note.md')).toContain(jobs[0].name);
  expect(read('Projects/scenario/note.md')).not.toContain(jobs[1].name);
  expect(read(`${jobs[1].workspace.path}/note.md`)).toContain(jobs[1].name);
  await shots(page, 'T-25-merged');
  expect(errors).toEqual([]);
});
