import { memo, useEffect, useRef, type CSSProperties, type DragEvent, type MouseEvent } from 'react';
import type { FsEntry } from '@shared/protocol';
import { agentVars } from '../../design/color';
import { Glyph } from '../../design/icons';
import { hasDragPath, readDragPath, writeDragPath } from '../../lib/dnd';
import { glyphOf, nameOf, parentOf } from './kinds';
import { loadFolder, useFilesStore, useListing, type Mark } from './store';

/** What is being typed into a row: a new name for it, or the name of something new. */
export type Draft = { mode: 'rename'; path: string } | { mode: 'new-file' | 'new-folder'; folder: string };

export interface ColumnActions {
  select(path: string): void;
  open(entry: FsEntry): void;
  openFolder(path: string): void;
  contextMenu(event: MouseEvent, folder: string, entry: FsEntry | null): void;
  commitDraft(name: string): void;
  cancelDraft(): void;
  confirmDelete(): void;
  cancelDelete(): void;
  /** A dragged file was dropped on a folder. */
  moveInto(from: string, folder: string): void;
  setDropTarget(folder: string | null): void;
}

interface ColumnProps {
  folder: string;
  /** The selected row, when this column has one. */
  selected: string | null;
  /** True for the column the keyboard moves in. */
  active: boolean;
  showHidden: boolean;
  draft: Draft | null;
  /** The row that is asking whether to delete it. */
  confirming: string | null;
  dropTarget: string | null;
  actions: ColumnActions;
}

/** The path being dragged out of a Files window on this page; a drop reads the real payload. */
let dragging: string | null = null;

const canDropOn = (folder: string): boolean =>
  dragging === null || (dragging !== folder && !folder.startsWith(`${dragging}/`));

/** Handlers that make an element accept a dragged file for `folder`. */
export function dropHandlers(folder: string, actions: Pick<ColumnActions, 'moveInto' | 'setDropTarget'>) {
  const over = (event: DragEvent) => {
    if (!hasDragPath(event.dataTransfer) || !canDropOn(folder)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    actions.setDropTarget(folder);
  };
  return {
    onDragEnter: over,
    onDragOver: over,
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) actions.setDropTarget(null);
    },
    onDrop: (event: DragEvent) => {
      const from = readDragPath(event.dataTransfer);
      if (!from) return;
      event.preventDefault();
      event.stopPropagation();
      actions.setDropTarget(null);
      actions.moveInto(from, folder);
    },
  };
}

/** What follows the pointer while a row is dragged: the row's glyph and name on a small clipped label. */
function setDragImage(event: DragEvent<HTMLElement>, entry: FsEntry): void {
  const label = document.createElement('div');
  label.className = 'files-drag';
  const glyph = event.currentTarget.querySelector('svg')?.cloneNode(true);
  if (glyph) label.append(glyph);
  label.append(entry.name);
  document.body.append(label);
  event.dataTransfer.setDragImage(label, 14, 14);
  // The browser has taken its picture by the next task.
  window.setTimeout(() => label.remove(), 0);
}

export function Column({ folder, selected, active, showHidden, draft, confirming, dropTarget, actions }: ColumnProps) {
  const listing = useListing(folder);
  const marks = useFilesStore((state) => state.marks);
  const activity = useFilesStore((state) => state.activity);
  const leaving = useFilesStore((state) => state.leaving);
  const element = useRef<HTMLDivElement>(null);

  // Always read again when a column appears: what is cached shows at once, the answer corrects it.
  useEffect(() => {
    void loadFolder(folder);
  }, [folder]);

  // Keep the selected row in view without scrolling anything but this column.
  useEffect(() => {
    const column = element.current;
    if (!column || !selected) return;
    const row = column.querySelector<HTMLElement>('[data-selected]');
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < column.scrollTop + 6) column.scrollTop = top - 6;
    else if (bottom > column.scrollTop + column.clientHeight - 6) column.scrollTop = bottom - column.clientHeight + 6;
  }, [selected, listing]);

  const entries = (listing?.entries ?? []).filter(
    (entry) => showHidden || !entry.hidden || entry.path === selected || leaving[entry.path],
  );
  const creating = draft && draft.mode !== 'rename' && draft.folder === folder ? draft.mode : null;
  const name = folder ? nameOf(folder) : 'Home';

  let body;
  if (!listing || (listing.status === 'loading' && entries.length === 0)) {
    body = (
      <div className="files-column__loading" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    );
  } else if (listing.status === 'error') {
    body = (
      <p className="files-column__note" data-testid="files-column-error">
        {listing.errorCode === 'not_found' ? 'This folder is gone.' : (listing.error ?? 'This folder could not be read.')}
      </p>
    );
  } else if (entries.length === 0 && !creating) {
    body = (
      <p className="files-column__note" data-testid="files-column-empty">
        <Glyph name="folder-open" size={22} strokeWidth={1.1} />
        <span>Nothing in {name} yet</span>
        <span className="files-column__hint">
          <kbd>Ctrl</kbd> <kbd>N</kbd> makes a file here
        </span>
      </p>
    );
  }

  return (
    <div
      ref={element}
      className="files-column"
      role="listbox"
      aria-label={name}
      data-testid="files-column"
      data-folder={folder}
      data-active={active || undefined}
      data-drop={dropTarget === folder || undefined}
      onPointerDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) actions.openFolder(folder);
      }}
      onContextMenu={(event) => actions.contextMenu(event, folder, null)}
      {...dropHandlers(folder, actions)}
    >
      {creating && (
        <div className="files-row files-row--draft" data-testid="files-draft">
          <Glyph name={creating === 'new-folder' ? 'folder' : 'file'} size={16} className="files-row__glyph" />
          <NameInput
            initial=""
            label={creating === 'new-folder' ? 'Name of the new folder' : 'Name of the new file'}
            placeholder={creating === 'new-folder' ? 'New folder' : 'New file'}
            onCommit={actions.commitDraft}
            onCancel={actions.cancelDraft}
          />
        </div>
      )}
      {body}
      {entries.map((entry) => (
        <Row
          key={entry.path}
          entry={entry}
          selected={entry.path === selected ? (active ? 'active' : 'trail') : null}
          mark={marks[entry.path]}
          busy={entry.kind === 'dir' ? activity[entry.path] : undefined}
          leaving={!!leaving[entry.path]}
          renaming={draft?.mode === 'rename' && draft.path === entry.path}
          confirming={confirming === entry.path}
          dropping={dropTarget === entry.path}
          actions={actions}
        />
      ))}
    </div>
  );
}

