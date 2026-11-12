import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { Glyph } from '../design/icons';
import { prefersReducedMotion, spring } from '../design/motion';
import { api, ApiRequestError } from '../lib/api';
import { events } from '../lib/events';
import { useAgentsStore } from '../stores/agents';
import { useShellStore } from '../stores/shell';
import { useTheme } from '../stores/theme';
import { buildActions } from './launcher/actions';
import { useFileIndex } from './launcher/file-index';
import { openTarget } from './launcher/files';
import { Item } from './launcher/items';
import {
  actionTargets,
  agentTargets,
  homeSections,
  search,
  type LauncherItem,
  type Section,
} from './launcher/search';
import './launcher/launcher.css';

const PROJECTS = 'Projects';

/** After a file appears or goes, wait this long for the burst to end before asking for the index again. */
const REINDEX_DELAY_MS = 250;

/** Runs the task when the page has nothing better to do; returns the function that calls it off. */
function whenIdle(task: () => void): () => void {
  if (typeof window.requestIdleCallback !== 'function') {
    const timer = window.setTimeout(task, 200);
    return () => window.clearTimeout(timer);
  }
  const handle = window.requestIdleCallback(task, { timeout: 2000 });
  return () => window.cancelIdleCallback(handle);
}

const closeLauncher = () => useShellStore.getState().sync({ launcherOpen: false });

/** Ctrl or Cmd with Space or K, and nothing else held. */
function isLauncherKey(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.code === 'Space' || event.code === 'KeyK')
  );
}

/** True when running the item hands the keyboard to something else, so the old focus must not be given back. */
function takesFocus(item: LauncherItem): boolean {
  return item.kind === 'action' ? item.action.takesFocus === true : true;
}

function runItem(item: LauncherItem, forceEditor: boolean): void {
  const shell = useShellStore.getState();
  switch (item.kind) {
    case 'app':
      if (shell.runningApps.includes(item.app.id)) shell.focusApp(item.app.id);
      else shell.launchApp(item.app.id);
      break;
    case 'file': {
      const target = openTarget(item.file, forceEditor);
      shell.launchApp(target.app, target.params);
      break;
    }
    case 'agent':
      shell.launchApp('agent', { agentId: item.agent.id });
      break;
    case 'action':
      item.action.run();
      break;
  }
}

/** Why a project name cannot be used, or null when it can. */
function nameProblem(name: string): string | null {
  if (name === '') return 'Give the folder a name.';
  if (/[\\/]/.test(name)) return 'A folder name cannot contain a slash.';
  if (name === '.' || name === '..') return 'That name is taken by the folder itself.';
  return null;
}

const countLabel = (count: number, noun: string): string => `${count.toLocaleString('en')} ${noun}${count === 1 ? '' : 's'}`;

function SectionHeading({ section }: { section: Section }) {
  const shown = section.items.length;
  return (
    <h2 className="launcher__heading">
      <span>{section.label}</span>
      <span className="launcher__count" data-testid={`launcher-count-${section.id}`}>
        {section.total > shown ? `${shown} of ${section.total}` : shown}
      </span>
    </h2>
  );
}

interface PanelProps {
  /** Where the keyboard focus was when the launcher opened. */
  returnTo: RefObject<HTMLElement | null>;
  /** Set when a result took the focus for itself. */
  handedOff: RefObject<boolean>;
}

