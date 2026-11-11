/**
 * The windows store: every window, which one is in front, the four desktops
 * and whether each is tiled. Components read it; nothing here touches the DOM.
 *
 * One invariant keeps the modes honest: `restoreBounds` is the last rectangle
 * the user gave the window themselves, and it is null exactly while the window
 * is free-floating (normal and not tiled). Full screen, snapped and tiled
 * windows get their `bounds` from the viewport through arrange().
 */
import { create } from 'zustand';
import { getApp, type AppId } from '../../apps/registry';
import { DESKTOP_COUNT } from '../../stores/shell';
import {
  MENUBAR_HEIGHT,
  fitInView,
  fullRect,
  keepReachable,
  placeNew,
  rectsEqual,
  roundRect,
  snapRect,
  tileRects,
  type Rect,
  type Size,
  type SnapZone,
} from './geometry';
import { loadLayout, type SavedLayout } from './persistence';

export type WindowMode = 'normal' | 'minimized' | 'fullscreen' | 'snapped';

export interface WindowState {
  id: string;
  appId: AppId;
  title: string;
  /** Whatever the window was opened with, for example { path } or { agentId }. */
  params: Record<string, unknown>;
  bounds: Rect;
  /** The user's own rectangle to go back to; null while the window is free-floating. */
  restoreBounds: Rect | null;
  /** Stacking order; the highest is in front. */
  z: number;
  /** 0 to DESKTOP_COUNT - 1. */
  desktop: number;
  mode: WindowMode;
  /** The mode a minimised window returns to. */
  restoreMode: Exclude<WindowMode, 'minimized'>;
  snapZone: SnapZone | null;
  /** True while the desktop's tiling arranges this window. */
  tiled: boolean;
  /** Position in the tiled layout; swapping two tiles swaps their slots. */
  slot: number;
  createdAt: number;
}

export interface WindowsState {
  windows: Record<string, WindowState>;
  /** The front window of the current desktop, null when the desktop itself is in front. */
  focusedId: string | null;
  desktop: number;
  /** One flag per desktop: each tiles on its own. */
  tiling: boolean[];
  /** Size of the windows layer (the screen below the menu bar). */
  viewport: Size;
  overviewOpen: boolean;
  /** The zone a dragged window would snap to if released now. */
  snapPreview: SnapZone | null;
  /** Counter behind window ids and tile slots. */
  seq: number;
  /** Windows created before this moment came from a saved layout and appear without an opening animation. */
  bootedAt: number;

  /** Opens a window, or focuses the one that already shows the same thing. Returns its id. */
  open(appId: AppId, params?: Record<string, unknown>): string;
  close(id: string): void;
  /** Brings a window to the front, restoring it if minimised and switching to its desktop. */
  focus(id: string): void;
  /** Puts the desktop itself in front. */
  blur(): void;
  minimise(id: string): void;
  restore(id: string): void;
  toggleFullscreen(id: string): void;
  /** Places a window freely: it leaves any snap zone and keeps the given rectangle. */
  setBounds(id: string, bounds: Rect): void;
  /** Snaps a window to a zone; `from` is the rectangle to restore when it is dragged away. */
  snap(id: string, zone: SnapZone, from?: Rect): void;
  /** Back to the user's own rectangle from snapped or full screen. */
  unsnap(id: string): void;
  moveToDesktop(id: string, desktop: number): void;
  setTitle(id: string, title: string): void;
  setDesktop(desktop: number): void;
  toggleTiling(): void;
  /** Exchanges the places of two tiled windows. */
  swapTiles(a: string, b: string): void;
  /** Focuses the next window of the current desktop, or the previous one. */
  cycle(direction?: 1 | -1): void;
  setOverview(open: boolean): void;
  setSnapPreview(zone: SnapZone | null): void;
  setViewport(viewport: Size): void;
}

type Windows = Record<string, WindowState>;

const clampDesktop = (index: number): number => Math.min(DESKTOP_COUNT - 1, Math.max(0, Math.trunc(index)));

/** Windows of one desktop that are on screen, front first. */
export function visibleWindows(windows: Windows, desktop: number): WindowState[] {
  return Object.values(windows)
    .filter((window) => window.desktop === desktop && window.mode !== 'minimized')
    .sort((a, b) => b.z - a.z);
}

