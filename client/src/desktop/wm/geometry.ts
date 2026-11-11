/**
 * Pure geometry for the window manager. Every rectangle is in the windows
 * layer's own coordinates: the origin is the corner just under the menu bar,
 * so y = 0 can never be under it.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** Height of the menu bar; the windows layer starts right below it. Mirrors --menubar-height. */
export const MENUBAR_HEIGHT = 30;

/** Space kept free at the bottom for the dock when windows are placed for the user. */
export const DOCK_RESERVE = 88;

/** Gap between tiled or snapped windows, and between them and the screen edge. */
export const GUTTER = 8;

/** How much of a title bar must stay on screen, sideways and from the bottom. */
const REACH_X = 140;
const REACH_Y = 40;

/** New windows step down and right by this much so each title bar stays visible. */
const CASCADE_STEP = 28;

export const roundRect = (rect: Rect): Rect => ({
  x: Math.round(rect.x),
  y: Math.round(rect.y),
  w: Math.round(rect.w),
  h: Math.round(rect.h),
});

export const rectsEqual = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export const containsPoint = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;

/** Linear blend of two rectangles; t may overshoot 0..1, which is what gives a spring its bounce. */
export const mixRect = (from: Rect, to: Rect, t: number): Rect => ({
  x: from.x + (to.x - from.x) * t,
  y: from.y + (to.y - from.y) * t,
  w: from.w + (to.w - from.w) * t,
  h: from.h + (to.h - from.h) * t,
});

/** The whole layer: what a full screen window fills. */
export const fullRect = (view: Size): Rect => ({ x: 0, y: 0, w: view.w, h: view.h });

/** The part of the layer that tiled and snapped windows share: inside the gutters, above the dock. */
export const workArea = (view: Size): Rect => ({
  x: GUTTER,
  y: GUTTER,
  w: Math.max(0, view.w - GUTTER * 2),
  h: Math.max(0, view.h - DOCK_RESERVE - GUTTER * 2),
});

/**
 * Keeps a window where its title bar can still be grabbed: never above the
 * layer (that is under the menu bar), never so far out that the bar is gone.
 * The size is left alone.
 */
export function keepReachable(rect: Rect, view: Size): Rect {
  const reachX = Math.min(REACH_X, rect.w);
  return {
    ...rect,
    x: Math.min(view.w - reachX, Math.max(reachX - rect.w, rect.x)),
    y: Math.min(Math.max(0, view.h - REACH_Y), Math.max(0, rect.y)),
  };
}

/**
 * Brings a window wholly into view where it fits, for a viewport that got
 * smaller. A window larger than the viewport is shrunk to it, down to minSize.
 */
export function fitInView(rect: Rect, view: Size, min: Size): Rect {
  const w = Math.max(Math.min(rect.w, view.w), Math.min(min.w, rect.w));
  const h = Math.max(Math.min(rect.h, view.h), Math.min(min.h, rect.h));
  return {
    x: Math.max(0, Math.min(rect.x, view.w - w)),
    y: Math.max(0, Math.min(rect.y, view.h - h)),
    w,
    h,
  };
}

/**
 * Where a new window opens. The first one is centred in the space above the
 * dock, a little above the middle. The next ones cascade from `front` (the
 * free-floating window in front), one step down and right, so every title bar
 * stays visible; when the cascade runs out of room it starts again near the
 * top-left corner.
 */
export function placeNew(size: Size, view: Size, front: Rect | null, taken: Rect[]): Rect {
  const available = Math.max(0, view.h - DOCK_RESERVE);
  const w = Math.min(size.w, Math.max(240, view.w - GUTTER * 4));
  const h = Math.min(size.h, Math.max(160, available - GUTTER * 4));
  const fits = (x: number, y: number) => x >= GUTTER && y >= GUTTER && x + w <= view.w - GUTTER && y + h <= available;
  const occupied = (x: number, y: number) =>
    taken.some((rect) => Math.abs(rect.x - x) < CASCADE_STEP / 2 && Math.abs(rect.y - y) < CASCADE_STEP / 2);

  let x = Math.round((view.w - w) / 2);
  let y = Math.max(GUTTER * 2, Math.round((available - h) * 0.4));
  if (front) {
    const next = { x: front.x + CASCADE_STEP, y: front.y + CASCADE_STEP };
    [x, y] = fits(next.x, next.y) ? [next.x, next.y] : [GUTTER * 4, GUTTER * 4];
  }
  // Bounded: on a desk this crowded a window may land on another one's corner.
  for (let step = 0; step < 24 && occupied(x, y) && fits(x + CASCADE_STEP, y + CASCADE_STEP); step += 1) {
    x += CASCADE_STEP;
    y += CASCADE_STEP;
  }
  return keepReachable({ x, y, w, h }, view);
}

