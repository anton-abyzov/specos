import {
  Component,
  Suspense,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { motion, useIsPresent, type TargetAndTransition } from 'motion/react';
import { getApp } from '../../apps/registry';
import { agentVars } from '../../design/color';
import { AppIcon, Glyph } from '../../design/icons';
import { spring } from '../../design/motion';
import { useAgent } from '../../stores/agents';
import { beginMove, beginResize } from './drag';
import { FrameController } from './frame';
import { MENUBAR_HEIGHT, type Rect, type ResizeEdges } from './geometry';
import { useWindowsStore, type WindowState } from './store';
import './window.css';

/** Where a window sits in the overview grid, relative to its own frame. */
export interface OverviewPlace {
  x: number;
  y: number;
  scale: number;
}

interface WindowProps {
  win: WindowState;
  focused: boolean;
  /** On another desktop and not sliding past: kept mounted, hidden. */
  offstage: boolean;
  /** Set while the overview shows this window. */
  place: OverviewPlace | null;
  /** The overview's keyboard selection is on this window. */
  selected: boolean;
}

const HANDLES: Array<{ name: string; edges: ResizeEdges }> = [
  { name: 'n', edges: { n: true } },
  { name: 's', edges: { s: true } },
  { name: 'e', edges: { e: true } },
  { name: 'w', edges: { w: true } },
  { name: 'ne', edges: { n: true, e: true } },
  { name: 'nw', edges: { n: true, w: true } },
  { name: 'se', edges: { s: true, e: true } },
  { name: 'sw', edges: { s: true, w: true } },
];

const REST: TargetAndTransition = { x: 0, y: 0, scale: 1, opacity: 1 };

/** Scaling about the middle, written for an element whose transform origin is its top-left corner. */
const scaledAboutCentre = (bounds: Rect, scale: number) => ({
  scale,
  x: (bounds.w * (1 - scale)) / 2,
  y: (bounds.h * (1 - scale)) / 2,
});

/**
 * Where a minimised window lands: on its dock icon, at the icon's size. Falls
 * back to the middle of the bottom edge when the icon is not in the dock.
 */
function dockTarget(win: WindowState): TargetAndTransition {
  const agentId = win.appId === 'agent' ? win.params.agentId : undefined;
  const testId = typeof agentId === 'string' ? `dock-agent-${agentId}` : `dock-app-${win.appId}`;
  const icon = document.querySelector(`[data-testid="${CSS.escape(testId)}"]`)?.getBoundingClientRect();
  const view = useWindowsStore.getState().viewport;
  const target = icon
    ? { x: icon.left, y: icon.top - MENUBAR_HEIGHT, size: icon.width }
    : { x: view.w / 2 - 26, y: view.h - 60, size: 52 };
  return {
    x: target.x - win.bounds.x,
    y: target.y - win.bounds.y,
    scale: target.size / win.bounds.w,
    opacity: 0,
  };
}

interface BoundaryProps {
  appName: string;
  children: ReactNode;
}

/** A crash inside an app stays inside its window: the desktop and the other windows carry on. */
class AppBoundary extends Component<BoundaryProps, { failed: boolean; attempt: number }> {
  override state = { failed: false, attempt: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn(`${this.props.appName} stopped working`, error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return <div className="window__app" key={this.state.attempt}>{this.props.children}</div>;
    return (
      <div className="window__failure" role="alert" data-testid="window-failure">
        <p className="window__failure-title">{this.props.appName} stopped working</p>
        <p className="window__failure-text">The rest of the desktop is fine. Reloading starts this window again.</p>
        <button
          type="button"
          className="window__failure-action"
          onClick={() => this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }))}
        >
          Reload {this.props.appName}
        </button>
      </div>
    );
  }
}

