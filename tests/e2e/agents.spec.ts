import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E_HOME, login, shots, trackErrors } from './helpers';

/** Stops and forgets every job earlier specs left on the shared server, so the counts here start at zero. */
async function clearAgents(page: Page): Promise<void> {
  const list = async (): Promise<Array<{ id: string; status: string }>> => (await (await page.request.get('/api/agents')).json()).agents;
  for (const agent of await list()) {
    if (agent.status === 'starting' || agent.status === 'running') await page.request.post(`/api/agents/${agent.id}/stop`);
  }
  await expect.poll(async () => (await list()).filter((agent) => agent.status === 'starting' || agent.status === 'running').length).toBe(0);
  for (const agent of await list()) await page.request.delete(`/api/agents/${agent.id}`);
}

async function openAgents(page: Page): Promise<Locator> {
  await page.evaluate(() => window.__specos!.openApp!('agents'));
  const agents = page.getByTestId('app-agents');
  await expect(agents).toBeVisible();
  return agents;
}

async function writeHomeFile(page: Page, file: string, text: string): Promise<void> {
  const made = await page.request.put(`/api/fs/write?path=${encodeURIComponent(file)}`, {
    data: text,
    headers: { 'content-type': 'text/plain' },
  });
  expect(made.ok()).toBe(true);
}

/** Starts a job from the Agents header and returns the window it opened. */
async function startFromAgents(page: Page, prompt: string): Promise<{ id: string; window: Locator }> {
  const agents = await openAgents(page);
  const before = await page.locator('[data-testid="app-agent"]').evaluateAll((apps) => apps.map((app) => app.getAttribute('data-agent')));
  await agents.getByTestId('agents-new-prompt').click();
  await page.keyboard.type(prompt);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('app-agent')).toHaveCount(before.length + 1);
  const ids = await page.locator('[data-testid="app-agent"]').evaluateAll((apps) => apps.map((app) => app.getAttribute('data-agent')!));
  const id = ids.find((entry) => !before.includes(entry))!;
  return { id, window: page.locator(`[data-testid="app-agent"][data-agent="${id}"]`) };
}

const streamed = (scope: Locator): Promise<number> =>
  scope.getByTestId('stream-text').evaluateAll((blocks) => blocks.reduce((sum, block) => sum + block.textContent!.length, 0));

/** A drag of a home file as Files starts it: real DragEvents that carry the path under the SpecOS type. */
async function drag(target: Locator, types: Array<'dragenter' | 'dragover' | 'drop'>, file: string): Promise<void> {
  await target.evaluate(
    (element, { types, file }) => {
      const transfer = new DataTransfer();
      transfer.setData('application/x-specos-path', file);
      transfer.setData('text/plain', file);
      for (const type of types) {
        element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }
    },
    { types, file },
  );
}

test('with no agents the app says what an agent gets and offers to start one', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);
  await clearAgents(page);
  const agents = await openAgents(page);

  await expect(agents.getByTestId('agents-empty')).toContainText('a window, a dock icon and its own copy of a project');
  await expect(agents.getByTestId('agents-running')).toHaveText('0');
  await expect(agents.getByTestId('agents-new-prompt')).toBeFocused();
  // "Start one" hands the keyboard to the prompt.
  await agents.getByTestId('agents-empty').getByRole('button', { name: 'Start one' }).click();
  await expect(agents.getByTestId('agents-new-prompt')).toBeFocused();

  await shots(page, 'T-21-agents-empty');
  expect(errors).toEqual([]);
});

