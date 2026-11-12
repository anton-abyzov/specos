/**
 * Files: the home folder as columns. Each folder on the way to the selection
 * is a column, the last column describes what is selected, and every change on
 * disk shows the moment it happens, in the colour of whoever made it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { FsEntry } from '@shared/protocol';
import { Glyph } from '../../design/icons';
import { prefersReducedMotion } from '../../design/motion';
import { api, ApiRequestError } from '../../lib/api';
import { useShellStore } from '../../stores/shell';
import { useSystemStore } from '../../stores/system';
import type { AppProps } from '../registry';
import { Column, type ColumnActions, type Draft } from './Column';
import { registerFilesWindow, type FilesCommand } from './commands';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Details } from './Details';
import { chainOf, isWithin, joinPath, kindOf, nameOf, nameProblem, opensInEditor, parentOf } from './kinds';
import { usePeekStore, type PeekKey, type PeekOrigin } from './peek';
import { Sidebar } from './Sidebar';
import { findEntry, putEntry, removeEntry, replaceEntry, useFilesStore, visibleEntries } from './store';
import './files.css';

/** Where the window is: the folder the keyboard moves in, and the row selected in it. */
interface Location {
  folder: string;
  selected: string | null;
}

const clean = (value: unknown): string | null =>
  typeof value === 'string' ? value.replace(/^\/+|\/+$/g, '') : null;

/** The launcher's contract: { path } opens a folder, { path, select } opens it with a file selected. */
function startAt(params: Record<string, unknown>): Location {
  const select = clean(params.select);
  if (select) return { folder: parentOf(select), selected: select };
  return { folder: clean(params.path) ?? '', selected: null };
}

const TYPE_AHEAD_MS = 700;
const NOTICE_MS = 6000;

async function copyText(text: string): Promise<void> {
  try {
    // Only offered to pages on HTTPS or localhost; a desktop opened over the network falls through.
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;top:-100px;opacity:0';
    document.body.append(field);
    field.select();
    document.execCommand('copy');
    field.remove();
  }
}

const failureText = (error: unknown, fallback: string): string =>
  error instanceof ApiRequestError && error.status !== 0 ? error.message : fallback;

