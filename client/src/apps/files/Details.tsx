import { Fragment, useState, type ReactNode } from 'react';
import type { CloneReport, FsEntry, Workspace } from '@shared/protocol';
import { agentVars } from '../../design/color';
import { Glyph } from '../../design/icons';
import { api, ApiRequestError } from '../../lib/api';
import { isAgentActive, useAgent } from '../../stores/agents';
import { useWorkspacesStore } from '../../stores/workspaces';
import { formatBytes, formatModified, formatMs, glyphOf, kindLabel, kindOf, opensInEditor } from './kinds';
import { useListing } from './store';

interface DetailsProps {
  entry: FsEntry;
  onOpenInEditor(entry: FsEntry): void;
  onPeek(entry: FsEntry): void;
  /** Shows a folder in the columns, for example the copy that was just made. */
  onShow(path: string): void;
}

const PROJECT = /^Projects\/[^/]+$/;

/** The last column: what the selected file or folder is, and what can be done with it. */
export function Details({ entry, onOpenInEditor, onPeek, onShow }: DetailsProps) {
  const kind = kindOf(entry);
  const isDir = entry.kind === 'dir';
  const listing = useListing(isDir ? entry.path : '');
  const workspace = useWorkspacesStore((state) =>
    isDir ? Object.values(state.workspaces).find((candidate) => candidate.path === entry.path) : undefined,
  );
  const count = isDir && listing?.status === 'ready' ? listing.entries.length : null;

  return (
    <aside className="files-details" data-testid="files-details" aria-label={`Details of ${entry.name}`}>
      <div className="files-details__figure" data-kind={kind}>
        {kind === 'image' ? (
          <img
            className="files-details__thumb"
            data-testid="files-thumb"
            src={api.fs.readUrl(entry.path, entry.mtime)}
            alt=""
            draggable={false}
          />
        ) : isDir ? (
          <Glyph name="folder" size={88} strokeWidth={0.75} className="files-details__folder" />
        ) : (
          <Sheet entry={entry} />
        )}
      </div>

      <h3 className="files-details__name selectable" data-testid="files-details-name">
        {entry.name}
      </h3>
      <p className="files-details__kind">{kindLabel(entry)}</p>

      <dl className="files-facts">
        {isDir ? (
          <Fact label="Holds">{count === null ? '' : `${count} ${count === 1 ? 'item' : 'items'}`}</Fact>
        ) : (
          <Fact label="Size" testId="files-details-size">
            {formatBytes(entry.size)}
          </Fact>
        )}
        <Fact label="Modified">{formatModified(entry.mtime)}</Fact>
        <Fact label="Path" wrap testId="files-details-path">
          <BreakablePath path={entry.path} />
        </Fact>
      </dl>

      {!isDir && (
        <div className="files-details__actions">
          {opensInEditor(entry) && (
            <button
              type="button"
              className="files-button files-button--primary"
              data-testid="files-open-editor"
              onClick={() => onOpenInEditor(entry)}
            >
              Open in Editor
            </button>
          )}
          <button type="button" className="files-button" data-testid="files-peek" onClick={() => onPeek(entry)}>
            Peek
          </button>
        </div>
      )}

      {isDir && PROJECT.test(entry.path) && <CopyForAgent key={entry.path} project={entry.path} onShow={onShow} />}
      {workspace && <WorkspaceFacts workspace={workspace} />}
    </aside>
  );
}

/** A path that wraps after a slash, so a name is not cut in the middle while there is room for it. */
function BreakablePath({ path }: { path: string }) {
  return path.split('/').map((part, index, parts) => (
    <Fragment key={index}>
      {index < parts.length - 1 ? `${part}/` : part}
      {index < parts.length - 1 && <wbr />}
    </Fragment>
  ));
}

function Fact({ label, children, wrap, testId }: { label: string; children: ReactNode; wrap?: boolean; testId?: string }) {
  return (
    <div className="files-facts__row">
      <dt>{label}</dt>
      <dd className={wrap ? 'selectable files-facts__wrap' : 'selectable'} data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/** A sheet of paper with the clipped corner, carrying the file's extension like a stamp. */
function Sheet({ entry }: { entry: FsEntry }) {
  return (
    <div className="files-sheet">
      <svg viewBox="0 0 96 120" width="96" height="120" aria-hidden="true">
        <path className="files-sheet__paper" d="M7 1.5h58L94.5 31v82a5.5 5.5 0 0 1-5.5 5.5H7A5.5 5.5 0 0 1 1.5 113V7A5.5 5.5 0 0 1 7 1.5z" />
        <path className="files-sheet__fold" d="M65 1.5V25.5a5.5 5.5 0 0 0 5.5 5.5h24" />
        <path className="files-sheet__lines" d="M16 52h64M16 64h64M16 76h46" />
      </svg>
      <Glyph name={glyphOf(entry)} size={22} className="files-sheet__glyph" />
      {entry.ext && <span className="files-sheet__ext">{entry.ext.slice(0, 5)}</span>}
    </div>
  );
}

function CloneFacts({ clone }: { clone: CloneReport }) {
  return (
    <dl className="files-facts files-facts--clone" data-testid="files-clone-report">
      <Fact label="Strategy" testId="files-clone-strategy">
        {clone.strategy}
      </Fact>
      <Fact label="Time" testId="files-clone-ms">
        {formatMs(clone.ms)}
      </Fact>
      <Fact label="Size" testId="files-clone-bytes">
        {formatBytes(clone.bytes)}
      </Fact>
      <Fact label="Files" testId="files-clone-files">
        {clone.files}
      </Fact>
    </dl>
  );
}

/** "Give an agent its own copy": clones the project into a workspace and reports how the clone went. */
function CopyForAgent({ project, onShow }: { project: string; onShow(path: string): void }) {
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Workspace | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const copy = () => {
    setBusy(true);
    setFailure(null);
    api.workspaces
      .create({ project })
      .then(
        (workspace) => {
          useWorkspacesStore.getState().upsert(workspace);
          setMade(workspace);
        },
        (error: unknown) =>
          setFailure(error instanceof ApiRequestError ? error.message : 'The copy could not be made.'),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section className="files-copy">
      <button
        type="button"
        className="files-button files-button--primary files-button--wide"
        data-testid="files-copy-for-agent"
        disabled={busy}
        onClick={copy}
      >
        <Glyph name="branch" size={14} />
        Give an agent its own copy
      </button>
      {failure && (
        <p className="files-copy__failure" role="alert">
          {failure}
        </p>
      )}
      {made && (
        <>
          <p className="files-copy__made">
            Copied to
            <button type="button" className="files-copy__link" data-testid="files-clone-open" onClick={() => onShow(made.path)}>
              {made.path}
            </button>
          </p>
          <CloneFacts clone={made.clone} />
        </>
      )}
    </section>
  );
}

/** For a workspace folder: whose copy it is and how it was made. */
function WorkspaceFacts({ workspace }: { workspace: Workspace }) {
  const agent = useAgent(workspace.agentId);
  return (
    <section className="files-copy" data-testid="files-workspace">
      {agent && (
        <p className="files-owner" style={agentVars(agent.hue)}>
          <span className="files-owner__dot" data-running={isAgentActive(agent) || undefined} />
          <span className="files-owner__name">{agent.name}</span>
          <span className="files-owner__status">{agent.status}</span>
        </p>
      )}
      <dl className="files-facts">
        <Fact label="Copy of">{workspace.project}</Fact>
        <Fact label="Branch">{workspace.branch}</Fact>
      </dl>
      <CloneFacts clone={workspace.clone} />
    </section>
  );
}
