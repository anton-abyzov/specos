/**
 * The launcher's actions: things to do that are not an app, a file or an
 * agent. Each one is a title, a few extra words it can be found by, and what
 * it does.
 */
import type { GlyphName } from '../../design/icons';
import { api } from '../../lib/api';
import { setTheme, type Theme } from '../../lib/theme';
import { isAgentActive, useAgentsStore } from '../../stores/agents';
import { DESKTOP_COUNT, useShellStore } from '../../stores/shell';
import { useWindowsStore } from '../wm/store';

export interface LauncherAction {
  id: string;
  title: string;
  /** Words the action is also found by, besides its title. */
  keywords: string;
  glyph: GlyphName;
  /** The keyboard shortcut that does the same thing outside the launcher. */
  shortcut?: string;
  /** Asks for a name in the launcher's field instead of running at once. */
  prompt?: 'project';
  /** True when running it hands the keyboard to something else: a window, the overview. */
  takesFocus?: boolean;
  run(): void;
}

/** The actions offered before anything is typed. */
export const SUGGESTED_ACTIONS = ['new-terminal', 'new-chat', 'new-project', 'toggle-tiling', 'theme', 'overview'];

const shell = () => useShellStore.getState();

/** A request the launcher fires and leaves: the app that shows the outcome reports failures itself. */
function fireAndForget(request: Promise<unknown>): void {
  request.catch(() => undefined);
}

function stopAllAgents(): void {
  for (const agent of Object.values(useAgentsStore.getState().agents)) {
    if (isAgentActive(agent)) fireAndForget(api.agents.stop(agent.id));
  }
}

function closeAllWindows(): void {
  const windows = useWindowsStore.getState();
  for (const id of Object.keys(windows.windows)) windows.close(id);
}

function runBenchmark(): void {
  // System draws the result from the 'bench' frames, so it is opened first.
  shell().launchApp('system');
  fireAndForget(api.system.benchmark());
}

/** Every action. The theme action is named after the theme it switches to. */
export function buildActions(theme: Theme): LauncherAction[] {
  const other: Theme = theme === 'light' ? 'dark' : 'light';
  return [
    {
      id: 'new-terminal',
      title: 'New terminal',
      keywords: 'shell console command line',
      glyph: 'terminal',
      takesFocus: true,
      run: () => shell().launchApp('terminal'),
    },
    {
      id: 'new-chat',
      title: 'New chat',
      keywords: 'agent job prompt ask',
      glyph: 'send',
      takesFocus: true,
      run: () => shell().launchApp('chat'),
    },
    {
      id: 'new-project',
      title: 'New project folder...',
      keywords: 'create mkdir directory',
      glyph: 'plus',
      prompt: 'project',
      run: () => undefined,
    },
    {
      id: 'toggle-tiling',
      title: 'Toggle tiling',
      keywords: 'tile windows arrange layout',
      glyph: 'layout',
      shortcut: 'Ctrl Alt T',
      run: () => shell().toggleTiling(),
    },
    {
      id: 'theme',
      title: other === 'dark' ? 'Dark theme' : 'Light theme',
      keywords: 'light dark appearance night paper switch mode',
      glyph: other === 'dark' ? 'moon' : 'sun',
      run: () => setTheme(other),
    },
    {
      id: 'overview',
      title: 'Show overview',
      keywords: 'all windows desktops',
      glyph: 'grid',
      shortcut: 'F3',
      takesFocus: true,
      run: () => useWindowsStore.getState().setOverview(true),
    },
    ...Array.from({ length: DESKTOP_COUNT }, (_, index): LauncherAction => ({
      id: `desktop-${index + 1}`,
      title: `Go to desktop ${index + 1}`,
      keywords: 'switch space workspace',
      glyph: 'desktop',
      shortcut: `Ctrl Alt ${index + 1}`,
      run: () => shell().setDesktop(index),
    })),
    {
      id: 'benchmark',
      title: 'Run workspace benchmark',
      keywords: 'clone speed reflink worktree measure system',
      glyph: 'cpu',
      takesFocus: true,
      run: runBenchmark,
    },
    {
      id: 'stop-agents',
      title: 'Stop all agents',
      keywords: 'cancel kill halt jobs',
      glyph: 'stop',
      run: stopAllAgents,
    },
    {
      id: 'close-windows',
      title: 'Close all windows',
      keywords: 'quit clear desktop',
      glyph: 'close',
      run: closeAllWindows,
    },
  ];
}
