import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_HOME, login, setTheme, shots, trackErrors } from './helpers';

let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = trackErrors(page);
  await login(page);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const openTerminal = (page: Page, params?: Record<string, unknown>) =>
  page.evaluate((p) => window.__specos!.openApp!('terminal', p), params);

const frame = (page: Page, id: string) => page.getByTestId(`window-${id}`);
const app = (page: Page, id: string) => frame(page, id).getByTestId('app-terminal');

/** Everything on the terminal's screen and in its scrollback, read from xterm's buffer. */
const screen = (page: Page, id: string) =>
  page.evaluate((windowId) => {
    const terminal = (window.__specos!.terminals as Record<string, any>)[windowId];
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row += 1) lines.push(buffer.getLine(row).translateToString(true));
    return lines.join('\n');
  }, id);

const size = (page: Page, id: string) =>
  page.evaluate((windowId) => {
    const terminal = (window.__specos!.terminals as Record<string, any>)[windowId];
    return `${terminal.rows} ${terminal.cols}`;
  }, id);

/** Waits until the shell has drawn its prompt. */
async function ready(page: Page, id: string): Promise<void> {
  await expect(app(page, id)).toHaveAttribute('data-phase', 'running');
  await expect.poll(async () => (await screen(page, id)).trim().length).toBeGreaterThan(0);
  await expect(frame(page, id).locator('.xterm-helper-textarea')).toBeFocused();
}

