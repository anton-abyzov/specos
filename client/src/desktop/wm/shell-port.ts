/**
 * Plugs the windows store into the shell: the menu bar, dock and launcher call
 * the port, and every change in the store is reported back as a snapshot.
 */
import type { AppId } from '../../apps/registry';
import { useShellStore, type WindowCommand, type WindowManagerPort, type WindowSnapshot } from '../../stores/shell';
import { focusedWindow, useWindowsStore, type WindowsState, type WindowState } from './store';

type Reported = Omit<WindowSnapshot, 'launcherOpen'>;

function snapshot(state: WindowsState): Reported {
  const windows = Object.values(state.windows);
  const focused = focusedWindow(state);
  return {
    activeAppId: focused?.appId ?? null,
    activeWindowId: focused?.id ?? null,
    runningApps: [...new Set(windows.map((window) => window.appId))],
    agentWindows: windows.flatMap((window) =>
      window.appId === 'agent' && typeof window.params.agentId === 'string'
        ? [{ agentId: window.params.agentId, windowId: window.id }]
        : [],
    ),
    desktop: state.desktop,
    tiling: state.tiling[state.desktop] ?? false,
    overviewOpen: state.overviewOpen,
    occupiedDesktops: [...new Set(windows.map((window) => window.desktop))].sort(),
    immersive: focused?.mode === 'fullscreen',
  };
}

/** The app's window that was in front most recently, narrowed to one agent when asked. */
function latestWindow(state: WindowsState, appId: AppId, params?: Record<string, unknown>): WindowState | undefined {
  const agentId = appId === 'agent' ? params?.agentId : undefined;
  return Object.values(state.windows)
    .filter((window) => window.appId === appId && (agentId === undefined || window.params.agentId === agentId))
    .sort((a, b) => b.z - a.z)[0];
}

const COMMANDS: Record<WindowCommand, (state: WindowsState, id: string) => void> = {
  minimise: (state, id) => state.minimise(id),
  fullscreen: (state, id) => state.toggleFullscreen(id),
  close: (state, id) => state.close(id),
  'snap-left': (state, id) => state.snap(id, 'left'),
  'snap-right': (state, id) => state.snap(id, 'right'),
  restore: (state, id) => state.unsnap(id),
  'next-window': (state) => state.cycle(1),
};

const port: WindowManagerPort = {
  launchApp(appId, params) {
    const id = useWindowsStore.getState().open(appId, params);
    useShellStore.getState().sync({ launcherOpen: false });
    return id;
  },
  focusApp(appId, params) {
    const state = useWindowsStore.getState();
    const window = latestWindow(state, appId, params);
    if (!window) return;
    state.setOverview(false);
    state.focus(window.id);
  },
  setDesktop: (index) => useWindowsStore.getState().setDesktop(index),
  toggleTiling: () => useWindowsStore.getState().toggleTiling(),
  toggleLauncher() {
    const shell = useShellStore.getState();
    useWindowsStore.getState().setOverview(false);
    shell.sync({ launcherOpen: !shell.launcherOpen });
  },
  toggleOverview() {
    const state = useWindowsStore.getState();
    useShellStore.getState().sync({ launcherOpen: false });
    state.setOverview(!state.overviewOpen);
  },
  windowCommand(command) {
    const state = useWindowsStore.getState();
    if (state.focusedId) COMMANDS[command](state, state.focusedId);
  },
  moveWindowToDesktop(index) {
    const state = useWindowsStore.getState();
    if (state.focusedId) state.moveToDesktop(state.focusedId, index);
  },
};

const sameList = (a: unknown[], b: unknown[]): boolean =>
  a.length === b.length && a.every((item, index) => JSON.stringify(item) === JSON.stringify(b[index]));

/** Only the parts that changed, so shell subscribers are not woken by an identical list. */
function changes(next: Reported, shell: WindowSnapshot): Partial<WindowSnapshot> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as Array<keyof Reported>) {
    const value = next[key];
    const held = shell[key];
    const same = Array.isArray(value) && Array.isArray(held) ? sameList(value, held) : value === held;
    if (!same) patch[key] = value;
  }
  return patch;
}

/** Takes over the shell's window actions. Returns the function that hands them back. */
export function connectShell(): () => void {
  const release = useShellStore.getState().registerWindowManager(port);
  const report = (state: WindowsState) => {
    const patch = changes(snapshot(state), useShellStore.getState());
    if (Object.keys(patch).length > 0) useShellStore.getState().sync(patch);
  };
  report(useWindowsStore.getState());
  const unsubscribe = useWindowsStore.subscribe(report);
  return () => {
    unsubscribe();
    release();
  };
}
