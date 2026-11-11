/**
 * The interface glyph set: 16px line drawings on one grid, one stroke weight
 * (1.5) and round joins, so any two of them sit together. Documents carry the
 * clipped corner that runs through the whole identity.
 */
import type { ReactNode, SVGProps } from 'react';

/** The document outline with the clipped top-right corner. */
const FILE = 'M4.5 2.5h5l3 3v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z';

const GLYPHS = {
  // Window controls
  minimise: <path d="M4 11.5h8" />,
  fullscreen: <path d="M3.5 7v-3.5H7M12.5 9v3.5H9" />,
  restore: <path d="M6.5 3v3.5H3M9.5 13V9.5H13" />,
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,

  // Direction
  'chevron-right': <path d="M6 3.5 10.5 8 6 12.5" />,
  'chevron-left': <path d="M10 3.5 5.5 8 10 12.5" />,
  'chevron-down': <path d="M3.5 6 8 10.5 12.5 6" />,
  'chevron-up': <path d="M3.5 10 8 5.5 12.5 10" />,
  'arrow-up': <path d="M8 13V3.5M4 7.5l4-4 4 4" />,
  'arrow-right': <path d="M3 8h9.5M8.5 4l4 4-4 4" />,
  external: <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" />,

  // Files
  folder: (
    <path d="M2.5 4.5a1 1 0 0 1 1-1h2.6L7.5 5h5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
  ),
  'folder-open': (
    <path d="M2.5 11V4.5a1 1 0 0 1 1-1h2.6L7.5 5h4a1 1 0 0 1 1 1v1M2.6 12.2 4.3 7.6a1 1 0 0 1 .9-.6h8.1a.7.7 0 0 1 .66.94l-1.5 4a1 1 0 0 1-.94.66H3.2a.65.65 0 0 1-.6-.4z" />
  ),
  file: <path d={FILE} />,
  'file-text': <path d={`${FILE}M6 8h4M6 10.5h4`} />,
  'file-code': <path d={`${FILE}M7 7.5 5.5 9.25 7 11M9 7.5l1.5 1.75L9 11`} />,
  'file-image': (
    <>
      <path d={`${FILE}M5 11.5 7 9.5 8.5 11l1-1 1.5 1.5`} />
      <circle cx="6.6" cy="6.6" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  'file-markdown': <path d={`${FILE}M5.75 11.25V8.25L8 10.5l2.25-2.25v3`} />,
  home: <path d="M2.5 7.5 8 2.75l5.5 4.75M4 6.5V12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6.5M6.75 13V9.5h2.5V13" />,
  trash: <path d="M3 4.5h10M6.5 4.5v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4.5l.5 7.6a1 1 0 0 0 1 .9h4a1 1 0 0 0 1-.9l.5-7.6M6.75 7v3.5M9.25 7v3.5" />,
  pencil: <path d="M3 13l.6-2.9 6.9-6.9a1.1 1.1 0 0 1 1.6 0l.7.7a1.1 1.1 0 0 1 0 1.6l-6.9 6.9zM9.5 4.25l2.25 2.25" />,
  save: <path d="M3.5 2.5h7l2 2v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM5.5 2.5v3h4v-3M5 13.5v-4h6v4" />,

  // Actions
  search: (
    <>
      <circle cx="7" cy="7" r="3.75" />
      <path d="M9.9 9.9 13 13" />
    </>
  ),
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  minus: <path d="M3.5 8h9" />,
  stop: <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.25" />,
  play: <path d="M5.5 3.9v8.2a.4.4 0 0 0 .6.34l6.6-4.1a.4.4 0 0 0 0-.68L6.1 3.56a.4.4 0 0 0-.6.34z" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.6-3.66M13 2.75v2.5h-2.5" />,
  send: <path d="M13.5 2.5 7 9M13.5 2.5 9.25 13.5 7 9 2.5 6.75z" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  eye: (
    <>
      <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" />
      <circle cx="8" cy="8" r="1.75" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.25v3.5" />
      <circle cx="8" cy="5.2" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),

  // Work
  merge: (
    <>
      <circle cx="4.5" cy="3.75" r="1.5" />
      <circle cx="4.5" cy="12.25" r="1.5" />
      <circle cx="11.5" cy="8" r="1.5" />
      <path d="M4.5 5.25v5.5M4.5 5.25C4.5 7.5 6.5 8 10 8" />
    </>
  ),
  branch: (
    <>
      <circle cx="4.5" cy="3.75" r="1.5" />
      <circle cx="4.5" cy="12.25" r="1.5" />
      <circle cx="11.5" cy="5" r="1.5" />
      <path d="M4.5 5.25v5.5M11.5 6.5c0 2.5-3 2.25-7 3.25" />
    </>
  ),
  diff: <path d="M8 2.5v5M5.5 5h5M5.5 11.5h5" />,
  agent: (
    <>
      <path d="M8 4.5 4 11.5h8z" />
      <circle cx="8" cy="4" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4" cy="11.75" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="11.75" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  terminal: <path d="M3 4.5 6.5 8 3 11.5M8.5 12H13" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  cpu: (
    <>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.25" />
      <path d="M6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2" />
    </>
  ),
  memory: (
    <>
      <rect x="2.5" y="4.5" width="11" height="6" rx="1" />
      <path d="M5.25 6.75v1.5M8 6.75v1.5M10.75 6.75v1.5M4.5 10.5v2M8 10.5v2M11.5 10.5v2" />
    </>
  ),
  disk: (
    <>
      <path d="M3.5 3h9l1 6.5v2.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V9.5zM2.5 9.5h11" />
      <circle cx="11" cy="11.25" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),

  // Shell
  sun: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
    </>
  ),
  moon: <path d="M13 9.6A5.5 5.5 0 0 1 6.4 3 5.5 5.5 0 1 0 13 9.6z" />,
  grid: (
    <>
      <rect x="2.75" y="2.75" width="4.25" height="4.25" rx="1" />
      <rect x="9" y="2.75" width="4.25" height="4.25" rx="1" />
      <rect x="2.75" y="9" width="4.25" height="4.25" rx="1" />
      <rect x="9" y="9" width="4.25" height="4.25" rx="1" />
    </>
  ),
  layout: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.25" />
      <path d="M8 3v10M8 8h5.5" />
    </>
  ),
  desktop: (
    <>
      <path d="M3.5 3h6.5l3.5 3.5v4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M6 13.5h4" />
    </>
  ),
} as const satisfies Record<string, ReactNode>;

export type GlyphName = keyof typeof GLYPHS;

export const GLYPH_NAMES = Object.keys(GLYPHS) as GlyphName[];

export interface GlyphProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: GlyphName;
  /** Rendered size in pixels; the drawing grid is always 16. */
  size?: number;
}

/** One interface glyph by name. Decorative by default: label the control, not the glyph. */
export function Glyph({ name, size = 16, ...rest }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {GLYPHS[name]}
    </svg>
  );
}
