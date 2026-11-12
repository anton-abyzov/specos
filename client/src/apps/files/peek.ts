/**
 * Peek: the quick preview that Space opens. The Files window that owns the
 * selection puts a file here; the panel itself (desktop/QuickLook.tsx) is
 * mounted once on the desktop and draws whatever this store holds.
 */
import { create } from 'zustand';
import type { FsEntry } from '@shared/protocol';

/** A rectangle in viewport coordinates: the row the panel springs from and returns to. */
export interface PeekOrigin {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PeekKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export interface PeekTarget {
  entry: FsEntry;
  origin: PeekOrigin | null;
  /** The window whose selection is being shown. */
  owner: string;
  /** Moves the selection under the panel; the owner then shows the new file. */
  navigate(key: PeekKey): void;
}

interface PeekState {
  target: PeekTarget | null;
  show(target: PeekTarget): void;
  /** The owner's selection moved: follow it without closing. */
  follow(owner: string, entry: FsEntry, origin: PeekOrigin | null): void;
  /** Closes the panel; with an owner, only when that window owns it. */
  close(owner?: string): void;
}

export const usePeekStore = create<PeekState>((set) => ({
  target: null,
  show: (target) => set({ target }),
  follow: (owner, entry, origin) =>
    set((state) => (state.target?.owner === owner ? { target: { ...state.target, entry, origin } } : state)),
  close: (owner) => set((state) => (!owner || state.target?.owner === owner ? { target: null } : state)),
}));
