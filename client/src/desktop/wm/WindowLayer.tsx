import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { spring } from '../../design/motion';
import { DropPreview } from './DropPreview';
import { bindKeys } from './keys';
import { allOverviewTiles } from './overview-layout';
import { persistLayout } from './persistence';
import { connectShell } from './shell-port';
import { useWindowsStore } from './store';
import { Window, type OverviewPlace } from './Window';

/**
 * The layer every window lives in, below the menu bar. The four desktops lie
 * side by side on one stage that slides; a window is offset by its desktop, so
 * moving it to another desktop never remounts the app inside it.
 */
export function WindowLayer() {
  const windows = useWindowsStore((state) => state.windows);
  const focusedId = useWindowsStore((state) => state.focusedId);
  const desktop = useWindowsStore((state) => state.desktop);
  const overviewOpen = useWindowsStore((state) => state.overviewOpen);
  const viewport = useWindowsStore((state) => state.viewport);
  const layer = useRef<HTMLDivElement>(null);

  // In the overview each window is moved and scaled from its own frame to its tile.
  const places = useMemo(() => {
    const byId = new Map<string, OverviewPlace>();
    if (!overviewOpen) return byId;
    for (const [id, tile] of allOverviewTiles(windows, viewport)) {
      const { bounds } = windows[id]!;
      byId.set(id, { x: tile.rect.x - bounds.x, y: tile.rect.y - bounds.y, scale: tile.scale });
    }
    return byId;
  }, [overviewOpen, windows, viewport]);

  // The desktop the stage last came to rest on. While it differs from the
  // current one the stage is sliding and every desktop it passes is visible.
  const [rested, setRested] = useState(desktop);
  const sliding = rested !== desktop;

  useLayoutEffect(() => connectShell(), []);
  useEffect(() => persistLayout(useWindowsStore), []);
  useEffect(() => bindKeys(), []);

  useLayoutEffect(() => {
    const element = layer.current!;
    const measure = () => useWindowsStore.getState().setViewport({ w: element.clientWidth, h: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // The windows store joins the other stores on the hook that tests drive the desktop through.
    window.__specos = { ...(window.__specos ?? {}), windows: useWindowsStore };
  }, []);

  // A fixed order in the document: stacking is z-index, so focusing a window never moves its element.
  const ordered = Object.values(windows).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  return (
    <div className="desktop__windows" data-testid="windows-layer" ref={layer}>
      <motion.div
        className="wm-stage"
        initial={false}
        animate={{ x: -desktop * viewport.w }}
        transition={spring('desktopSlide')}
        onAnimationComplete={() => setRested(useWindowsStore.getState().desktop)}
      >
        <AnimatePresence>
          {ordered.map((win) => (
            <Window
              key={win.id}
              win={win}
              focused={win.id === focusedId}
              offstage={!sliding && win.desktop !== desktop}
              place={places.get(win.id) ?? null}
            />
          ))}
        </AnimatePresence>
        <DropPreview />
      </motion.div>
    </div>
  );
}