function LauncherPanel({ returnTo, handedOff }: PanelProps) {
  const present = useIsPresent();
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  /** Sections present on the first frame rise in one after the other; later ones just appear. */
  const entering = useRef(true);
  /** Where the pointer last was: a list that scrolls under a resting pointer must not move the selection. */
  const pointer = useRef({ x: -1, y: -1 });

  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** The field doubles as the name prompt of "New project folder...". */
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const theme = useTheme();
  const files = useFileIndex((state) => state.files);
  const truncated = useFileIndex((state) => state.truncated);
  const agents = useAgentsStore((state) => state.agents);

  const sources = useMemo(
    () => ({ files, agents: agentTargets(agents), actions: actionTargets(buildActions(theme)) }),
    [files, agents, theme],
  );
  const trimmed = query.trim();
  const sections = useMemo(
    () => (naming ? [] : trimmed === '' ? homeSections(sources) : search(trimmed, sources)),
    [naming, trimmed, sources],
  );
  const items = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const selected = items.find((item) => item.key === selectedKey) ?? items[0];
  const selectedIndex = selected ? items.indexOf(selected) : -1;

  // Reopened while it was still fading out, the same panel comes back: it starts over like a new one.
  const [wasPresent, setWasPresent] = useState(true);
  if (present !== wasPresent) {
    setWasPresent(present);
    if (present) {
      setQuery('');
      setSelectedKey(null);
      setNaming(false);
      setName('');
      setProblem(null);
    }
  }

  useLayoutEffect(() => {
    if (!present) return;
    // Before the field takes the focus, remember who had it.
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    entering.current = false;
  }, [present, returnTo]);

  useEffect(() => {
    if (!present) return;
    // A window that was still opening may ask for the focus once it has loaded. The launcher is modal, so
    // the field keeps it, and the window gets it when the launcher closes.
    const keepFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('.launcher')) return;
      // Once it is closing, the focus it gives back is not to be taken again.
      if (!useShellStore.getState().launcherOpen) return;
      returnTo.current = target;
      input.current?.focus();
    };
    document.addEventListener('focusin', keepFocus);
    return () => document.removeEventListener('focusin', keepFocus);
  }, [present, returnTo]);

  useEffect(() => {
    if (!present) return;
    const index = useFileIndex.getState();
    void index.refresh();
    let timer: number | undefined;
    const unsubscribe = events.subscribe('fs', ({ entry }) => {
      if (entry.kind === 'change') return; // Same paths as before: nothing to index.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void index.refresh(), REINDEX_DELAY_MS);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [present]);

  useLayoutEffect(() => {
    results.current?.querySelector('[data-selected]')?.scrollIntoView({ block: 'nearest' });
  }, [selected?.key]);

  const pick = (item: LauncherItem, forceEditor: boolean) => {
    if (item.kind === 'action' && item.action.prompt === 'project') {
      setNaming(true);
      input.current?.focus();
      return;
    }
    handedOff.current = takesFocus(item);
    closeLauncher();
    runItem(item, forceEditor);
  };

  const createProject = async () => {
    const folder = name.trim();
    const invalid = nameProblem(folder);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    const path = `${PROJECTS}/${folder}`;
    // mkdir succeeds on a folder that is already there, so a fresh index is consulted first.
    await useFileIndex.getState().refresh();
    if (useFileIndex.getState().files.some((file) => file.path === path)) {
      setProblem(`${path} already exists.`);
      return;
    }
    try {
      await api.fs.mkdir(path);
    } catch (error) {
      setProblem(error instanceof ApiRequestError ? error.message : 'The folder could not be created.');
      return;
    }
    handedOff.current = true;
    closeLauncher();
    useShellStore.getState().launchApp('files', { path });
  };

  const leaveNaming = () => {
    setNaming(false);
    setName('');
    setProblem(null);
  };

  const move = (step: 1 | -1) => {
    if (items.length === 0) return;
    const next = (selectedIndex + step + items.length) % items.length;
    setSelectedKey(items[next]!.key);
  };

  /** Tab: the first result of the next group, or of the previous one with Shift. */
  const jumpGroup = (step: 1 | -1) => {
    if (!selected) return;
    const current = sections.findIndex((section) => section.id === selected.group);
    const next = sections[(current + step + sections.length) % sections.length]!;
    setSelectedKey(next.items[0]!.key);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (key === 'Escape') {
      // One step back at a time: out of the name prompt, then an empty field, then closed.
      if (naming) leaveNaming();
      else if (query !== '') setQuery('');
      else closeLauncher();
    } else if (key === 'Tab') {
      if (!naming) jumpGroup(event.shiftKey ? -1 : 1);
    } else if (key === 'Enter') {
      if (naming) void createProject();
      else if (selected) pick(selected, event.ctrlKey || event.metaKey);
    } else if (naming) {
      return;
    } else if (key === 'ArrowDown' || (key === 'ArrowRight' && query === '')) {
      move(1);
    } else if (key === 'ArrowUp' || (key === 'ArrowLeft' && query === '')) {
      move(-1);
    } else {
      return;
    }
    event.preventDefault();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('[data-solid]')) {
      // A press on a result must not take the keyboard away from the field.
      if (event.target !== input.current) event.preventDefault();
      return;
    }
    closeLauncher();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const { clientX: x, clientY: y } = event;
    if (pointer.current.x === x && pointer.current.y === y) return;
    pointer.current = { x, y };
    const key = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-key]')?.dataset.key : undefined;
    if (key && key !== selected?.key) setSelectedKey(key);
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { value } = event.currentTarget;
    if (naming) {
      setName(value);
      setProblem(null);
    } else {
      setQuery(value);
      setSelectedKey(null);
    }
  };

  const status = naming
    ? ''
    : trimmed === ''
      ? `${countLabel(files.length, 'file')}${truncated ? ' and more' : ''} indexed`
      : items.length === 0
        ? 'No matches'
        : countLabel(items.length, 'result');

  const fade = { duration: prefersReducedMotion() ? 0 : 0.14 };
  let optionIndex = 0;

  return (
    <motion.div
      className="launcher"
      role="dialog"
      aria-modal="true"
      aria-label="Launcher"
      data-testid="launcher"
      data-leaving={!present || undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={fade}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    >
      <div className="launcher__backdrop" data-testid="launcher-backdrop" />
      <div className="launcher__column">
        <motion.div
          className="launcher__field"
          data-solid
          data-naming={naming || undefined}
          initial={{ y: -26, scale: 0.985 }}
          animate={{ y: 0, scale: 1 }}
          transition={spring('launcher')}
        >
          <label className="launcher__entry">
            <span className="launcher__lead">
              <Glyph name={naming ? 'folder' : 'search'} size={34} strokeWidth={1.2} />
            </span>
            {naming && <span className="launcher__prefix">{PROJECTS}/</span>}
            <input
              ref={input}
              className="launcher__input"
              data-testid="launcher-input"
              type="text"
              role="combobox"
              aria-label={naming ? 'Name of the new project folder' : 'Search apps, files, agents and actions'}
              aria-expanded={items.length > 0}
              aria-controls="launcher-results"
              aria-activedescendant={selectedIndex >= 0 ? `launcher-option-${selectedIndex}` : undefined}
              aria-autocomplete="list"
              aria-invalid={problem !== null || undefined}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={naming ? 'folder name' : 'Search apps, files, agents, actions'}
              value={naming ? name : query}
              onChange={onChange}
            />
          </label>
          <div className="launcher__ruler" />
          <div className="launcher__meta">
            <span className="launcher__hints">
              {naming ? (
                <>
                  <kbd className="launcher-key">Enter</kbd> create and open in Files
                  <kbd className="launcher-key">Esc</kbd> back
                </>
              ) : (
                <>
                  <kbd className="launcher-key">↑↓</kbd> move
                  <kbd className="launcher-key">Tab</kbd> next group
                  <kbd className="launcher-key">Enter</kbd> open
                  {selected?.kind === 'file' && selected.file.kind !== 'dir' && (
                    <>
                      <kbd className="launcher-key">Ctrl Enter</kbd> open in Editor
                    </>
                  )}
                  <kbd className="launcher-key">Esc</kbd> {query === '' ? 'close' : 'clear'}
                </>
              )}
            </span>
            <span className="launcher__status" data-testid="launcher-status" aria-live="polite">
              {status}
            </span>
          </div>
        </motion.div>

        <div
          className="launcher__results"
          id="launcher-results"
          data-testid="launcher-results"
          role="listbox"
          aria-label="Results"
          ref={results}
          onPointerMove={onPointerMove}
        >
          {sections.map((section, index) => (
            <motion.section
              key={section.id}
              className="launcher__section"
              data-testid={`launcher-group-${section.id}`}
              aria-label={section.label}
              initial={entering.current ? { opacity: 0, y: 14 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...spring('launcher'), delay: prefersReducedMotion() ? 0 : 0.035 + index * 0.028 }}
            >
              <SectionHeading section={section} />
              <ul
                className={`launcher__items launcher__items--${section.layout}`}
                data-columns={section.columns}
                role="presentation"
              >
                {section.items.map((item) => {
                  const position = optionIndex;
                  optionIndex += 1;
                  return (
                    <Item
                      key={item.key}
                      item={item}
                      layout={section.layout}
                      id={`launcher-option-${position}`}
                      selected={item === selected}
                      onPick={pick}
                    />
                  );
                })}
              </ul>
            </motion.section>
          ))}

          {!naming && trimmed !== '' && items.length === 0 && (
            <p className="launcher__note" data-testid="launcher-empty">
              Nothing matches <q>{trimmed}</q>. Try part of a file name, an app, an agent or an action.
            </p>
          )}
          {naming && (
            <p className="launcher__note" data-problem={problem !== null || undefined} role={problem ? 'alert' : undefined}>
              {problem ?? `A new, empty folder in ${PROJECTS}. Agents get their own copy of a project to work in.`}
            </p>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/**
 * The Launcher: a full-screen layer over the desktop with one field that
 * finds apps, files, agents and actions. It opens on Ctrl or Cmd with Space
 * or K, from the SpecOS menu and from the menu bar.
 */
export function Launcher() {
  const open = useShellStore((state) => state.launcherOpen);
  const returnTo = useRef<HTMLElement | null>(null);
  const handedOff = useRef(false);

  useEffect(() => {
    // Capture phase, so the shortcut works while an app or a terminal holds the keyboard.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isLauncherKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) useShellStore.getState().toggleLauncher();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // The index is first read while the page is idle, so the first open already has its files prepared.
  useEffect(() => whenIdle(() => void useFileIndex.getState().refresh()), []);

  useLayoutEffect(() => {
    if (open) {
      handedOff.current = false;
      return;
    }
    const previous = returnTo.current;
    returnTo.current = null;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.closest('.launcher')) return;
    // The field fades out with the layer; it must not keep the keyboard meanwhile.
    if (previous?.isConnected && previous !== document.body && !handedOff.current) previous.focus({ preventScroll: true });
    else active.blur();
  }, [open]);

  return <AnimatePresence>{open && <LauncherPanel key="launcher" returnTo={returnTo} handedOff={handedOff} />}</AnimatePresence>;
}
