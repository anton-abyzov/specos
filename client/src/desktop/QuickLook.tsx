/**
 * Peek: a translucent panel in the middle of the desk that shows the selected
 * file without opening it. It springs out of the row it belongs to and goes
 * back into it. The file's own markup is never trusted: text is shown as text,
 * Markdown is sanitised, and pictures are only ever an <img>.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { FsEntry } from '@shared/protocol';
import { formatBytes, glyphOf, kindLabel, kindOf, opensInEditor, parentOf } from '../apps/files/kinds';
import { usePeekStore, type PeekKey, type PeekOrigin } from '../apps/files/peek';
import { Glyph } from '../design/icons';
import { spring } from '../design/motion';
import { api } from '../lib/api';
import { events } from '../lib/events';
import { useShellStore } from '../stores/shell';
import './quicklook.css';

/** How much of a text file Peek reads and shows. */
const TEXT_CAP_BYTES = 256 * 1024;
const TEXT_CAP_LINES = 4000;

type Loaded =
  | { kind: 'text'; text: string; lines: number; truncated: boolean }
  | { kind: 'markdown'; html: string; truncated: boolean }
  | { kind: 'binary' }
  | { kind: 'error'; message: string };

interface Content {
  /** The path and version this was read for. */
  key: string;
  loaded: Loaded;
}

