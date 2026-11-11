/**
 * Owns the position and size of one window's element. React never writes
 * these: a drag writes them every frame, and a change in the store is either
 * already on screen (the drag just committed it) or is animated to with a
 * spring. Keeping the last written rectangle here is what makes both cases
 * free of jumps.
 */
import { animate, type AnimationPlaybackControls } from 'motion/react';
import { prefersReducedMotion, springs } from '../../design/motion';
import { mixRect, rectsEqual, type Rect } from './geometry';

export class FrameController {
  private element: HTMLElement | null = null;
  private shown: Rect;
  private running: AnimationPlaybackControls | null = null;
  /** Where the running spring is going. */
  private heading: Rect;

  constructor(initial: Rect) {
    this.shown = initial;
    this.heading = initial;
  }

  /** The rectangle on screen right now, mid-animation included. */
  get rect(): Rect {
    return this.shown;
  }

  attach(element: HTMLElement | null): void {
    this.element = element;
    if (element) this.write(this.shown);
  }

  /** Puts the element at `rect` at once. Used for every frame of a drag or resize. */
  write(rect: Rect): void {
    this.shown = rect;
    const style = this.element?.style;
    if (!style) return;
    // Whole pixels keep text crisp while the window moves.
    style.transform = `translate3d(${Math.round(rect.x)}px, ${Math.round(rect.y)}px, 0)`;
    style.width = `${Math.round(rect.w)}px`;
    style.height = `${Math.round(rect.h)}px`;
  }

  /** Stops a running spring where it is, so a drag can pick the window up mid-flight. */
  stop(): void {
    this.running?.stop();
    this.running = null;
    this.element?.removeAttribute('data-moving');
  }

  /** Moves to `target` with the layout spring; does nothing when it is already there or on its way. */
  moveTo(target: Rect, animated = true): void {
    if (rectsEqual(this.running ? this.heading : this.shown, target)) return;
    this.stop();
    if (!animated || prefersReducedMotion() || !this.element) {
      this.write(target);
      return;
    }
    const from = this.shown;
    this.heading = target;
    this.element.setAttribute('data-moving', '');
    this.running = animate(0, 1, {
      ...springs.layout,
      onUpdate: (progress) => this.write(mixRect(from, target, progress)),
      onComplete: () => {
        this.write(target);
        this.running = null;
        this.element?.removeAttribute('data-moving');
      },
    });
  }
}
