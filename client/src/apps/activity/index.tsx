import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppProps } from '../registry';
import { useAgentsStore } from '../../stores/agents';
import { useShellStore } from '../../stores/shell';
import { useWorkspaceList, useWorkspacesStore } from '../../stores/workspaces';
import { onActivityCommand, type ActivityCommand } from './commands';
import { loadWorkspaces, mergeWorkspace, reviewOf, useJournal, useReviews } from './data';
import { EntryPane } from './EntryPane';
import {
  groupRows,
  isBenchPath,
  isBenchWorkspace,
  matches,
  mergeRows,
  splitClones,
  toRows,
  type AuthorFilter,
  type Filters,
  type Row,
} from './model';
import { Blank } from './parts';
import { Timeline, type AgentChip } from './Timeline';
import { WorkspacePane } from './WorkspacePane';
import './activity.css';

type View =
  | { type: 'entry'; entryId: number }
  | { type: 'workspace'; id: string; file: string | null }
  | null;

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** Scrolls inside one container only; scrollIntoView would also move the desktop under the window. */
function reveal(scroller: HTMLElement, element: Element, where: 'nearest' | 'centre', topInset = 0): void {
  const box = scroller.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (where === 'centre') {
    scroller.scrollTop += rect.top - box.top - (box.height - rect.height) / 2;
  } else if (rect.top < box.top + topInset) {
    scroller.scrollTop += rect.top - box.top - topInset;
  } else if (rect.bottom > box.bottom) {
    scroller.scrollTop += rect.bottom - box.bottom + 6;
  }
}

