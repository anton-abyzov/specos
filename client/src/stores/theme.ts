import { useSyncExternalStore } from 'react';
import { getTheme, type Theme } from '../lib/theme';

function subscribe(listener: () => void): () => void {
  window.addEventListener('specos:theme', listener);
  return () => window.removeEventListener('specos:theme', listener);
}

/** The current theme, re-rendering when it changes. Change it with setTheme from lib/theme. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme);
}
