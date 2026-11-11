/**
 * Colour helpers. An agent is one hue everywhere (dock, menu bar, Files,
 * Activity); these helpers turn that hue into the handful of colours the UI
 * uses, so no component invents its own.
 */
import type { CSSProperties } from 'react';
import type { Theme } from '../lib/theme';

export interface AgentPalette {
  /** Tile and badge fill. */
  solid: string;
  /** The deep end of the tile gradient, and pressed states. */
  deep: string;
  /** The light end of the tile gradient. */
  bright: string;
  /** Text and line colour on the theme's surfaces (AA on paper and night). */
  text: string;
  /** Quiet background for rows, chips and highlights. */
  soft: string;
  /** Hairline in the agent's colour. */
  border: string;
  /** Pulse ring around a running agent. */
  ring: string;
  /** Text and glyph colour on top of `solid`. */
  onSolid: string;
}

const clampHue = (hue: number): number => ((Math.round(hue) % 360) + 360) % 360;
const oklch = (l: number, c: number, h: number, alpha = 1): string =>
  alpha === 1 ? `oklch(${l} ${c} ${h})` : `oklch(${l} ${c} ${h} / ${alpha})`;

/** Lightness and chroma per theme; only the hue changes between agents. */
const RECIPES: Record<Theme, (h: number) => AgentPalette> = {
  light: (h) => ({
    solid: oklch(0.6, 0.15, h),
    deep: oklch(0.48, 0.15, h),
    bright: oklch(0.72, 0.13, h),
    text: oklch(0.44, 0.14, h),
    soft: oklch(0.6, 0.15, h, 0.13),
    border: oklch(0.6, 0.15, h, 0.36),
    ring: oklch(0.6, 0.17, h, 0.6),
    onSolid: '#fffdf8',
  }),
  dark: (h) => ({
    solid: oklch(0.66, 0.15, h),
    deep: oklch(0.5, 0.15, h),
    bright: oklch(0.78, 0.13, h),
    text: oklch(0.8, 0.12, h),
    soft: oklch(0.72, 0.14, h, 0.17),
    border: oklch(0.72, 0.14, h, 0.4),
    ring: oklch(0.76, 0.16, h, 0.65),
    onSolid: '#fffdf8',
  }),
};

/** The agent's palette for one named theme, as plain oklch strings. */
export function agentPalette(hue: number, theme: Theme): AgentPalette {
  return RECIPES[theme](clampHue(hue));
}

/**
 * The agent's palette as theme-aware CSS colours: each value is a
 * `light-dark()` pair, so it follows data-theme without a re-render. Use these
 * in style props and SVG presentation styles.
 */
export function agentColor(hue: number): AgentPalette {
  const light = agentPalette(hue, 'light');
  const dark = agentPalette(hue, 'dark');
  const keys = Object.keys(light) as Array<keyof AgentPalette>;
  return Object.fromEntries(keys.map((key) => [key, `light-dark(${light[key]}, ${dark[key]})`])) as unknown as AgentPalette;
}

/**
 * The same palette as CSS custom properties (--agent-solid, --agent-text,
 * --agent-soft ...). Spread it into a style prop and let a stylesheet use it.
 */
export function agentVars(hue: number): CSSProperties {
  const palette = agentColor(hue);
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(palette)) {
    vars[`--agent-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`] = value;
  }
  return vars as CSSProperties;
}

/** A stable hue for anything that has an id but no hue of its own. */
export function hueFromSeed(seed: string): number {
  return hashSeed(seed) % 360;
}

/** FNV-1a, 32 bit. Small, stable and good enough to spread ids over hues and sigils. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Each app's own colour, used for its icon tile and small accents inside it.
 * Chosen to sit together on paper: no two neighbours in the dock share a hue.
 */
export const APP_COLORS = {
  files: 'oklch(0.72 0.135 78)',
  terminal: 'oklch(0.36 0.018 265)',
  editor: 'oklch(0.56 0.15 256)',
  chat: 'oklch(0.63 0.2 33)',
  agents: 'oklch(0.54 0.17 302)',
  activity: 'oklch(0.6 0.13 162)',
  system: 'oklch(0.52 0.075 218)',
  agent: 'oklch(0.6 0.15 200)',
} as const;
