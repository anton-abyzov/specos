import { useEffect, useMemo, useRef, type RefObject } from 'react';
import type { DiffFile, Workspace } from '@shared/protocol';
import { agentVars } from '../../design/color';
import { AgentIcon, Glyph } from '../../design/icons';
import { useShellStore } from '../../stores/shell';
import { Diff } from './Diff';
import { reviewOf, useReviews, watchWorkspace } from './data';
import { parentOf } from './model';
import { parsePatch } from './patch';
import { Action, Blank, Counts, PathLabel } from './parts';
import { StatusChip, useWorkspaceOwner } from './Timeline';

const STATUS_LETTER: Record<DiffFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const STATUS_WORD: Record<DiffFile['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
};

const formatMs = (ms: number): string => `${ms < 100 ? ms.toFixed(1) : Math.round(ms)} ms`;

interface WorkspacePaneProps {
  workspace: Workspace;
  /** Workspace relative path of the file whose diff shows; the first file when null. */
  selectedFile: string | null;
  activeChange: number | null;
  /** True while the keyboard merge waits for its confirmation. */
  confirming: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onSelectFile(path: string): void;
  onMerge(): void;
  onCancelConfirm(): void;
}

/** A whole workspace against the commit it was cloned from, and the way back into its project. */
export function WorkspacePane(props: WorkspacePaneProps) {
  const { workspace, selectedFile, confirming } = props;
  const owner = useWorkspaceOwner(workspace);
  const review = useReviews((state) => reviewOf(state, workspace.id));
  const launchApp = useShellStore((state) => state.launchApp);
  useEffect(() => watchWorkspace(workspace.id), [workspace.id]);

  const files = review.diff?.files ?? [];
  const file = files.find((candidate) => candidate.path === selectedFile) ?? files[0];
  const parsed = useMemo(() => (file && file.patch !== '' ? parsePatch(file.patch) : null), [file?.patch]);

  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);

  const working = owner.agent?.status === 'starting' || owner.agent?.status === 'running';
  const merged = workspace.status === 'merged';
  const nothingToMerge = review.diff !== undefined && files.length === 0;
  const conflicts = workspace.status === 'conflict' ? (review.merge?.conflicts ?? []) : [];
  const done = merged && review.merge?.merged ? review.merge : undefined;
  const inWorkspace = (path: string): string => `${workspace.path}/${path}`;
  const inProject = (path: string): string => `${workspace.project}/${path}`;

  return (
    <div className="act-pane" data-testid="workspace-pane" data-workspace={workspace.id} style={agentVars(owner.hue)}>
      <header className="act-pane__head">
        <AgentIcon hue={owner.hue} seed={owner.seed} size={34} running={working} />
        <div className="act-pane__title">
          <h2 className="act-pane__name">
            {owner.agent ? `${owner.name}'s copy of ${workspace.project.replace(/^Projects\//, '')}` : workspace.name}
          </h2>
          <p className="act-pane__sub">
            <span className="act-pane__folder">{workspace.path}</span>
            <span>
              {workspace.clone.strategy} clone in {formatMs(workspace.clone.ms)}
            </span>
          </p>
        </div>
        <StatusChip status={workspace.status} />
      </header>

      <div className="act-merge" data-state={merged ? 'merged' : conflicts.length > 0 ? 'conflict' : 'open'}>
        <div className="act-merge__line">
          <p className="act-merge__totals" data-testid="workspace-totals">
            {review.diff ? (
              <>
                <span className="tabular">
                  {files.length} {files.length === 1 ? 'file' : 'files'} changed
                </span>
                <Counts additions={review.diff.additions} deletions={review.diff.deletions} />
                <span className="act-merge__base">against {workspace.project}</span>
              </>
            ) : (
              <span className="act-merge__base">{review.error ?? 'Reading the workspace'}</span>
            )}
          </p>
          {confirming ? (
            <div className="act-confirm" role="alertdialog" aria-label="Confirm the merge" data-testid="merge-confirm">
              <span>
                Merge into <span className="act-mono">{workspace.project}</span>?
              </span>
              <button
                ref={confirmButton}
                type="button"
                className="act-primary"
                data-testid="merge-confirm-yes"
                onClick={props.onMerge}
              >
                Merge
              </button>
              <button type="button" className="act-action" data-testid="merge-confirm-no" onClick={props.onCancelConfirm}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={merged ? 'act-action' : 'act-primary'}
              data-testid="merge-button"
              disabled={review.merging || nothingToMerge || review.diff === undefined}
              onClick={props.onMerge}
            >
              <Glyph name="merge" size={14} />
              {review.merging ? 'Merging' : merged ? 'Merge again' : "Merge this agent's work back"}
            </button>
          )}
        </div>

        {working && !merged && (
          <p className="act-merge__hint">
            {owner.name} is still working. Merging now brings over what is written so far.
          </p>
        )}
        {workspace.status === 'conflict' && !review.merge && !review.merging && (
          <p className="act-merge__hint">The last merge stopped on a conflict. Merge again to see which files.</p>
        )}
        {review.mergeError && (
          <p className="act-merge__error" role="alert" data-testid="merge-error">
            The merge did not run: {review.mergeError}
          </p>
        )}

        {done && (
          <div className="act-result" role="status" data-testid="merge-result">
            <Glyph name="check" size={16} className="act-result__glyph" />
            <div className="act-result__body">
              <p className="act-result__title">
                Merged into <span className="act-mono">{workspace.project}</span>
                {done.commit && (
                  <>
                    {' '}
                    as commit{' '}
                    <span className="act-mono act-result__commit selectable" data-testid="merge-commit" title={done.commit}>
                      {done.commit.slice(0, 8)}
                    </span>
                  </>
                )}
              </p>
              {done.files.length > 0 ? (
                <ul className="act-result__files" data-testid="merge-files">
                  {done.files.map((path) => (
                    <li key={path}>
                      <button
                        type="button"
                        className="act-filelink"
                        title="Open the merged file in Editor"
                        onClick={() => launchApp('editor', { path: inProject(path) })}
                      >
                        {path}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="act-result__text">The project already had all of this work.</p>
              )}
            </div>
          </div>
        )}

        {conflicts.length > 0 && (
          <div className="act-conflict" role="alert" data-testid="merge-conflict">
            <p className="act-conflict__title">
              Not merged. {conflicts.length === 1 ? 'One file was' : `${conflicts.length} files were`} changed in the same
              place on both sides.
            </p>
            <p className="act-conflict__text">
              The project is exactly as it was. Open both versions, bring one in line with the other and save it, then
              merge again.
            </p>
            <ul className="act-conflict__files">
              {conflicts.map((path) => (
                <li key={path} className="act-conflict__file" data-testid="conflict-file">
                  <span className="act-mono act-conflict__path selectable">{path}</span>
                  <Action glyph="pencil" testId="open-project-version" onClick={() => launchApp('editor', { path: inProject(path) })}>
                    Project version
                  </Action>
                  <Action
                    glyph="pencil"
                    testId="open-agent-version"
                    onClick={() => launchApp('editor', { path: inWorkspace(path) })}
                  >
                    {owner.agent ? `${owner.name}'s version` : 'Workspace version'}
                  </Action>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {review.diff === undefined && review.error && (
        <Blank glyph="info" title="The workspace could not be read">
          <p>{review.error}</p>
        </Blank>
      )}
      {review.diff === undefined && !review.error && <div className="act-wait" aria-label="Reading the workspace" />}
      {nothingToMerge && (
        <Blank glyph="branch" title="No changes in this copy yet">
          <p>
            It still matches {workspace.project}. Files {owner.agent ? owner.name : 'the agent'} writes here appear as they
            are saved.
          </p>
        </Blank>
      )}

      {files.length > 0 && file && (
        <div className="act-review">
          <ul className="act-files" role="listbox" aria-label="Changed files" data-testid="workspace-files">
            {files.map((candidate) => (
              <li
                key={candidate.path}
                role="option"
                aria-selected={candidate === file}
                className="act-file"
                data-testid="workspace-file"
                data-path={candidate.path}
                data-status={candidate.status}
                onClick={() => props.onSelectFile(candidate.path)}
              >
                <span className="act-file__status" title={STATUS_WORD[candidate.status]}>
                  {STATUS_LETTER[candidate.status]}
                </span>
                <PathLabel path={candidate.path} />
                <Counts additions={candidate.additions} deletions={candidate.deletions} />
              </li>
            ))}
          </ul>
          <div className="act-pane__bar">
            <Action
              glyph="pencil"
              testId="open-in-editor"
              disabled={file.status === 'deleted'}
              onClick={() => launchApp('editor', { path: inWorkspace(file.path) })}
            >
              Open in Editor
            </Action>
            <Action
              glyph="folder"
              testId="reveal-in-files"
              onClick={() =>
                launchApp(
                  'files',
                  file.status === 'deleted'
                    ? { path: parentOf(inWorkspace(file.path)) }
                    : { path: parentOf(inWorkspace(file.path)), select: inWorkspace(file.path) },
                )
              }
            >
              Reveal in Files
            </Action>
          </div>
          <div
            className="act-pane__scroll"
            ref={props.scrollRef}
            tabIndex={0}
            data-testid="diff-scroll"
            aria-label={`Diff of ${file.path}`}
          >
            {parsed ? (
              <Diff key={file.path} parsed={parsed} activeChange={props.activeChange} />
            ) : (
              <Blank glyph="file" title="No text diff for this file">
                <p>It is binary, or it was only renamed or had its permissions changed.</p>
              </Blank>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
