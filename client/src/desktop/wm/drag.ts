/**
 * Moving and resizing a window with the pointer. Both write the window's
 * rectangle straight to its element once per frame and tell the store only at
 * the end, so React renders nothing while the pointer moves.
 */
import type { PointerEvent as ReactPointerEvent } from 'react';
import { getApp } from '../../apps/registry';
import type { FrameController } from './frame';
import {
  MENUBAR_HEIGHT,
  containsPoint,
  keepReachable,
  resizeRect,
  snapRect,
  zoneAt,
  type Rect,
  type ResizeEdges,
  type SnapZone,
} from './geometry';
import { holdGesture, trackPointer, type PointerPosition } from './gestures';
import { tiledWindows, useWindowsStore } from './store';

/** The pointer must travel this far before a press on the title bar becomes a drag. */
const DRAG_THRESHOLD = 4;

/** How long a window takes to return to its own size when it is dragged out of a snap zone. */
const RELEASE_MS = 180;

const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/**
 * Drags a window by its title bar. A snapped or full screen window shrinks
 * back to the size it had before, around the pointer, as soon as the drag
 * starts. On release it snaps to the zone under the pointer, swaps with the
 * tile under the pointer, or simply stays where it was dropped.
 */
export function beginMove(event: ReactPointerEvent<HTMLElement>, id: string, frame: FrameController): void {
  const pressed = useWindowsStore.getState().windows[id];
  const element = event.currentTarget.closest<HTMLElement>('[data-window-id]');
  if (!pressed || !element) return;

  const start = frame.rect;
  // A window in a zone returns to this size once it is pulled out; a tile keeps its size and is swapped.
  const own = !pressed.tiled && pressed.restoreBounds ? pressed.restoreBounds : null;
  const grab = {
    // Where on the bar the pointer holds the window, as a share of its width, so it stays under the pointer as the width changes.
    x: (event.clientX - start.x) / start.w,
    y: event.clientY - MENUBAR_HEIGHT - start.y,
  };
  let releaseGesture: (() => void) | null = null;
  let startedAt = 0;

  const rectAt = (pointer: PointerPosition, progress: number): Rect => {
    const view = useWindowsStore.getState().viewport;
    if (!own) return keepReachable({ ...start, x: start.x + pointer.dx, y: start.y + pointer.dy }, view);
    const w = start.w + (own.w - start.w) * progress;
    const h = start.h + (own.h - start.h) * progress;
    return keepReachable({ x: pointer.x - grab.x * w, y: pointer.y - MENUBAR_HEIGHT - grab.y, w, h }, view);
  };

  /** What releasing the window here would do: swap with a tile, snap to a zone, or neither. */
  const dropTarget = (pointer: PointerPosition): { rect: Rect | null; zone?: SnapZone | null; tile?: string } => {
    const state = useWindowsStore.getState();
    const layerY = pointer.y - MENUBAR_HEIGHT;
    if (pressed.tiled) {
      const under = tiledWindows(state.windows, pressed.desktop).find(
        (other) => other.id !== id && containsPoint(other.bounds, pointer.x, layerY),
      );
      return { rect: under?.bounds ?? null, tile: under?.id };
    }
    const zone = zoneAt(pointer.x, layerY, state.viewport);
    return { rect: zone && snapRect(zone, state.viewport), zone };
  };

  trackPointer(event, {
    frame(pointer) {
      if (!releaseGesture) {
        if (Math.hypot(pointer.dx, pointer.dy) < DRAG_THRESHOLD) return;
        frame.stop();
        releaseGesture = holdGesture('move', 'grabbing');
        element.dataset.gesture = 'move';
        startedAt = performance.now();
      }
      const elapsed = performance.now() - startedAt;
      frame.write(rectAt(pointer, easeOut(Math.min(1, elapsed / RELEASE_MS))));
      useWindowsStore.getState().setDropPreview(dropTarget(pointer).rect);
      // Keep drawing until the window has reached its own size, even if the pointer rests.
      return own !== null && elapsed < RELEASE_MS;
    },

    end(pointer) {
      if (!releaseGesture) return;
      releaseGesture();
      delete element.dataset.gesture;

      const state = useWindowsStore.getState();
      const target = dropTarget(pointer);
      if (target.tile) state.swapTiles(id, target.tile);
      else if (target.zone) state.snap(id, target.zone, own ?? start);
      else if (!pressed.tiled) state.setBounds(id, rectAt(pointer, 1));
      state.setDropPreview(null);

      // Whatever the store decided, travel there from where the window was dropped.
      const settled = useWindowsStore.getState().windows[id];
      if (settled) frame.moveTo(settled.bounds);
    },
  });
}

/** Resizes a window from one of its eight handles, never below the app's minimum size. */
export function beginResize(
  event: ReactPointerEvent<HTMLElement>,
  id: string,
  frame: FrameController,
  edges: ResizeEdges,
  onSize: (rect: Rect) => void,
): void {
  const pressed = useWindowsStore.getState().windows[id];
  const element = event.currentTarget.closest<HTMLElement>('[data-window-id]');
  if (!pressed || !element) return;
  event.stopPropagation();

  frame.stop();
  const start = frame.rect;
  const min = getApp(pressed.appId).minSize;
  const releaseGesture = holdGesture('resize', getComputedStyle(event.currentTarget).cursor);

  trackPointer(event, {
    frame(pointer) {
      const rect = resizeRect(start, edges, pointer.dx, pointer.dy, min, useWindowsStore.getState().viewport);
      frame.write(rect);
      onSize(rect);
      // Set on the first frame, not on pointer down: a press alone changes nothing on screen.
      element.dataset.gesture = 'resize';
    },
    end() {
      releaseGesture();
      delete element.dataset.gesture;
      useWindowsStore.getState().setBounds(id, frame.rect);
      const settled = useWindowsStore.getState().windows[id];
      if (settled) frame.moveTo(settled.bounds);
    },
  });
}
