import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { getApp } from '../apps/registry';
import { AppIcon } from '../design/icons';
import { spring } from '../design/motion';
import { useAgentsStore } from '../stores/agents';
import { DESKTOP_COUNT } from '../stores/shell';
import { MENUBAR_HEIGHT } from './wm/geometry';
import { trackPointer } from './wm/gestures';
import { overviewTiles, type OverviewTile } from './wm/overview-layout';
import { useWindowsStore, type WindowState } from './wm/store';
import './overview.css';

const DESKTOPS = Array.from({ length: DESKTOP_COUNT }, (_, index) => index);

/** Width of a desktop's miniature in the strip; its height follows the screen's shape. */
const MINIATURE_WIDTH = 176;

/** A press on a window becomes a drag towards a desktop after this much travel. */
const DRAG_THRESHOLD = 6;

type Direction = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

/** The tile the selection moves to for an arrow key: the neighbour in order, or the nearest one in the row above or below. */
function neighbour(tiles: OverviewTile[], current: string | null, key: Direction): string | null {
  const index = tiles.findIndex((tile) => tile.id === current);
  if (index < 0) return tiles[0]?.id ?? null;
  if (key === 'ArrowLeft') return tiles[Math.max(0, index - 1)]!.id;
  if (key === 'ArrowRight') return tiles[Math.min(tiles.length - 1, index + 1)]!.id;

  const centre = (tile: OverviewTile) => ({ x: tile.rect.x + tile.rect.w / 2, y: tile.rect.y + tile.rect.h / 2 });
  const from = centre(tiles[index]!);
  const sign = key === 'ArrowDown' ? 1 : -1;
  const beyond = tiles
    .map((tile) => ({ id: tile.id, dx: Math.abs(centre(tile).x - from.x), dy: (centre(tile).y - from.y) * sign }))
    .filter((tile) => tile.dy > 24)
    // The nearest row first, then the tile most directly above or below.
    .sort((a, b) => Math.round((a.dy - b.dy) / 48) || a.dx - b.dx);
  return beyond[0]?.id ?? current;
}

/** One desktop in the strip, drawn as a small plan of its windows. */
function Miniature({ windows, scale }: { windows: WindowState[]; scale: number }) {
  return (
    <>
      {windows.map((win) => (
        <span
          key={win.id}
          className="overview__mini"
          style={
            {
              left: win.bounds.x * scale,
              top: (win.bounds.y + MENUBAR_HEIGHT) * scale,
              width: Math.max(8, win.bounds.w * scale),
              height: Math.max(6, win.bounds.h * scale),
              zIndex: win.z,
              '--app': getApp(win.appId).color,
            } as CSSProperties
          }
        />
      ))}
    </>
  );
}

