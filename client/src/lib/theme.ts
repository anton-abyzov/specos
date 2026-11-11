export type Theme = 'light' | 'dark';

const KEY = 'specos.theme';

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** Switches the theme, remembers it and tells listeners. */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Private mode: the theme still applies for this page.
  }
  window.dispatchEvent(new CustomEvent('specos:theme', { detail: theme }));
}