interface RowProps {
  entry: FsEntry;
  selected: 'active' | 'trail' | null;
  mark: Mark | undefined;
  /** A fresh change somewhere inside this folder. */
  busy: Mark | undefined;
  leaving: boolean;
  renaming: boolean;
  confirming: boolean;
  dropping: boolean;
  actions: ColumnActions;
}

const hueOf = (mark: Mark | undefined): number | null =>
  mark && mark.actor.type !== 'me' ? mark.actor.hue : null;

const Row = memo(function Row({ entry, selected, mark, busy, leaving, renaming, confirming, dropping, actions }: RowProps) {
  const isDir = entry.kind === 'dir';
  const hue = hueOf(mark) ?? hueOf(busy);
  const agent = mark && mark.actor.type !== 'me' ? mark.actor : null;
  const style: CSSProperties | undefined = hue === null ? undefined : agentVars(hue);

  return (
    <div
      className="files-row"
      role="option"
      aria-selected={selected !== null}
      data-testid="files-row"
      data-path={entry.path}
      data-name={entry.name}
      data-kind={isDir ? 'dir' : 'file'}
      data-selected={selected ?? undefined}
      data-fresh={mark ? (agent ? 'agent' : 'me') : undefined}
      data-new={mark && (mark.kind === 'add' || mark.kind === 'addDir') ? '' : undefined}
      data-leaving={leaving || undefined}
      data-hidden={entry.hidden || undefined}
      data-drop={dropping || undefined}
      style={style}
      draggable={!renaming && !leaving}
      onDragStart={(event) => {
        dragging = entry.path;
        writeDragPath(event.dataTransfer, entry.path);
        event.dataTransfer.effectAllowed = 'copyMove';
        setDragImage(event, entry);
      }}
      onDragEnd={() => {
        dragging = null;
        actions.setDropTarget(null);
      }}
      {...(isDir ? dropHandlers(entry.path, actions) : null)}
      onPointerDown={(event) => {
        if (event.button === 0 && !renaming) actions.select(entry.path);
      }}
      onDoubleClick={() => {
        if (!renaming && !confirming) actions.open(entry);
      }}
      onContextMenu={(event) => actions.contextMenu(event, parentOf(entry.path), entry)}
    >
      {/* Remounted for every change, so the sweep runs again each time the file is touched. */}
      {mark && <span className="files-row__sweep" key={mark.at} aria-hidden="true" />}
      <Glyph name={isDir && selected ? 'folder-open' : glyphOf(entry)} size={16} className="files-row__glyph" />
      {renaming ? (
        <NameInput
          initial={entry.name}
          label={`New name for ${entry.name}`}
          selectStem={!isDir}
          onCommit={actions.commitDraft}
          onCancel={actions.cancelDraft}
        />
      ) : (
        <span className="files-row__name">{entry.name}</span>
      )}
      {confirming ? (
        <span className="files-row__confirm" data-testid="files-confirm">
          <button
            type="button"
            className="files-row__yes"
            data-testid="files-confirm-delete"
            tabIndex={-1}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={actions.confirmDelete}
          >
            Delete
          </button>
          <button
            type="button"
            className="files-row__no"
            data-testid="files-confirm-keep"
            tabIndex={-1}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={actions.cancelDelete}
          >
            Keep
          </button>
        </span>
      ) : (
        <>
          {agent && (
            <span className="files-row__tag" data-testid="files-row-tag">
              {agent.name}
            </span>
          )}
          {busy && !agent && <span className="files-row__dot" data-testid="files-row-dot" aria-label="Changed inside" />}
          {isDir && <Glyph name="chevron-right" size={12} className="files-row__chevron" />}
        </>
      )}
    </div>
  );
});

interface NameInputProps {
  initial: string;
  label: string;
  placeholder?: string;
  /** Selects the name without its extension, the part that is usually retyped. */
  selectStem?: boolean;
  onCommit(name: string): void;
  onCancel(): void;
}

/** The field a name is typed into, in place of the row's name. Enter keeps it, Escape leaves. */
function NameInput({ initial, label, placeholder, selectStem, onCommit, onCancel }: NameInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    const field = input.current!;
    field.focus();
    const dot = selectStem ? initial.lastIndexOf('.') : -1;
    field.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial, selectStem]);

  const settle = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const name = input.current!.value.trim();
    if (commit && name && name !== initial) onCommit(name);
    else onCancel();
  };

  return (
    <input
      ref={input}
      className="files-row__input"
      data-testid="files-name-input"
      aria-label={label}
      placeholder={placeholder}
      defaultValue={initial}
      spellCheck={false}
      autoComplete="off"
      draggable={false}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') settle(true);
        else if (event.key === 'Escape') settle(false);
      }}
      // Clicking away keeps what was typed, the way a label on a drawing is left once written.
      onBlur={() => settle(true)}
    />
  );
}
