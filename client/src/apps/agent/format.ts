import type { AgentInfo, AgentStatus, ChangeKind, Workspace } from '@shared/protocol';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  starting: 'starting',
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  add: 'added',
  change: 'changed',
  unlink: 'removed',
  addDir: 'added',
  unlinkDir: 'removed',
};

/** 0:07, 1:23, 1:02:45. Whole seconds, so the digits only move once a second. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Clone time the way a person reads it: 38 ms, 4.2 ms, 1.3 s. */
export function formatCloneMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${ms >= 10 ? Math.round(ms) : ms.toFixed(1)} ms`;
}

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A file below a workspace, without the workspace in front. */
export function pathInWorkspace(path: string, workspace: Workspace): string {
  return path.startsWith(workspace.path + '/') ? path.slice(workspace.path.length + 1) : path;
}

/** The prompt on one line, cut for a title. */
export function shortPrompt(prompt: string, max = 48): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}

/** A project path as its folder name. */
export const projectName = (project: string): string => project.replace(/^Projects\//, '');

/** A follow-up works in the copy its first job made; only that first job cloned anything. */
export const madeWorkspace = (agent: AgentInfo): boolean => agent.continues === undefined;
