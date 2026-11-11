/** The right side of the menu bar: small live facts about desktops, agents and the machine. */
import { useEffect, useState } from 'react';
import { Glyph, type GlyphName } from '../../design/icons';
import { setTheme } from '../../lib/theme';
import { useRunningAgentCount } from '../../stores/agents';
import { useConnectionStore } from '../../stores/connection';
import { DESKTOP_COUNT, useShellStore } from '../../stores/shell';
import { useSystemStore } from '../../stores/system';
import { useTheme } from '../../stores/theme';

const DESKTOPS = Array.from({ length: DESKTOP_COUNT }, (_, index) => index);

export function DesktopSwitcher() {
  const current = useShellStore((state) => state.desktop);
  const setDesktop = useShellStore((state) => state.setDesktop);
  return (
    <div className="desktops" role="group" aria-label="Desktops" data-testid="desktops">
      {DESKTOPS.map((index) => (
        <button
          key={index}
          type="button"
          className="desktops__slot"
          data-testid={`desktop-slot-${index + 1}`}
          data-current={current === index || undefined}
          aria-label={`Desktop ${index + 1}`}
          aria-pressed={current === index}
          title={`Desktop ${index + 1}`}
          onClick={() => setDesktop(index)}
        >
          <span className="desktops__sheet" />
        </button>
      ))}
    </div>
  );
}

export function AgentsPill() {
  const running = useRunningAgentCount();
  const launchApp = useShellStore((state) => state.launchApp);
  const label = running === 0 ? 'No agents running' : `${running} ${running === 1 ? 'agent' : 'agents'} running`;
  return (
    <button
      type="button"
      className="status-item agents-pill"
      data-testid="agents-pill"
      data-running={running > 0 || undefined}
      aria-label={label}
      title={label}
      onClick={() => launchApp('agents')}
    >
      <span className="agents-pill__dot" />
      <span className="agents-pill__count tabular" data-testid="agents-count">
        {running}
      </span>
    </button>
  );
}

interface MeterProps {
  glyph: GlyphName;
  label: string;
  /** 0 to 1, or null before the first stats frame. */
  value: number | null;
  testId: string;
}

function Meter({ glyph, label, value, testId }: MeterProps) {
  const percent = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span
      className="meter"
      role="img"
      aria-label={percent === null ? `${label}: waiting for the first reading` : `${label} ${percent}%`}
      title={label}
      data-high={(percent ?? 0) >= 85 || undefined}
    >
      <Glyph name={glyph} size={14} />
      <span className="meter__track">
        <span className="meter__fill" style={{ transform: `scaleX(${(percent ?? 0) / 100})` }} />
      </span>
      {/* A fixed-width number in tabular figures: the bar never shifts as it changes. */}
      <span className="meter__value tabular" data-testid={testId}>
        {percent === null ? '–' : `${percent}%`}
      </span>
    </span>
  );
}

export function SystemMeters() {
  const stats = useSystemStore((state) => state.stats);
  return (
    <div className="meters">
      <Meter glyph="cpu" label="CPU" value={stats?.cpu ?? null} testId="cpu-value" />
      <Meter glyph="memory" label="Memory" value={stats?.memory ?? null} testId="memory-value" />
    </div>
  );
}

/** Kernel and file system, the two facts that decide how fast an agent gets its own copy. */
export function SystemBadge() {
  const badge = useSystemStore((state) => state.info?.badge);
  const launchApp = useShellStore((state) => state.launchApp);
  if (!badge) return null;
  return (
    <button
      type="button"
      className="system-badge"
      data-testid="system-badge"
      title="Open System"
      onClick={() => launchApp('system')}
    >
      <span className="system-badge__text">{badge}</span>
    </button>
  );
}

export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="status-item status-item--icon"
      data-testid="theme-toggle"
      aria-label={`Switch to the ${next} theme`}
      title={`Switch to the ${next} theme`}
      onClick={() => setTheme(next)}
    >
      <Glyph name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
    </button>
  );
}

/** Shown only while the events socket is down, so stale numbers are never mistaken for live ones. */
export function ConnectionNotice() {
  const status = useConnectionStore((state) => state.status);
  if (status !== 'reconnecting') return null;
  return (
    <span className="connection-notice" role="status" data-testid="connection-notice">
      Reconnecting
    </span>
  );
}

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Wake exactly when the minute turns instead of polling every second.
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, 60_000 - (Date.now() % 60_000) + 20);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <time className="clock tabular" data-testid="clock" dateTime={now.toISOString()}>
      <span className="clock__day" data-testid="clock-day">{dayFormat.format(now)}</span>
      <span className="clock__time" data-testid="clock-time">{timeFormat.format(now)}</span>
    </time>
  );
}
