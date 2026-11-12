import { expect, test, type Locator, type Page } from '@playwright/test';
import { login, shots, trackErrors } from './helpers';

const WORKSPACE_LINE = /^workspace notes-[\w-]+ · (worktree|reflink|copy) · [\d.]+ (ms|s)$/;

async function openChat(page: Page): Promise<Locator> {
  await page.evaluate(() => window.__specos!.openApp!('chat'));
  const chat = page.getByTestId('app-chat');
  await expect(chat).toBeVisible();
  return chat;
}

const replyText = (reply: Locator): Promise<number> =>
  reply.getByTestId('stream-text').evaluateAll((blocks) => blocks.reduce((sum, block) => sum + block.textContent!.length, 0));

test('an empty chat says what it is for and has the keyboard', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);
  const chat = await openChat(page);

  await expect(chat.getByTestId('chat-empty')).toBeVisible();
  await expect(chat.getByTestId('chat-input')).toBeFocused();
  await expect(chat.getByTestId('chat-send')).toBeDisabled();
  await expect(chat.getByTestId('project-chip')).toHaveText('No project');

  // An idea fills the composer and leaves the sending to the user.
  await chat.getByTestId('chat-idea').first().click();
  await expect(chat.getByTestId('chat-input')).toHaveValue(/Summarise/);
  await expect(chat.getByTestId('chat-input')).toBeFocused();
  await chat.getByTestId('chat-input').fill('');

  await shots(page, 'T-20-chat-empty');
  expect(errors).toEqual([]);
});