function OverviewSurface() {
  const windows = useWindowsStore((state) => state.windows);
  const agents = useAgentsStore((state) => state.agents);
  const desktop = useWindowsStore((state) => state.desktop);
  const viewport = useWindowsStore((state) => state.viewport);
  const tiles = useMemo(() => overviewTiles(windows, desktop, viewport), [windows, desktop, viewport]);

  const [selected, setSelected] = useState<string | null>(() => useWindowsStore.getState().focusedId);
  // The selection always rests on a window of the desktop in view.
  const selectedId = tiles.some((tile) => tile.id === selected) ? selected : (tiles[0]?.id ?? null);

  /** The window being carried to another desktop, and the desktop under the pointer. */
  const [carried, setCarried] = useState<string | null>(null);
  const [dropDesktop, setDropDesktop] = useState<number | null>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const pointerAt = useRef({ x: 0, y: 0 });
  const surface = useRef<HTMLDivElement>(null);
  /** Set by a drag so the click that ends it does not also open the window. */
  const dragged = useRef(false);

  const close = () => useWindowsStore.getState().setOverview(false);
  const show = (id: string) => {
    const state = useWindowsStore.getState();
    state.setOverview(false);
    state.focus(id);
  };

  // The keyboard belongs to the overview while it is open, not to the app behind it.
  useLayoutEffect(() => surface.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // While it fades out the keys already belong to the window behind it.
      if (!useWindowsStore.getState().overviewOpen) return;
      if (event.key === 'Escape') close();
      else if (event.key === 'Enter' && selectedId) show(selectedId);
      else if (event.key.startsWith('Arrow')) setSelected(neighbour(tiles, selectedId, event.key as Direction));
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [tiles, selectedId]);

  // The ghost follows the pointer without a render per frame; the layout effect
  // puts it there on the frame it first appears, so it never shows in the corner.
  const placeGhost = () => {
    const { x, y } = pointerAt.current;
    if (ghost.current) ghost.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };
  useLayoutEffect(placeGhost, [carried]);

  const desktopAt = (x: number, y: number): number | null => {
    const slot = document.elementsFromPoint(x, y).find((element) => element instanceof HTMLElement && element.dataset.desktop);
    return slot instanceof HTMLElement ? Number(slot.dataset.desktop) : null;
  };

  const onTilePointerDown = (event: PointerEvent<HTMLElement>, id: string) => {
    if (event.button !== 0) return;
    dragged.current = false;
    trackPointer(event, {
      frame(pointer) {
        if (!dragged.current) {
          if (Math.hypot(pointer.dx, pointer.dy) < DRAG_THRESHOLD) return;
          dragged.current = true;
          setCarried(id);
        }
        pointerAt.current = pointer;
        placeGhost();
        setDropDesktop(desktopAt(pointer.x, pointer.y));
      },
      end(pointer, cancelled) {
        if (!dragged.current) return;
        const target = cancelled ? null : desktopAt(pointer.x, pointer.y);
        if (target !== null) useWindowsStore.getState().moveToDesktop(id, target);
        setCarried(null);
        setDropDesktop(null);
      },
    });
  };

  const miniature = MINIATURE_WIDTH / viewport.w;
  const carriedWindow = carried ? windows[carried] : undefined;
  const shelf = tiles.filter((tile) => tile.minimized);

  return (
    <motion.div
      ref={surface}
      className="overview"
      data-testid="overview"
      role="dialog"
      aria-label="Overview"
      tabIndex={-1}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={spring('launcher')}
    >
      {/* Anywhere that is not a window or a desktop leaves the overview. */}
      <div className="overview__away" onClick={close} />

      <div className="overview__strip" role="group" aria-label="Desktops">
        {DESKTOPS.map((index) => {
          const onDesktop = Object.values(windows).filter((win) => win.desktop === index && win.mode !== 'minimized');
          return (
            <button
              key={index}
              type="button"
              className="overview__desk"
              data-testid={`overview-desktop-${index + 1}`}
              data-desktop={index}
              data-current={index === desktop || undefined}
              data-drop={(carried !== null && dropDesktop === index) || undefined}
              aria-label={`Desktop ${index + 1}, ${onDesktop.length} ${onDesktop.length === 1 ? 'window' : 'windows'}`}
              aria-pressed={index === desktop}
              onClick={() => useWindowsStore.getState().setDesktop(index)}
            >
              <span className="overview__plate">
                <span
                  className="overview__sheet"
                  style={{ width: MINIATURE_WIDTH, height: (viewport.h + MENUBAR_HEIGHT) * miniature }}
                >
                  <Miniature windows={onDesktop} scale={miniature} />
                </span>
              </span>
              <span className="overview__desk-name">Desktop {index + 1}</span>
            </button>
          );
        })}
      </div>

      <div className="overview__tiles" role="listbox" aria-label="Windows">
        {tiles.map((tile) => {
          const win = windows[tile.id]!;
          const appName = getApp(win.appId).name;
          // An agent's window is named after the agent; other titles lose the app's name in front, which the label already says.
          const ownTitle = win.title.startsWith(appName) ? win.title.slice(appName.length).replace(/^\s*[·:]\s*/, '') : win.title;
          const agent = win.appId === 'agent' && typeof win.params.agentId === 'string' ? agents[win.params.agentId] : undefined;
          return (
            <button
              key={tile.id}
              type="button"
              role="option"
              className="overview__tile"
              data-testid={`overview-tile-${tile.id}`}
              data-selected={tile.id === selectedId || undefined}
              data-minimized={tile.minimized || undefined}
              data-carried={tile.id === carried || undefined}
              aria-selected={tile.id === selectedId}
              tabIndex={-1}
              style={{
                left: tile.rect.x,
                top: tile.rect.y + MENUBAR_HEIGHT,
                width: tile.rect.w,
                height: tile.rect.h,
              }}
              onPointerDown={(event) => onTilePointerDown(event, tile.id)}
              onPointerEnter={() => setSelected(tile.id)}
              onClick={() => {
                if (!dragged.current) show(tile.id);
              }}
            >
              <span className="overview__label">
                <AppIcon id={win.appId} size={tile.minimized ? 14 : 16} hue={agent?.hue} seed={agent?.id} />
                {win.appId !== 'agent' && <span className="overview__label-app">{appName}</span>}
                {ownTitle !== '' && <span className="overview__label-text">{ownTitle}</span>}
              </span>
            </button>
          );
        })}
      </div>

      {shelf.length > 0 && (
        <p className="overview__shelf-name" style={{ top: Math.min(...shelf.map((tile) => tile.rect.y)) + MENUBAR_HEIGHT - 34 }}>
          Minimised
        </p>
      )}

      {tiles.length === 0 && (
        <div className="overview__empty" data-testid="overview-empty">
          <p className="overview__empty-title">Desktop {desktop + 1} is clear</p>
          <p className="overview__empty-text">Open an app here, or pick another desktop above.</p>
        </div>
      )}

      {carriedWindow && (
        <div className="overview__ghost" ref={ghost} data-testid="overview-ghost">
          <AppIcon id={carriedWindow.appId} size={18} />
          <span>{carriedWindow.title}</span>
        </div>
      )}
    </motion.div>
  );
}

/**
 * The overview: every window of the current desktop at once, scaled into a
 * grid, with the four desktops in a strip above. The windows themselves are
 * the live ones, moved by the windows layer; this draws the dimmed backdrop
 * underneath them and the titles, targets and desktops strip on top.
 */
export function Overview({ onClosed }: { onClosed(): void }) {
  const open = useWindowsStore((state) => state.overviewOpen);
  return (
    <AnimatePresence onExitComplete={onClosed}>
      {open && (
        <motion.div
          key="backdrop"
          className="overview-backdrop"
          data-testid="overview-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={spring('desktopSlide')}
        />
      )}
      {open && <OverviewSurface key="surface" />}
    </AnimatePresence>
  );
}