const topZ = (windows: Windows): number => Object.values(windows).reduce((top, window) => Math.max(top, window.z), 0);

const frontId = (windows: Windows, desktop: number): string | null => visibleWindows(windows, desktop)[0]?.id ?? null;

/** The windows a desktop's tiling arranges, in slot order. */
export function tiledWindows(windows: Windows, desktop: number): WindowState[] {
  return Object.values(windows)
    .filter((window) => window.desktop === desktop && (window.mode === 'normal' || window.mode === 'snapped'))
    .sort((a, b) => a.slot - b.slot);
}

/**
 * Gives every window whose rectangle follows from the viewport its current
 * one: full screen fills the layer, snapped windows take their zone, and the
 * windows of a tiled desktop share the work area. Windows that need no change
 * keep their identity, so nothing re-renders for them.
 */
function arrange(windows: Windows, tiling: boolean[], view: Size): Windows {
  const next: Windows = {};
  const tiles = new Map<string, Rect>();
  for (let desktop = 0; desktop < DESKTOP_COUNT; desktop += 1) {
    if (!tiling[desktop]) continue;
    const members = tiledWindows(windows, desktop);
    const rects = tileRects(members.length, view);
    members.forEach((window, index) => tiles.set(window.id, rects[index]!));
  }

  let changed = false;
  for (const window of Object.values(windows)) {
    let arranged = window;
    const tile = tiles.get(window.id);
    if (tile) {
      arranged = {
        ...window,
        mode: 'normal',
        snapZone: null,
        tiled: true,
        restoreBounds: window.restoreBounds ?? window.bounds,
        bounds: tile,
      };
    } else if (window.tiled && !tiling[window.desktop]) {
      // Tiling was turned off, or the window moved to a desktop that is not tiled.
      const free = window.restoreBounds ?? window.bounds;
      const floating = window.mode === 'normal' || (window.mode === 'minimized' && window.restoreMode === 'normal');
      arranged = floating
        ? { ...window, tiled: false, bounds: free, restoreBounds: null }
        : { ...window, tiled: false };
    }
    if (!arranged.tiled || arranged.mode !== 'normal') {
      if (arranged.mode === 'fullscreen') arranged = { ...arranged, bounds: fullRect(view) };
      else if (arranged.mode === 'snapped' && arranged.snapZone) {
        arranged = { ...arranged, bounds: snapRect(arranged.snapZone, view) };
      }
    }
    const same =
      arranged === window ||
      (arranged.mode === window.mode &&
        arranged.tiled === window.tiled &&
        arranged.snapZone === window.snapZone &&
        rectsEqual(arranged.bounds, window.bounds) &&
        (arranged.restoreBounds === window.restoreBounds ||
          (!!arranged.restoreBounds && !!window.restoreBounds && rectsEqual(arranged.restoreBounds, window.restoreBounds))));
    next[window.id] = same ? window : arranged;
    changed ||= !same;
  }
  return changed ? next : windows;
}

/** The window that already shows what open() was asked for, if the app keeps one. */
function reusable(windows: Windows, appId: AppId, params: Record<string, unknown>): WindowState | undefined {
  const candidates = Object.values(windows).filter((window) => window.appId === appId);
  if (getApp(appId).singleton) return candidates[0];
  // An agent has one window: opening it again shows the one that is already there.
  if (appId === 'agent' && typeof params.agentId === 'string') {
    return candidates.find((window) => window.params.agentId === params.agentId);
  }
  return undefined;
}

const measureViewport = (): Size => ({
  w: typeof window === 'undefined' ? 1920 : window.innerWidth,
  h: typeof window === 'undefined' ? 1050 : Math.max(0, window.innerHeight - MENUBAR_HEIGHT),
});

/** Brings every window the user placed into the viewport, for a first load or a screen that shrank. */
function fitAll(windows: Windows, view: Size): Windows {
  const fitted: Windows = {};
  for (const window of Object.values(windows)) {
    const min = getApp(window.appId).minSize;
    const bounds = window.restoreBounds === null ? fitInView(window.bounds, view, min) : window.bounds;
    const restoreBounds = window.restoreBounds && fitInView(window.restoreBounds, view, min);
    const unchanged =
      rectsEqual(bounds, window.bounds) &&
      (restoreBounds === null || rectsEqual(restoreBounds, window.restoreBounds!));
    fitted[window.id] = unchanged ? window : { ...window, bounds, restoreBounds };
  }
  return fitted;
}

