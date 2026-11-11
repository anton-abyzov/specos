import { create } from 'zustand';
import type { SystemInfo, SystemStats } from '@shared/protocol';

/** How many stats samples are kept for sparklines: two minutes at one every 2 s. */
export const STATS_HISTORY = 60;

interface SystemState {
  /** Machine facts from the socket's hello frame; null until the first one. */
  info: SystemInfo | null;
  /** The latest stats tick. */
  stats: SystemStats | null;
  /** The last STATS_HISTORY ticks, oldest first. */
  history: SystemStats[];
  setInfo(info: SystemInfo): void;
  pushStats(stats: SystemStats): void;
}

export const useSystemStore = create<SystemState>((set) => ({
  info: null,
  stats: null,
  history: [],
  setInfo: (info) => set({ info }),
  pushStats: (stats) =>
    set((state) => ({
      stats,
      history: [...state.history.slice(-(STATS_HISTORY - 1)), stats],
    })),
}));
