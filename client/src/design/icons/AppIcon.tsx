/**
 * App icons. Every icon is the same tile: a rounded square with the top-right
 * corner clipped, a quiet gradient in the app's own colour and a line glyph
 * drawn on a 64 unit grid with a 3 unit stroke.
 */
import { memo, useId, useMemo, type ReactNode } from 'react';
import { APP_COLORS, agentColor } from '../color';
import { sigilFor } from './sigil';
import './icons.css';

export type AppIconId = keyof typeof APP_COLORS;

/** The tile outline: 12 unit corners, 17 unit clip at the top right. */
export const TILE_PATH = 'M15 3H44L61 20V49A12 12 0 0 1 49 61H15A12 12 0 0 1 3 49V15A12 12 0 0 1 15 3Z';

const INK = '#fffdf8';

/** Line glyphs for the seven apps, in tile ink. */
const APP_GLYPHS: Record<Exclude<AppIconId, 'agent'>, ReactNode> = {
  files: (
    <>
      <path d="M17 24.5a3 3 0 0 1 3-3h7.2l4.3 4.5H44a3 3 0 0 1 3 3V42a3 3 0 0 1-3 3H20a3 3 0 0 1-3-3z" />
      <path d="M24 35.5h16" opacity="0.6" />
    </>
  ),
  terminal: (
    <>
      <path d="M19 23.5 28.5 32 19 40.5" />
      <path d="M33 41.5h12" stroke="#ff6a4d" />
    </>
  ),
  editor: (
    <>
      <path d="M18 23h15M18 32h10M18 41h13" opacity="0.6" />
      <path d="M38 20h8M42 20v24M38 44h8" />
    </>
  ),
  chat: (
    <>
      <path d="M17 24a3 3 0 0 1 3-3h20l7 7v11a3 3 0 0 1-3 3H31l-7.5 6v-6H20a3 3 0 0 1-3-3z" />
      <path d="M24 29.5h10M24 35.5h15" opacity="0.6" />
    </>
  ),
  agents: (
    <>
      <path d="M32 21 20 42h24z" opacity="0.6" />
      <circle cx="32" cy="21" r="4.25" fill={INK} stroke="none" />
      <circle cx="20" cy="42" r="4.25" fill={INK} stroke="none" />
      <circle cx="44" cy="42" r="4.25" fill={INK} stroke="none" />
    </>
  ),
  activity: (
    <>
      <path d="M16 34h8l4.5-12 7 22 4.5-10h8" />
    </>
  ),
  system: (
    <>
      <rect x="22" y="22" width="20" height="20" rx="3.5" />
      <path d="M28 16v6M36 16v6M28 42v6M36 42v6M16 28h6M16 36h6M42 28h6M42 36h6" opacity="0.6" />
      <rect x="28.5" y="28.5" width="7" height="7" rx="1.5" fill={INK} stroke="none" />
    </>
  ),
};

interface TileProps {
  size: number;
  /** Stops of the tile gradient, top-left to bottom-right. */
  from: string;
  to: string;
  className?: string;
  /** Drawn behind the tile, for the running ring. */
  backdrop?: ReactNode;
  children: ReactNode;
}

function Tile({ size, from, to, className, backdrop, children }: TileProps) {
  const id = useId();
  const fill = `${id}-fill`;
  const sheen = `${id}-sheen`;
  return (
    <svg
      className={className ? `app-icon ${className}` : 'app-icon'}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={fill} x1="8" y1="4" x2="56" y2="62" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: from }} />
          <stop offset="1" style={{ stopColor: to }} />
        </linearGradient>
        <linearGradient id={sheen} x1="32" y1="3" x2="32" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.3" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {backdrop}
      <path d={TILE_PATH} fill={`url(#${fill})`} />
      <path d={TILE_PATH} fill={`url(#${sheen})`} />
      {/* A lit inner edge and a dark outer hairline give the tile a physical rim. */}
      <path d={TILE_PATH} stroke="#000" strokeOpacity="0.2" strokeWidth="1" />
      <path
        d="M15 4.5H43.4L59.5 20.6V49A10.5 10.5 0 0 1 49 59.5H15A10.5 10.5 0 0 1 4.5 49V15A10.5 10.5 0 0 1 15 4.5Z"
        stroke="#fff"
        strokeOpacity="0.26"
        strokeWidth="1"
      />
      <g stroke={INK} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </g>
    </svg>
  );
}

export interface AgentIconProps {
  /** AgentInfo.hue, 0 to 359. */
  hue: number;
  /** The agent id; the sigil is drawn from it. */
  seed: string;
  /** Shows the soft pulsing ring. */
  running?: boolean;
  size?: number;
}

/** An agent's icon: its hue on the tile, its sigil as the glyph. */
export const AgentIcon = memo(function AgentIcon({ hue, seed, running = false, size = 48 }: AgentIconProps) {
  const color = agentColor(hue);
  const sigil = useMemo(() => sigilFor(seed), [seed]);
  return (
    <Tile
      size={size}
      from={color.bright}
      to={color.deep}
      className={running ? 'app-icon--running' : undefined}
      backdrop={
        running ? <path className="app-icon__ring" d={TILE_PATH} style={{ stroke: color.ring }} strokeWidth="3" /> : null
      }
    >
      <path d={sigil.path} />
      <circle cx={sigil.start.x} cy={sigil.start.y} r="4" fill={INK} stroke="none" />
      <circle cx={sigil.mark.x} cy={sigil.mark.y} r="2.5" fill={INK} stroke="none" opacity="0.7" />
    </Tile>
  );
});

export type AppIconProps =
  | { id: Exclude<AppIconId, 'agent'>; size?: number }
  | ({ id: 'agent' } & Partial<AgentIconProps>);

/** Any app's icon by id. The 'agent' icon takes hue, seed and running. */
export const AppIcon = memo(function AppIcon(props: AppIconProps) {
  if (props.id === 'agent') {
    return <AgentIcon hue={props.hue ?? 200} seed={props.seed ?? 'agent'} running={props.running} size={props.size} />;
  }
  const color = APP_COLORS[props.id];
  return (
    <Tile
      size={props.size ?? 48}
      from={`color-mix(in oklch, ${color}, white 20%)`}
      to={`color-mix(in oklch, ${color}, black 16%)`}
    >
      {APP_GLYPHS[props.id]}
    </Tile>
  );
});
