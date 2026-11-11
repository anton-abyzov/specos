/**
 * Where each window sits in the overview: the windows of a desktop scaled
 * into a tidy grid, with minimised ones in a smaller row underneath. The
 * windows layer uses it to move the live windows, and the overview uses the
 * same rectangles for the titles and click targets on top of them.
 */
import { DESKTOP_COUNT } from '../../stores/shell';
import type { Rect, Size } from './geometry';
import type { WindowState } from './store';

export interface OverviewTile {
  id: string;
  /** The scaled window, in the windows layer's coordinates. */
  rect: Rect;
  scale: number;
  minimized: boolean;
}

/** Top of the grid: the room the desktops strip takes, measured from the top of the layer. */
const GRID_TOP = 148;
const GRID_SIDE = 112;
const GRID_BOTTOM = 56;
const GAP_X = 48;
/** Vertical gap between rows; each title sits in it. */
const GAP_Y = 72;

/** The row of minimised windows: small, at the bottom, under its own caption. */
const SHELF_HEIGHT = 92;
const SHELF_MAX_WIDTH = 168;
const SHELF_GAP = 40;
/** From the bottom of the layer to the bottom of the row; the titles sit below it. */
const SHELF_BOTTOM = 64;
/** What the grid gives up for the row: its caption, the row and the titles of the grid's last row above it. */
const SHELF_ROOM = SHELF_HEIGHT + 96;

/** A window never grows in the overview; a lone small window stays its own size. */
const MAX_SCALE = 1;

function grid(windows: WindowState[], area: Rect): OverviewTile[] {
  const count = windows.length;
  if (count === 0) return [];

  // Try every column count and keep the one that leaves the windows largest.
  let best = { columns: 1, scale: 0 };
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const cellW = (area.w - GAP_X * (columns - 1)) / columns;
    const cellH = (area.h - GAP_Y * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    const scale = Math.min(...windows.map((win) => Math.min(cellW / win.bounds.w, cellH / win.bounds.h, MAX_SCALE)));
    if (scale > best.scale) best = { columns, scale };
  }

  const { columns } = best;
  const rows = Math.ceil(count / columns);
  const cellW = (area.w - GAP_X * (columns - 1)) / columns;
  const cellH = (area.h - GAP_Y * (rows - 1)) / rows;
  return windows.map((win, index) => {
    const row = Math.floor(index / columns);
    const inRow = row === rows - 1 ? count - columns * (rows - 1) : columns;
    // A short last row is centred under the others.
    const rowLeft = area.x + (area.w - (inRow * cellW + (inRow - 1) * GAP_X)) / 2;
    const cellX = rowLeft + (index - row * columns) * (cellW + GAP_X);
    const cellY = area.y + row * (cellH + GAP_Y);
    const scale = Math.min(cellW / win.bounds.w, cellH / win.bounds.h, MAX_SCALE);
    const w = win.bounds.w * scale;
    const h = win.bounds.h * scale;
    return {
      id: win.id,
      scale,
      minimized: false,
      rect: { x: cellX + (cellW - w) / 2, y: cellY + (cellH - h) / 2, w, h },
    };
  });
}

function shelf(windows: WindowState[], view: Size): OverviewTile[] {
  const sized = windows.map((win) => {
    const scale = Math.min(SHELF_HEIGHT / win.bounds.h, SHELF_MAX_WIDTH / win.bounds.w);
    return { win, scale, w: win.bounds.w * scale, h: win.bounds.h * scale };
  });
  const total = sized.reduce((sum, tile) => sum + tile.w, 0) + SHELF_GAP * (sized.length - 1);
  let x = (view.w - total) / 2;
  const bottom = view.h - SHELF_BOTTOM;
  return sized.map(({ win, scale, w, h }) => {
    const tile = { id: win.id, scale, minimized: true, rect: { x, y: bottom - h, w, h } };
    x += w + SHELF_GAP;
    return tile;
  });
}

/** The overview tiles of one desktop, in the order the arrow keys walk them. */
export function overviewTiles(windows: Record<string, WindowState>, desktop: number, view: Size): OverviewTile[] {
  const onDesktop = Object.values(windows)
    .filter((win) => win.desktop === desktop)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const open = onDesktop.filter((win) => win.mode !== 'minimized');
  const minimized = onDesktop.filter((win) => win.mode === 'minimized');
  const area: Rect = {
    x: GRID_SIDE,
    y: GRID_TOP,
    w: view.w - GRID_SIDE * 2,
    h: view.h - GRID_TOP - GRID_BOTTOM - (minimized.length > 0 ? SHELF_ROOM : 0),
  };
  return [...grid(open, area), ...shelf(minimized, view)];
}

/** Tiles for every desktop, so the grid is already in place when the stage slides to another one. */
export function allOverviewTiles(windows: Record<string, WindowState>, view: Size): Map<string, OverviewTile> {
  const tiles = new Map<string, OverviewTile>();
  for (let desktop = 0; desktop < DESKTOP_COUNT; desktop += 1) {
    for (const tile of overviewTiles(windows, desktop, view)) tiles.set(tile.id, tile);
  }
  return tiles;
}