/** A clock for relative times and time groups; ten seconds is as fine as "12 s ago" needs. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export default function ActivityApp({ windowId, params, setTitle, focused }: AppProps) {
  const journal = useJournal((state) => state.entries);
  const entries = useMemo(() => journal.filter((entry) => !isBenchPath(entry.path)), [journal]);
  const status = useJournal((state) => state.status);
  const journalError = useJournal((state) => state.error);
  const hasOlder = useJournal((state) => state.hasOlder);
  const loadingOlder = useJournal((state) => state.loadingOlder);
  const agents = useAgentsStore((state) => state.agents);
  const allWorkspaces = useWorkspaceList();
  /** True once the list of earlier workspaces has answered. */
  const workspacesKnown = useWorkspacesStore((state) => state.strategy !== null);
  const workspaces = useMemo(() => allWorkspaces.filter((workspace) => !isBenchWorkspace(workspace)), [allWorkspaces]);

  const [author, setAuthor] = useState<AuthorFilter>('all');
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>(null);
  const [activeChange, setActiveChange] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** While the list is scrolled away from the top, nothing newer than this id is drawn. */
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  const tick = useNow();
  // A change that just arrived must never be dated in the future of a ten second old clock.
  const now = Math.max(tick, entries[0]?.at ?? 0);

  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    useJournal.getState().loadFirst();
    loadWorkspaces();
  }, []);

  // Opened for one workspace (from an agent's window, the launcher or a test).
  const wanted = typeof params.workspaceId === 'string' ? params.workspaceId : null;
  useEffect(() => {
    if (wanted) setView({ type: 'workspace', id: wanted, file: null });
  }, [wanted]);

  // ---------------------------------------------------------------- rows

  const filterWorkspace = workspaces.find((workspace) => workspace.id === workspaceFilter) ?? null;
  const filters = useMemo<Filters>(
    () => ({ author, workspace: filterWorkspace, query: query.trim() }),
    [author, filterWorkspace, query],
  );
  // Clones are taken out before filtering, so a search for one file never finds it inside a copy.
  const split = useMemo(() => splitClones(entries, workspaces), [entries, workspaces]);
  const build = useCallback(
    (shown: (id: number) => boolean): Row[] =>
      mergeRows(
        toRows(split.rest.filter((entry) => shown(entry.id) && matches(entry, filters))),
        split.clones.filter((row) => shown(row.entries[0]!.id) && matches(row, filters)),
      ),
    [split, filters],
  );
  const rows = useMemo(() => build((id) => frozenAt === null || id <= frozenAt), [build, frozenAt]);
  const pending = useMemo(
    () => (frozenAt === null ? 0 : build((id) => id > frozenAt).length),
    [build, frozenAt],
  );
  const groups = useMemo(() => groupRows(rows, now), [rows, now]);

  // Rows that begin after the first page was drawn slide in; the first page itself does not.
  const [freshAfter, setFreshAfter] = useState<number | null>(null);
  useEffect(() => {
    if (freshAfter === null && status === 'ready') setFreshAfter(useJournal.getState().entries[0]?.id ?? 0);
  }, [status, freshAfter]);

  const chips = useMemo<AgentChip[]>(() => {
    const byId = new Map<string, AgentChip>();
    for (const agent of Object.values(agents)) byId.set(agent.id, { agentId: agent.id, name: agent.name, hue: agent.hue });
    // Agents the server has forgotten still have rows; they keep their chip.
    for (const { actor } of entries) {
      if (actor.type !== 'me' && actor.agentId && !byId.has(actor.agentId)) {
        byId.set(actor.agentId, { agentId: actor.agentId, name: actor.name, hue: actor.hue });
      }
    }
    return [...byId.values()];
  }, [agents, entries]);

  const selectedRow = view?.type === 'entry' ? rows.find((row) => row.entries.some((entry) => entry.id === view.entryId)) : undefined;
  const viewedWorkspace = view?.type === 'workspace' ? workspaces.find((workspace) => workspace.id === view.id) : undefined;
  const reviewable = useMemo(
    () => workspaces.filter((workspace) => workspace.status !== 'merged' || workspace.id === viewedWorkspace?.id),
    [workspaces, viewedWorkspace?.id],
  );

  // The first row opens by itself, so the window never starts with an empty half.
  const autoSelected = useRef(false);
  useEffect(() => {
    if (autoSelected.current || status !== 'ready') return;
    autoSelected.current = true;
    if (view === null && !wanted && rows[0]) setView({ type: 'entry', entryId: rows[0].key });
  }, [status, rows, view, wanted]);

  const viewKey = view === null ? '' : view.type === 'entry' ? `e${selectedRow?.key}` : `w${view.id}:${view.file}`;
  useEffect(() => {
    setActiveChange(null);
    setConfirming(false);
  }, [viewKey]);

  useEffect(() => {
    setTitle(viewedWorkspace ? `Activity · ${viewedWorkspace.name}` : 'Activity');
  }, [viewedWorkspace?.name, setTitle]);

  // ---------------------------------------------------------------- actions

  const selectRow = useCallback((row: Row) => setView({ type: 'entry', entryId: row.key }), []);

  const openWorkspace = useCallback((id: string) => setView({ type: 'workspace', id, file: null }), []);

  const chooseWorkspaceFilter = useCallback((id: string) => {
    setWorkspaceFilter(id);
    if (id) setView({ type: 'workspace', id, file: null });
  }, []);

  const clearFilters = useCallback(() => {
    setAuthor('all');
    setWorkspaceFilter('');
    setQuery('');
  }, []);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const away = list.scrollTop > 4;
    setFrozenAt((held) => {
      if (!away) return null;
      return held ?? useJournal.getState().entries[0]?.id ?? 0;
    });
  }, []);

  const showPending = useCallback(() => {
    setFrozenAt(null);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, []);

  const moveRow = useCallback(
    (step: number) => {
      if (rows.length === 0) return;
      const at = selectedRow ? rows.indexOf(selectedRow) : -1;
      const next = rows[Math.min(rows.length - 1, Math.max(0, at === -1 ? 0 : at + step))]!;
      setView({ type: 'entry', entryId: next.key });
    },
    [rows, selectedRow],
  );

  // Keeps the selected row in view when the keyboard moved it.
  const selectedKey = selectedRow?.key ?? null;
  const movedByKeyboard = useRef(false);
  useLayoutEffect(() => {
    if (!movedByKeyboard.current || selectedKey === null) return;
    movedByKeyboard.current = false;
    const list = listRef.current;
    const element = list?.querySelector(`[data-row-key="${selectedKey}"]`);
    if (list && element) reveal(list, element, 'nearest', 30);
  }, [selectedKey]);

  const moveFile = useCallback(
    (step: number) => {
      if (view?.type !== 'workspace') return;
      const files = reviewOf(useReviews.getState(), view.id).diff?.files ?? [];
      if (files.length === 0) return;
      const at = Math.max(0, files.findIndex((file) => file.path === view.file));
      const next = files[Math.min(files.length - 1, Math.max(0, at + step))]!;
      setView({ type: 'workspace', id: view.id, file: next.path });
    },
    [view],
  );

  const moveChange = useCallback((step: number) => {
    const scroller = diffRef.current;
    if (!scroller) return;
    const marked = scroller.querySelectorAll<HTMLElement>('[data-change]');
    const last = marked.length === 0 ? -1 : Number(marked[marked.length - 1]!.dataset.change);
    if (last < 0) return;
    setActiveChange((held) => {
      const next = held === null ? (step > 0 ? 0 : last) : Math.min(last, Math.max(0, held + step));
      const first = scroller.querySelector(`[data-change="${next}"]`);
      if (first) reveal(scroller, first, 'centre');
      return next;
    });
  }, []);

  const mergeNow = useCallback(() => {
    if (view?.type !== 'workspace') return;
    setConfirming(false);
    void mergeWorkspace(view.id);
  }, [view]);

  const askToMerge = useCallback(() => {
    if (view?.type !== 'workspace') return;
    const review = reviewOf(useReviews.getState(), view.id);
    if (review.merging || !review.diff || review.diff.files.length === 0) return;
    setConfirming(true);
  }, [view]);

  // ---------------------------------------------------------------- keyboard and menus

  const run = useCallback(
    (command: ActivityCommand) => {
      if (command === 'show-all') setAuthor('all');
      else if (command === 'show-mine') setAuthor('me');
      else if (command === 'find') searchRef.current?.focus();
      else if (command === 'reload') {
        useJournal.getState().loadFirst();
        loadWorkspaces();
      } else if (command === 'next-change') moveChange(1);
      else if (command === 'previous-change') moveChange(-1);
      else askToMerge();
    },
    [moveChange, askToMerge],
  );
  useEffect(() => onActivityCommand(windowId, run), [windowId, run]);

  useEffect(() => {
    if (!focused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const shell = useShellStore.getState();
      if (shell.launcherOpen || shell.overviewOpen) return;
      const target = event.target;
      if (event.key === 'Escape') {
        if (confirming) setConfirming(false);
        else if (target instanceof HTMLElement && (isTyping(target) || diffRef.current?.contains(target))) listRef.current?.focus();
        else return;
        event.preventDefault();
        return;
      }
      if (isTyping(target)) return;
      const inDiff = target instanceof Node && diffRef.current?.contains(target) === true;
      const onButton = target instanceof HTMLElement && target.closest('button') !== null;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if ((key === 'ArrowDown' || key === 'ArrowUp') && !inDiff) {
        const step = key === 'ArrowDown' ? 1 : -1;
        if (view?.type === 'workspace') moveFile(step);
        else {
          movedByKeyboard.current = true;
          moveRow(step);
        }
      } else if (key === 'Enter' && !onButton && !inDiff) {
        diffRef.current?.focus();
      } else if (key === 'j') moveChange(1);
      else if (key === 'k') moveChange(-1);
      else if (key === 'm' && view?.type === 'workspace' && !confirming) askToMerge();
      else if (key === '/') searchRef.current?.focus();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, view, confirming, moveRow, moveFile, moveChange, askToMerge]);

  // ---------------------------------------------------------------- view

  const filtered = author !== 'all' || workspaceFilter !== '' || query.trim() !== '';

  return (
    <section className="activity" data-testid="app-activity" data-view={view?.type ?? 'none'}>
      <Timeline
        groups={groups}
        selectedKey={selectedKey}
        freshAfter={freshAfter ?? Infinity}
        now={now}
        pending={pending}
        status={status}
        error={journalError}
        filtered={filtered}
        hasOlder={hasOlder}
        loadingOlder={loadingOlder}
        author={author}
        agents={chips}
        workspaces={workspaces}
        reviewable={reviewable}
        workspaceFilter={workspaceFilter}
        viewedWorkspace={viewedWorkspace?.id ?? null}
        query={query}
        listRef={listRef}
        searchRef={searchRef}
        onAuthor={setAuthor}
        onWorkspaceFilter={chooseWorkspaceFilter}
        onQuery={setQuery}
        onSelect={selectRow}
        onOpenWorkspace={openWorkspace}
        onScroll={onScroll}
        onShowPending={showPending}
        onLoadOlder={useJournal.getState().loadOlder}
        onClearFilters={clearFilters}
        onRetry={useJournal.getState().loadFirst}
      />
      <div className="activity__detail">
        {viewedWorkspace && view?.type === 'workspace' ? (
          <WorkspacePane
            key={viewedWorkspace.id}
            workspace={viewedWorkspace}
            selectedFile={view.file}
            activeChange={activeChange}
            confirming={confirming}
            scrollRef={diffRef}
            onSelectFile={(file) => setView({ type: 'workspace', id: viewedWorkspace.id, file })}
            onMerge={mergeNow}
            onCancelConfirm={() => setConfirming(false)}
          />
        ) : selectedRow ? (
          <EntryPane
            row={selectedRow}
            now={now}
            workspace={workspaces.find((workspace) => workspace.id === selectedRow.workspaceId)}
            activeChange={activeChange}
            scrollRef={diffRef}
            onOpenWorkspace={openWorkspace}
          />
        ) : view?.type === 'workspace' && !workspacesKnown ? (
          <div className="act-wait" aria-label="Loading the workspace" />
        ) : view?.type === 'workspace' ? (
          <Blank glyph="branch" title="This workspace is not here any more">
            <p>It was removed, or it belongs to a different home folder.</p>
          </Blank>
        ) : (
          <Blank glyph="diff" title="Select a change to see its diff">
            <p className="act-keys">
              <kbd>↑</kbd>
              <kbd>↓</kbd> move through changes <kbd>Enter</kbd> read the diff <kbd>J</kbd>
              <kbd>K</kbd> next and previous change
            </p>
          </Blank>
        )}
      </div>
    </section>
  );
}
