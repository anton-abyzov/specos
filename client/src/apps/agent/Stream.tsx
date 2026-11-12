/**
 * The conversation view of one agent job, and the scroller that keeps the
 * newest line in sight. Chat and the agent window both draw a job with these.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Glyph, type GlyphName } from '../../design/icons';
import { isAgentActive, useAgent, useAgentEvents } from '../../stores/agents';
import { openFile } from './actions';
import { FileChip } from './kit';
import { renderMarkdown } from './markdown';
import { useAgentReplay } from './replay';
import { buildStream, type StreamItem } from './stream-model';
import './stream.css';

const TOOL_GLYPHS: Record<string, GlyphName> = {
  Read: 'eye',
  Edit: 'pencil',
  Write: 'pencil',
  MultiEdit: 'pencil',
  NotebookEdit: 'pencil',
  List: 'folder-open',
  LS: 'folder-open',
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  Bash: 'terminal',
  Task: 'agent',
};

/** Rows are rebuilt from the events on every chunk; only the ones whose content moved are drawn again. */
function sameRow(a: { item: StreamItem; streaming: boolean }, b: { item: StreamItem; streaming: boolean }): boolean {
  if (a.streaming !== b.streaming || a.item.type !== b.item.type) return false;
  const [x, y] = [a.item, b.item];
  if (x.type === 'text' && y.type === 'text') return x.text === y.text && x.complete === y.complete;
  if (x.type === 'files' && y.type === 'files') {
    return (
      x.files.length === y.files.length &&
      x.files.every((file, index) => file.count === y.files[index]!.count && file.change === y.files[index]!.change)
    );
  }
  // Tools and lines never change once they exist.
  return true;
}

const Row = memo(function Row({ item, streaming }: { item: StreamItem; streaming: boolean }) {
  switch (item.type) {
    case 'text':
      // Plain text while it is being written, so the lines only ever grow; Markdown once the block is whole.
      return item.complete ? (
        <div
          className="stream__text stream__text--md selectable"
          data-testid="stream-text"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
        />
      ) : (
        <div className="stream__text selectable" data-testid="stream-text" data-streaming={streaming || undefined}>
          {item.text}
          {streaming && <span className="stream__caret" aria-hidden="true" />}
        </div>
      );
    case 'tool':
      return (
        <div className="stream__tool" data-testid="stream-tool">
          <Glyph name={TOOL_GLYPHS[item.tool] ?? 'play'} size={13} />
          <span className="stream__tool-name">{item.tool}</span>
          <span className="stream__tool-summary">{item.summary}</span>
        </div>
      );
    case 'files':
      return (
        <div className="stream__files" data-testid="stream-files">
          {item.files.map((file) => (
            <FileChip key={file.path} path={file.path} change={file.change} count={file.count} onOpen={openFile} />
          ))}
        </div>
      );
    case 'result':
      return (
        <div className="stream__line stream__line--result" data-testid="stream-result">
          <Glyph name="check" size={12} />
          {item.text}
        </div>
      );
    case 'error':
      return (
        <div className="stream__line stream__line--error" role="alert" data-testid="stream-error">
          {item.text}
        </div>
      );
    case 'status':
      return (
        <div className="stream__line" data-testid="stream-status">
          {item.text}
        </div>
      );
  }
}, sameRow);

interface StreamProps {
  agentId: string;
  /** Leaves out the line that says where the job started, for surfaces that show the workspace themselves. */
  compact?: boolean;
}

export function Stream({ agentId, compact = false }: StreamProps) {
  const agent = useAgent(agentId);
  const events = useAgentEvents(agentId);
  useAgentReplay(agentId);
  const live = agent ? isAgentActive(agent) : false;
  const items = useMemo(() => {
    const built = buildStream(events, live);
    return compact ? built.filter((item) => !(item.type === 'status' && item.text.startsWith('started in '))) : built;
  }, [events, live, compact]);

  const last = items.at(-1);
  const writing = live && last?.type === 'text' && !last.complete;
  return (
    <div className="stream" data-testid="stream" data-live={live || undefined} aria-live="polite" aria-busy={live}>
      {items.map((item) => (
        <Row key={item.key} item={item} streaming={writing && item === last} />
      ))}
      {live && !writing && (
        <div className="stream__working" data-testid="stream-working" aria-label="Working">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}

/** How close to the end still counts as "at the end", in pixels. */
const STICK_WITHIN = 36;

interface StreamScrollerProps {
  className?: string;
  /** Scrolls to the end when this changes, wherever the user was: a new message of their own. */
  resetKey?: unknown;
  children: ReactNode;
}

/**
 * A scrolling column that follows its content while the user is at the end.
 * Once they scroll up it stays where they put it and offers a way back.
 */
export function StreamScroller({ className, resetKey, children }: StreamScrollerProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [away, setAway] = useState(false);

  const toEnd = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    stuck.current = true;
    setAway(false);
  }, []);

  useLayoutEffect(toEnd, [resetKey, toEnd]);

  useEffect(() => {
    const follow = new ResizeObserver(() => {
      const element = scroller.current;
      if (element && stuck.current) element.scrollTop = element.scrollHeight;
    });
    follow.observe(content.current!);
    follow.observe(scroller.current!);
    return () => follow.disconnect();
  }, []);

  const onScroll = () => {
    const element = scroller.current!;
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_WITHIN;
    stuck.current = atEnd;
    setAway(!atEnd);
  };

  return (
    <div className={className ? `stream-scroller ${className}` : 'stream-scroller'}>
      <div className="stream-scroller__view" ref={scroller} onScroll={onScroll} data-testid="stream-scroller">
        <div className="stream-scroller__content" ref={content}>
          {children}
        </div>
      </div>
      {away && (
        <button type="button" className="stream-scroller__jump" data-testid="jump-to-latest" onClick={toEnd}>
          <Glyph name="chevron-down" size={13} />
          Jump to latest
        </button>
      )}
    </div>
  );
}