async function run(page: Page, command: string): Promise<void> {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/** Runs a command that prints `<tag>:<value>` and returns the value. */
async function capture(page: Page, id: string, tag: string, command: string): Promise<string> {
  await run(page, `echo "${tag}:$(${command})"`);
  const pattern = new RegExp(`^${tag}:(.+)$`, 'm');
  await expect.poll(async () => pattern.test(await screen(page, id))).toBe(true);
  return pattern.exec(await screen(page, id))![1]!.trim();
}

const shellState = (page: Page) =>
  page.evaluate(() => {
    const { launcherOpen, overviewOpen, desktop } = window.__specos!.stores!.shell.getState();
    return { launcherOpen, overviewOpen, desktop };
  });

test('a terminal window runs a real shell in the home folder', async ({ page }) => {
  const id = await openTerminal(page);
  await ready(page, id);

  await run(page, 'echo specos-$((20+22))');
  await expect.poll(() => screen(page, id)).toContain('specos-42');

  expect(await capture(page, id, 'where', 'pwd')).toBe(E2E_HOME);
  // The title is the shell's own, or the shell and the folder when it sends none.
  await expect(frame(page, id).getByTestId('window-title')).not.toHaveText('Terminal');
  await expect(frame(page, id).getByTestId('window-title')).toHaveText(/\S/);
});

test('params.cwd starts the shell in that folder', async ({ page }) => {
  fs.mkdirSync(path.join(E2E_HOME, 'Projects/atlas'), { recursive: true });
  const id = await openTerminal(page, { cwd: 'Projects/atlas' });
  await ready(page, id);
  expect(await capture(page, id, 'where', 'pwd')).toBe(path.join(E2E_HOME, 'Projects/atlas'));
});

test('the shell follows the window size, after a resize and after a snap has settled', async ({ page }) => {
  const id = await openTerminal(page);
  await ready(page, id);
  const before = await capture(page, id, 'size-a', 'stty size');
  expect(before).toBe(await size(page, id));

  await page.evaluate((windowId) => {
    const store = window.__specos!.windows!.getState();
    const { bounds } = store.windows[windowId]!;
    store.setBounds(windowId, { ...bounds, w: bounds.w + 260, h: bounds.h + 180 });
  }, id);
  await expect.poll(() => size(page, id)).not.toBe(before);
  const resized = await capture(page, id, 'size-b', 'stty size');
  expect(resized).not.toBe(before);
  expect(resized).toBe(await size(page, id));
  const [rows, cols] = resized.split(' ').map(Number);
  expect(rows).toBeGreaterThan(Number(before.split(' ')[0]));
  expect(cols).toBeGreaterThan(Number(before.split(' ')[1]));

  // Snapped with the keyboard while the terminal has the focus: the window manager's key still works.
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await expect(frame(page, id)).toHaveAttribute('data-mode', 'snapped');
  await expect.poll(() => size(page, id)).not.toBe(resized);
  await expect(frame(page, id)).not.toHaveAttribute('data-moving');
  const snapped = await capture(page, id, 'size-c', 'stty size');
  expect(snapped).toBe(await size(page, id));
  expect(Number(snapped.split(' ')[0])).toBeGreaterThan(rows!);

  // The screen fills the window: no stray gap below the last row.
  const gap = await frame(page, id).evaluate((element) => {
    const host = element.querySelector('.terminal__host')!.getBoundingClientRect();
    const rowsBox = element.querySelector('.xterm-screen')!.getBoundingClientRect();
    return host.height - rowsBox.height;
  });
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(17);
});

test('each window has its own shell, and a session survives other desktops and the dock', async ({ page }) => {
  const first = await openTerminal(page);
  await ready(page, first);
  const firstPid = await capture(page, first, 'pid', 'echo $$');
  await run(page, 'kept=lantern-$((3*7))');

  const second = await openTerminal(page);
  expect(second).not.toBe(first);
  await ready(page, second);
  const secondPid = await capture(page, second, 'pid', 'echo $$');
  expect(Number(firstPid)).toBeGreaterThan(0);
  expect(secondPid).not.toBe(firstPid);
  // The second shell knows nothing of the first one's variable.
  expect(await capture(page, second, 'kept', 'echo ${kept:-none}')).toBe('none');

  // Away to another desktop and back, then into the dock and back.
  await frame(page, first).getByTestId('window-titlebar').click({ position: { x: 200, y: 12 } });
  await expect(frame(page, first)).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Control+Alt+2');
  expect((await shellState(page)).desktop).toBe(1);
  await page.keyboard.press('Control+Alt+1');
  await expect(frame(page, first)).toBeVisible();
  await page.evaluate((windowId) => window.__specos!.windows!.getState().minimise(windowId), first);
  await expect(frame(page, first)).toHaveAttribute('data-mode', 'minimized');
  await page.evaluate((windowId) => window.__specos!.windows!.getState().focus(windowId), first);
  await expect(frame(page, first).locator('.xterm-helper-textarea')).toBeFocused();

  expect(await screen(page, first)).toContain(`pid:${firstPid}`);
  expect(await capture(page, first, 'again', 'echo $kept-$$')).toBe(`lantern-21-${firstPid}`);
});

test('the desktop keeps its shortcuts while ordinary keys go to the shell', async ({ page }) => {
  const id = await openTerminal(page);
  await ready(page, id);

  // The launcher opens over the terminal and gives the keyboard back when it closes.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('launcher-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('launcher')).toHaveCount(0);
  await expect(frame(page, id).locator('.xterm-helper-textarea')).toBeFocused();

  await page.keyboard.press('F3');
  expect((await shellState(page)).overviewOpen).toBe(true);
  await page.keyboard.press('F3');
  expect((await shellState(page)).overviewOpen).toBe(false);

  // Ctrl+W is the shell's "delete the word before the cursor", not "close the window".
  await page.keyboard.type('echo keep-this drop-this');
  await page.keyboard.press('Control+w');
  await page.keyboard.press('Enter');
  await expect.poll(() => screen(page, id)).toMatch(/^keep-this$/m);
  await expect(frame(page, id)).toBeVisible();

  // Ctrl+C interrupts, Ctrl+L and the arrow keys reach the shell too.
  await run(page, 'sleep 30');
  await page.keyboard.press('Control+c');
  expect(await capture(page, id, 'after', 'echo interrupted')).toBe('interrupted');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await screen(page, id)).match(/^after:interrupted$/gm)?.length).toBe(2);

  // Ctrl+Shift+C copies the selection and leaves the shell alone.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate((windowId) => (window.__specos!.terminals as Record<string, any>)[windowId].selectAll(), id);
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('after:interrupted');
});

test('the terminal takes its colours from the theme and switches live', async ({ page }) => {
  const id = await openTerminal(page);
  await ready(page, id);
  const colours = () =>
    page.evaluate((windowId) => {
      const terminal = (window.__specos!.terminals as Record<string, any>)[windowId];
      const element = document.querySelector(`[data-window-id="${windowId}"] .terminal`)!;
      return { theme: terminal.options.theme.background as string, painted: getComputedStyle(element).backgroundColor };
    }, id);

  const light = await colours();
  expect(light.theme).toBe('#fffdf8');
  expect(light.painted).toBe('rgb(255, 253, 248)');

  await setTheme(page, 'dark');
  await expect.poll(async () => (await colours()).theme).toBe('#181b21');
  expect((await colours()).painted).toBe('rgb(24, 27, 33)');
  // Nothing in the terminal is left on the light paper.
  const viewport = await frame(page, id).locator('.xterm-viewport').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(viewport).toBe('rgba(0, 0, 0, 0)');
  await setTheme(page, 'light');
  await expect.poll(async () => (await colours()).theme).toBe('#fffdf8');
});