/** Which edges a resize handle moves. */
export interface ResizeEdges {
  n?: boolean;
  s?: boolean;
  e?: boolean;
  w?: boolean;
}

/**
 * The rectangle after dragging a resize handle by (dx, dy). The opposite edge
 * stays put, the size never goes under `min`, and the top never goes above the layer.
 */
export function resizeRect(start: Rect, edges: ResizeEdges, dx: number, dy: number, min: Size, view: Size): Rect {
  let { x, y, w, h } = start;
  const right = start.x + start.w;
  const bottom = start.y + start.h;

  if (edges.e) w = Math.max(min.w, start.w + dx);
  if (edges.w) {
    w = Math.max(min.w, start.w - dx);
    x = right - w;
  }
  if (edges.s) h = Math.max(min.h, Math.min(start.h + dy, view.h - start.y));
  if (edges.n) {
    const top = Math.max(0, Math.min(start.y + dy, bottom - min.h));
    h = bottom - top;
    y = top;
  }
  return { x, y, w, h };
}

/** Where a window can snap: a half, a quarter, or the whole screen. */
export type SnapZone = 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'full';

/** The pointer must come this close to a side edge for a half, or to the top for full screen. */
const EDGE_REACH = 12;
/** ...and this close to both edges of a corner for a quarter. */
const CORNER_REACH = 80;

/** The snap zone under the pointer, or null when it is not near an edge. */
export function zoneAt(x: number, y: number, view: Size): SnapZone | null {
  const left = x <= CORNER_REACH;
  const right = x >= view.w - CORNER_REACH;
  const top = y <= CORNER_REACH;
  const bottom = y >= view.h - CORNER_REACH;
  if (top && left) return 'top-left';
  if (top && right) return 'top-right';
  if (bottom && left) return 'bottom-left';
  if (bottom && right) return 'bottom-right';
  if (x <= EDGE_REACH) return 'left';
  if (x >= view.w - EDGE_REACH) return 'right';
  if (y <= EDGE_REACH) return 'full';
  return null;
}

/** Splits a length into two parts with a gutter between them. */
const halves = (start: number, length: number): [first: [number, number], second: [number, number]] => {
  const first = Math.floor((length - GUTTER) / 2);
  return [
    [start, first],
    [start + first + GUTTER, length - first - GUTTER],
  ];
};

/** The rectangle a snap zone stands for. Halves and quarters stay inside the work area. */
export function snapRect(zone: SnapZone, view: Size): Rect {
  if (zone === 'full') return fullRect(view);
  const area = workArea(view);
  const [leftCol, rightCol] = halves(area.x, area.w);
  const [topRow, bottomRow] = halves(area.y, area.h);
  const [x, w] = zone === 'left' || zone.endsWith('-left') ? leftCol : rightCol;
  if (zone === 'left' || zone === 'right') return { x, y: area.y, w, h: area.h };
  const [y, h] = zone.startsWith('top') ? topRow : bottomRow;
  return { x, y, w, h };
}

/** Share of the width the main window takes when three to five windows are tiled. */
const MAIN_SHARE = 0.58;

/** Splits a length into `count` parts with gutters; the last part takes the rounding remainder. */
function spans(start: number, length: number, count: number): Array<[number, number]> {
  const size = Math.floor((length - GUTTER * (count - 1)) / count);
  return Array.from({ length: count }, (_, index) => {
    const offset = start + index * (size + GUTTER);
    return [offset, index === count - 1 ? start + length - offset : size];
  });
}

/**
 * Rectangles for `count` tiled windows, in order: one fills the work area, two
 * split it, three to five put the first in a main area on the left with the
 * rest stacked on the right, and more than five form a grid.
 */
export function tileRects(count: number, view: Size): Rect[] {
  const area = workArea(view);
  if (count <= 0) return [];
  if (count === 1) return [area];

  if (count <= 5) {
    const mainW = count === 2 ? Math.floor((area.w - GUTTER) / 2) : Math.round((area.w - GUTTER) * MAIN_SHARE);
    const sideX = area.x + mainW + GUTTER;
    const sideW = area.w - mainW - GUTTER;
    return [
      { x: area.x, y: area.y, w: mainW, h: area.h },
      ...spans(area.y, area.h, count - 1).map(([y, h]) => ({ x: sideX, y, w: sideW, h })),
    ];
  }

  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const rects: Rect[] = [];
  spans(area.y, area.h, rows).forEach(([y, h], row) => {
    // The last row may hold fewer windows; they widen to fill it.
    const inRow = row === rows - 1 ? count - columns * (rows - 1) : columns;
    for (const [x, w] of spans(area.x, area.w, inRow)) rects.push({ x, y, w, h });
  });
  return rects;
}
