import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AgentInfo, TouchedFile } from '@shared/protocol';
import { agentVars } from '../../design/color';
import { AgentIcon, Glyph } from '../../design/icons';
import { useWindowsStore } from '../../desktop/wm/store';
import { ApiRequestError, api } from '../../lib/api';
import { hasDragPath, readDragPath } from '../../lib/dnd';
import { isAgentActive, useAgentsStore } from '../../stores/agents';
import type { AppProps } from '../registry';
import { openFile, openWorkspace, startAgent, stopAgent, viewChanges } from './actions';
import { chainOf } from './chain';
import { baseName, ownChanges, pathInWorkspace, shortPrompt } from './format';
import { Elapsed, FileChip, StatusBadge, ToolButton, WorkspaceChip } from './kit';
import { Stream, StreamScroller } from './Stream';
import './agent.css';

/** Every file the jobs of one agent touched, newest change first, counts added up. */
function touchedBy(chain: AgentInfo[]): TouchedFile[] {
  const files = new Map<string, TouchedFile>();
  for (const job of chain) {
    for (const file of job.filesTouched) {
      const held = files.get(file.path);
      files.set(file.path, held ? { ...file, count: held.count + file.count, at: Math.max(held.at, file.at) } : file);
    }
  }
  return [...files.values()].sort((a, b) => b.at - a.at);
}

function Unavailable({ windowId }: { windowId: string }) {
  return (
    <section className="agent-gone" data-testid="agent-gone">
      <Glyph name="agent" size={28} />
      <h1 className="agent-gone__title">This job is no longer available</h1>
      <p className="agent-gone__text">
        The server does not list it any more. If its workspace was kept, it is still in Files under Workspaces.
      </p>
      <ToolButton
        glyph="close"
        label="Close"
        labelled
        data-testid="agent-gone-close"
        onClick={() => useWindowsStore.getState().close(windowId)}
      />
    </section>
  );
}

