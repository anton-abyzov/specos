import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion, useMotionValue, useTransform } from 'motion/react';
import { DOCK_APPS, type AppDefinition } from '../apps/registry';
import { agentVars } from '../design/color';
import { AgentIcon, AppIcon } from '../design/icons';
import { spring } from '../design/motion';
import type { AgentInfo } from '@shared/protocol';
import { isAgentActive, useAgentList } from '../stores/agents';
import { useShellStore } from '../stores/shell';
import { DockMagnifier } from './dock-magnify';
import './dock.css';

/** Icon size and the slot it sits in, in pixels. Mirrors --dock-icon and --dock-gap. */
const ICON = 52;
const SLOT = ICON + 6;
const DIVIDER_SLOT = 17;

const Magnifier = createContext<DockMagnifier | null>(null);

function useMagnifier(): DockMagnifier {
  const magnifier = useContext(Magnifier);
  if (!magnifier) throw new Error('Dock items must be rendered inside the Dock');
  return magnifier;
}

interface DockItemProps {
  testId: string;
  /** Shown in the tooltip and read to screen readers. */
  label: string;
  running: boolean;
  /** The app in front: its indicator is drawn in the signal colour. */
  active: boolean;
  onActivate(): void;
  /** Extra attributes on the slot, for example the agent's colour variables. */
  style?: CSSProperties;
  children: ReactNode;
}

function DockItem({ testId, label, running, active, onActivate, style, children }: DockItemProps) {
  const magnifier = useMagnifier();
  const slot = useRef<HTMLLIElement>(null);
  const scale = useMotionValue(1);
  const shift = useMotionValue(0);
  // The tooltip rides on top of the icon as it grows.
  const lift = useTransform(scale, (value) => -ICON * (value - 1));
  const [hinted, setHinted] = useState(false);

  useLayoutEffect(() => magnifier.join(slot.current!, ICON, scale, shift), [magnifier, scale, shift]);

  return (
    <motion.li
      ref={slot}
      className="dock__slot"
      style={style}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: SLOT, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={spring('layout')}
      onAnimationComplete={() => magnifier.measure()}
    >
      <motion.div className="dock__mover" style={{ x: shift }}>
        <motion.div className="dock__tip-anchor" style={{ y: lift }}>
          <AnimatePresence>
            {hinted && (
              <motion.span
                className="dock__tip"
                role="tooltip"
                initial={{ opacity: 0, y: 4, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.08 } }}
                transition={spring('menu')}
              >
                {label}
              </motion.span>
            )}
          </AnimatePresence>
        </motion.div>
        <motion.button
          type="button"
          className="dock__button"
          data-testid={testId}
          data-running={running || undefined}
          aria-label={running ? `${label}, running` : label}
          style={{ scale }}
          whileTap={{ filter: 'brightness(0.86)' }}
          onClick={onActivate}
          onPointerEnter={() => setHinted(true)}
          onPointerLeave={() => setHinted(false)}
          onFocus={(event) => setHinted(event.currentTarget.matches(':focus-visible'))}
          onBlur={() => setHinted(false)}
        >
          {children}
        </motion.button>
        <span className="dock__indicator" data-running={running || undefined} data-active={active || undefined} />
      </motion.div>
    </motion.li>
  );
}

/** The rule between apps and agents. It does not grow, but it moves with its neighbours. */
function DockDivider() {
  const magnifier = useMagnifier();
  const slot = useRef<HTMLLIElement>(null);
  const scale = useMotionValue(1);
  const shift = useMotionValue(0);
  useLayoutEffect(() => magnifier.join(slot.current!, 0, scale, shift), [magnifier, scale, shift]);
  return (
    <motion.li
      ref={slot}
      className="dock__divider"
      role="separator"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: DIVIDER_SLOT, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={spring('layout')}
      onAnimationComplete={() => magnifier.measure()}
    >
      <motion.span className="dock__rule" style={{ x: shift }} />
    </motion.li>
  );
}

function AppItem({ app }: { app: AppDefinition }) {
  const running = useShellStore((state) => state.runningApps.includes(app.id));
  const active = useShellStore((state) => state.activeAppId === app.id);
  const launchApp = useShellStore((state) => state.launchApp);
  const focusApp = useShellStore((state) => state.focusApp);
  return (
    <DockItem
      testId={`dock-app-${app.id}`}
      label={app.name}
      running={running}
      active={active}
      onActivate={() => (running ? focusApp(app.id) : launchApp(app.id))}
    >
      <AppIcon id={app.id} size={ICON} />
    </DockItem>
  );
}

function AgentItem({ agent, hasWindow }: { agent: AgentInfo; hasWindow: boolean }) {
  const launchApp = useShellStore((state) => state.launchApp);
  const focusApp = useShellStore((state) => state.focusApp);
  const params = { agentId: agent.id };
  return (
    <DockItem
      testId={`dock-agent-${agent.id}`}
      label={agent.name}
      running={hasWindow}
      active={false}
      style={agentVars(agent.hue)}
      onActivate={() => (hasWindow ? focusApp('agent', params) : launchApp('agent', params))}
    >
      <AgentIcon hue={agent.hue} seed={agent.id} running={isAgentActive(agent)} size={ICON} />
    </DockItem>
  );
}

/**
 * The shelf at the bottom: the seven apps, then one icon per agent that is
 * working or still has a window open.
 */
export function Dock() {
  const magnifier = useMemo(() => new DockMagnifier(), []);
  const row = useRef<HTMLUListElement>(null);
  const agents = useAgentList();
  const agentWindows = useShellStore((state) => state.agentWindows);

  const windowed = useMemo(() => new Set(agentWindows.map((window) => window.agentId)), [agentWindows]);
  const dockAgents = agents.filter((agent) => isAgentActive(agent) || windowed.has(agent.id));

  useEffect(() => {
    // Icons arriving and leaving change every resting position.
    const observer = new ResizeObserver(() => magnifier.measure());
    observer.observe(row.current!);
    const detach = magnifier.attach();
    return () => {
      observer.disconnect();
      detach();
    };
  }, [magnifier]);

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch') return;
    magnifier.track(event.clientX - row.current!.getBoundingClientRect().left);
  };

  // The shelf widens with the icons, half of the growth on each side.
  const overhang = useTransform(magnifier.spread, (value) => -value / 2);

  return (
    <Magnifier.Provider value={magnifier}>
      <nav
        className="dock"
        aria-label="Dock"
        data-testid="dock"
        onPointerMove={onPointerMove}
        onPointerLeave={() => magnifier.release()}
      >
        <motion.div className="dock__shelf" style={{ left: overhang, right: overhang }} />
        <ul className="dock__row" ref={row}>
          <AnimatePresence initial={false}>
            {DOCK_APPS.map((app) => (
              <AppItem key={app.id} app={app} />
            ))}
            {dockAgents.length > 0 && <DockDivider key="divider" />}
            {dockAgents.map((agent) => (
              <AgentItem key={`agent-${agent.id}`} agent={agent} hasWindow={windowed.has(agent.id)} />
            ))}
          </AnimatePresence>
        </ul>
      </nav>
    </Magnifier.Provider>
  );
}
