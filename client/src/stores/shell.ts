/**
 * What the shell (menu bar, dock, launcher) knows about windows, and the
 * actions it calls. The shell never manages windows itself: the window manager
 * registers a WindowManagerPort here and reports what is open through sync().
 * Until one registers, a minimal built-in port keeps the same state, so the
 * dock and menu bar behave (an app clicked in the dock counts as running).
 */
import { create } from 'zustand';
import type { AppId } from '../apps/registry';

export const DESKTOP_COUNT = 4;

export type WindowCommand =
  | 'minimise'
  | 'fullscreen'
  | 'close'
  | 'snap-left'
  | 'snap-right'
  | 'restore'
  | 'next-window';

/** An open window of the 'agent' app. Its agent keeps a dock icon for as long as it exists. */
export interface AgentWindow {
  agentId: string;
  windowId: string;
}

/** The part of the shell state that the window manager owns and reports. */
export interface WindowSnapshot {
  /** App of the front window, null when the desktop itself is in front. */
  activeAppId: AppId | null;
  /** The front window, null when there is none. Window commands need one. */
  activeWindowId: string | null;
  /** Apps with at least one window, on any desktop. */
  runningApps: AppId[];
  agentWindows: AgentWindow[];
  /** 0 to DESKTOP_COUNT - 1. */
  desktop: number;
  tiling: boolean;
  launcherOpen: boolean;
  overviewOpen: boolean;
  /** Desktops that hold at least one window. */
  occupiedDesktops: number[];
  /** True while the front window is full screen: the dock tucks out of its way. */
  immersive: boolean;
}

/** What a window manager implements to take over the shell's actions. */
export interface WindowManagerPort {
  /** Opens a window (or focuses the singleton) and returns its window id. */
  launchApp(appId: AppId, params?: Record<string, unknown>): string;
  /** Brings the app's most recent window to the front, restoring it if minimised. */
  focusApp(appId: AppId, params?: Record<string, unknown>): void;
  setDesktop(index: number): void;
  toggleTiling(): void;
  toggleLauncher(): void;
  toggleOverview(): void;
  /** Applies a command to the front window. */
  windowCommand(command: WindowCommand): void;
  /** Sends the front window to another desktop. */
  moveWindowToDesktop(index: number): void;
}

interface ShellState extends WindowSnapshot, WindowManagerPort {
  /** True once a window manager has registered. */
  managed: boolean;
  /**
   * Hands the shell's actions to a window manager. It should call sync() right
   * away with its state. Returns a function that hands them back.
   */
  registerWindowManager(port: WindowManagerPort): () => void;
  /** The window manager reports its state here after every change that the shell shows. */
  sync(snapshot: Partial<WindowSnapshot>): void;
}

const clampDesktop = (index: number): number => Math.min(DESKTOP_COUNT - 1, Math.max(0, Math.trunc(index)));

export const useShellStore = create<ShellState>((set, get) => {
  /**
   * The built-in port: there are no windows, so "launching" only records that
   * the app is running and in front. Window ids it hands out are placeholders
   * no window answers to, which is why activeWindowId stays null.
   */
  let unmanagedWindows = 0;
  const builtIn: WindowManagerPort = {
    launchApp(appId, params) {
      const windowId = `unmanaged-${(unmanagedWindows += 1)}`;
      set((state) => {
        const runningApps = state.runningApps.includes(appId) ? state.runningApps : [...state.runningApps, appId];
        const agentId = appId === 'agent' && typeof params?.agentId === 'string' ? params.agentId : null;
        const agentWindows =
          agentId && !state.agentWindows.some((window) => window.agentId === agentId)
            ? [...state.agentWindows, { agentId, windowId }]
            : state.agentWindows;
        return { runningApps, agentWindows, activeAppId: appId, launcherOpen: false };
      });
      return windowId;
    },
    focusApp(appId) {
      if (get().runningApps.includes(appId)) set({ activeAppId: appId });
    },
    setDesktop: (index) => set({ desktop: clampDesktop(index) }),
    toggleTiling: () => set((state) => ({ tiling: !state.tiling })),
    toggleLauncher: () => set((state) => ({ launcherOpen: !state.launcherOpen, overviewOpen: false })),
    toggleOverview: () => set((state) => ({ overviewOpen: !state.overviewOpen, launcherOpen: false })),
    windowCommand: () => {
      // No windows exist without a window manager; the menu bar disables these items.
    },
    moveWindowToDesktop: () => {
      // Nothing to move for the same reason.
    },
  };

  let port: WindowManagerPort = builtIn;

  return {
    activeAppId: null,
    activeWindowId: null,
    runningApps: [],
    agentWindows: [],
    desktop: 0,
    tiling: false,
    launcherOpen: false,
    overviewOpen: false,
    occupiedDesktops: [],
    immersive: false,
    managed: false,

    launchApp: (appId, params) => port.launchApp(appId, params),
    focusApp: (appId, params) => port.focusApp(appId, params),
    setDesktop: (index) => port.setDesktop(clampDesktop(index)),
    toggleTiling: () => port.toggleTiling(),
    toggleLauncher: () => port.toggleLauncher(),
    toggleOverview: () => port.toggleOverview(),
    windowCommand: (command) => port.windowCommand(command),
    moveWindowToDesktop: (index) => port.moveWindowToDesktop(clampDesktop(index)),

    registerWindowManager(next) {
      port = next;
      // Whatever the built-in port recorded is not real; the manager reports the truth next.
      set({
        managed: true,
        activeAppId: null,
        activeWindowId: null,
        runningApps: [],
        agentWindows: [],
        occupiedDesktops: [],
        immersive: false,
      });
      return () => {
        if (port !== next) return;
        port = builtIn;
        set({ managed: false, activeWindowId: null });
      };
    },

    sync: (snapshot) => set(snapshot),
  };
});
