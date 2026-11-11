/**
 * Contour lines for the wallpaper. A fixed, seeded height field (a few soft
 * hills) is traced with marching squares into one SVG path per line weight.
 * Everything is deterministic, so the desktop looks the same on every load.
 */

export interface ContourMap {
  width: number;
  height: number;
  /** Every contour that is not an index line. */
  minor: string;
  /** Every fourth contour, drawn heavier like the index lines of a survey map. */
  major: string;
  /** Hill tops, labelled with their spot height. */
  summits: Array<{ x: number; y: number; height: number }>;
}

interface Hill {
  x: number;
  y: number;
  radius: number;
  height: number;
}

/** Hills in units of the drawing height, so they stay round at any aspect ratio. */
const HILLS: Hill[] = [
  { x: 0.34, y: 0.3, radius: 0.34, height: 1.0 },
  { x: 1.38, y: 0.72, radius: 0.4, height: 0.92 },
  { x: 1.02, y: 0.12, radius: 0.24, height: 0.55 },
  { x: 0.1, y: 0.92, radius: 0.3, height: 0.6 },
  { x: 1.72, y: 0.14, radius: 0.22, height: 0.5 },
  { x: 0.78, y: 0.78, radius: 0.2, height: -0.35 },
];

const LEVELS = 17;
const MAJOR_EVERY = 4;
/** Grid cell in drawing units. 15 keeps curves smooth and the path small. */
const CELL = 15;

function heightAt(px: number, py: number, height: number): number {
  const x = px / height;
  const y = py / height;
  // A slow ripple keeps the lines from being perfect ellipses.
  let value = 0.07 * Math.sin(x * 5.1 + y * 2.3) + 0.05 * Math.cos(y * 7.3 - x * 3.7);
  for (const hill of HILLS) {
    const dx = x - hill.x;
    const dy = y - hill.y;
    value += hill.height * Math.exp(-(dx * dx + dy * dy) / (hill.radius * hill.radius));
  }
  return value;
}

const round = (n: number): string => (Math.round(n * 10) / 10).toString();

export function buildContours(width = 1920, height = 1080): ContourMap {
  const columns = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const field: number[][] = [];
  let low = Infinity;
  let high = -Infinity;
  for (let row = 0; row <= rows; row += 1) {
    const line: number[] = [];
    for (let column = 0; column <= columns; column += 1) {
      const value = heightAt(column * CELL, row * CELL, height);
      line.push(value);
      if (value < low) low = value;
      if (value > high) high = value;
    }
    field.push(line);
  }

  const minor: string[] = [];
  const major: string[] = [];
  for (let level = 1; level < LEVELS; level += 1) {
    const threshold = low + ((high - low) * level) / LEVELS;
    const out = level % MAJOR_EVERY === 0 ? major : minor;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const tl = field[row]![column]!;
        const tr = field[row]![column + 1]!;
        const br = field[row + 1]![column + 1]!;
        const bl = field[row + 1]![column]!;
        const kind = (tl > threshold ? 8 : 0) | (tr > threshold ? 4 : 0) | (br > threshold ? 2 : 0) | (bl > threshold ? 1 : 0);
        if (kind === 0 || kind === 15) continue;
        const x = column * CELL;
        const y = row * CELL;
        // Where the contour crosses each edge of the cell.
        const top = `${round(x + (CELL * (threshold - tl)) / (tr - tl))} ${round(y)}`;
        const right = `${round(x + CELL)} ${round(y + (CELL * (threshold - tr)) / (br - tr))}`;
        const bottom = `${round(x + (CELL * (threshold - bl)) / (br - bl))} ${round(y + CELL)}`;
        const left = `${round(x)} ${round(y + (CELL * (threshold - tl)) / (bl - tl))}`;
        const segment = (a: string, b: string) => out.push(`M${a}L${b}`);
        switch (kind) {
          case 1:
          case 14:
            segment(left, bottom);
            break;
          case 2:
          case 13:
            segment(bottom, right);
            break;
          case 3:
          case 12:
            segment(left, right);
            break;
          case 4:
          case 11:
            segment(top, right);
            break;
          case 6:
          case 9:
            segment(top, bottom);
            break;
          case 7:
          case 8:
            segment(left, top);
            break;
          case 5:
            segment(left, top);
            segment(bottom, right);
            break;
          case 10:
            segment(left, bottom);
            segment(top, right);
            break;
        }
      }
    }
  }

  // Label the real tops of the field: grid points higher than all eight
  // neighbours, well up the range and clear of the screen edges and the dock.
  const summits: ContourMap['summits'] = [];
  const edge = Math.ceil(90 / CELL);
  for (let row = edge; row <= rows - edge * 2; row += 1) {
    for (let column = edge; column <= columns - edge; column += 1) {
      const value = field[row]![column]!;
      if (value < low + (high - low) * 0.5) continue;
      let top = true;
      for (let dy = -1; dy <= 1 && top; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if ((dx !== 0 || dy !== 0) && field[row + dy]![column + dx]! >= value) top = false;
        }
      }
      if (top) summits.push({ x: column * CELL, y: row * CELL, height: Math.round(value * 400) });
    }
  }

  return { width, height, minor: minor.join(''), major: major.join(''), summits };
}