export default function FilesApp({ windowId, params, setTitle, focused }: AppProps) {
  const [location, setLocation] = useState<Location>(() => startAt(params));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const listings = useFilesStore((state) => state.listings);
  const leaving = useFilesStore((state) => state.leaving);
  const { folder, selected } = location;
  const listing = listings[folder];
  const selectedEntry = selected ? listing?.entries.find((entry) => entry.path === selected) : undefined;
  const preview = selectedEntry?.kind === 'dir' ? selectedEntry.path : null;
  const chain = useMemo(() => chainOf(folder), [folder]);
  const rows = useMemo(
    () => visibleEntries(folder, showHidden, selected),
    // The listing and the leaving rows are what visibleEntries reads from the store.
    [folder, showHidden, selected, listing, leaving],
  );

  const focusRoot = useCallback(() => root.current?.focus({ preventScroll: true }), []);

  // Everything below reads the latest state through this, so handlers handed to rows never go stale.
  const latest = useRef({ location, rows, selectedEntry, draft, confirming, showHidden });
  latest.current = { location, rows, selectedEntry, draft, confirming, showHidden };

  const say = useCallback((text: string) => setNotice(text), []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => setTitle(folder ? nameOf(folder) : 'Home'), [folder, setTitle]);

  // ---------------------------------------------------------------- moving around

  /** Letters typed in quick succession, for selecting by name. */
  const typed = useRef({ text: '', at: 0 });

  const go = useCallback((next: Location) => {
    setConfirming(null);
    // Moving any other way ends the word being typed, so the next letter starts a new one.
    typed.current.text = '';
    setLocation(next);
  }, []);

  const select = useCallback((path: string) => go({ folder: parentOf(path), selected: path }), [go]);
  const openFolder = useCallback((path: string) => go({ folder: path, selected: null }), [go]);

  /** A folder that Right or Enter stepped into before it was listed: its first row is selected when it arrives. */
  const awaitingFirst = useRef<string | null>(null);

  const descend = useCallback(
    (path: string) => {
      const first = visibleEntries(path, latest.current.showHidden)[0];
      awaitingFirst.current = first ? null : path;
      go({ folder: path, selected: first?.path ?? null });
    },
    [go],
  );

  useEffect(() => {
    if (awaitingFirst.current !== folder || listing?.status !== 'ready') return;
    awaitingFirst.current = null;
    if (selected === null && rows[0]) setLocation({ folder, selected: rows[0].path });
  }, [folder, listing, rows, selected]);

  const goUp = useCallback(() => {
    const { folder: from } = latest.current.location;
    if (from) go({ folder: parentOf(from), selected: from });
  }, [go]);

  // The folder was deleted, or the window was opened on a file: step up to something that can be listed.
  useEffect(() => {
    if (listing?.status !== 'error' || !folder) return;
    setLocation({ folder: parentOf(folder), selected: listing.errorCode === 'not_a_directory' ? folder : null });
  }, [listing, folder]);

  // The selected row was deleted: the row that took its place is selected, so the keyboard keeps its footing.
  const lastRows = useRef<FsEntry[]>([]);
  useEffect(() => {
    if (selected && listing?.status === 'ready' && !rows.some((entry) => entry.path === selected)) {
      const index = lastRows.current.findIndex((entry) => entry.path === selected);
      const next = rows[Math.min(Math.max(index, 0), rows.length - 1)];
      setLocation({ folder, selected: next?.path ?? null });
    }
    lastRows.current = rows;
  }, [rows, selected, listing, folder]);

  const moveBy = useCallback(
    (delta: number) => {
      const { rows: list, location: at } = latest.current;
      if (list.length === 0) return;
      const index = list.findIndex((entry) => entry.path === at.selected);
      const next = index < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, index + delta));
      select(list[next]!.path);
    },
    [select],
  );

  // ---------------------------------------------------------------- peek

  const originOf = useCallback((path: string): PeekOrigin | null => {
    const row = root.current?.querySelector(`[data-testid="files-row"][data-path="${CSS.escape(path)}"]`);
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  }, []);

  const navigate = useRef<(key: PeekKey) => void>(() => undefined);

  const showPeek = useCallback(
    (entry: FsEntry) => {
      if (entry.kind === 'dir') return;
      usePeekStore.getState().show({
        entry,
        origin: originOf(entry.path),
        owner: windowId,
        navigate: (key) => navigate.current(key),
      });
    },
    [originOf, windowId],
  );

  const togglePeek = useCallback(() => {
    const peek = usePeekStore.getState();
    const entry = latest.current.selectedEntry;
    if (peek.target?.owner === windowId) peek.close();
    else if (entry) showPeek(entry);
  }, [showPeek, windowId]);

  // Peek follows the selection, and closes when the selection is no longer a file.
  useEffect(() => {
    const peek = usePeekStore.getState();
    if (peek.target?.owner !== windowId) return;
    if (selectedEntry && selectedEntry.kind !== 'dir') peek.follow(windowId, selectedEntry, originOf(selectedEntry.path));
    else peek.close(windowId);
  }, [selectedEntry, originOf, windowId]);

  // It belongs to the front window: another window coming forward, or this one closing, puts it away.
  useEffect(() => {
    if (!focused) usePeekStore.getState().close(windowId);
  }, [focused, windowId]);
  useEffect(() => () => usePeekStore.getState().close(windowId), [windowId]);

  // ---------------------------------------------------------------- acting on files

  const openInEditor = useCallback(
    (entry: FsEntry) => {
      usePeekStore.getState().close(windowId);
      useShellStore.getState().launchApp('editor', { path: entry.path });
    },
    [windowId],
  );

  const open = useCallback(
    (entry: FsEntry) => {
      if (entry.kind === 'dir') descend(entry.path);
      else if (opensInEditor(entry)) openInEditor(entry);
      else showPeek(entry);
    },
    [descend, openInEditor, showPeek],
  );

  const startNew = useCallback((mode: 'new-file' | 'new-folder') => {
    usePeekStore.getState().close(windowId);
    setConfirming(null);
    setDraft({ mode, folder: latest.current.location.folder });
  }, [windowId]);

  const startRename = useCallback(() => {
    const entry = latest.current.selectedEntry;
    if (!entry) return;
    usePeekStore.getState().close(windowId);
    setConfirming(null);
    setDraft({ mode: 'rename', path: entry.path });
  }, [windowId]);

  const cancelDraft = useCallback(() => {
    setDraft(null);
    focusRoot();
  }, [focusRoot]);

  const commitDraft = useCallback(
    (name: string) => {
      const current = latest.current.draft;
      setDraft(null);
      focusRoot();
      if (!current) return;
      const problem = nameProblem(name);
      if (problem) return say(problem);

      if (current.mode === 'rename') {
        const to = joinPath(parentOf(current.path), name);
        // Asked here first: a refused request would only say the same thing later.
        if (findEntry(to)) return say(`There is already something named ${name} here.`);
        api.fs.rename(current.path, to).then(
          (entry) => {
            replaceEntry(current.path, entry);
            setLocation((at) => (at.selected === current.path ? { folder: at.folder, selected: entry.path } : at));
          },
          (error: unknown) =>
            say(
              error instanceof ApiRequestError && error.code === 'conflict'
                ? `There is already something named ${name} here.`
                : failureText(error, `${nameOf(current.path)} could not be renamed.`),
            ),
        );
        return;
      }

      const path = joinPath(current.folder, name);
      if (findEntry(path)) return say(`There is already something named ${name} here.`);
      const made = current.mode === 'new-folder' ? api.fs.mkdir(path) : api.fs.write(path, '');
      made.then(
        (entry) => {
          putEntry(entry);
          setLocation({ folder: current.folder, selected: entry.path });
        },
        (error: unknown) => say(failureText(error, `${name} could not be created.`)),
      );
    },
    [focusRoot, say],
  );

  const askDelete = useCallback(() => {
    const entry = latest.current.selectedEntry;
    if (entry) setConfirming(entry.path);
  }, []);

  const cancelDelete = useCallback(() => {
    setConfirming(null);
    focusRoot();
  }, [focusRoot]);

  const confirmDelete = useCallback(() => {
    const path = latest.current.confirming;
    setConfirming(null);
    focusRoot();
    if (!path) return;
    api.fs.remove(path).then(
      () => removeEntry(path),
      (error: unknown) => say(failureText(error, `${nameOf(path)} could not be deleted.`)),
    );
  }, [focusRoot, say]);

  const copyPath = useCallback(() => {
    const { location: at } = latest.current;
    const relative = at.selected ?? at.folder;
    const home = useSystemStore.getState().info?.home;
    const full = home ? [home.replace(/\/+$/, ''), relative].filter(Boolean).join('/') : relative;
    void copyText(full).then(() => say(`Copied ${full}`));
  }, [say]);

  const moveInto = useCallback(
    (from: string, target: string) => {
      if (parentOf(from) === target) return;
      if (isWithin(target, from)) return say('A folder cannot be moved into itself.');
      const name = nameOf(from);
      if (findEntry(joinPath(target, name))) return say(`${target ? nameOf(target) : 'Home'} already has something named ${name}.`);
      api.fs.rename(from, joinPath(target, name)).then(
        (entry) => {
          replaceEntry(from, entry);
          setLocation((at) => (at.selected && isWithin(at.selected, from) ? { folder: at.folder, selected: null } : at));
        },
        (error: unknown) =>
          say(
            error instanceof ApiRequestError && error.code === 'conflict'
              ? `${target ? nameOf(target) : 'Home'} already has something named ${name}.`
              : failureText(error, `${name} could not be moved.`),
          ),
      );
    },
    [say],
  );

  const command = useCallback(
    (name: FilesCommand) => {
      const entry = latest.current.selectedEntry;
      switch (name) {
        case 'new-file':
        case 'new-folder':
          return startNew(name);
        case 'open':
          return entry && open(entry);
        case 'open-in-editor':
          return entry && entry.kind !== 'dir' && openInEditor(entry);
        case 'peek':
          return togglePeek();
        case 'rename':
          return startRename();
        case 'delete':
          return askDelete();
        case 'copy-path':
          return copyPath();
        case 'go-up':
          return goUp();
        case 'go-home':
          return openFolder('');
        case 'go-projects':
          return openFolder('Projects');
        case 'go-workspaces':
          return openFolder('Workspaces');
        case 'toggle-hidden':
          return setShowHidden((shown) => !shown);
      }
    },
    [askDelete, copyPath, goUp, open, openFolder, openInEditor, startNew, startRename, togglePeek],
  );

  useEffect(() => registerFilesWindow(windowId, command), [windowId, command]);

  // ---------------------------------------------------------------- keyboard

  const onNavigationKey = useCallback(
    (key: string): boolean => {
      const { selectedEntry: entry } = latest.current;
      if (key === 'ArrowDown') moveBy(1);
      else if (key === 'ArrowUp') moveBy(-1);
      else if (key === 'ArrowRight') {
        if (entry?.kind === 'dir') descend(entry.path);
      } else if (key === 'ArrowLeft') goUp();
      else return false;
      return true;
    },
    [descend, goUp, moveBy],
  );
  navigate.current = onNavigationKey;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // Keys typed into a name field or the context menu are theirs.
    if (!root.current?.contains(target) || target.closest('input, textarea, button, [role="menu"]')) return;
    const { key } = event;
    const mod = event.ctrlKey || event.metaKey;

    if (confirming) {
      if (key === 'Enter' || key === 'Delete') confirmDelete();
      else cancelDelete();
      if (key === 'Enter' || key === 'Delete' || key === 'Escape') {
        event.preventDefault();
        return;
      }
    }

    if (mod && !event.altKey && event.code === 'KeyN') {
      startNew(event.shiftKey ? 'new-folder' : 'new-file');
    } else if (mod || event.altKey) {
      return;
    } else if (onNavigationKey(key)) {
      // Moved.
    } else if (key === 'Home') {
      if (rows[0]) select(rows[0].path);
    } else if (key === 'End') {
      if (rows.length > 0) select(rows.at(-1)!.path);
    } else if (key === 'Enter') {
      if (selectedEntry) open(selectedEntry);
    } else if (key === ' ') {
      togglePeek();
    } else if (key === 'Backspace') {
      goUp();
    } else if (key === 'F2') {
      startRename();
    } else if (key === 'Delete') {
      askDelete();
    } else if (key.length === 1) {
      // Type-ahead: letters typed in quick succession select the first row that starts with them.
      const now = Date.now();
      const text = (now - typed.current.at > TYPE_AHEAD_MS ? '' : typed.current.text) + key.toLowerCase();
      const match = rows.find((entry) => entry.name.toLowerCase().startsWith(text));
      if (match) select(match.path);
      typed.current = { text, at: now };
    } else {
      return;
    }
    event.preventDefault();
  };

  // ---------------------------------------------------------------- focus and scrolling

  // The front window takes the keyboard, unless a field inside it already has it.
  useEffect(() => {
    if (focused && !root.current?.contains(document.activeElement)) focusRoot();
  }, [focused, focusRoot]);

  // A new column slides into view at the right end.
  const columnKey = `${folder}\n${preview ?? ''}\n${selectedEntry ? 'details' : ''}`;
  const firstScroll = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const instant = firstScroll.current || prefersReducedMotion();
    firstScroll.current = false;
    element.scrollTo({ left: element.scrollWidth, behavior: instant ? 'auto' : 'smooth' });
  }, [columnKey]);

  // ---------------------------------------------------------------- context menu

  const openMenu = useCallback(
    (event: MouseEvent, inFolder: string, entry: FsEntry | null) => {
      event.preventDefault();
      event.stopPropagation();
      usePeekStore.getState().close(windowId);
      go(entry ? { folder: parentOf(entry.path), selected: entry.path } : { folder: inFolder, selected: null });
      setMenu({ x: event.clientX, y: event.clientY, entry });
    },
    [go, windowId],
  );

  const closeMenu = useCallback(() => {
    setMenu(null);
    focusRoot();
  }, [focusRoot]);

  const menuItems = useMemo<ContextItem[]>(() => {
    if (!menu) return [];
    const { entry } = menu;
    const none = entry === null;
    const rule: ContextItem = { label: '', separator: true };
    return [
      { label: 'Open', shortcut: 'Enter', disabled: none, action: () => entry && open(entry) },
      { label: 'Open in Editor', disabled: none || entry.kind === 'dir', action: () => entry && openInEditor(entry) },
      { label: 'Peek', shortcut: 'Space', disabled: none || entry.kind === 'dir', action: () => entry && showPeek(entry) },
      rule,
      { label: 'Rename', shortcut: 'F2', disabled: none, action: startRename },
      { label: 'Delete', shortcut: 'Del', disabled: none, danger: true, action: askDelete },
      rule,
      { label: 'New file', shortcut: 'Ctrl N', action: () => startNew('new-file') },
      { label: 'New folder', shortcut: 'Ctrl Shift N', action: () => startNew('new-folder') },
      rule,
      { label: 'Copy path', action: copyPath },
    ];
  }, [menu, open, openInEditor, showPeek, startRename, askDelete, startNew, copyPath]);

  const actions = useMemo<ColumnActions>(
    () => ({
      select,
      open,
      openFolder,
      contextMenu: openMenu,
      commitDraft,
      cancelDraft,
      confirmDelete,
      cancelDelete,
      moveInto,
      setDropTarget,
    }),
    [select, open, openFolder, openMenu, commitDraft, cancelDraft, confirmDelete, cancelDelete, moveInto],
  );

  // ---------------------------------------------------------------- render

  // One list, so a column keeps its element (and its scroll position) when the selection steps into it.
  const columns = preview ? [...chain, preview] : chain;
  const crumbs = columns;
  const hiddenCount = (listing?.entries.length ?? 0) - rows.length - (listing?.entries.filter((entry) => leaving[entry.path]).length ?? 0);
  const count = rows.length;

  return (
    <div
      ref={root}
      className="files"
      data-testid="app-files"
      data-focused={focused || undefined}
      data-folder={folder}
      data-selected-path={selected ?? ''}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <Sidebar
        current={preview ?? folder}
        dropTarget={dropTarget}
        onGo={(path) => {
          openFolder(path);
          focusRoot();
        }}
        actions={actions}
      />

      <div className="files__main">
        <header className="files-bar">
          <button
            type="button"
            className="files-bar__key"
            data-testid="files-up"
            aria-label="Up one folder"
            title="Up one folder (Backspace)"
            disabled={!folder}
            onClick={() => {
              goUp();
              focusRoot();
            }}
          >
            <Glyph name="arrow-up" size={14} />
          </button>
          <nav className="files-crumbs" data-testid="files-crumbs" aria-label="Path">
            {crumbs.map((path, index) => (
              <span className="files-crumbs__step" key={path}>
                {index > 0 && <Glyph name="chevron-right" size={10} className="files-crumbs__rule" />}
                <button
                  type="button"
                  className="files-crumbs__crumb"
                  data-testid="files-crumb"
                  data-path={path}
                  aria-current={index === crumbs.length - 1 ? 'location' : undefined}
                  aria-label={path ? undefined : 'Home'}
                  title={path || 'Home'}
                  onClick={() => {
                    openFolder(path);
                    focusRoot();
                  }}
                >
                  {path ? nameOf(path) : <Glyph name="home" size={14} />}
                </button>
              </span>
            ))}
          </nav>
          <button
            type="button"
            className="files-bar__button"
            data-testid="files-new-file"
            title="New file (Ctrl N)"
            onClick={() => startNew('new-file')}
          >
            <Glyph name="plus" size={12} />
            File
          </button>
          <button
            type="button"
            className="files-bar__button"
            data-testid="files-new-folder"
            title="New folder (Ctrl Shift N)"
            onClick={() => startNew('new-folder')}
          >
            <Glyph name="plus" size={12} />
            Folder
          </button>
        </header>

        <div
          className="files-columns"
          ref={scroller}
          data-testid="files-columns"
          // Columns that have slid out to the left fade at the edge instead of ending in a sliver.
          onScroll={(event) => event.currentTarget.toggleAttribute('data-scrolled', event.currentTarget.scrollLeft > 0)}
        >
          {columns.map((path, index) => (
            <Column
              key={path}
              folder={path}
              selected={index < chain.length - 1 ? chain[index + 1]! : index === chain.length - 1 ? selected : null}
              active={index === chain.length - 1}
              showHidden={showHidden}
              draft={draft}
              confirming={confirming}
              dropTarget={dropTarget}
              actions={actions}
            />
          ))}
          {selectedEntry && (
            <Details
              key="details"
              entry={selectedEntry}
              onOpenInEditor={openInEditor}
              onPeek={showPeek}
              onShow={(path) => {
                select(path);
                focusRoot();
              }}
            />
          )}
        </div>

        <footer className="files-foot">
          <p className="files-foot__count" data-testid="files-count">
            {listing?.status === 'ready' ? `${count} ${count === 1 ? 'item' : 'items'}` : ''}
            {hiddenCount > 0 && <span className="files-foot__hidden">{hiddenCount} hidden</span>}
          </p>
          <p className="files-foot__notice" role="status" data-testid="files-notice">
            {notice}
          </p>
        </footer>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
    </div>
  );
}
