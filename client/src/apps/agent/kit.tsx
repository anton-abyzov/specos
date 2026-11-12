/**
 * The small pieces every agent surface is built from, so an agent looks the
 * same in Chat, in the Agents list and in its own window.
 */
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { AgentInfo, AgentStatus, ChangeKind, Workspace } from '@shared/protocol';
import { Glyph, type GlyphName } from '../../design/icons';
import { isAgentActive } from '../../stores/agents';
import { CHANGE_LABEL, STATUS_LABEL, baseName, formatCloneMs, formatElapsed } from './format';
import './kit.css';

/** The current time, moving once a second while `ticking`. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

export function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span className="ak-status" data-status={status} data-testid="agent-status">
      <span className="ak-status__dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Time at work: ticking while the job runs, its final duration after. */
export function Elapsed({ agent }: { agent: AgentInfo }) {
  const active = isAgentActive(agent);
  const now = useNow(active);
  const end = active ? Math.max(now, agent.startedAt) : (agent.endedAt ?? agent.startedAt);
  return (
    <time className="ak-elapsed tabular" data-testid="agent-elapsed" aria-label="Time at work">
      {formatElapsed(end - agent.startedAt)}
    </time>
  );
}

interface FileChipProps {
  path: string;
  change: ChangeKind;
  count: number;
  /** Shown in place of the file name, for example a path inside the workspace. */
  label?: string;
  onOpen(path: string): void;
}

/** One touched file. A file that is gone cannot be opened, so its chip is plain text. */
export function FileChip({ path, change, count, label, onOpen }: FileChipProps) {
  const gone = change === 'unlink' || change === 'unlinkDir';
  return (
    <button
      type="button"
      className="ak-chip ak-chip--file"
      data-testid="file-chip"
      data-path={path}
      data-change={change}
      title={gone ? path : `Open ${path} in the Editor`}
      disabled={gone}
      onClick={() => onOpen(path)}
    >
      <Glyph name="file-text" size={13} />
      <span className="ak-chip__name">{label ?? baseName(path)}</span>
      <span className="ak-chip__kind">{CHANGE_LABEL[change]}</span>
      {count > 1 && (
        <span className="ak-chip__count tabular" key={count} data-testid="file-chip-count">
          ×{count}
        </span>
      )}
    </button>
  );
}

/** The agent's own copy of the project: its name and how it was made. Opens in Files. */
export function WorkspaceChip({ workspace, onOpen }: { workspace: Workspace; onOpen(workspace: Workspace): void }) {
  return (
    <button
      type="button"
      className="ak-chip ak-chip--workspace"
      data-testid="workspace-chip"
      title={`Open ${workspace.path} in Files`}
      onClick={() => onOpen(workspace)}
    >
      <Glyph name="branch" size={13} />
      <span className="ak-chip__name">{workspace.name}</span>
      <span className="ak-chip__kind">
        {workspace.clone.strategy} {formatCloneMs(workspace.clone.ms)}
      </span>
      {workspace.status !== 'active' && <span className="ak-chip__kind">{workspace.status}</span>}
    </button>
  );
}

interface ToolButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  glyph: GlyphName;
  /** Read to screen readers and shown as the tooltip. */
  label: string;
  /** Draws the label next to the glyph. */
  labelled?: boolean;
  tone?: 'plain' | 'danger' | 'agent';
  children?: ReactNode;
}

/** A small action: a glyph, with its words beside it when there is room. */
export function ToolButton({ glyph, label, labelled = false, tone = 'plain', children, ...rest }: ToolButtonProps) {
  return (
    <button
      type="button"
      className="ak-tool"
      data-tone={tone}
      data-labelled={labelled || undefined}
      aria-label={label}
      title={labelled ? undefined : label}
      {...rest}
    >
      <Glyph name={glyph} size={14} />
      {labelled && <span>{label}</span>}
      {children}
    </button>
  );
}
