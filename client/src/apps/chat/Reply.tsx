import { agentVars } from '../../design/color';
import { AgentIcon } from '../../design/icons';
import { isAgentActive, useAgent, useAgentsStore } from '../../stores/agents';
import { openAgentWindow, openWorkspace, stopAgent, viewChanges } from '../agent/actions';
import { formatCloneMs, madeWorkspace } from '../agent/format';
import { Elapsed, StatusBadge, ToolButton } from '../agent/kit';
import { Stream } from '../agent/Stream';
import { useChatStore, type Turn } from './store';

/** The colour of a reply whose agent is not known yet: no agent's own, so it never looks like one of them. */
const UNNAMED = { name: 'Agent', hue: 250 };

/** One agent's answer to one message: who it is, where it works, and its stream. */
export function Reply({ turn }: { turn: Turn }) {
  const agent = useAgent(turn.jobId ?? undefined);
  const loaded = useAgentsStore((state) => state.loaded);
  const retry = useChatStore((state) => state.retry);
  const identity = agent ?? turn.identity ?? UNNAMED;
  const active = agent ? isAgentActive(agent) : !turn.error && turn.jobId === null;
  const gone = !agent && !turn.error && turn.jobId !== null && loaded;
  const status = agent?.status ?? (turn.error ? 'failed' : 'starting');

  return (
    <article
      className="chat-reply ak-frame"
      style={agentVars(identity.hue)}
      data-testid="chat-reply"
      data-agent-name={identity.name}
      data-job={turn.jobId ?? undefined}
      data-status={gone ? 'gone' : status}
      data-workspace={agent?.workspace.name}
      aria-label={`Reply from ${identity.name}`}
    >
      <div className="ak-frame__body">
        <header className="chat-reply__band">
          <AgentIcon hue={identity.hue} seed={turn.jobId ?? turn.key} size={22} />
          <span className="chat-reply__name" data-testid="chat-reply-name">
            {identity.name}
          </span>
          {!gone && <StatusBadge status={status} />}
          {agent && <Elapsed agent={agent} />}
          <span className="chat-reply__actions">
            {agent && active && (
              <ToolButton
                glyph="stop"
                label="Stop"
                tone="danger"
                data-testid="reply-stop"
                onClick={() => stopAgent(agent.id)}
              />
            )}
            <ToolButton
              glyph="external"
              label="Open agent window"
              data-testid="reply-open-window"
              disabled={!agent}
              onClick={() => agent && openAgentWindow(agent.id)}
            />
            <ToolButton
              glyph="folder"
              label="Open workspace in Files"
              data-testid="reply-open-workspace"
              disabled={!agent}
              onClick={() => agent && openWorkspace(agent.workspace)}
            />
            <ToolButton
              glyph="diff"
              label="View changes"
              data-testid="reply-view-changes"
              disabled={!agent}
              onClick={() => agent && viewChanges(agent.workspace)}
            />
          </span>
        </header>
        <div className="chat-reply__body">
          {turn.error ? (
            <div className="chat-reply__failure" role="alert">
              <p>{turn.error}</p>
              <ToolButton glyph="refresh" label="Try again" labelled onClick={() => retry(turn.key)} />
            </div>
          ) : agent ? (
            <>
              <p className="chat-reply__workspace" data-testid="chat-workspace" data-state="ready">
                workspace <strong>{agent.workspace.name}</strong>
                {madeWorkspace(agent) ? (
                  <>
                    {' · '}
                    {agent.workspace.clone.strategy}
                    {' · '}
                    <span className="tabular">{formatCloneMs(agent.workspace.clone.ms)}</span>
                  </>
                ) : (
                  ' · continued in the same copy'
                )}
              </p>
              <Stream agentId={agent.id} compact />
            </>
          ) : gone ? (
            <p className="chat-reply__workspace" data-testid="chat-gone">
              This job is no longer available.
            </p>
          ) : (
            <p className="chat-reply__workspace" data-testid="chat-workspace" data-state="starting">
              {turn.jobId === null ? (turn.continued ? 'picking the workspace up' : 'starting workspace') : 'reconnecting'}
              <span className="chat-reply__sweep" aria-hidden="true" />
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