test('when the shell exits the window says so and Enter starts a new one', async ({ page }) => {
  const id = await openTerminal(page);
  await ready(page, id);
  const pid = await capture(page, id, 'pid', 'echo $$');

  await run(page, 'exit 3');
  const ended = frame(page, id).getByTestId('terminal-ended');
  await expect(ended).toBeVisible();
  await expect(ended).toContainText('Session ended');
  await expect(ended).toContainText('exit 3');
  await shots(page, 'T-18-terminal-ended');

  await page.keyboard.press('Enter');
  await expect(ended).toHaveCount(0);
  await ready(page, id);
  const next = await capture(page, id, 'pid', 'echo $$');
  expect(next).not.toBe(pid);

  // The button does the same.
  await run(page, 'exit');
  await frame(page, id).getByTestId('terminal-restart').click();
  await ready(page, id);
  expect(await capture(page, id, 'ok', 'echo again')).toBe('again');
});

test('the menus act on the terminal in front', async ({ page }) => {
  const id = await openTerminal(page);
  await ready(page, id);
  await run(page, 'echo before-the-clear');
  await expect.poll(() => screen(page, id)).toMatch(/^before-the-clear$/m);

  await page.getByTestId('menu-app-shell').click();
  await page.getByRole('menuitem', { name: 'Restart shell' }).click();
  await ready(page, id);
  expect(await screen(page, id)).not.toContain('before-the-clear');

  await page.getByTestId('menu-app-shell').click();
  await page.getByRole('menuitem', { name: 'New terminal' }).click();
  await expect(page.locator('[data-testid^="window-w-"][data-app="terminal"]')).toHaveCount(2);
});

test('colourful output, for the screenshots', async ({ page }) => {
  const project = path.join(E2E_HOME, 'Projects/contour');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# Contour\n\nElevation lines from survey points.\n');
  fs.writeFileSync(path.join(project, 'src/isolines.ts'), 'export const step = 10;\n');
  fs.writeFileSync(path.join(project, 'build.sh'), '#!/bin/sh\necho building\n', { mode: 0o755 });
  fs.writeFileSync(path.join(project, 'survey.tar.gz'), '');
  fs.symlinkSync('src/isolines.ts', path.join(project, 'latest.ts'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: project,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Mira Okafor',
        GIT_AUTHOR_EMAIL: 'mira@example.com',
        GIT_COMMITTER_NAME: 'Mira Okafor',
        GIT_COMMITTER_EMAIL: 'mira@example.com',
      },
    });
  git('init', '--quiet', '--initial-branch=main');
  git('add', 'README.md');
  git('commit', '--quiet', '--no-verify', '-m', 'Describe the project');
  git('add', 'src', 'latest.ts');
  git('commit', '--quiet', '--no-verify', '-m', 'Add isolines at a ten metre step');
  git('add', 'build.sh');
  git('commit', '--quiet', '--no-verify', '-m', 'Add the build script');
  git('tag', 'v0.1.0');

  const id = await openTerminal(page, { cwd: 'Projects/contour' });
  await ready(page, id);
  await page.evaluate((windowId) => {
    const store = window.__specos!.windows!.getState();
    store.setBounds(windowId, { x: 420, y: 150, w: 1040, h: 660 });
  }, id);
  // One command at a time, each after the prompt is back, so no keystroke lands in another command's output.
  const commands = [
    'clear; ls -la --color=always',
    'git log --oneline --decorate --graph --color=always | cat',
    'git status --short',
    'for c in 0 1 2 3 4 5 6 7; do printf "\\e[3${c}m%-7s\\e[9${c}m%-7s\\e[0m" tone bright; done; echo',
    'for c in 0 1 2 3 4 5 6 7; do printf "\\e[4${c}m   \\e[10${c}m   "; done; printf "\\e[0m\\n"',
  ];
  for (const command of commands) {
    await run(page, command);
    await expect.poll(async () => (await screen(page, id)).trimEnd().split('\n').pop()).toMatch(/\$$/);
  }
  await expect.poll(() => screen(page, id)).toContain('Add the build script');
  await expect.poll(async () => (await screen(page, id)).match(/tone/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
  await page.mouse.move(200, 600);
  await page.waitForTimeout(400);
  await shots(page, 'T-18-terminal');
});