/** Shown while an app's code loads. Quiet on purpose, and late enough that a fast load never shows it. */
function Skeleton() {
  return (
    <div className="window__skeleton" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

export const Window = memo(function Window({ win, focused, offstage, place, selected }: WindowProps) {
  const { id, appId, mode, bounds } = win;
  const app = getApp(appId);
  const AppComponent = app.component;
  const present = useIsPresent();
  const minimized = mode === 'minimized';

  const frame = useRef<FrameController>(null);
  frame.current ??= new FrameController(bounds);
  const attach = useCallback((element: HTMLElement | null) => frame.current!.attach(element), []);
  const size = useRef<HTMLSpanElement>(null);

  // The store moved the window (snap, tile, full screen, a smaller screen): travel there.
  // After a drag the element is already there and nothing happens.
  useLayoutEffect(() => {
    if (present) frame.current!.moveTo(bounds);
  }, [present, bounds]);

  // Once the flight to the dock is over the window is taken off screen for real.
  const [parked, setParked] = useState(minimized);
  if (!minimized && parked) setParked(false);

  // Measured as the window is minimised, so it flies to where its icon is now.
  const docked = useMemo(() => (minimized ? dockTarget(win) : null), [minimized]);

  const resting = docked ? 'docked' : place ? 'overview' : 'rest';
  const previous = useRef(resting);
  const target: TargetAndTransition = place
    ? { x: place.x, y: place.y, scale: place.scale, opacity: 1 }
    : (docked ?? REST);
  // The spring is chosen by the journey: to or from the dock, into or out of the overview, or just opening.
  const journey = [previous.current, resting];
  const transition = journey.includes('docked')
    ? spring('minimise')
    : journey.includes('overview')
      ? spring('desktopSlide')
      : spring('windowOpen');
  useLayoutEffect(() => {
    previous.current = resting;
  }, [resting]);

  const restored = win.createdAt < useWindowsStore.getState().bootedAt;
  const setTitle = useCallback((title: string) => useWindowsStore.getState().setTitle(id, title), [id]);
  const agent = useAgent(appId === 'agent' && typeof win.params.agentId === 'string' ? win.params.agentId : undefined);

  const actions = useWindowsStore.getState();
  const onBarPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('.window__controls')) return;
    beginMove(event, id, frame.current!);
  };
  const onBarDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (!(event.target as Element).closest('.window__controls')) actions.toggleFullscreen(id);
  };
  const showSize = (rect: Rect) => {
    if (size.current) size.current.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
  };

  const resizable = mode === 'normal' || mode === 'snapped';
  const fullscreen = mode === 'fullscreen';

  return (
    <section
      ref={attach}
      className="wm-frame"
      data-testid={`window-${id}`}
      data-window-id={id}
      data-app={appId}
      data-mode={mode}
      data-focused={focused || undefined}
      data-tiled={win.tiled || undefined}
      data-offstage={offstage || undefined}
      data-parked={(minimized && parked && !place) || undefined}
      data-closing={!present || undefined}
      data-overview={place ? '' : undefined}
      data-selected={selected || undefined}
      aria-label={win.title}
      style={{ zIndex: win.z, '--desk': win.desktop, ...(agent ? agentVars(agent.hue) : null) } as CSSProperties}
      onPointerDownCapture={() => {
        if (!place) actions.focus(id);
      }}
    >
      <motion.div
        className="window"
        style={{ transformOrigin: '0 0' }}
        initial={restored ? false : { opacity: 0, ...scaledAboutCentre(bounds, 0.94) }}
        animate={target}
        exit={{ opacity: 0, ...scaledAboutCentre(bounds, 0.96), transition: spring('windowClose') }}
        transition={transition}
        onAnimationComplete={() => {
          if (useWindowsStore.getState().windows[id]?.mode === 'minimized') setParked(true);
        }}
      >
        <header
          className="window__bar"
          data-testid="window-titlebar"
          onPointerDown={onBarPointerDown}
          onDoubleClick={onBarDoubleClick}
        >
          <AppIcon id={appId} size={18} hue={agent?.hue} seed={agent?.id} />
          <h2 className="window__title" data-testid="window-title">
            {win.title}
          </h2>
          <span className="window__size tabular" ref={size} aria-hidden="true" />
          <div className="window__controls" role="group" aria-label="Window">
            <button
              type="button"
              className="window__key"
              data-testid="window-minimise"
              aria-label="Minimise"
              title="Minimise"
              onClick={() => actions.minimise(id)}
            >
              <Glyph name="minimise" size={14} />
            </button>
            <button
              type="button"
              className="window__key"
              data-testid="window-fullscreen"
              aria-label={fullscreen ? 'Leave full screen' : 'Full screen'}
              title={fullscreen ? 'Leave full screen' : 'Full screen'}
              onClick={() => actions.toggleFullscreen(id)}
            >
              <Glyph name={fullscreen ? 'restore' : 'fullscreen'} size={14} />
            </button>
            <button
              type="button"
              className="window__key window__key--close"
              data-testid="window-close"
              aria-label="Close"
              title="Close"
              onClick={() => actions.close(id)}
            >
              <Glyph name="close" size={14} />
            </button>
          </div>
        </header>
        <div className="window__body">
          <AppBoundary appName={app.name}>
            <Suspense fallback={<Skeleton />}>
              <AppComponent windowId={id} params={win.params} setTitle={setTitle} focused={focused} />
            </Suspense>
          </AppBoundary>
          {/* Covers the app while any window is dragged, so iframes and canvases cannot take the pointer. */}
          <div className="window__shield" />
        </div>
      </motion.div>
      {resizable &&
        !win.tiled &&
        !place &&
        HANDLES.map((handle) => (
          <div
            key={handle.name}
            className="wm-handle"
            data-resize={handle.name}
            onPointerDown={(event) => {
              if (event.button === 0) beginResize(event, id, frame.current!, handle.edges, showSize);
            }}
          />
        ))}
    </section>
  );
});
