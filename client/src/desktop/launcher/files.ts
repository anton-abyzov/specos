/** What a file is, as far as the launcher cares: which glyph it gets and which app opens it. */
import type { GlyphName } from '../../design/icons';
import type { IndexedFile } from './file-index';

const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);

/** Files the Editor cannot show as text; Files opens their folder with the file selected instead. */
const NOT_TEXT = new Set([
  ...IMAGES,
  ...['pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'tar', 'rar', 'jar'],
  ...['mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'mov', 'mkv', 'webm', 'avi'],
  ...['woff', 'woff2', 'ttf', 'otf', 'eot'],
  ...['exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'wasm', 'pyc', 'sqlite', 'db'],
  ...['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'psd', 'sketch', 'fig'],
]);

const CODE = new Set([
  ...['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'html', 'vue', 'svelte'],
  ...['py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'lua'],
  ...['sh', 'bash', 'zsh', 'fish', 'sql', 'yml', 'yaml', 'toml', 'xml', 'ini', 'env'],
]);

export function glyphFor(file: IndexedFile): GlyphName {
  if (file.kind === 'dir') return 'folder';
  if (file.ext === 'md' || file.ext === 'mdx') return 'file-markdown';
  if (IMAGES.has(file.ext)) return 'file-image';
  if (CODE.has(file.ext)) return 'file-code';
  if (NOT_TEXT.has(file.ext)) return 'file';
  return 'file-text';
}

export type FileTarget =
  | { app: 'editor'; params: { path: string } }
  | { app: 'files'; params: { path: string; select?: string } };

/**
 * Where a file opens. Folders open in Files; text and code in the Editor;
 * anything else in Files with the file selected. `forceEditor` is the
 * Ctrl/Cmd+Enter route: the Editor even when it is not the default.
 */
export function openTarget(file: IndexedFile, forceEditor: boolean): FileTarget {
  if (file.kind === 'dir') return { app: 'files', params: { path: file.path } };
  if (forceEditor || !NOT_TEXT.has(file.ext)) return { app: 'editor', params: { path: file.path } };
  return { app: 'files', params: { path: file.folder, select: file.path } };
}
