/**
 * The terminal's colours. Paper, ink, the cursor and the status colours are
 * read from the design tokens, so the terminal follows tokens.css; the rest of
 * the sixteen ANSI colours are tuned here to sit beside them in each theme.
 */
import type { ITheme } from '@xterm/xterm';
import type { Theme } from '../../lib/theme';

/** The ANSI colours that have no token of their own. */
const ANSI: Record<Theme, Pick<ITheme, 'black' | 'blue' | 'magenta' | 'cyan' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan'>> = {
  light: {
    black: '#1b1a17',
    blue: '#2a5db0',
    magenta: '#8a3a9e',
    cyan: '#0c6f7e',
    brightRed: '#d8442a',
    brightGreen: '#1f8a5b',
    brightYellow: '#a06a08',
    brightBlue: '#3b74cc',
    brightMagenta: '#a44fb8',
    brightCyan: '#16879a',
  },
  dark: {
    black: '#2b3039',
    blue: '#6ea8f7',
    magenta: '#c58af0',
    cyan: '#4fc3d0',
    brightRed: '#ff8f7d',
    brightGreen: '#6bd9a6',
    brightYellow: '#f2c263',
    brightBlue: '#95c2ff',
    brightMagenta: '#d9abf9',
    brightCyan: '#80dde7',
  },
};

const MODERN_RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?)\s*)?\)$/;

/**
 * A token's value in a form xterm's colour parser reads. Tokens are written
 * as hex or as `rgb(r g b / a)`; xterm only knows hex and the comma form.
 */
function token(style: CSSStyleDeclaration, name: string): string {
  const value = style.getPropertyValue(name).trim();
  const parts = MODERN_RGB.exec(value);
  if (!parts) return value;
  const [, r, g, b, a] = parts;
  if (a === undefined) return `rgb(${r}, ${g}, ${b})`;
  const alpha = a.endsWith('%') ? Number(a.slice(0, -1)) / 100 : Number(a);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The xterm theme for the theme that is on <html> right now. */
export function terminalTheme(theme: Theme): ITheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => token(style, name);
  return {
    background: read('--surface'),
    foreground: read('--ink'),
    cursor: read('--accent'),
    cursorAccent: read('--surface'),
    selectionBackground: read('--selection'),
    selectionInactiveBackground: read('--pressed'),
    scrollbarSliderBackground: read('--hairline-strong'),
    scrollbarSliderHoverBackground: read('--ink-faint'),
    scrollbarSliderActiveBackground: read('--ink-muted'),
    red: read('--danger'),
    green: read('--success-ink'),
    yellow: read('--warning'),
    white: read('--ink-muted'),
    brightBlack: read('--ink-faint'),
    brightWhite: read('--ink-soft'),
    ...ANSI[theme],
  };
}
