/**
 * Dock magnification. Icons near the pointer grow from their baseline and
 * push their neighbours aside. Nothing here touches layout: every icon gets a
 * scale and a sideways shift as motion values, computed together so the row
 * stays centred and never jumps.
 */
import { animate, motionValue, type MotionValue } from 'motion/react';
import { prefersReducedMotion, springs } from '../design/motion';

/** How large the icon under the pointer gets. */
const MAX_SCALE = 1.35;
/** Distance from the pointer, in pixels, at which an icon is back to its own size. */
const REACH = 132;

interface Member {
  element: HTMLElement;
  /** Width that scales with the icon; 0 for the divider, which only moves. */
  size: number;
  scale: MotionValue<number>;
  shift: MotionValue<number>;
  /** Resting centre, relative to the row. */
  centre: number;
}

export class DockMagnifier {
  /** Extra width the row has gained; the shelf behind it widens by this much. */
  readonly spread = motionValue(0);
  private readonly members = new Set<Member>();
  /** 0 when the pointer is away, 1 when it is over the dock; sprung, so entering and leaving are soft. */
  private readonly presence = motionValue(0);
  private pointer = 0;

  /** Starts following the presence spring; returns the function that stops it. */
  attach(): () => void {
    const unsubscribe = this.presence.on('change', () => this.apply());
    return () => {
      unsubscribe();
      this.presence.stop();
      this.presence.set(0);
    };
  }

  /** Adds an icon (or the divider) to the row; returns the function that removes it. */
  join(element: HTMLElement, size: number, scale: MotionValue<number>, shift: MotionValue<number>): () => void {
    const member: Member = { element, size, scale, shift, centre: 0 };
    this.members.add(member);
    this.measure();
    return () => {
      this.members.delete(member);
    };
  }

  /** Reads every member's resting centre. Call when the row's layout changes. */
  measure(): void {
    for (const member of this.members) {
      member.centre = member.element.offsetLeft + member.element.offsetWidth / 2;
    }
    this.apply();
  }

  /** The pointer is over the dock at x, relative to the row. */
  track(x: number): void {
    this.pointer = x;
    if (prefersReducedMotion()) return;
    if (this.presence.get() === 0 || this.presence.getVelocity() < 0) animate(this.presence, 1, springs.dock);
    this.apply();
  }

  /** The pointer left: everything settles back. */
  release(): void {
    animate(this.presence, 0, springs.dockSettle);
  }

  private apply(): void {
    const presence = Math.max(0, this.presence.get());
    const ordered = [...this.members].sort((a, b) => a.centre - b.centre);
    const extras = ordered.map((member) => {
      const distance = Math.abs(this.pointer - member.centre);
      // A raised cosine: flat at the pointer, flat again at REACH, so neighbours ease in and out.
      const falloff = distance >= REACH ? 0 : Math.cos((distance / REACH) * (Math.PI / 2)) ** 2;
      const scale = 1 + (MAX_SCALE - 1) * falloff * presence;
      member.scale.set(scale);
      return member.size * (scale - 1);
    });
    const total = extras.reduce((sum, extra) => sum + extra, 0);
    let before = 0;
    ordered.forEach((member, index) => {
      const extra = extras[index]!;
      // Each icon moves by the growth to its left plus half its own, less half the row's, which keeps the row centred.
      member.shift.set(before + extra / 2 - total / 2);
      before += extra;
    });
    this.spread.set(total);
  }
}
