import { hashSeed } from '../color';

export interface Sigil {
  /** A polyline through lattice points, as an SVG path on the 64 unit icon grid. */
  path: string;
  /** The filled dot that starts the stroke. */
  start: { x: number; y: number };
  /** A second, free-standing dot. */
  mark: { x: number; y: number };
}

/** The 3 by 3 lattice a sigil is drawn on, inside the icon tile. */
const LATTICE = [20, 32, 44] as const;

/** Small deterministic generator (mulberry32) so a seed always draws the same sigil. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An agent's sigil: one stroke through four or five points of a 3 by 3
 * lattice plus a dot, drawn from the agent id. 9 lattice points give
 * thousands of distinct marks, enough to tell a dock full of agents apart.
 */
export function sigilFor(seed: string): Sigil {
  const random = generator(hashSeed(seed));
  const points = LATTICE.flatMap((y) => LATTICE.map((x) => ({ x, y })));
  // Fisher-Yates with the seeded generator.
  for (let i = points.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [points[i], points[j]] = [points[j]!, points[i]!];
  }
  const strokeLength = 4 + Math.floor(random() * 2);
  const stroke = points.slice(0, strokeLength);
  const start = stroke[0]!;
  const mark = points[strokeLength]!;
  const path = stroke.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join('');
  return { path, start, mark };
}
