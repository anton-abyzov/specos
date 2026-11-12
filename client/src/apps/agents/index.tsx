import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentInfo, MergeResult } from '@shared/protocol';
import { agentVars } from '../../design/color';
import { AgentIcon, AppIcon, Glyph } from '../../design/icons';
import { ApiRequestError, api } from '../../lib/api';
import { isAgentActive, useAgentList } from '../../stores/agents';
import { useWorkspacesStore } from '../../stores/workspaces';
import { openAgentWindow, openFile, openWorkspace, startAgent, stopAgent, viewChanges } from '../agent/actions';
import { formatBytes, formatCloneMs, ownChanges, pathInWorkspace, projectName } from '../agent/format';
import { Elapsed, FileChip, StatusBadge, ToolButton } from '../agent/kit';
import { ProjectPicker } from '../agent/ProjectPicker';
import type { AppProps } from '../registry';
import './agents.css';

type MergeState = { phase: 'merging' } | { phase: 'done'; result: MergeResult } | { phase: 'failed'; message: string };

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function MergeOutcome({ state, project }: { state: MergeState; project: string }) {
  if (state.phase === 'merging') {
    return (
      <p className="agent-card__merge" data-testid="merge-result" data-merged="pending">
        Merging into {projectName(project)}
      </p>
    );
  }
  if (state.phase === 'failed') {
    return (
      <p className="agent-card__merge" data-testid="merge-result" data-merged="false" role="alert">
        The merge did not run: {state.message}
      </p>
    );
  }
  const { result } = state;
  if (result.merged) {
    return (
      <p className="agent-card__merge" data-testid="merge-result" data-merged="true">
        <Glyph name="check" size={13} />
        <span>
          Merged {plural(result.files.length, 'file')} into {projectName(project)}
          {result.commit && <code>{result.commit.slice(0, 7)}</code>}
        </span>
      </p>
    );
  }
  return (
    <div className="agent-card__merge" data-testid="merge-result" data-merged="false" role="alert">
      <p>
        {plural(result.conflicts.length, 'file')} changed on both sides, so nothing was merged and {projectName(project)}{' '}
        is as it was.
      </p>
      <ul data-testid="merge-conflicts">
        {result.conflicts.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentInfo }) {
  // The workspace store hears about a merge first; the job carries the copy it was started with.
  const workspace = useWorkspacesStore((state) => state.workspaces[agent.workspace.id]) ?? agent.workspace;
  const [expanded, setExpanded] = useState(false);
  const [merge, setMerge] = useState<MergeState | null>(null);
  const active = isAgentActive(agent);
  const long = agent.prompt.length > 110 || agent.prompt.includes('\n');
  const touched = ownChanges(agent.filesTouched, workspace, agent.attachments);

  const mergeBack = () => {
    setMerge({ phase: 'merging' });
    api.workspaces.merge(workspace.id).then(
      (result) => setMerge({ phase: 'done', result }),
      (error: unknown) =>
        setMerge({ phase: 'failed', message: error instanceof ApiRequestError ? error.message : 'the server did not answer' }),
    );
  };

  return (
    <li
      className="agent-card ak-frame"
      style={agentVars(agent.hue)}
      data-testid="agent-card"
      data-agent={agent.id}
      data-agent-name={agent.name}
      data-status={agent.status}
    >
      <article className="ak-frame__body" aria-label={`${agent.name}, ${agent.status}`}>
        <header className="agent-card__band">
          <AgentIcon hue={agent.hue} seed={agent.id} size={32} running={active} />
          <div className="agent-card__who">
            <h3 className="agent-card__name">{agent.name}</h3>
            <StatusBadge status={agent.status} />
          </div>
          <div className="agent-card__clock">
            <Elapsed agent={agent} />
            <span className="agent-card__runner" data-testid="agent-runner">
              {agent.runner}
            </span>
          </div>
        </header>

        <div className="agent-card__body">
          <button
            type="button"
            className="agent-card__prompt selectable"
            data-expanded={expanded || undefined}
            aria-expanded={long ? expanded : undefined}
            disabled={!long}
            title={long ? (expanded ? 'Show less' : 'Show the whole prompt') : undefined}
            onClick={() => setExpanded((value) => !value)}
          >
            {agent.prompt}
          </button>

          <button
            type="button"
            className="agent-card__workspace"
            data-testid="card-workspace"
            title={`Open ${workspace.path} in Files`}
            onClick={() => openWorkspace(workspace)}
          >
            <Glyph name="branch" size={14} />
            <span className="agent-card__workspace-name">{workspace.name}</span>
            <span className="agent-card__workspace-facts tabular">
              {workspace.clone.strategy} · {formatCloneMs(workspace.clone.ms)} · {formatBytes(workspace.clone.bytes)}
              {workspace.status !== 'active' && ` · ${workspace.status}`}
            </span>
          </button>

          <ul className="agent-card__files" data-testid="card-files">
            {touched.map((file) => (
              <li key={file.path}>
                <FileChip
                  path={file.path}
                  change={file.kind}
                  count={file.count}
                  label={pathInWorkspace(file.path, workspace)}
                  onOpen={openFile}
                />
              </li>
            ))}
            {touched.length === 0 && (
              <li className="agent-card__none">{active ? 'No file touched yet' : 'No file was changed'}</li>
            )}
          </ul>

          {agent.error && (
            <p className="agent-card__error" role="alert">
              {agent.error}
            </p>
          )}
          {merge && <MergeOutcome state={merge} project={workspace.project} />}
        </div>

        <footer className="agent-card__actions">
          {active && (
            <ToolButton
              glyph="stop"
              label="Stop"
              labelled
              tone="danger"
              data-testid="card-stop"
              onClick={() => stopAgent(agent.id)}
            />
          )}
          <ToolButton
            glyph="external"
            label="Open window"
            labelled
            data-testid="card-open"
            onClick={() => openAgentWindow(agent.id)}
          />
          <ToolButton
            glyph="diff"
            label="View changes"
            labelled
            data-testid="card-changes"
            onClick={() => viewChanges(workspace)}
          />
          {!active && (
            <>
              <ToolButton
                glyph="merge"
                label={workspace.status === 'merged' ? 'Merge again' : 'Merge back'}
                labelled
                data-testid="card-merge"
                disabled={merge?.phase === 'merging'}
                onClick={mergeBack}
              />
              <ToolButton
                glyph="trash"
                label="Remove"
                tone="danger"
                data-testid="card-remove"
                onClick={() => void api.agents.remove(agent.id).catch(() => undefined)}
              />
            </>
          )}
        </footer>
      </article>
    </li>
  );
}

/** Every agent job: the ones at work first, then the rest, newest first. */
export default function AgentsApp({ focused }: AppProps) {
  const agents = useAgentList();
  const [prompt, setPrompt] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const { running, finished } = useMemo(() => {
    const newestFirst = [...agents].sort((a, b) => b.startedAt - a.startedAt);
    return {
      running: newestFirst.filter(isAgentActive),
      finished: newestFirst.filter((agent) => !isAgentActive(agent)),
    };
  }, [agents]);

  useEffect(() => {
    if (focused && agents.length === 0) field.current?.focus();
  }, [focused, agents.length]);

  const start = () => {
    const text = prompt.trim();
    if (text === '') return field.current?.focus();
    setFailure(null);
    setPrompt('');
    // An agent started here is watched: it gets its window as soon as it exists.
    startAgent({ prompt: text, ...(project ? { project } : {}) }).job.then(
      (agent) => openAgentWindow(agent.id),
      (error: unknown) => {
        setPrompt(text);
        setFailure(error instanceof ApiRequestError ? error.message : 'The agent could not be started.');
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      start();
    }
  };

  return (
    <section className="agents" data-testid="app-agents">
      <header className="agents__header">
        <div className="agents__counts" aria-live="polite">
          <span className="agents__count" data-live={running.length > 0 || undefined}>
            <strong className="tabular" data-testid="agents-running">
              {running.length}
            </strong>
            running
          </span>
          <span className="agents__count">
            <strong className="tabular" data-testid="agents-finished">
              {finished.length}
            </strong>
            finished
          </span>
        </div>
        <div className="agents__new" data-failed={failure !== null || undefined}>
          <Glyph name="plus" size={15} />
          <input
            ref={field}
            className="agents__prompt"
            data-testid="agents-new-prompt"
            placeholder="New agent: say what it should do"
            aria-label="Prompt for a new agent"
            value={prompt}
            spellCheck={false}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <ProjectPicker value={project} placement="down" onChange={setProject} onClose={() => field.current?.focus()} />
          <button type="button" className="agents__start" data-testid="agents-new-start" onClick={start}>
            Start
          </button>
        </div>
        {failure && (
          <p className="agents__failure" role="alert">
            {failure}
          </p>
        )}
      </header>

      {agents.length === 0 ? (
        <div className="agents__empty" data-testid="agents-empty">
          <AppIcon id="agents" size={44} />
          <h1 className="agents__empty-title">No agents yet</h1>
          <p className="agents__empty-text">
            An agent gets a window, a dock icon and its own copy of a project to work in.
          </p>
          <button type="button" className="agents__empty-action" onClick={() => field.current?.focus()}>
            Start one
          </button>
        </div>
      ) : (
        <div className="agents__scroll">
          {running.length > 0 && (
            <>
              <h2 className="agents__section">Running</h2>
              <ul className="agents__grid" data-testid="agents-running-list">
                {running.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} />
                ))}
              </ul>
            </>
          )}
          {finished.length > 0 && (
            <>
              <h2 className="agents__section">Recent</h2>
              <ul className="agents__grid" data-testid="agents-finished-list">
                {finished.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
