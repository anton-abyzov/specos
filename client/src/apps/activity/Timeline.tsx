import { memo, useEffect, type CSSProperties, type RefObject } from 'react';
import type { AgentInfo, Workspace } from '@shared/protocol';
import { agentVars } from '../../design/color';
import { AgentIcon, Glyph } from '../../design/icons';
import { useAgent } from '../../stores/agents';
import { reviewOf, useReviews, watchWorkspace } from './data';
import { relativeTime, type AuthorFilter, type Row, type RowGroup } from './model';
import { actorName, Avatar, Blank, Counts, PathLabel } from './parts';

export interface AgentChip {
  agentId: string;
  name: string;
  hue: number;
}

/** The agent a workspace belongs to, or the workspace's own name when the job is no longer listed. */
export function useWorkspaceOwner(workspace: Workspace): { name: string; hue: number; seed: string; agent?: AgentInfo } {
  const agent = useAgent(workspace.agentId);
  return agent
    ? { name: agent.name, hue: agent.hue, seed: agent.id, agent }
    : { name: workspace.name, hue: 200, seed: workspace.agentId ?? workspace.id };
}

const STATUS_TEXT: Record<Workspace['status'], string> = { active: 'active', merged: 'merged', conflict: 'conflict' };

export function StatusChip({ status }: { status: Workspace['status'] }) {
  return (
    <span className="act-status" data-status={status} data-testid="workspace-status">
      {STATUS_TEXT[status]}
    </span>
  );
}

const WorkspaceCard = memo(function WorkspaceCard({
  workspace,
  current,
  onOpen,
}: {
  workspace: Workspace;
  current: boolean;
  onOpen(id: string): void;
}) {
  const owner = useWorkspaceOwner(workspace);
  const diff = useReviews((state) => reviewOf(state, workspace.id).diff);
  useEffect(() => watchWorkspace(workspace.id), [workspace.id]);
  const working = owner.agent?.status === 'starting' || owner.agent?.status === 'running';
  return (
    <button
      type="button"
      className="act-ws"
      data-testid={`workspace-card-${workspace.id}`}
      data-current={current || undefined}
      style={agentVars(owner.hue)}
      onClick={() => onOpen(workspace.id)}
    >
      <AgentIcon hue={owner.hue} seed={owner.seed} size={26} running={working} />
      <span className="act-ws__main">
        <span className="act-ws__name">{owner.name}</span>
        <span className="act-ws__path">{workspace.name}</span>
      </span>
      <span className="act-ws__facts">
        <StatusChip status={workspace.status} />
        {diff && (
          <span className="act-ws__totals tabular">
            {diff.files.length} {diff.files.length === 1 ? 'file' : 'files'}
            <Counts additions={diff.additions} deletions={diff.deletions} />
          </span>
        )}
      </span>
    </button>
  );
});

const VERB_TEXT: Record<Row['verb'], string> = {
  created: 'created',
  changed: 'changed',
  deleted: 'deleted',
  merged: 'merged',
  cloned: 'got its own copy',
};