test('messages start agents that answer at once, side by side, and survive a reload', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackErrors(page);
  await login(page);
  const made = await page.request.put('/api/fs/write?path=Projects/notes/note.md', {
    data: '# Notes\n\nA first line.\n',
    headers: { 'content-type': 'text/plain' },
  });
  expect(made.ok()).toBe(true);

  const chat = await openChat(page);
  const input = chat.getByTestId('chat-input');
  const replies = chat.getByTestId('chat-reply');

  // Ctrl+P opens the project list; a few letters and Enter choose, and the keyboard is back in the composer.
  await page.keyboard.press('Control+p');
  await expect(chat.getByTestId('project-picker-input')).toBeFocused();
  await page.keyboard.type('nts');
  await expect(chat.getByTestId('project-option').first()).toContainText('notes');
  await page.keyboard.press('Enter');
  await expect(chat.getByTestId('project-chip')).toHaveText('notes');
  await expect(input).toBeFocused();

  // "@" at the start of a word opens the same list.
  await page.keyboard.type('@');
  await expect(chat.getByTestId('project-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');

  // Measured in the page: from the Enter key going down to the message and the reply being in the document.
  await page.evaluate(() => {
    const probe: { down?: number; shown?: number; name?: string; state?: string | null } = {};
    (window as unknown as { __probe: typeof probe }).__probe = probe;
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter') probe.down ??= performance.now();
      },
      true,
    );
    new MutationObserver(() => {
      if (probe.shown !== undefined) return;
      const reply = document.querySelector('[data-testid="chat-reply"]');
      if (!reply || !document.querySelector('[data-testid="chat-user-message"]')) return;
      probe.shown = performance.now();
      probe.name = reply.querySelector('[data-testid="chat-reply-name"]')?.textContent ?? '';
      probe.state = reply.querySelector('[data-testid="chat-workspace"]')?.getAttribute('data-state');
    }).observe(document.body, { childList: true, subtree: true });
  });

  // The server's answer is held back, so everything seen before it is the desktop's own doing.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/agents', async (route) => {
    if (route.request().method() === 'POST') await held;
    await route.continue();
  });

  await page.keyboard.type('Add a short summary to note.md');
  await page.keyboard.press('Enter');

  await expect(chat.getByTestId('chat-user-message')).toHaveText('Add a short summary to note.md');
  await expect(replies).toHaveCount(1);
  await expect(input).toHaveValue('');
  const probe = await page.evaluate(
    () => (window as unknown as { __probe: { down: number; shown: number; name: string; state: string } }).__probe,
  );
  expect(probe.shown - probe.down).toBeLessThan(150);
  // The reply already carries the agent's name and the starting line, with no answer from the server yet.
  expect(probe.state).toBe('starting');
  expect(probe.name).not.toBe('');
  expect(probe.name).not.toBe('Agent');
  await expect(replies.first().getByTestId('chat-workspace')).toHaveText('starting workspace');
  await expect(replies.first()).toHaveAttribute('data-status', 'starting');
  // Typing is never blocked while the job is on its way.
  await page.keyboard.type('still typing');
  await expect(input).toHaveValue('still typing');
  await input.fill('');

  release();

  const first = replies.first();
  await expect(first.getByTestId('chat-workspace')).toHaveText(WORKSPACE_LINE);
  // The name that was shown before the answer is the name the agent got.
  await expect(first.getByTestId('chat-reply-name')).toHaveText(probe.name);

  // The reply grows while the agent writes.
  await expect.poll(() => replyText(first)).toBeGreaterThan(0);
  const early = await replyText(first);
  await expect.poll(() => replyText(first)).toBeGreaterThan(early + 10);

  // A second message while the first is running: a second agent beside it, in its own workspace.
  await page.keyboard.type('List what is missing from note.md');
  await page.keyboard.press('Enter');
  await expect(replies).toHaveCount(2);
  const second = replies.nth(1);
  await expect(second.getByTestId('chat-workspace')).toHaveText(WORKSPACE_LINE);
  await expect(chat.getByTestId('chat-row')).toHaveCount(1);
  await expect(chat.getByTestId('chat-row')).toHaveAttribute('data-agents', '2');
  await expect(first).toHaveAttribute('data-status', 'running');
  await expect(second).toHaveAttribute('data-status', 'running');
  const names = [await first.getAttribute('data-agent-name'), await second.getAttribute('data-agent-name')];
  expect(names[0]).not.toBe(names[1]);
  expect(await first.getAttribute('data-workspace')).not.toBe(await second.getAttribute('data-workspace'));
  // Both write at the same time.
  await expect.poll(() => replyText(second)).toBeGreaterThan(0);
  const [a, b] = [await replyText(first), await replyText(second)];
  await expect.poll(() => replyText(second)).toBeGreaterThan(b + 10);
  expect(await replyText(first)).toBeGreaterThanOrEqual(a);
  await expect(first).toHaveAttribute('data-status', 'running');
  // Side by side: the two replies share a line.
  const [left, right] = [(await first.boundingBox())!, (await second.boundingBox())!];
  expect(right.x).toBeGreaterThan(left.x + left.width - 1);
  await expect(page.getByTestId('agents-count')).toHaveText('2');
  await shots(page, 'T-20-chat-streaming');

  // Escape stops the reply that started last; the other carries on to the end.
  await page.keyboard.press('Escape');
  await expect(second).toHaveAttribute('data-status', 'stopped');
  await expect(second.getByTestId('agent-status')).toHaveText('stopped');
  await expect(first).not.toHaveAttribute('data-status', 'stopped');
  await expect(first).toHaveAttribute('data-status', 'done', { timeout: 40_000 });
  await expect(first.getByTestId('stream-result')).toBeVisible();
  // A finished reply is whole: no caret, and the text is not doubled by the closing message.
  await expect(first.locator('[data-streaming]')).toHaveCount(0);
  expect(await first.getByTestId('stream-text').first().textContent()).toMatch(/^On it\. I am \w+/);
  await expect(first.getByTestId('stream-text')).toHaveCount(2);
  await expect(first.getByTestId('file-chip')).toHaveCount(1);
  await expect(first.getByTestId('file-chip-count')).toHaveText(/×\d/);

  // With nothing running, the next message carries on in the workspace of the last reply.
  const workspace = await second.getAttribute('data-workspace');
  await page.keyboard.type('Now shorten it');
  await page.keyboard.press('Enter');
  await expect(replies).toHaveCount(3);
  const third = replies.nth(2);
  await expect(third).toHaveAttribute('data-workspace', workspace!);
  await expect(third).toHaveAttribute('data-agent-name', names[1]!);
  await expect(third.getByTestId('chat-workspace')).toContainText('continued in the same copy');
  await expect(chat.getByTestId('chat-row')).toHaveCount(2);
  await expect(third).toHaveAttribute('data-status', 'done', { timeout: 40_000 });

  // Up in an empty composer brings the last prompt back.
  await page.keyboard.press('ArrowUp');
  await expect(input).toHaveValue('Now shorten it');
  await input.fill('');

  // Ctrl+N starts a conversation, Ctrl+Up goes back to the first.
  await page.keyboard.press('Control+n');
  await expect(chat.getByTestId('chat-empty')).toBeVisible();
  await expect(chat.getByTestId('chat-conversation')).toHaveCount(2);
  await page.keyboard.press('Control+ArrowDown');
  await expect(replies).toHaveCount(3);

  // A reload keeps the conversation: the turns come from the browser, what was said replays from the server.
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByTestId('desktop')).toBeVisible();
  const restored = page.getByTestId('app-chat');
  await expect(restored.getByTestId('chat-user-message')).toHaveText([
    'Add a short summary to note.md',
    'List what is missing from note.md',
    'Now shorten it',
  ]);
  const again = restored.getByTestId('chat-reply');
  await expect(again).toHaveCount(3);
  await expect(again.first()).toHaveAttribute('data-status', 'done');
  await expect(again.nth(1)).toHaveAttribute('data-status', 'stopped');
  await expect(again.first().getByTestId('stream-text').first()).toContainText('On it. I am');
  await expect(again.first().getByTestId('chat-workspace')).toHaveText(WORKSPACE_LINE);
  await expect(restored.getByTestId('chat-conversation')).toHaveCount(2);

  expect(errors).toEqual([]);
});
