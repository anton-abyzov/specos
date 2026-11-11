import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { spring } from '../../design/motion';
import { bindKeys } from './keys';
import { persistLayout } from './persistence';
import { connectShell } from './shell-port';
import { useWindowsStore } from './store';
import { Window } from './Window';

/**
 * The layer every window lives in, below the menu bar. The four desktops lie
 * side by side on one stage that slides; a window is offset by its desktop, so
 * moving it to another desktop never remounts the app inside it.
 */
export function WindowLayer() {
  const windows = useWindowsStore((state) => state.windows);
  const focusedId = useWindowsStore((state) => state.focusedId);
  const desktop = useWindowsStore((state) => state.desktop);
  const layer = useRef<HTMLDivElement>(null);

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
        animate={{ x: `${-desktop * 100}%` }}
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
              place={null}
              selected={false}
            />
          ))}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