/** Reads the head of a file as text, stopping at the cap instead of downloading all of it. */
async function readHead(path: string, version: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean; binary: boolean }> {
  const response = await fetch(api.fs.readUrl(path, version), { credentials: 'same-origin', signal });
  if (!response.ok || !response.body) throw new Error(`The file could not be read (${response.status}).`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= TEXT_CAP_BYTES) {
      truncated = size > TEXT_CAP_BYTES || !(await reader.read()).done;
      void reader.cancel().catch(() => undefined);
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(size, TEXT_CAP_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const room = bytes.byteLength - offset;
    if (room <= 0) break;
    bytes.set(chunk.byteLength > room ? chunk.subarray(0, room) : chunk, offset);
    offset += chunk.byteLength;
  }
  // A NUL in the head means this is not text, whatever its name says.
  const binary = bytes.subarray(0, 8192).includes(0);
  return { text: binary ? '' : new TextDecoder('utf-8').decode(bytes), truncated, binary };
}

async function load(entry: FsEntry, version: number, signal: AbortSignal): Promise<Loaded> {
  const kind = kindOf(entry);
  if (kind === 'binary') return { kind: 'binary' };
  const head = await readHead(entry.path, version, signal);
  if (head.binary) return { kind: 'binary' };
  if (kind === 'markdown') {
    const { renderMarkdown } = await import('../apps/files/markdown');
    return { kind: 'markdown', html: renderMarkdown(head.text, parentOf(entry.path)), truncated: head.truncated };
  }
  const all = head.text.split('\n');
  // A file that ends with a newline has no extra empty last line.
  if (all.at(-1) === '') all.pop();
  const lines = all.slice(0, TEXT_CAP_LINES);
  return {
    kind: 'text',
    text: lines.join('\n'),
    lines: lines.length,
    truncated: head.truncated || all.length > TEXT_CAP_LINES,
  };
}

/** Where the panel starts from and returns to: the row, as an offset from the middle of the screen. */
function fromOrigin(origin: PeekOrigin | null) {
  if (!origin) return { opacity: 0, scale: 0.92, x: 0, y: 12 };
  return {
    opacity: 0,
    scale: 0.16,
    x: origin.x + origin.w / 2 - window.innerWidth / 2,
    y: origin.y + origin.h / 2 - window.innerHeight / 2,
  };
}

const NAVIGATION = new Set<string>(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function QuickLook() {
  const target = usePeekStore((state) => state.target);
  const close = usePeekStore((state) => state.close);
  const dismiss = useCallback(() => close(), [close]);
  const covered = useShellStore((state) => state.launcherOpen || state.overviewOpen);

  // The launcher and the overview take the whole desk; Peek gives way to them.
  useEffect(() => {
    if (covered) close();
  }, [covered, close]);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
      const peek = usePeekStore.getState();
      if (event.key === 'Escape' || event.key === ' ') peek.close();
      else if (NAVIGATION.has(event.key)) peek.target?.navigate(event.key as PeekKey);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    // Capture: Peek answers these keys wherever the focus happens to be.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [target !== null]);

  // The origin of the file that was last shown, for the way back into its row.
  const lastOrigin = useRef<PeekOrigin | null>(null);
  if (target) lastOrigin.current = target.origin;

  return (
    <AnimatePresence>
      {target && (
        <div className="peek" key="peek">
          <motion.section
            className="peek__panel"
            data-testid="peek"
            role="dialog"
            aria-label={`Peek: ${target.entry.name}`}
            initial={fromOrigin(target.origin)}
            animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
            exit={{ ...fromOrigin(lastOrigin.current), transition: spring('windowClose') }}
            transition={spring('launcher')}
          >
            <Panel entry={target.entry} onClose={dismiss} />
          </motion.section>
        </div>
      )}
    </AnimatePresence>
  );
}

function Panel({ entry, onClose }: { entry: FsEntry; onClose(): void }) {
  const kind = kindOf(entry);
  // Bumped whenever the file changes on disk while it is shown.
  const [version, setVersion] = useState(0);
  const [content, setContent] = useState<Content | null>(null);
  const [dimensions, setDimensions] = useState<{ key: string; text: string } | null>(null);
  const key = `${entry.path}\n${version}`;

  useEffect(
    () =>
      events.subscribe('fs', ({ entry: change }) => {
        if (change.path !== entry.path) return;
        if (change.kind === 'unlink') onClose();
        else setVersion((current) => current + 1);
      }),
    [entry.path, onClose],
  );

  useEffect(() => {
    if (kind === 'image' || kind === 'folder') return;
    const abort = new AbortController();
    load(entry, version, abort.signal).then(
      (loaded) => setContent({ key, loaded }),
      (error: unknown) => {
        if (abort.signal.aborted) return;
        setContent({ key, loaded: { kind: 'error', message: error instanceof Error ? error.message : 'The file could not be read.' } });
      },
    );
    return () => abort.abort();
    // The entry object changes with every stat; the path and version are what decide a reload.
  }, [key, kind]);

  // Another file shows nothing until it has loaded; the same file keeps its old text until the new text is in.
  const shown = content && content.key.split('\n')[0] === entry.path ? content.loaded : null;
  const size = shown?.kind === 'text' ? `${shown.lines} ${shown.lines === 1 ? 'line' : 'lines'}` : null;
  const pixels = dimensions?.key === entry.path ? dimensions.text : null;
  const truncated = (shown?.kind === 'text' || shown?.kind === 'markdown') && shown.truncated;
  const editable = opensInEditor(entry) && shown?.kind !== 'binary';

  const openInEditor = () => {
    onClose();
    useShellStore.getState().launchApp('editor', { path: entry.path });
  };

  return (
    <>
      <header className="peek__bar">
        <Glyph name={glyphOf(entry)} size={18} className="peek__glyph" />
        <h2 className="peek__name" data-testid="peek-title">
          {entry.name}
        </h2>
        <p className="peek__facts">
          <span>{kindLabel(entry)}</span>
          <span>{formatBytes(entry.size)}</span>
          {size && <span data-testid="peek-lines">{size}</span>}
          {pixels && <span data-testid="peek-dimensions">{pixels}</span>}
        </p>
        {editable && (
          <button type="button" className="peek__action" data-testid="peek-open-editor" onClick={openInEditor}>
            Open in Editor
          </button>
        )}
        <button type="button" className="peek__close" aria-label="Close Peek" title="Close (Esc)" onClick={onClose}>
          <Glyph name="close" size={14} />
        </button>
      </header>

      <div className="peek__body" data-kind={kind === 'image' ? 'image' : (shown?.kind ?? 'loading')}>
        {kind === 'image' ? (
          <Picture entry={entry} version={version} onSize={(text) => setDimensions({ key: entry.path, text })} />
        ) : shown === null ? (
          <div className="peek__loading" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : shown.kind === 'text' ? (
          <Text text={shown.text} lines={shown.lines} />
        ) : shown.kind === 'markdown' ? (
          <article
            className="peek__markdown selectable"
            data-testid="peek-markdown"
            // Sanitised by renderMarkdown: no scripts, no handlers, no styles survive it.
            dangerouslySetInnerHTML={{ __html: shown.html }}
          />
        ) : (
          <div className="peek__blank" data-testid="peek-blank">
            <Glyph name={shown.kind === 'error' ? 'info' : glyphOf(entry)} size={40} />
            <p className="peek__blank-title">{shown.kind === 'error' ? 'Peek could not read this file' : 'Nothing to preview'}</p>
            <p className="peek__blank-text">
              {shown.kind === 'error' ? shown.message : `${entry.name} is not text or a picture.`}
            </p>
          </div>
        )}
      </div>

      <footer className="peek__foot">
        {truncated ? (
          <p className="peek__note" data-testid="peek-note">
            Showing the first part of this file. Open it in the Editor for the rest.
          </p>
        ) : (
          <p className="peek__path">{entry.path}</p>
        )}
        <p className="peek__keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd> next file <kbd>Space</kbd> close
        </p>
      </footer>
    </>
  );
}

function Text({ text, lines }: { text: string; lines: number }) {
  const numbers = useMemo(() => Array.from({ length: lines }, (_, index) => index + 1).join('\n'), [lines]);
  if (lines === 0) {
    return (
      <div className="peek__blank" data-testid="peek-blank">
        <p className="peek__blank-title">This file is empty</p>
      </div>
    );
  }
  return (
    <div className="peek__text" data-testid="peek-text">
      <pre className="peek__gutter" aria-hidden="true">
        {numbers}
      </pre>
      <pre className="peek__code selectable">{text}</pre>
    </div>
  );
}

function Picture({ entry, version, onSize }: { entry: FsEntry; version: number; onSize(text: string): void }) {
  const [failed, setFailed] = useState<string | null>(null);
  // The modified time is part of the address, so a picture that changed is fetched again.
  const source = api.fs.readUrl(entry.path, entry.mtime + version);
  if (failed === source) {
    return (
      <div className="peek__blank" data-testid="peek-blank">
        <Glyph name="file-image" size={40} />
        <p className="peek__blank-title">This picture could not be shown</p>
        <p className="peek__blank-text">{entry.name} may be damaged or in a format the browser does not read.</p>
      </div>
    );
  }
  return (
    <img
      className="peek__image"
      data-testid="peek-image"
      src={source}
      alt={entry.name}
      draggable={false}
      onLoad={(event) => onSize(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)}
      onError={() => setFailed(source)}
    />
  );
}
