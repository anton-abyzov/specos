import type { Theme } from './lib/theme';

declare global {
  interface SpecOSTestHook {
    setTheme?: (theme: Theme) => void;
    /** Opens an app window; returns the window id. Added by the window manager. */
    openApp?: (appId: string, params?: Record<string, unknown>) => string;
    [key: string]: unknown;
  }
  interface Window {
    __specos?: SpecOSTestHook;
  }
}

export {};
