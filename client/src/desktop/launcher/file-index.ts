/**
 * The launcher's copy of the home folder's index. Every path is prepared for
 * fuzzysort once, when the index arrives, so a keystroke only has to score:
 * that is what keeps the search inside one frame for thousands of files.
 */
import fuzzysort, { type Prepared } from 'fuzzysort';
import { create } from 'zustand';
import type { EntryKind } from '@shared/protocol';
import { api } from '../../lib/api';

export interface IndexedFile {
  name: string;
  /** Home relative. */
  path: string;
  kind: EntryKind;
  /** The folder that holds it, home relative; "" for the home folder itself. */
  folder: string;
  /** Lower case extension without the dot, "" when none. */
  ext: string;
  /** The path as the search compares it: lower case, accents removed. */
  folded: string;
  nameTarget: Prepared;
  pathTarget: Prepared;
}

/** Lower case and without accents, the way fuzzysort reads a string. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

interface FileIndexState {
  files: IndexedFile[];
  /** True when the server capped the index: there are more files than these. */
  truncated: boolean;
  /** Fetches the index again. The previous one stays in place until the new one has arrived. */
  refresh(): Promise<void>;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  // A leading dot is a hidden file, not an extension.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

let inFlight: AbortController | null = null;

export const useFileIndex = create<FileIndexState>((set, get) => ({
  files: [],
  truncated: false,

  async refresh() {
    inFlight?.abort();
    const request = new AbortController();
    inFlight = request;
    try {
      const { entries, truncated } = await api.fs.index(request.signal);
      const held = get();
      // Preparing is the costly part, so a path that is still there keeps the target it already has.
      const known = new Map(held.files.map((file) => [file.path, file]));
      let changed = entries.length !== held.files.length || truncated !== held.truncated;
      const files = entries.map((entry, position): IndexedFile => {
        const existing = known.get(entry.path);
        if (existing?.kind === entry.kind) {
          changed ||= held.files[position] !== existing;
          return existing;
        }
        changed = true;
        const folder = entry.path.slice(0, Math.max(0, entry.path.length - entry.name.length - 1));
        return {
          ...entry,
          folder,
          ext: entry.kind === 'dir' ? '' : extensionOf(entry.name),
          folded: fold(entry.path),
          nameTarget: fuzzysort.prepare(entry.name),
          pathTarget: fuzzysort.prepare(entry.path),
        };
      });
      // The same index again leaves the store alone: nothing that reads it has to search or render again.
      if (changed) set({ files, truncated });
    } catch {
      // Superseded by a newer request, or the server is away: the index held so far still answers.
    } finally {
      if (inFlight === request) inFlight = null;
    }
  },
}));
