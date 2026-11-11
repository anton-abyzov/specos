import type { Theme } from './lib/theme';
import type { useWindowsStore } from './desktop/wm/store';
import type { Stores } from './stores';

declare global {
  interface SpecOSTestHook {
    setTheme?: (theme: Theme) => void;
    /** Opens an app window through the shell; returns the window id. */
    openApp?: (appId: string, params?: Record<string, unknown>) => string;
    /** Every zustand store, for reading and driving state from tests. */
    stores?: Stores;
    /** The window manager's store: every window, its bounds, mode and desktop. */
    windows?: typeof useWindowsStore;
    [key: string]: unknown;
  }
  interface Window {
    __specos?: SpecOSTestHook;
  }
}

export {};
