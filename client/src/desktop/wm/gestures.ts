/**
 * One pointer gesture (a drag or a resize) from pointer down to pointer up.
 * Pointer moves are coalesced: however many arrive between two frames, the
 * handler runs once per animation frame with the latest position, and once
 * more, synchronously, when the pointer is released, so what is committed is
 * exactly what the last frame showed.
 */
import type { PointerEvent as ReactPointerEvent } from 'react';

export interface PointerPosition {
  /** Viewport coordinates. */
  x: number;
  y: number;
  /** Distance travelled since pointer down. */
  dx: number;
  dy: number;
}

export interface GestureHandlers {
  /**
   * Called once per animation frame while the pointer moves. Return true to be
   * called again next frame even if the pointer stays still (an animation that
   * runs during the drag needs that).
   */
  frame(pointer: PointerPosition): boolean | void;
  /** Called once at the end, after a final frame(). `cancelled` is true when the browser took the pointer away. */
  end(pointer: PointerPosition, cancelled: boolean): void;
}

export function trackPointer(event: ReactPointerEvent<HTMLElement>, handlers: GestureHandlers): void {
  const target = event.currentTarget;
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startY = event.clientY;
  let latest: PointerPosition = { x: startX, y: startY, dx: 0, dy: 0 };
  let scheduled = 0;
  let finished = false;

  const tick = () => {
    scheduled = 0;
    if (handlers.frame(latest) === true) schedule();
  };
  const schedule = () => {
    if (scheduled === 0 && !finished) scheduled = requestAnimationFrame(tick);
  };

  const onMove = (move: PointerEvent) => {
    if (move.pointerId !== pointerId) return;
    latest = { x: move.clientX, y: move.clientY, dx: move.clientX - startX, dy: move.clientY - startY };
    schedule();
  };

  const finish = (cancelled: boolean) => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(scheduled);
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onCancel);
    target.removeEventListener('lostpointercapture', onCancel);
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    // The frame the user saw last may be one move behind; draw the final one before committing.
    handlers.frame(latest);
    handlers.end(latest, cancelled);
  };
  const onUp = (up: PointerEvent) => {
    if (up.pointerId !== pointerId) return;
    latest = { x: up.clientX, y: up.clientY, dx: up.clientX - startX, dy: up.clientY - startY };
    finish(false);
  };
  const onCancel = (cancel: PointerEvent) => {
    if (cancel.pointerId === pointerId) finish(true);
  };

  target.setPointerCapture(pointerId);
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onCancel);
  target.addEventListener('lostpointercapture', onCancel);
}

/**
 * Marks the page as mid-gesture: a stylesheet uses it to stop text selection
 * and to hold one cursor everywhere. Returns the function that clears it.
 */
export function holdGesture(kind: 'move' | 'resize', cursor: string): () => void {
  const root = document.documentElement;
  root.dataset.wmGesture = kind;
  root.style.setProperty('--wm-gesture-cursor', cursor);
  return () => {
    delete root.dataset.wmGesture;
    root.style.removeProperty('--wm-gesture-cursor');
  };
}
