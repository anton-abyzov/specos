import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/base.css';
import { App } from './App';
import { getApp, preloadApps } from './apps/registry';
import { useWindowsStore } from './desktop/wm/store';
import { startEvents } from './lib/events';

// Outside React on purpose: the socket lives as long as the page, not as long as a component.
startEvents();

/** How long the first paint may wait for the code of the windows that come back with it. */
const RESTORE_WAIT_MS = 400;

// Windows kept from the last visit come back with their apps drawn, not as empty frames that fill in.
const restored = new Set(Object.values(useWindowsStore.getState().windows).map((win) => win.appId));
const code = Promise.all([...restored].map((id) => getApp(id).preload().catch(() => undefined)));
const patience = new Promise((resolve) => window.setTimeout(resolve, RESTORE_WAIT_MS));

void Promise.race([code, patience]).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // The rest arrives once the desktop is drawn and the page is idle, so every first window opens complete.
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(preloadApps, { timeout: 3000 });
  else window.setTimeout(preloadApps, 1200);
});
