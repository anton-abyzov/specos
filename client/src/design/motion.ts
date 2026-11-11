/**
 * Every animated thing in SpecOS picks a spring from here, so motion reads as
 * one system: quick and slightly damped for chrome, a little softer for
 * windows, firm for whole-desktop moves.
 */
import type { Transition } from 'motion/react';

export const springs = {
  /** A window growing out of its dock icon or the launcher. */
  windowOpen: { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 },
  /** Closing is faster than opening: the user has already moved on. */
  windowClose: { type: 'spring', stiffness: 560, damping: 42, mass: 0.8 },
  /** A window travelling to or from the dock. */
  minimise: { type: 'spring', stiffness: 360, damping: 36, mass: 1 },
  /** Snap, tile and full screen: a rectangle moving to a new rectangle. */
  layout: { type: 'spring', stiffness: 480, damping: 40, mass: 0.9 },
  /** Dock icons following the pointer. Tight, so they never lag behind it. */
  dock: { type: 'spring', stiffness: 700, damping: 46, mass: 0.5 },
  /** Dock icons settling back after the pointer leaves. */
  dockSettle: { type: 'spring', stiffness: 380, damping: 30, mass: 0.7 },
  /** Launcher and Peek panels. */
  launcher: { type: 'spring', stiffness: 520, damping: 38, mass: 0.8 },
  /** Menus and tooltips: nearly instant, with just enough travel to be seen. */
  menu: { type: 'spring', stiffness: 900, damping: 50, mass: 0.5 },
  /** Sliding between desktops and into the overview. */
  desktopSlide: { type: 'spring', stiffness: 300, damping: 34, mass: 1 },
  /** Small state changes inside chrome: a pill filling, a slot moving. */
  nudge: { type: 'spring', stiffness: 600, damping: 36, mass: 0.6 },
} as const satisfies Record<string, Transition>;

export type SpringName = keyof typeof springs;

const INSTANT: Transition = { duration: 0 };

const reducedQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

/** True when the user asked the system for less motion. Read at call time. */
export function prefersReducedMotion(): boolean {
  return reducedQuery?.matches ?? false;
}

/** The named spring, or an instant change when motion is reduced. */
export function spring(name: SpringName): Transition {
  return prefersReducedMotion() ? INSTANT : springs[name];
}

/** Calls back when the reduced-motion preference changes; returns the unsubscribe. */
export function onReducedMotionChange(listener: (reduced: boolean) => void): () => void {
  if (!reducedQuery) return () => {};
  const handle = (event: MediaQueryListEvent) => listener(event.matches);
  reducedQuery.addEventListener('change', handle);
  return () => reducedQuery.removeEventListener('change', handle);
}