const TimelineRow = memo(function TimelineRow({
  row,
  selected,
  fresh,
  now,
  onSelect,
}: {
  row: Row;
  selected: boolean;
  fresh: boolean;
  now: number;
  onSelect(row: Row): void;
}) {
  const style = row.actor.type === 'me' ? undefined : (agentVars(row.actor.hue) as CSSProperties);
  return (
    <li className="act-row-slot" data-fresh={fresh || undefined}>
      <div
        role="option"
        aria-selected={selected}
        className="act-row"
        data-testid="activity-row"
        data-row-key={row.key}
        data-actor={row.actor.type}
        data-verb={row.verb}
        data-path={row.path}
        style={style}
        onClick={() => onSelect(row)}
      >
        <Avatar actor={row.actor} />
        <div className="act-row__main">
          <div className="act-row__who">
            <span className="act-row__name" data-testid="row-author">
              {actorName(row.actor)}
            </span>
            <span className="act-row__verb">
              {row.verb === 'cloned' && row.actor.type === 'me' ? 'made a copy' : VERB_TEXT[row.verb]}
              {row.isDir && row.verb !== 'cloned' ? ' folder' : ''}
            </span>
            {row.entries.length > 1 && row.verb !== 'cloned' && (
              <span className="act-row__burst tabular" data-testid="row-burst" title={`${row.entries.length} saves in a row`}>
                ×{row.entries.length}
              </span>
            )}
            <span className="act-row__time tabular">{relativeTime(row.at, now)}</span>
          </div>
          <div className="act-row__what">
            <PathLabel path={row.path} />
            {row.counted && <Counts additions={row.additions} deletions={row.deletions} />}
            {row.clonedFiles !== undefined && (
              <span className="act-row__files tabular">
                {row.clonedFiles} {row.clonedFiles === 1 ? 'file' : 'files'}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
});

/** A row slides in only while it is news; one that is drawn again later, in an older time group, does not. */
const FRESH_MS = 3000;

interface TimelineProps {
  groups: RowGroup[];
  /** Key of the row whose diff is open. */
  selectedKey: number | null;
  /** Rows that began after this id slide in. */
  freshAfter: number;
  now: number;
  pending: number;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  error: string | null;
  filtered: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  author: AuthorFilter;
  agents: AgentChip[];
  workspaces: Workspace[];
  /** Workspaces listed above the timeline. */
  reviewable: Workspace[];
  workspaceFilter: string;
  viewedWorkspace: string | null;
  query: string;
  listRef: RefObject<HTMLDivElement | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  onAuthor(author: AuthorFilter): void;
  onWorkspaceFilter(id: string): void;
  onQuery(query: string): void;
  onSelect(row: Row): void;
  onOpenWorkspace(id: string): void;
  onScroll(): void;
  onShowPending(): void;
  onLoadOlder(): void;
  onClearFilters(): void;
  onRetry(): void;
}

export function Timeline(props: TimelineProps) {
  const { groups, author, agents, status } = props;
  const empty = groups.length === 0;
  const authorIs = (value: AuthorFilter): boolean =>
    typeof value === 'object' && typeof author === 'object' ? value.agentId === author.agentId : value === author;

  return (
    <div className="act-side">
      <div className="act-filters">
        <label className="act-search">
          <Glyph name="search" size={14} />
          <input
            ref={props.searchRef}
            type="search"
            className="act-search__input"
            data-testid="activity-search"
            placeholder="Filter by path"
            aria-label="Filter by path"
            spellCheck={false}
            value={props.query}
            onChange={(event) => props.onQuery(event.target.value)}
          />
        </label>
        <div className="act-chips" role="group" aria-label="Author">
          <button type="button" className="act-chip" data-testid="filter-all" aria-pressed={authorIs('all')} onClick={() => props.onAuthor('all')}>
            All
          </button>
          <button type="button" className="act-chip" data-testid="filter-me" aria-pressed={authorIs('me')} onClick={() => props.onAuthor('me')}>
            Me
          </button>
          {agents.map((agent) => (
            <button
              key={agent.agentId}
              type="button"
              className="act-chip act-chip--agent"
              data-testid={`filter-agent-${agent.agentId}`}
              style={agentVars(agent.hue)}
              aria-pressed={authorIs({ agentId: agent.agentId })}
              onClick={() => props.onAuthor({ agentId: agent.agentId })}
            >
              <span className="act-chip__dot" />
              {agent.name}
            </button>
          ))}
        </div>
        <label className="act-select">
          <Glyph name="branch" size={14} />
          <select
            data-testid="workspace-filter"
            aria-label="Workspace"
            value={props.workspaceFilter}
            onChange={(event) => props.onWorkspaceFilter(event.target.value)}
          >
            <option value="">Every workspace and project</option>
            {props.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <Glyph name="chevron-down" size={12} className="act-select__caret" />
        </label>
      </div>

      <div className="act-list" ref={props.listRef} tabIndex={0} onScroll={props.onScroll} data-testid="activity-list">
        <div className="act-pending-anchor">
          {props.pending > 0 && (
            <button type="button" className="act-pending" data-testid="new-pill" onClick={props.onShowPending}>
              <Glyph name="arrow-up" size={12} />
              {props.pending} new
            </button>
          )}
        </div>
        {props.reviewable.length > 0 && (
          <section className="act-section" aria-label="Workspaces">
            <h3 className="act-heading">Workspaces</h3>
            <div className="act-ws-list">
              {props.reviewable.map((workspace) => (
                <WorkspaceCard
                  key={workspace.id}
                  workspace={workspace}
                  current={props.viewedWorkspace === workspace.id}
                  onOpen={props.onOpenWorkspace}
                />
              ))}
            </div>
          </section>
        )}

        {empty && status === 'loading' && <div className="act-wait" aria-label="Loading the journal" />}
        {empty && status === 'failed' && (
          <Blank glyph="info" title="The journal did not load">
            <p>{props.error}</p>
            <button type="button" className="act-action" onClick={props.onRetry}>
              Try again
            </button>
          </Blank>
        )}
        {empty && (status === 'ready' || status === 'idle') && !props.filtered && (
          <Blank glyph="clock" title="Nothing has changed yet">
            <p>Every file you or an agent creates, edits or deletes in the home folder is listed here as it happens.</p>
          </Blank>
        )}
        {empty && status === 'ready' && props.filtered && (
          <Blank glyph="search" title="No changes match">
            <button type="button" className="act-action" data-testid="clear-filters" onClick={props.onClearFilters}>
              Clear the filters
            </button>
          </Blank>
        )}

        {!empty && (
          <div role="listbox" aria-label="File changes" className="act-groups" data-testid="activity-rows">
            {groups.map((group) => (
              <section key={group.label} className="act-section" aria-label={group.label}>
                <h3 className="act-heading act-heading--sticky">{group.label}</h3>
                <ul>
                  {group.rows.map((row) => (
                    <TimelineRow
                      key={row.key}
                      row={row}
                      selected={row.key === props.selectedKey}
                      fresh={row.key > props.freshAfter && props.now - row.at < FRESH_MS}
                      now={props.now}
                      onSelect={props.onSelect}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {!empty && props.hasOlder && (
          <button
            type="button"
            className="act-older"
            data-testid="load-older"
            disabled={props.loadingOlder}
            onClick={props.onLoadOlder}
          >
            {props.loadingOlder ? 'Loading' : 'Load older changes'}
          </button>
        )}
        {!empty && props.error && status === 'ready' && <p className="act-list__error">{props.error}</p>}
      </div>

    </div>
  );
}
