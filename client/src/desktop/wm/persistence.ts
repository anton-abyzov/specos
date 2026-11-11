/**
 * The saved layout: every window with its place, mode and desktop, kept in
 * localStorage under one versioned key so a reload brings the desk back as it
 * was. A layout that does not parse, or was written by another version, is
 * ignored rather than repaired.
 */
import { getApp, isAppId } from '../../apps/registry';
import { DESKTOP_COUNT } from '../../stores/shell';
import type { Rect, SnapZone } from './geometry';
import type { WindowMode, WindowsState, WindowState } from './store';

const KEY = 'specos.windows.v1';
const VERSION = 1;

/** Writes are held back this long so a burst of changes becomes one write. */
const SAVE_DELAY = 200;

export interface SavedLayout {
  windows: Record<string, WindowState>;
  desktop: number;
  tiling: boolean[];
  focusedId: string | null;
  seq: number;
}

const MODES: WindowMode[] = ['normal', 'minimized', 'fullscreen', 'snapped'];
const ZONES: SnapZone[] = ['left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'full'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDesktop = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < DESKTOP_COUNT;

function readRect(value: unknown): Rect | null {
  if (!isRecord(value)) return null;
  const { x, y, w, h } = value;
  const numbers = [x, y, w, h].every((part) => typeof part === 'number' && Number.isFinite(part));
  return numbers && (w as number) > 0 && (h as number) > 0 ? { x, y, w, h } as Rect : null;
}

/** One saved window, or null when any part of it cannot be trusted. */
function readWindow(value: unknown): WindowState | null {
  if (!isRecord(value)) return null;
  const { id, appId, mode, restoreMode, snapZone } = value;
  const bounds = readRect(value.bounds);
  if (typeof id !== 'string' || typeof appId !== 'string' || !isAppId(appId) || !bounds) return null;
  if (!MODES.includes(mode as WindowMode) || !isDesktop(value.desktop)) return null;
  const zone = ZONES.includes(snapZone as SnapZone) && snapZone !== 'full' ? (snapZone as SnapZone) : null;
  // A snapped window without its zone has nowhere to snap to: it comes back floating.
  const safeMode = mode === 'snapped' && !zone ? 'normal' : (mode as WindowMode);
  const tiled = value.tiled === true;
  const restoreBounds = readRect(value.restoreBounds);
  return {
    id,
    appId,
    title: typeof value.title === 'string' && value.title ? value.title : getApp(appId).name,
    params: isRecord(value.params) ? value.params : {},
    bounds,
    restoreBounds: safeMode === 'normal' && !tiled ? null : (restoreBounds ?? bounds),
    z: typeof value.z === 'number' && Number.isFinite(value.z) ? value.z : 0,
    desktop: value.desktop,
    mode: safeMode,
    restoreMode:
      restoreMode === 'fullscreen' || (restoreMode === 'snapped' && zone) ? (restoreMode as 'fullscreen' | 'snapped') : 'normal',
    snapZone: zone,
    tiled,
    slot: typeof value.slot === 'number' && Number.isFinite(value.slot) ? value.slot : 0,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
  };
}

/** The layout saved by an earlier visit, or null when there is none worth restoring. */
export function loadLayout(): SavedLayout | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const saved: unknown = JSON.parse(raw);
    if (!isRecord(saved) || saved.version !== VERSION || !Array.isArray(saved.windows)) return null;

    const windows: Record<string, WindowState> = {};
    for (const entry of saved.windows) {
      const window = readWindow(entry);
      if (window) windows[window.id] = window;
    }
    const highestId = Object.keys(windows).reduce((top, id) => Math.max(top, Number(id.replace(/^w-/, '')) || 0), 0);
    return {
      windows,
      desktop: isDesktop(saved.desktop) ? saved.desktop : 0,
      tiling: Array.from({ length: DESKTOP_COUNT }, (_, index) => Array.isArray(saved.tiling) && saved.tiling[index] === true),
      focusedId: typeof saved.focusedId === 'string' ? saved.focusedId : null,
      // Never hand out an id that a restored window already has.
      seq: Math.max(typeof saved.seq === 'number' ? saved.seq : 0, highestId),
    };
  } catch {
    // Storage is blocked or the value is not JSON: start with an empty desk.
    return null;
  }
}

/** Params an app was opened with may hold anything; only what survives JSON is saved. */
function serialisable(params: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function saveLayout(state: WindowsState): void {
  const layout = {
    version: VERSION,
    windows: Object.values(state.windows).map((window) => ({ ...window, params: serialisable(window.params) })),
    desktop: state.desktop,
    tiling: state.tiling,
    focusedId: state.focusedId,
    seq: state.seq,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Storage is full or blocked: the desk still works, it just will not come back after a reload.
  }
}

interface LayoutSource {
  getState(): WindowsState;
  subscribe(listener: (state: WindowsState, previous: WindowsState) => void): () => void;
}

/** Saves the layout after every change that a reload should keep. Returns the function that stops it. */
export function persistLayout(store: LayoutSource): () => void {
  let timer: number | undefined;
  const flush = () => {
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timer = undefined;
    saveLayout(store.getState());
  };
  const unsubscribe = store.subscribe((state, previous) => {
    const kept =
      state.windows !== previous.windows ||
      state.desktop !== previous.desktop ||
      state.tiling !== previous.tiling ||
      state.focusedId !== previous.focusedId;
    if (!kept) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(flush, SAVE_DELAY);
  });
  // A reload right after a change must not lose it.
  window.addEventListener('pagehide', flush);
  return () => {
    flush();
    unsubscribe();
    window.removeEventListener('pagehide', flush);
  };
}
