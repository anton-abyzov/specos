import type { Theme } from './lib/theme';
import type { Stores } from './stores';

declare global {
  interface SpecOSTestHook {
    setTheme?: (theme: Theme) => void;
    /** Opens an app window through the shell; returns the window id. */
    openApp?: (appId: string, params?: Record<string, unknown>) => string;
    /** Every zustand store, for reading and driving state from tests. */
    stores?: Stores;
    [key: string]: unknown;
  }
  interface Window {
    __specos?: SpecOSTestHook;
  }
}

export {};