test('a window for a job the server does not know says so and closes', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);
  await page.evaluate(() => window.__specos!.openApp!('agent', { agentId: 'nobody' }));

  const gone = page.getByTestId('agent-gone');
  await expect(gone).toContainText('This job is no longer available');
  await gone.getByTestId('agent-gone-close').click();
  await expect(page.locator('[data-app="agent"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an agent is a process: a card, a window, a dock icon, files, attachments and a merge', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = trackErrors(page);
  await login(page);
  await clearAgents(page);
  await writeHomeFile(page, 'Projects/ledger/note.md', '# Notes\n\nA first line.\n');
  await writeHomeFile(page, 'Projects/ledger/plan.md', '# Plan\n\nNothing yet.\n');
  await writeHomeFile(page, 'brief.md', '# Brief\n\nKeep it short.\n');

  const agents = await openAgents(page);
  const pill = page.getByTestId('agents-count');
  await expect(pill).toHaveText('0');

  // The project is chosen once, from the chip beside the prompt.
  await agents.getByTestId('project-chip').click();
  await page.keyboard.type('ledger');
  await page.keyboard.press('Enter');
  await expect(agents.getByTestId('project-chip')).toHaveText('ledger');
  await expect(agents.getByTestId('agents-new-prompt')).toBeFocused();

  // Starting a job opens its own window with the live stream.
  const first = await startFromAgents(page, 'Add a short summary to note.md');
  await expect(page.locator('[data-app="agent"]')).toHaveCount(1);
  await expect.poll(() => streamed(first.window)).toBeGreaterThan(0);
  const early = await streamed(first.window);
  await expect.poll(() => streamed(first.window)).toBeGreaterThan(early + 10);
  const name = (await first.window.getByTestId('agent-name').textContent())!;
  await expect(page.locator('[data-app="agent"]').getByTestId('window-title')).toHaveText(`${name} · Add a short summary to note.md`);

  // It is in the dock and counted in the menu bar.
  await expect(page.getByTestId(`dock-agent-${first.id}`)).toBeVisible();
  await expect(pill).toHaveText('1');

  // Its card is live: running, with a clock that moves.
  const card = agents.locator(`[data-testid="agent-card"][data-agent="${first.id}"]`);
  await expect(card).toHaveAttribute('data-status', 'running');
  await expect(card.getByTestId('agent-status')).toHaveText('running');
  await expect(card.getByTestId('agent-runner')).toHaveText('demo');
  await expect(card.getByTestId('card-workspace')).toHaveText(/ledger-[\w-]+\s*(worktree|reflink|copy) · [\d.]+ (ms|s) · [\d.]+ (B|KB|MB)/);
  const clock = await card.getByTestId('agent-elapsed').textContent();

  // A second agent beside it, on the same project, in its own window.
  const second = await startFromAgents(page, 'List what is missing from plan.md');
  await expect(pill).toHaveText('2');
  await expect(page.getByTestId(`dock-agent-${second.id}`)).toBeVisible();
  await openAgents(page);
  await expect(agents.getByTestId('agents-running')).toHaveText('2');
  await expect(agents.getByTestId('agents-running-list').getByTestId('agent-card')).toHaveCount(2);
  await shots(page, 'T-21-agents');
  await expect(card.getByTestId('agent-elapsed')).not.toHaveText(clock!);

  // A file dragged over the agent's window shows where it will land; dropped, it is attached.
  await page.evaluate((agentId) => window.__specos!.openApp!('agent', { agentId }), second.id);
  await drag(second.window, ['dragenter', 'dragover'], 'brief.md');
  await expect(second.window.getByTestId('agent-drop-overlay')).toBeVisible();
  await drag(second.window, ['drop'], 'brief.md');
  await expect(second.window.getByTestId('agent-drop-overlay')).toHaveCount(0);
  await expect(second.window.getByTestId('attachment-chip')).toHaveText('brief.md');
  await expect(second.window.getByTestId('stream-status').filter({ hasText: 'attached brief.md' })).toBeVisible();
  // The copy is the user's doing, so it is not counted among the files the agent touched.
  await expect(second.window.getByTestId('agent-files')).not.toContainText('brief.md');
  await shots(page, 'T-21-agent-window');

  // Stop, from the window: the card and the count follow.
  await second.window.getByTestId('agent-stop').click();
  const stopped = agents.locator(`[data-testid="agent-card"][data-agent="${second.id}"]`);
  await expect(stopped).toHaveAttribute('data-status', 'stopped');
  await expect(stopped.getByTestId('agent-status')).toHaveText('stopped');
  await expect(stopped.getByTestId('card-files')).not.toContainText('brief.md');
  await expect(pill).toHaveText('1');
  // The window stays, and now offers a follow-up.
  await expect(second.window.getByTestId('agent-followup')).toBeVisible();
  await expect(second.window.getByTestId('agent-stop')).toHaveCount(0);

  // The files the first agent touches appear on its card as it works; a chip opens the file in the Editor.
  await openAgents(page);
  const chip = card.getByTestId('file-chip').first();
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await expect(chip).toContainText('note.md');
  const touched = (await chip.getAttribute('data-path'))!;
  await chip.click();
  const editor = page.getByTestId('app-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId('editor-path')).toHaveAttribute('title', touched);

  // When it is done the card says so, with its final time, and the count is back to zero.
  await expect(card).toHaveAttribute('data-status', 'done', { timeout: 40_000 });
  await expect(pill).toHaveText('0');
  await expect(card.getByTestId('file-chip')).toHaveCount(2);
  await expect(card.getByTestId('file-chip-count').first()).toHaveText(/×\d/);
  const final = await card.getByTestId('agent-elapsed').textContent();
  await page.waitForTimeout(1200);
  await expect(card.getByTestId('agent-elapsed')).toHaveText(final!);
  // Its dock icon stays for as long as its window does.
  await expect(page.getByTestId(`dock-agent-${first.id}`)).toBeVisible();

  // Merge back: the project on disk gains the agent's lines.
  const project = path.join(E2E_HOME, 'Projects/ledger/note.md');
  expect(fs.readFileSync(project, 'utf8')).not.toContain(`- ${name} (1/`);
  await openAgents(page);
  await card.getByTestId('card-merge').click();
  await expect(card.getByTestId('merge-result')).toHaveAttribute('data-merged', 'true');
  await expect(card.getByTestId('merge-result')).toContainText('Merged 2 files into ledger');
  expect(fs.readFileSync(project, 'utf8')).toContain(`- ${name} (1/`);
  expect(fs.readFileSync(path.join(E2E_HOME, 'Projects/ledger/plan.md'), 'utf8')).toContain(`- ${name} (1/`);
  await expect(card.getByTestId('card-workspace')).toContainText('merged');
  await shots(page, 'T-21-agents-merged');

  // A follow-up in the agent's window carries on in the same workspace, as the same agent.
  await page.evaluate((agentId) => window.__specos!.openApp!('agent', { agentId }), first.id);
  await expect(first.window.getByTestId('agent-followup')).toBeFocused();
  await page.keyboard.type('Now shorten it');
  await page.keyboard.press('Enter');
  await expect(first.window.getByTestId('agent-job')).toHaveCount(2);
  await expect(first.window).toHaveAttribute('data-status', 'running');
  await expect(first.window.getByTestId('agent-followup')).toHaveCount(0);
  await expect(first.window.getByTestId('agent-name')).toHaveText(name);
  await expect(pill).toHaveText('1');
  await openAgents(page);
  const followUp = agents.getByTestId('agents-running-list').getByTestId('agent-card');
  await expect(followUp).toHaveCount(1);
  await expect(followUp).toHaveAttribute('data-agent-name', name);

  // Stop on the card: stopped, and nothing is counted as running.
  await followUp.getByTestId('card-stop').click();
  await expect(agents.getByTestId('agents-running')).toHaveText('0');
  await expect(agents.locator('[data-testid="agent-card"][data-status="stopped"]')).toHaveCount(2);
  await expect(pill).toHaveText('0');

  // Remove forgets a finished job.
  await expect(agents.getByTestId('agent-card')).toHaveCount(3);
  await stopped.getByTestId('card-remove').click();
  await expect(agents.getByTestId('agent-card')).toHaveCount(2);
  // Its window does not pretend the job is still there.
  await expect(page.getByTestId('agent-gone')).toBeVisible();

  expect(errors).toEqual([]);
});