/** One agent, live: who it is, what it says and does, and the files it has touched. */
export default function AgentApp({ windowId, params, setTitle, focused }: AppProps) {
  const agentId = typeof params.agentId === 'string' ? params.agentId : undefined;
  const loaded = useAgentsStore((state) => state.loaded);
  const chain = useAgentsStore(useShallow((state) => (agentId ? chainOf(state.agents, agentId) : [])));
  const own = chain.find((job) => job.id === agentId);
  const latest = chain.at(-1);

  const [dropping, setDropping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const followUp = useRef<HTMLTextAreaElement>(null);
  const attachments = useMemo(() => [...new Set(chain.flatMap((job) => job.attachments))], [chain]);
  // The copy of an attached file is the user's doing, and is listed under Attached.
  const touched = useMemo(
    () => (latest ? ownChanges(touchedBy(chain), latest.workspace, attachments) : []),
    [chain, attachments, latest],
  );

  useEffect(() => {
    if (own) setTitle(`${own.name} · ${shortPrompt(own.prompt)}`);
  }, [own?.name, own?.prompt, setTitle]);

  const active = latest ? isAgentActive(latest) : false;
  // When the job ends the composer appears; the keyboard goes to it if this window is in front.
  useEffect(() => {
    if (focused && !active) followUp.current?.focus();
  }, [focused, active]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!latest || !own) return loaded ? <Unavailable windowId={windowId} /> : <section className="agent-app" />;

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!hasDragPath(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  };
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    const path = readDragPath(event.dataTransfer);
    setDropping(false);
    if (!path) return;
    event.preventDefault();
    api.agents.attach(latest.id, path).then(
      () => setNotice(null),
      (error: unknown) =>
        setNotice(`${baseName(path)} was not attached: ${error instanceof ApiRequestError ? error.message : 'the server did not answer'}`),
    );
  };

  const sendFollowUp = () => {
    const prompt = draft.trim();
    if (prompt === '' || sending || active) return;
    setSending(true);
    startAgent({ prompt, continueFrom: latest.id }).job.then(
      () => {
        setDraft('');
        setSending(false);
      },
      (error: unknown) => {
        setSending(false);
        setNotice(error instanceof ApiRequestError ? error.message : 'The follow-up could not be started.');
      },
    );
  };
  const onFollowUpKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendFollowUp();
    }
  };

  return (
    <section
      className="agent-app"
      style={agentVars(latest.hue)}
      data-testid="app-agent"
      data-agent={own.id}
      data-status={latest.status}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="agent-app__header">
        <AgentIcon hue={latest.hue} seed={own.id} size={30} running={active} />
        <div className="agent-app__who">
          <h1 className="agent-app__name" data-testid="agent-name">
            {latest.name}
          </h1>
          <span className="agent-app__facts">
            <StatusBadge status={latest.status} />
            <Elapsed agent={latest} />
            <span className="agent-app__runner">{latest.runner}</span>
          </span>
        </div>
        <span className="agent-app__tools">
          <WorkspaceChip workspace={latest.workspace} onOpen={openWorkspace} />
          <ToolButton
            glyph="diff"
            label="View changes"
            data-testid="agent-view-changes"
            onClick={() => viewChanges(latest.workspace)}
          />
          {active && (
            <ToolButton
              glyph="stop"
              label="Stop"
              labelled
              tone="danger"
              data-testid="agent-stop"
              onClick={() => stopAgent(latest.id)}
            />
          )}
        </span>
      </header>

      <div className="agent-app__columns">
        <StreamScroller className="agent-app__stream" resetKey={chain.length}>
          <div className="agent-app__jobs">
            {chain.map((job) => (
              <div key={job.id} className="agent-app__job" data-testid="agent-job">
                <p className="stream-prompt selectable" data-testid="agent-prompt">
                  {job.prompt}
                </p>
                <Stream agentId={job.id} />
              </div>
            ))}
          </div>
        </StreamScroller>

        <aside className="agent-app__side" aria-label="Files">
          <h2 className="agent-app__label">
            Touched <span className="tabular">{touched.length}</span>
          </h2>
          <ul className="agent-app__chips" data-testid="agent-files">
            {touched.map((file) => (
              <li key={file.path}>
                <FileChip
                  path={file.path}
                  change={file.kind}
                  count={file.count}
                  label={pathInWorkspace(file.path, latest.workspace)}
                  onOpen={openFile}
                />
              </li>
            ))}
          </ul>
          {touched.length === 0 && (
            <p className="agent-app__none">{active ? 'Files appear here as they change.' : 'No file was changed.'}</p>
          )}

          <h2 className="agent-app__label">
            Attached <span className="tabular">{attachments.length}</span>
          </h2>
          <ul className="agent-app__chips" data-testid="agent-attachments">
            {attachments.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  className="ak-chip"
                  data-testid="attachment-chip"
                  title={`Open ${path} in the Editor`}
                  onClick={() => openFile(path)}
                >
                  <Glyph name="file" size={13} />
                  <span className="ak-chip__name">{baseName(path)}</span>
                </button>
              </li>
            ))}
          </ul>
          {attachments.length === 0 && <p className="agent-app__none">Drop a file from Files onto this window.</p>}
          {notice && (
            <p className="agent-app__notice" role="alert" data-testid="agent-notice">
              {notice}
            </p>
          )}
        </aside>
      </div>

      {!active && (
        <div className="agent-app__followup">
          <textarea
            ref={followUp}
            className="agent-app__field"
            data-testid="agent-followup"
            rows={1}
            placeholder={`Ask ${latest.name} to carry on in the same workspace`}
            aria-label="Follow-up"
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onFollowUpKeyDown}
          />
          <ToolButton
            glyph="send"
            label="Send"
            tone="agent"
            data-testid="agent-followup-send"
            disabled={draft.trim() === '' || sending}
            onClick={sendFollowUp}
          />
        </div>
      )}

      {dropping && (
        <div className="agent-app__drop" data-testid="agent-drop-overlay">
          <AgentIcon hue={latest.hue} seed={own.id} size={44} />
          <p>Drop to give {latest.name} this file</p>
          <span>It is copied into {latest.workspace.name}/attachments</span>
        </div>
      )}
    </section>
  );
}
