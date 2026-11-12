/** The files the Editor opened last, newest first, kept in this browser. */
const KEY = 'specos.editor.recent';
const LIMIT = 8;

export function recentFiles(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((path): path is string => typeof path === 'string').slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

function store(paths: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(paths.slice(0, LIMIT)));
  } catch {
    // Private mode: the list simply does not outlive the page.
  }
}

export function rememberFile(path: string): void {
  store([path, ...recentFiles().filter((other) => other !== path)]);
}

export function forgetFile(path: string): void {
  store(recentFiles().filter((other) => other !== path));
}
