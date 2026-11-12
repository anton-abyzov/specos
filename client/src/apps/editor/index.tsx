import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { redo, selectAll, undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { Compartment, EditorState, Text, Transaction, type ChangeSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { diffLines } from 'diff';
import type { Actor } from '@shared/protocol';
import type { AppProps } from '../registry';
import { agentColor } from '../../design/color';
import { AppIcon, Glyph, type GlyphName } from '../../design/icons';
import { setCloseGuard } from '../../desktop/wm/close-guard';
import { useWindowsStore } from '../../desktop/wm/store';
import { api, ApiRequestError } from '../../lib/api';
import { events } from '../../lib/events';
import { useShellStore } from '../../stores/shell';
import { useTheme } from '../../stores/theme';
import { baseExtensions, clearFlash, extensionOf, flashLines, isMarkdown, languageFor } from './codemirror';
import { editorWindows } from './menus';
import { Preview } from './Preview';
import { forgetFile, recentFiles, rememberFile } from './recent';
import './editor.css';

/** Text files up to this size are opened; anything larger gets a message. */
const MAX_BYTES = 2 * 1024 * 1024;
/** How many lines one reload marks; a rewrite of a whole long file does not need them all. */
const MAX_FLASHED_LINES = 2000;
const FLASH_MS = 1700;

type Refusal =
  | { reason: 'large'; size: number }
  | { reason: 'binary' }
  | { reason: 'folder' }
  | { reason: 'missing' }
  | { reason: 'error'; message: string };

type Loaded = { text: string } | Refusal;

type Notice =
  | { kind: 'changed'; text: string; actor: Actor }
  | { kind: 'deleted' }
  | { kind: 'save-failed'; message: string };

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function glyphFor(path: string): GlyphName {
  const extension = extensionOf(path);
  if (extension === 'md' || extension === 'markdown') return 'file-markdown';
  return languageFor(path).support ? 'file-code' : 'file-text';
}

/** Reads the file as text, or says why the Editor will not show it. */
async function loadFile(path: string): Promise<Loaded> {
  try {
    const entry = await api.fs.find(path);
    if (!entry) return { reason: 'missing' };
    if (entry.kind === 'dir') return { reason: 'folder' };
    if (entry.size > MAX_BYTES) return { reason: 'large', size: entry.size };
    const response = await fetch(api.fs.readUrl(path), { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return response.status === 404 ? { reason: 'missing' } : { reason: 'error', message: `The server answered ${response.status}.` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { reason: 'large', size: bytes.length };
    // A NUL byte, or bytes that are not UTF-8, mean this is not text.
    if (bytes.subarray(0, 8192).includes(0)) return { reason: 'binary' };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { reason: 'binary' };
    }
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return { reason: 'missing' };
    return { reason: 'error', message: error instanceof Error ? error.message : 'The file could not be read.' };
  }
}

const toDoc = (text: string): Text => Text.of(text.split(/\r\n|\r|\n/));

/** The colours a change is marked in: the agent's own, or the accent for the user's. */
function authorColours(actor: Actor): { soft: string; solid: string } {
  if (actor.type === 'me') return { soft: 'var(--accent-soft)', solid: 'var(--accent)' };
  const palette = agentColor(actor.hue);
  return { soft: palette.soft, solid: palette.solid };
}

/**
 * The edits that turn the buffer into `next`, line by line, so the cursor and
 * the scroll position stay with the text around them; and where each new or
 * changed line starts in the result.
 */
function lineChanges(current: string, next: string): { changes: ChangeSpec[]; lines: number[] } {
  const changes: ChangeSpec[] = [];
  const lines: number[] = [];
  let from = 0;
  let to = 0;
  for (const part of diffLines(current, next)) {
    const length = part.value.length;
    if (part.removed) {
      changes.push({ from, to: from + length });
      from += length;
    } else if (part.added) {
      changes.push({ from, insert: part.value });
      for (let start = 0; start < length && lines.length < MAX_FLASHED_LINES; ) {
        lines.push(to + start);
        const end = part.value.indexOf('\n', start);
        if (end === -1) break;
        start = end + 1;
      }
      to += length;
    } else {
      from += length;
      to += length;
    }
  }
  return { changes, lines };
}

/** Makes this window show `path`, as if it had been opened with it. */
function showInWindow(windowId: string, path: string): void {
  useWindowsStore.setState((state) => {
    const window = state.windows[windowId];
    return window ? { windows: { ...state.windows, [windowId]: { ...window, params: { path } } } } : {};
  });
}

const showInFiles = (path: string, asFolder = false): void => {
  useShellStore
    .getState()
    .launchApp('files', asFolder ? { path } : { path: folderOf(path), select: path });
};

// ---------------------------------------------------------------- no file yet

function EmptyState({ windowId }: { windowId: string }) {
  const [recent, setRecent] = useState(recentFiles);
  const stopWatching = useRef<(() => void) | null>(null);
  useEffect(() => () => stopWatching.current?.(), []);

  /** Opens the launcher to pick a file. The file opens in a window of its own, and this empty one makes way. */
  const openWithLauncher = () => {
    stopWatching.current?.();
    const before = new Set(Object.keys(useWindowsStore.getState().windows));
    const stopWindows = useWindowsStore.subscribe((state) => {
      const opened = Object.values(state.windows).some(
        (window) => !before.has(window.id) && window.appId === 'editor' && typeof window.params.path === 'string',
      );
      if (!opened) return;
      stop();
      state.close(windowId, true);
    });
    const stopShell = useShellStore.subscribe((state) => {
      if (!state.launcherOpen) queueMicrotask(stop);
    });
    const stop = () => {
      stopWindows();
      stopShell();
      stopWatching.current = null;
    };
    stopWatching.current = stop;
    if (!useShellStore.getState().launcherOpen) useShellStore.getState().toggleLauncher();
  };

  return (
    <div className="editor editor--empty" data-testid="editor-empty">
      <div className="editor-empty">
        <AppIcon id="editor" size={44} />
        <h1 className="editor-empty__title">Open a file to edit</h1>
        <p className="editor-empty__text">
          Find any file in the home folder with the launcher. Changes that agents make to an open file show up here as
          they happen.
        </p>
        <button type="button" className="editor-button editor-button--primary" data-testid="editor-open" onClick={openWithLauncher}>
          Open…
          <kbd>Ctrl K</kbd>
        </button>

        <section className="editor-empty__recent" aria-labelledby={`${windowId}-recent`}>
          <h2 id={`${windowId}-recent`}>Recent files</h2>
          {recent.length === 0 ? (
            <p className="editor-empty__none">Nothing yet. Files you open are listed here for next time.</p>
          ) : (
            <ul>
              {recent.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className="editor-recent"
                    data-testid="editor-recent"
                    onClick={() => showInWindow(windowId, path)}
                  >
                    <Glyph name={glyphFor(path)} size={16} />
                    <span className="editor-recent__name">{nameOf(path)}</span>
                    <span className="editor-recent__folder">{folderOf(path) || 'Home'}</span>
                  </button>
                  <button
                    type="button"
                    className="editor-recent__forget"
                    aria-label={`Remove ${nameOf(path)} from recent files`}
                    title="Remove from recent files"
                    onClick={() => {
                      forgetFile(path);
                      setRecent(recentFiles());
                    }}
                  >
                    <Glyph name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- a file the Editor will not show

interface RefusedProps {
  path: string;
  refusal: Refusal;
  onRetry(): void;
}

function Refused({ path, refusal, onRetry }: RefusedProps) {
  const name = nameOf(path);
  const [failure, setFailure] = useState('');
  const create = () => {
    api.fs.write(path, '').then(onRetry, (error: unknown) => {
      setFailure(error instanceof Error ? error.message : 'The file could not be created.');
    });
  };

  const copy: Record<Refusal['reason'], { title: string; text: string }> = {
    large: {
      title: 'Too large to edit here',
      text: `${name} is ${refusal.reason === 'large' ? megabytes(refusal.size) : 'large'}. The Editor opens text files up to 2 MB.`,
    },
    binary: { title: 'Not a text file', text: `${name} holds binary data, so there is no text to show.` },
    folder: { title: 'This is a folder', text: `${path || 'Home'} is a folder. Files can show what is in it.` },
    missing: { title: 'No file here', text: `Nothing exists at ${path}. It may have been moved or deleted.` },
    error: { title: 'The file could not be opened', text: refusal.reason === 'error' ? refusal.message : '' },
  };
  const { title, text } = copy[refusal.reason];

  return (
    <div className="editor editor--refused" data-testid="editor-refused" data-reason={refusal.reason}>
      <div className="editor-refused">
        <span className="editor-refused__mark">
          <Glyph name={refusal.reason === 'folder' ? 'folder' : 'file'} size={22} />
        </span>
        <h1 className="editor-refused__title">{title}</h1>
        <p className="editor-refused__text">{text}</p>
        {failure && (
          <p className="editor-refused__text" role="alert">
            {failure}
          </p>
        )}
        <div className="editor-refused__actions">
          {(refusal.reason === 'large' || refusal.reason === 'binary') && (
            <button type="button" className="editor-button editor-button--primary" onClick={() => showInFiles(path)}>
              Show in Files
            </button>
          )}
          {refusal.reason === 'folder' && (
            <button type="button" className="editor-button editor-button--primary" onClick={() => showInFiles(path, true)}>
              Open in Files
            </button>
          )}
          {refusal.reason === 'missing' && (
            <button type="button" className="editor-button editor-button--primary" onClick={create}>
              Create {name}
            </button>
          )}
          {(refusal.reason === 'error' || refusal.reason === 'missing') && (
            <button type="button" className="editor-button" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      </div>
      <footer className="editor__status">
        <PathLabel path={path} />
      </footer>
    </div>
  );
}

function PathLabel({ path }: { path: string }) {
  const folder = folderOf(path);
  return (
    <span className="editor__path selectable" title={path} data-testid="editor-path">
      {folder && <span className="editor__folder">{folder}/</span>}
      <span className="editor__name">{nameOf(path)}</span>
    </span>
  );
}

// ---------------------------------------------------------------- the buffer

interface BufferProps {
  windowId: string;
  path: string;
  initialText: string;
  focused: boolean;
  setTitle(title: string): void;
}

function Buffer({ windowId, path, initialText, focused, setTitle }: BufferProps) {
  const name = nameOf(path);
  const language = useMemo(() => languageFor(path), [path]);
  const markdownFile = isMarkdown(path);
  const theme = useTheme();

  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const previewScroller = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const darkness = useRef(new Compartment());
  /** The text on disk as far as this window knows; null when the file is gone. */
  const baseline = useRef<Text | null>(null);
  const crlf = useRef(initialText.includes('\r\n'));
  const dirtyNow = useRef(false);
  const saving = useRef<Promise<boolean> | null>(null);
  const refreshes = useRef(0);
  const flashTimer = useRef(0);
  const previewTimer = useRef(0);

  const [dirty, setDirty] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preview, setPreview] = useState(false);
  const [previewText, setPreviewText] = useState(initialText);
  const [asking, setAsking] = useState(false);
  const [reloads, setReloads] = useState(0);

  const markDirty = useCallback((value: boolean) => {
    dirtyNow.current = value;
    setDirty(value);
  }, []);

  /** Compares the buffer with what is on disk. Undoing back to the saved text is clean again. */
  const checkDirty = useCallback(() => {
    const doc = view.current?.state.doc;
    markDirty(!doc || !baseline.current || !doc.eq(baseline.current));
  }, [markDirty]);

  // The editor itself: made once for this file.
  useEffect(() => {
    const created = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          baseExtensions(language),
          darkness.current.of(EditorView.darkTheme.of(document.documentElement.dataset.theme === 'dark')),
          EditorView.contentAttributes.of({ 'aria-label': `Contents of ${name}`, 'data-testid': 'editor-content' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              checkDirty();
              window.clearTimeout(previewTimer.current);
              previewTimer.current = window.setTimeout(() => setPreviewText(update.state.doc.toString()), 120);
            }
            if (update.docChanged || update.selectionSet) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              const next = { line: line.number, column: head - line.from + 1 };
              setCursor((held) => (held.line === next.line && held.column === next.column ? held : next));
            }
          }),
        ],
      }),
    });
    view.current = created;
    baseline.current = created.state.doc;
    rememberFile(path);
    // Tests read the buffer through this.
    const hook = (window.__specos ??= {});
    const editors = (hook.editors ??= {}) as Record<string, unknown>;
    editors[windowId] = created;
    return () => {
      delete editors[windowId];
      window.clearTimeout(flashTimer.current);
      window.clearTimeout(previewTimer.current);
      view.current = null;
      created.destroy();
    };
    // Made once: the parent gives a new key for another file or a fresh load.
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: darkness.current.reconfigure(EditorView.darkTheme.of(theme === 'dark')) });
  }, [theme]);

  useEffect(() => {
    setTitle(dirty ? `● ${name}` : name);
  }, [dirty, name, setTitle]);

  /** Writes the buffer to disk. Resolves true when the file holds what was in the buffer. */
  const save = useCallback((): Promise<boolean> => {
    if (saving.current) return saving.current;
    const editor = view.current;
    if (!editor) return Promise.resolve(false);
    const doc = editor.state.doc;
    const attempt = api.fs.write(path, doc.sliceString(0, doc.length, crlf.current ? '\r\n' : '\n')).then(
      () => {
        baseline.current = doc;
        checkDirty();
        setNotice(null);
        return true;
      },
      (error: unknown) => {
        setNotice({ kind: 'save-failed', message: error instanceof Error ? error.message : 'The server did not answer.' });
        return false;
      },
    );
    saving.current = attempt;
    void attempt.finally(() => {
      saving.current = null;
    });
    return attempt;
  }, [path, checkDirty]);

  /** Replaces the buffer with the text on disk, in place, and marks what changed in its author's colour. */
  const takeFromDisk = useCallback(
    (text: string, actor: Actor, undoable: boolean) => {
      const editor = view.current;
      if (!editor) return;
      const { changes, lines } = lineChanges(editor.state.doc.toString(), text.replace(/\r\n?/g, '\n'));
      editor.dispatch({
        changes,
        effects: flashLines.of({ lines, ...authorColours(actor) }),
        // What someone else wrote is not the user's to undo; their own text replaced by a reload is.
        annotations: undoable ? undefined : Transaction.addToHistory.of(false),
      });
      crlf.current = text.includes('\r\n');
      baseline.current = editor.state.doc;
      markDirty(false);
      setNotice(null);
      setReloads((count) => count + 1);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => view.current?.dispatch({ effects: clearFlash.of(null) }), FLASH_MS);
    },
    [markDirty],
  );

  /** Looks at the file again after a change on disk and decides what the window does about it. */
  const refresh = useCallback(
    async (actor: Actor, force = false) => {
      const turn = (refreshes.current += 1);
      const loaded = await loadFile(path);
      const editor = view.current;
      if (turn !== refreshes.current || !editor || !('text' in loaded)) return;
      const disk = toDoc(loaded.text);
      const held = baseline.current;
      // The file holds what this window last saw: its own save, or a touch that changed nothing.
      if (held && disk.eq(held)) {
        if (force && !editor.state.doc.eq(held)) takeFromDisk(loaded.text, actor, true);
        return;
      }
      const clean = held !== null && editor.state.doc.eq(held);
      if (clean) takeFromDisk(loaded.text, actor, false);
      else if (force) takeFromDisk(loaded.text, actor, true);
      else if (editor.state.doc.eq(disk)) {
        // Someone wrote exactly what is in the buffer.
        baseline.current = editor.state.doc;
        markDirty(false);
        setNotice(null);
      } else setNotice({ kind: 'changed', text: loaded.text, actor });
    },
    [path, takeFromDisk, markDirty],
  );

  useEffect(
    () =>
      events.subscribe('fs', ({ entry }) => {
        const gone =
          (entry.path === path && entry.kind === 'unlink') ||
          (entry.kind === 'unlinkDir' && path.startsWith(`${entry.path}/`));
        if (gone) {
          refreshes.current += 1;
          baseline.current = null;
          markDirty(true);
          setNotice({ kind: 'deleted' });
        } else if (entry.path === path && (entry.kind === 'add' || entry.kind === 'change')) {
          void refresh(entry.actor);
        }
      }),
    [path, refresh, markDirty],
  );

  const closeWindow = useCallback(() => useWindowsStore.getState().close(windowId, true), [windowId]);

  // Closing with unsaved changes asks first.
  useEffect(
    () =>
      setCloseGuard(windowId, () => {
        if (!dirtyNow.current) return true;
        const windows = useWindowsStore.getState();
        windows.setOverview(false);
        windows.focus(windowId);
        setAsking(true);
        return false;
      }),
    [windowId],
  );

  const togglePreview = useCallback(() => {
    if (!markdownFile) return;
    setPreviewText(view.current?.state.doc.toString() ?? '');
    setPreview((shown) => !shown);
  }, [markdownFile]);

  // The preview follows the editor's scroll position, by proportion.
  useEffect(() => {
    const scroller = view.current?.scrollDOM;
    if (!preview || !scroller) return;
    const follow = () => {
      const page = previewScroller.current;
      if (!page) return;
      const range = scroller.scrollHeight - scroller.clientHeight;
      page.scrollTop = range > 0 ? (scroller.scrollTop / range) * (page.scrollHeight - page.clientHeight) : 0;
    };
    scroller.addEventListener('scroll', follow, { passive: true });
    return () => scroller.removeEventListener('scroll', follow);
  }, [preview]);

  // The menu bar reaches this buffer through the table in menus.ts.
  useEffect(() => {
    const withView = (command: (editor: EditorView) => unknown) => () => {
      const editor = view.current;
      if (!editor) return;
      command(editor);
      editor.focus();
    };
    editorWindows.set(windowId, {
      save: () => void save(),
      reload: () => void refresh({ type: 'me' }, true),
      undo: withView(undo),
      redo: withView(redo),
      // The search panel takes the keyboard itself.
      find: () => view.current && openSearchPanel(view.current),
      selectAll: withView(selectAll),
      togglePreview,
      focus: () => view.current?.focus(),
    });
    return () => {
      editorWindows.delete(windowId);
    };
  }, [windowId, save, refresh, togglePreview]);

  // The keyboard follows the window; the overview and the launcher borrow it and give it back.
  const covered = useShellStore((state) => state.overviewOpen || state.launcherOpen);
  useEffect(() => {
    if (focused && !covered && !asking) view.current?.focus();
  }, [focused, covered, asking]);

  // A press on the title bar takes the focus off the text; hand it back.
  useEffect(() => {
    const frame = root.current?.closest<HTMLElement>('.wm-frame');
    if (!frame) return;
    const onPointerUp = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest('.window__bar') || target.closest('.window__controls')) return;
      requestAnimationFrame(() => {
        if (frame.hasAttribute('data-focused') && !root.current?.querySelector('.editor-ask')) view.current?.focus();
      });
    };
    frame.addEventListener('pointerup', onPointerUp);
    return () => frame.removeEventListener('pointerup', onPointerUp);
  }, []);

  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && !event.shiftKey && event.code === 'KeyS') {
      // Saving is the Editor's, never the browser's "save page".
      event.preventDefault();
      event.stopPropagation();
      void save();
    } else if (markdownFile && event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyV') {
      event.preventDefault();
      event.stopPropagation();
      togglePreview();
    }
  };

  const saved = notice?.kind === 'save-failed' ? 'failed' : notice?.kind === 'deleted' ? 'deleted' : dirty ? 'edited' : 'saved';
  const savedText = { saved: 'Saved', edited: 'Edited', failed: 'Not saved', deleted: 'Deleted on disk' }[saved];

  return (
    <div
      className="editor"
      ref={root}
      data-testid="app-editor"
      data-dirty={dirty || undefined}
      data-reloads={reloads}
      data-language={language.label}
      onKeyDownCapture={onKeyDownCapture}
    >
      {notice && (
        <Banner
          notice={notice}
          onReload={() => notice.kind === 'changed' && takeFromDisk(notice.text, notice.actor, true)}
          onKeep={() => {
            setNotice(null);
            view.current?.focus();
          }}
          onSave={() => void save()}
        />
      )}
      <div className="editor__main" data-preview={preview || undefined}>
        <div className="editor__code" ref={host} />
        {preview && <Preview text={previewText} path={path} scroller={previewScroller} />}
      </div>
      <footer className="editor__status" data-testid="editor-status">
        <PathLabel path={path} />
        {markdownFile && (
          <button
            type="button"
            className="editor__toggle"
            data-testid="editor-preview-toggle"
            aria-pressed={preview}
            title="Show or hide the preview (Ctrl Shift V)"
            onClick={togglePreview}
          >
            <Glyph name="eye" size={14} />
            Preview
          </button>
        )}
        <span className="editor__fact" data-testid="editor-language">
          {language.label}
        </span>
        <span className="editor__fact editor__fact--cursor tabular" data-testid="editor-cursor" title="Line and column">
          {cursor.line}:{cursor.column}
        </span>
        <span className="editor__saved" data-state={saved} data-testid="editor-saved">
          <span className="editor__saved-dot" aria-hidden="true" />
          {savedText}
        </span>
      </footer>
      {asking && (
        <AskBeforeClosing
          name={name}
          onSave={() => void save().then((written) => (written ? closeWindow() : setAsking(false)))}
          onDiscard={closeWindow}
          onCancel={() => setAsking(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- banner and question

interface BannerProps {
  notice: Notice;
  onReload(): void;
  onKeep(): void;
  onSave(): void;
}

function Banner({ notice, onReload, onKeep, onSave }: BannerProps) {
  const agent = notice.kind === 'changed' && notice.actor.type !== 'me' ? notice.actor : null;
  return (
    <div
      className="editor-banner"
      role="status"
      data-testid="editor-banner"
      data-kind={notice.kind}
      style={agent ? { '--banner-mark': agentColor(agent.hue).solid, '--banner-name': agentColor(agent.hue).text } as CSSProperties : undefined}
    >
      <span className="editor-banner__mark" aria-hidden="true" />
      {notice.kind === 'changed' && (
        <>
          <p className="editor-banner__text">
            {agent ? (
              <>
                <strong>{agent.name}</strong> changed this file on disk while you were editing.
              </>
            ) : (
              'This file changed on disk while you were editing.'
            )}
          </p>
          <button type="button" className="editor-button" data-testid="editor-reload" onClick={onReload}>
            Reload
          </button>
          <button type="button" className="editor-button" data-testid="editor-keep" onClick={onKeep}>
            Keep mine
          </button>
        </>
      )}
      {notice.kind === 'deleted' && (
        <>
          <p className="editor-banner__text">This file was deleted on disk. Your text is still here; saving writes it again.</p>
          <button type="button" className="editor-button" data-testid="editor-save-again" onClick={onSave}>
            Save
          </button>
        </>
      )}
      {notice.kind === 'save-failed' && (
        <>
          <p className="editor-banner__text">Not saved. {notice.message}</p>
          <button type="button" className="editor-button" onClick={onSave}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}

interface AskProps {
  name: string;
  onSave(): void;
  onDiscard(): void;
  onCancel(): void;
}

/** The question a window with unsaved changes asks before it closes. It covers that window only. */
function AskBeforeClosing({ name, onSave, onDiscard, onCancel }: AskProps) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => panel.current?.querySelector<HTMLButtonElement>('[data-primary]')?.focus(), []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Tab') {
      // Three buttons and nothing else: Tab goes round them.
      const buttons = [...panel.current!.querySelectorAll<HTMLButtonElement>('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
      event.preventDefault();
      next?.focus();
    }
  };

  return (
    <div className="editor-ask" data-testid="editor-ask" onKeyDown={onKeyDown}>
      <div className="editor-ask__panel" role="alertdialog" aria-modal="true" aria-labelledby="editor-ask-title" ref={panel}>
        <h2 id="editor-ask-title" className="editor-ask__title">
          Save the changes to {name}?
        </h2>
        <p className="editor-ask__text">They are only in this window. Closing without saving loses them.</p>
        <div className="editor-ask__actions">
          <button type="button" className="editor-button" data-testid="editor-ask-discard" onClick={onDiscard}>
            Close without saving
          </button>
          <button type="button" className="editor-button" data-testid="editor-ask-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="editor-button editor-button--primary" data-primary data-testid="editor-ask-save" onClick={onSave}>
            Save and close
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the app

function FileEditor({ windowId, path, focused, setTitle }: Omit<BufferProps, 'initialText'>) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setLoaded(null);
    setTitle(nameOf(path));
    void loadFile(path).then((result) => {
      if (current) setLoaded(result);
    });
    return () => {
      current = false;
    };
  }, [path, attempt, setTitle]);

  // Reading a file from this machine takes a few milliseconds: the window keeps its paper and shows nothing in between.
  if (!loaded) {
    return (
      <div className="editor" data-testid="editor-loading">
        <div className="editor__main" />
        <footer className="editor__status">
          <PathLabel path={path} />
        </footer>
      </div>
    );
  }
  if (!('text' in loaded)) return <Refused path={path} refusal={loaded} onRetry={() => setAttempt((count) => count + 1)} />;
  return (
    <Buffer
      key={`${path}:${attempt}`}
      windowId={windowId}
      path={path}
      initialText={loaded.text}
      focused={focused}
      setTitle={setTitle}
    />
  );
}

/** Edits one file from the home folder and keeps up with whoever else changes it. */
export default function EditorApp({ windowId, params, setTitle, focused }: AppProps) {
  const path = typeof params.path === 'string' && params.path !== '' ? params.path : null;
  useEffect(() => {
    if (path === null) setTitle('Editor');
  }, [path, setTitle]);

  if (path === null) return <EmptyState windowId={windowId} />;
  return <FileEditor key={path} windowId={windowId} path={path} focused={focused} setTitle={setTitle} />;
}