function initialState(saved: SavedLayout | null) {
  const viewport = measureViewport();
  const tiling = saved?.tiling ?? Array.from({ length: DESKTOP_COUNT }, () => false);
  const windows = saved ? arrange(fitAll(saved.windows, viewport), tiling, viewport) : {};
  const desktop = saved?.desktop ?? 0;
  const focused = saved?.focusedId ? windows[saved.focusedId] : undefined;
  return {
    windows,
    desktop,
    tiling,
    viewport,
    focusedId: focused && focused.desktop === desktop && focused.mode !== 'minimized' ? focused.id : null,
    seq: saved?.seq ?? 0,
  };
}

export const useWindowsStore = create<WindowsState>((set, get) => {
  /** Applies a change to the windows map, then re-arranges whatever the viewport lays out. */
  const update = (change: (state: WindowsState) => Partial<WindowsState>) =>
    set((state) => {
      const patch = change(state);
      const tiling = patch.tiling ?? state.tiling;
      const viewport = patch.viewport ?? state.viewport;
      return { ...patch, windows: arrange(patch.windows ?? state.windows, tiling, viewport) };
    });

  const patchWindow = (windows: Windows, id: string, patch: Partial<WindowState>): Windows => {
    const window = windows[id];
    return window ? { ...windows, [id]: { ...window, ...patch } } : windows;
  };

  return {
    ...initialState(loadLayout()),
    overviewOpen: false,
    snapPreview: null,
    bootedAt: Date.now(),

    open(appId, params = {}) {
      const existing = reusable(get().windows, appId, params);
      if (existing) {
        get().focus(existing.id);
        return existing.id;
      }
      const app = getApp(appId);
      const id = `w-${get().seq + 1}`;
      update((state) => {
        const onDesktop = visibleWindows(state.windows, state.desktop);
        const front = onDesktop.find((other) => other.restoreBounds === null);
        const window: WindowState = {
          id,
          appId,
          title: app.name,
          params,
          bounds: placeNew(
            app.defaultSize,
            state.viewport,
            front?.bounds ?? null,
            onDesktop.map((other) => other.restoreBounds ?? other.bounds),
          ),
          restoreBounds: null,
          z: topZ(state.windows) + 1,
          desktop: state.desktop,
          mode: 'normal',
          restoreMode: 'normal',
          snapZone: null,
          tiled: false,
          slot: state.seq + 1,
          createdAt: Date.now(),
        };
        return {
          windows: { ...state.windows, [id]: window },
          focusedId: id,
          seq: state.seq + 1,
          overviewOpen: false,
        };
      });
      return id;
    },

    close(id) {
      update((state) => {
        if (!state.windows[id]) return {};
        const { [id]: _closed, ...windows } = state.windows;
        return {
          windows,
          focusedId: state.focusedId === id ? frontId(windows, state.desktop) : state.focusedId,
        };
      });
    },

    focus(id) {
      update((state) => {
        const window = state.windows[id];
        if (!window) return {};
        const inFront = window.z === topZ(state.windows);
        if (inFront && state.focusedId === id && window.mode !== 'minimized' && window.desktop === state.desktop) {
          return {};
        }
        return {
          windows: patchWindow(state.windows, id, {
            z: inFront ? window.z : topZ(state.windows) + 1,
            mode: window.mode === 'minimized' ? window.restoreMode : window.mode,
          }),
          focusedId: id,
          desktop: window.desktop,
        };
      });
    },

    blur() {
      if (get().focusedId !== null) set({ focusedId: null });
    },

    minimise(id) {
      update((state) => {
        const window = state.windows[id];
        if (!window || window.mode === 'minimized') return {};
        const windows = patchWindow(state.windows, id, { mode: 'minimized', restoreMode: window.mode });
        return {
          windows,
          focusedId: state.focusedId === id ? frontId(windows, state.desktop) : state.focusedId,
        };
      });
    },

    restore(id) {
      get().focus(id);
    },

    toggleFullscreen(id) {
      update((state) => {
        const window = state.windows[id];
        if (!window || window.mode === 'minimized') return {};
        if (window.mode !== 'fullscreen') {
          return {
            windows: patchWindow(state.windows, id, {
              mode: 'fullscreen',
              restoreBounds: window.restoreBounds ?? window.bounds,
            }),
          };
        }
        // Back to where it was: its snap zone, its tile, or the user's own rectangle.
        if (window.snapZone) return { windows: patchWindow(state.windows, id, { mode: 'snapped' }) };
        if (state.tiling[window.desktop]) return { windows: patchWindow(state.windows, id, { mode: 'normal' }) };
        return {
          windows: patchWindow(state.windows, id, {
            mode: 'normal',
            bounds: window.restoreBounds ?? window.bounds,
            restoreBounds: null,
          }),
        };
      });
    },

    setBounds(id, bounds) {
      update((state) => {
        const window = state.windows[id];
        if (!window || window.tiled) return {};
        const min = getApp(window.appId).minSize;
        const rect = roundRect(bounds);
        const sized = { ...rect, w: Math.max(min.w, rect.w), h: Math.max(min.h, rect.h) };
        return {
          windows: patchWindow(state.windows, id, {
            mode: 'normal',
            snapZone: null,
            restoreBounds: null,
            bounds: keepReachable(sized, state.viewport),
          }),
        };
      });
    },

    snap(id, zone, from) {
      update((state) => {
        const window = state.windows[id];
        if (!window || window.tiled || window.mode === 'minimized') return {};
        const restoreBounds = window.restoreBounds ?? from ?? window.bounds;
        return {
          windows: patchWindow(
            state.windows,
            id,
            zone === 'full'
              ? { mode: 'fullscreen', snapZone: null, restoreBounds }
              : { mode: 'snapped', snapZone: zone, restoreBounds },
          ),
          snapPreview: null,
        };
      });
    },

    unsnap(id) {
      update((state) => {
        const window = state.windows[id];
        if (!window || window.tiled || !window.restoreBounds || window.mode === 'minimized') return {};
        return {
          windows: patchWindow(state.windows, id, {
            mode: 'normal',
            snapZone: null,
            bounds: window.restoreBounds,
            restoreBounds: null,
          }),
        };
      });
    },

    moveToDesktop(id, target) {
      const desktop = clampDesktop(target);
      update((state) => {
        const window = state.windows[id];
        if (!window || window.desktop === desktop) return {};
        const windows = patchWindow(state.windows, id, { desktop });
        return {
          windows,
          focusedId: state.focusedId === id ? frontId(windows, state.desktop) : state.focusedId,
        };
      });
    },

    setTitle(id, title) {
      const window = get().windows[id];
      if (window && window.title !== title) set({ windows: patchWindow(get().windows, id, { title }) });
    },

    setDesktop(target) {
      const desktop = clampDesktop(target);
      if (desktop === get().desktop) return;
      set((state) => ({ desktop, focusedId: frontId(state.windows, desktop), snapPreview: null }));
    },

    toggleTiling() {
      update((state) => ({
        tiling: state.tiling.map((on, desktop) => (desktop === state.desktop ? !on : on)),
      }));
    },

    swapTiles(a, b) {
      update((state) => {
        const first = state.windows[a];
        const second = state.windows[b];
        if (!first || !second || first.desktop !== second.desktop) return {};
        return {
          windows: patchWindow(patchWindow(state.windows, a, { slot: second.slot }), b, { slot: first.slot }),
        };
      });
    },

    cycle(direction = 1) {
      const state = get();
      // Oldest first is a stable ring; stepping through it by z would reorder it on every step.
      const ring = visibleWindows(state.windows, state.desktop).sort((x, y) => x.createdAt - y.createdAt);
      if (ring.length === 0) return;
      const index = ring.findIndex((window) => window.id === state.focusedId);
      const next = ring[(index + direction + ring.length) % ring.length]!;
      state.focus(next.id);
    },

    setOverview(open) {
      if (get().overviewOpen !== open) set({ overviewOpen: open, snapPreview: null });
    },

    setSnapPreview(zone) {
      if (get().snapPreview !== zone) set({ snapPreview: zone });
    },

    setViewport(viewport) {
      const current = get().viewport;
      if (current.w === viewport.w && current.h === viewport.h) return;
      update((state) => ({ viewport, windows: fitAll(state.windows, viewport) }));
    },
  };
});

/** The focused window, if any. */
export function focusedWindow(state: WindowsState): WindowState | undefined {
  return state.focusedId ? state.windows[state.focusedId] : undefined;
}
