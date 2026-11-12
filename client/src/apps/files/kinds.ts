/** What a file is to the Files app: its kind, its glyph, and the small text helpers every part shares. */
import type { FsEntry } from '@shared/protocol';
import type { GlyphName } from '../../design/icons';

export type FileKind = 'folder' | 'markdown' | 'image' | 'code' | 'text' | 'binary';

const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);

const MARKDOWN = new Set(['md', 'mdx', 'markdown']);

const CODE = new Set([
  ...['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'html', 'htm', 'vue', 'svelte'],
  ...['py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'lua'],
  ...['sh', 'bash', 'zsh', 'fish', 'sql', 'yml', 'yaml', 'toml', 'xml', 'ini', 'env'],
]);

const BINARY = new Set([
  ...['pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'tar', 'rar', 'jar'],
  ...['mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'mov', 'mkv', 'webm', 'avi'],
  ...['woff', 'woff2', 'ttf', 'otf', 'eot'],
  ...['exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'wasm', 'pyc', 'sqlite', 'db'],
  ...['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'psd', 'sketch', 'fig'],
]);

export function kindOf(entry: Pick<FsEntry, 'kind' | 'ext'>): FileKind {
  if (entry.kind === 'dir') return 'folder';
  if (MARKDOWN.has(entry.ext)) return 'markdown';
  if (IMAGES.has(entry.ext)) return 'image';
  if (CODE.has(entry.ext)) return 'code';
  if (BINARY.has(entry.ext)) return 'binary';
  return 'text';
}

const GLYPHS: Record<FileKind, GlyphName> = {
  folder: 'folder',
  markdown: 'file-markdown',
  image: 'file-image',
  code: 'file-code',
  text: 'file-text',
  binary: 'file',
};

export const glyphOf = (entry: Pick<FsEntry, 'kind' | 'ext'>): GlyphName => GLYPHS[kindOf(entry)];

const KIND_NAMES: Record<FileKind, string> = {
  folder: 'Folder',
  markdown: 'Markdown',
  image: 'Image',
  code: 'Code',
  text: 'Text',
  binary: 'File',
};

/** "Markdown", "PNG image", "TS code": what the details pane and Peek call the file. */
export function kindLabel(entry: Pick<FsEntry, 'kind' | 'ext'>): string {
  const kind = kindOf(entry);
  if (entry.kind === 'symlink') return 'Link';
  if (kind === 'folder' || kind === 'markdown' || !entry.ext) return KIND_NAMES[kind];
  return `${entry.ext.toUpperCase()} ${KIND_NAMES[kind].toLowerCase()}`;
}

/** Files the Editor can show: everything that is not known to be an image or another binary format. */
export const opensInEditor = (entry: Pick<FsEntry, 'kind' | 'ext'>): boolean => {
  const kind = kindOf(entry);
  return kind === 'markdown' || kind === 'code' || kind === 'text';
};

// ---------------------------------------------------------------- paths

/** The folder a path sits in; "" for anything directly in home. */
export const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const joinPath = (folder: string, name: string): string => (folder ? `${folder}/${name}` : name);

/** True when `path` is `folder` or lies anywhere below it. */
export const isWithin = (path: string, folder: string): boolean =>
  folder === '' || path === folder || path.startsWith(`${folder}/`);

/** Home, then every folder on the way down to `path`: "" , "a", "a/b". */
export function chainOf(path: string): string[] {
  const chain = [''];
  if (!path) return chain;
  const parts = path.split('/');
  for (let depth = 1; depth <= parts.length; depth += 1) chain.push(parts.slice(0, depth).join('/'));
  return chain;
}

/** A name the file system will take: one segment, not "." or "..". */
export function nameProblem(name: string): string | null {
  if (!name) return 'Give it a name.';
  if (name.includes('/') || name.includes('\0')) return 'A name cannot contain a slash.';
  if (name === '.' || name === '..') return 'That name is reserved.';
  return null;
}

// ---------------------------------------------------------------- facts

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(ms >= 100 ? 0 : 1)} ms`;
}

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** "Today 14:02", "Yesterday 09:15", "3 Nov 2026 18:40". */
export function formatModified(mtime: number, now = Date.now()): string {
  const date = new Date(mtime);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday.getTime() - new Date(mtime).setHours(0, 0, 0, 0)) / 86_400_000);
  const time = TIME.format(date);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${DAY.format(date)} ${time}`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then by name the way a person reads it (file2 before file10). */
export function compareEntries(a: Pick<FsEntry, 'kind' | 'name'>, b: Pick<FsEntry, 'kind' | 'name'>): number {
  const aDir = a.kind === 'dir' ? 0 : 1;
  const bDir = b.kind === 'dir' ? 0 : 1;
  return aDir - bDir || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
