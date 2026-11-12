import { useEffect, useMemo, useState, type CSSProperties, type RefObject } from 'react';
import type { ActivityDetail, Workspace } from '@shared/protocol';
import { agentVars } from '../../design/color';
import { useShellStore } from '../../stores/shell';
import { Diff } from './Diff';
import { loadDetail } from './data';
import { clockTime, parentOf, relativeTime, splitPath, type Row } from './model';
import { parsePatch, type ParsedPatch } from './patch';
import { Action, actorName, Avatar, Blank, Counts } from './parts';

/** Patches drawn for one burst; a longer burst shows its most recent saves. */
const MAX_PATCHES = 12;

const BINARY = new Set(
  'png jpg jpeg gif webp avif bmp ico tiff pdf zip gz tgz bz2 xz 7z rar tar jar wasm so dylib dll exe bin o a class woff woff2 ttf otf eot mp3 wav ogg flac m4a mp4 mov webm mkv avi sqlite db'.split(
    ' ',
  ),
);

const extensionOf = (path: string): string => {
  const name = splitPath(path).name;
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

type Loaded =
  | { key: number; state: 'loading' }
  | { key: number; state: 'failed' }
  | { key: number; state: 'ready'; patches: Array<{ detail: ActivityDetail; parsed: ParsedPatch; offset: number }> };

interface EntryPaneProps {
  row: Row;
  now: number;
  workspace: Workspace | undefined;
  activeChange: number | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  onOpenWorkspace(id: string): void;
}

const VERB_SENTENCE: Record<Row['verb'], string> = {
  created: 'created this',
  changed: 'changed this',
  deleted: 'deleted this',
  merged: 'merged this into the project',
  cloned: 'got this copy',
};

/** The right pane for one timeline row: who did what to which file, and the diff of every save in the burst. */
export function EntryPane({ row, now, workspace, activeChange, scrollRef, onOpenWorkspace }: EntryPaneProps) {
  const launchApp = useShellStore((state) => state.launchApp);
  const { name, folder } = splitPath(row.path);

  // Oldest first, so a burst reads in the order it was written.
  const ids = useMemo(
    () =>
      row.entries
        .filter((entry) => entry.hasDiff && row.verb !== 'cloned')
        .slice(0, MAX_PATCHES)
        .map((entry) => entry.id)
        .reverse(),
    [row.entries],
  );
  const idsKey = ids.join(',');
  const [loaded, setLoaded] = useState<Loaded>({ key: row.key, state: 'loading' });

  useEffect(() => {
    let current = true;
    // A burst that grows keeps showing what it has until the new save's patch is here.
    setLoaded((held) => (held.key === row.key ? held : { key: row.key, state: 'loading' }));
    Promise.all(ids.map(loadDetail)).then(
      (details) => {
        if (!current) return;
        let offset = 0;
        const patches = details
          .filter((detail) => detail.patch !== '')
          .map((detail) => {
            const parsed = parsePatch(detail.patch);
            const placed = { detail, parsed, offset };
            offset += parsed.changes;
            return placed;
          });
        setLoaded({ key: row.key, state: 'ready', patches });
      },
      () => {
        if (current) setLoaded({ key: row.key, state: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [row.key, idsKey]);

  const shown = loaded.key === row.key ? loaded : ({ key: row.key, state: 'loading' } as const);
  const dropped = row.verb === 'cloned' ? 0 : row.entries.filter((entry) => entry.hasDiff).length - ids.length;
  const gone = row.verb === 'deleted';

  return (
    <div
      className="act-pane"
      data-testid="entry-pane"
      style={row.actor.type === 'me' ? undefined : (agentVars(row.actor.hue) as CSSProperties)}
    >
      <header className="act-pane__head">
        <Avatar actor={row.actor} size={34} />
        <div className="act-pane__title">
          <h2 className="act-pane__name" data-testid="entry-file">
            {name}
          </h2>
          <p className="act-pane__sub">
            {folder && <span className="act-pane__folder">{folder}</span>}
            <span>
              <strong className="act-pane__who">{actorName(row.actor)}</strong> {VERB_SENTENCE[row.verb]}{' '}
              <time title={clockTime(row.at)}>{relativeTime(row.at, now).replace(/^now$/, 'just now')}</time>
              {row.entries.length > 1 && `, in ${row.entries.length} saves`}
            </span>
          </p>
        </div>
        {row.counted && <Counts additions={row.additions} deletions={row.deletions} />}
      </header>

      <div className="act-pane__bar">
        <Action
          glyph="pencil"
          testId="open-in-editor"
          disabled={gone || row.isDir}
          title={gone ? 'The file is no longer there' : undefined}
          onClick={() => launchApp('editor', { path: row.path })}
        >
          Open in Editor
        </Action>
        <Action
          glyph="folder"
          testId="reveal-in-files"
          onClick={() =>
            launchApp(
              'files',
              row.verb === 'cloned'
                ? { path: row.path }
                : gone || row.isDir
                  ? { path: parentOf(row.path) }
                  : { path: parentOf(row.path), select: row.path },
            )
          }
        >
          Reveal in Files
        </Action>
        {workspace && (
          <Action glyph="branch" testId="open-workspace" onClick={() => onOpenWorkspace(workspace.id)}>
            Review {workspace.name}
          </Action>
        )}
      </div>

      <div className="act-pane__scroll" ref={scrollRef} tabIndex={0} data-testid="diff-scroll" aria-label={`Diff of ${row.path}`}>
        {shown.state === 'loading' && ids.length > 0 && <div className="act-wait" aria-label="Loading the diff" />}
        {shown.state === 'failed' && (
          <Blank glyph="info" title="This diff is no longer in the journal">
            <p>The server keeps the patches of recent changes only. The file itself is untouched.</p>
          </Blank>
        )}
        {(ids.length === 0 || (shown.state === 'ready' && shown.patches.length === 0)) && (
          <NoDiff row={row} workspace={workspace} />
        )}
        {shown.state === 'ready' &&
          shown.patches.map(({ detail, parsed, offset }) => (
            <section key={detail.id} className="act-patch" data-testid="patch">
              {shown.patches.length > 1 && (
                <header className="act-patch__head">
                  <time className="tabular">{clockTime(detail.at)}</time>
                  <Counts additions={parsed.additions} deletions={parsed.deletions} />
                </header>
              )}
              <Diff parsed={parsed} changeOffset={offset} activeChange={activeChange} />
            </section>
          ))}
        {shown.state === 'ready' && dropped > 0 && (
          <p className="act-pane__note">
            {dropped} earlier {dropped === 1 ? 'save' : 'saves'} of this burst are not drawn.
          </p>
        )}
      </div>
    </div>
  );
}

function NoDiff({ row, workspace }: { row: Row; workspace: Workspace | undefined }) {
  if (row.verb === 'cloned') {
    const files = row.clonedFiles ?? 0;
    return (
      <Blank glyph="branch" title={workspace ? `A private copy of ${workspace.project}` : 'A private copy of a project'}>
        <p>
          {files} {files === 1 ? 'file was' : 'files were'} put in place
          {workspace &&
            ` by a ${workspace.clone.strategy} clone in ${workspace.clone.ms < 100 ? workspace.clone.ms.toFixed(1) : Math.round(workspace.clone.ms)} ms`}
          . Nothing here reaches the project until the work is merged back.
        </p>
      </Blank>
    );
  }
  if (row.isDir) {
    return (
      <Blank glyph="folder" title={row.verb === 'deleted' ? 'A folder was deleted' : 'A folder was created'}>
        <p>Folders have no diff. The files inside each have a row of their own.</p>
      </Blank>
    );
  }
  if (BINARY.has(extensionOf(row.path))) {
    return (
      <Blank glyph="file" title="Binary file">
        <p>There is no text to compare line by line. Reveal it in Files to look at it.</p>
      </Blank>
    );
  }
  return (
    <Blank glyph="diff" title="No diff for this change">
      <p>
        Diffs are kept for text files up to 256 KB. Empty files, binary files and changes recorded before the server last
        started have none.
      </p>
    </Blank>
  );
}
