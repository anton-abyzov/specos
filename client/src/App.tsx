import { useEffect } from 'react';
import { isAppId } from './apps/registry';
import { Desktop } from './desktop/Desktop';
import { setTheme } from './lib/theme';
import { stores } from './stores';

/** Opens an app through whichever window manager is registered with the shell. */
function openApp(appId: string, params?: Record<string, unknown>): string {
  if (!isAppId(appId)) throw new Error(`Unknown app "${appId}"`);
  return stores.shell.getState().launchApp(appId, params);
}

export function App() {
  useEffect(() => {
    // The hook that tests and screenshots drive the desktop through.
    window.__specos = { ...(window.__specos ?? {}), setTheme, openApp, stores };
  }, []);
  return <Desktop />;
}
