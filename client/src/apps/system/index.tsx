import { useEffect, useMemo, type ReactNode } from 'react';
import type { SystemInfo, SystemStats } from '@shared/protocol';
import type { AppProps } from '../registry';
import { Glyph } from '../../design/icons';
import { api } from '../../lib/api';
import { ACTIVITY_CAP, useActivityStore } from '../../stores/activity';
import { useShellStore } from '../../stores/shell';
import { STATS_HISTORY, useSystemStore } from '../../stores/system';
import { useWorkspaceList } from '../../stores/workspaces';
import { summarise, useBench } from './bench';
import { Benchmark } from './Benchmark';
import { formatBytes, formatMs, formatPercent, formatUptime } from './format';
import './system.css';

/** Sizes and load go stale in the hello frame; the open window reads them again this often. */
const REFRESH_MS = 10_000;

function refreshInfo(): void {
  api.system.info().then(
    (info) => useSystemStore.getState().setInfo(info),
    () => undefined,
  );
}

/** A line over the last two minutes of one 0 to 1 reading; new samples enter at the right. */
function Sparkline({ values, testId }: { values: number[]; testId: string }) {
  const last = STATS_HISTORY - 1;
  const points = values.map((value, index) => {
    const x = last - (values.length - 1 - index);
    const y = 1 - Math.min(1, Math.max(0, value));
    return `${x},${y.toFixed(4)}`;
  });
  const first = last - (values.length - 1);
  return (
    <svg
      className="sys-spark"
      viewBox={`0 -0.06 ${last} 1.12`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid={testId}
      data-points={values.length}
    >
      {values.length > 1 && (
        <>
          <polygon className="sys-spark__area" points={`${first},1 ${points.join(' ')} ${last},1`} />
          <polyline className="sys-spark__line" points={points.join(' ')} />
        </>
      )}
    </svg>
  );
}

function Fact({
  label,
  wide,
  testId,
  children,
}: {
  label: string;
  wide?: 2 | 4;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="sys-fact" data-wide={wide}>
      <dt className="sys-fact__label">{label}</dt>
      <dd className="sys-fact__value selectable" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

const loadText = (load: SystemInfo['cpu']['load']): string => load.map((value) => value.toFixed(2)).join('  ');

function Meter({
  label,
  reading,
  readingTestId,
  sparkTestId,
  values,
  children,
}: {
  label: string;
  reading: string;
  readingTestId: string;
  sparkTestId: string;
  values: number[];
  children: ReactNode;
}) {
  return (
    <div className="sys-fact sys-meter" data-wide={2}>
      <dt className="sys-fact__label">{label}</dt>
      <dd className="sys-meter__body">
        <span className="sys-meter__reading tabular" data-testid={readingTestId}>
          {reading}
        </span>
        <Sparkline values={values} testId={sparkTestId} />
        <span className="sys-meter__notes selectable">{children}</span>
      </dd>
    </div>
  );
}

function Sheet({ info, stats, history }: { info: SystemInfo; stats: SystemStats | null; history: SystemStats[] }) {
  // The uptime in the frame is as old as the frame; the clock of the stats tick carries it forward.
  const readAt = useMemo(() => Date.now(), [info]);
  const uptime = info.uptime + Math.max(0, ((stats?.at ?? readAt) - readAt) / 1000);
  const used = info.fs.total - info.fs.free;
  const usedShare = info.fs.total > 0 ? used / info.fs.total : 0;
  const cpu = useMemo(() => history.map((sample) => sample.cpu), [history]);
  const memory = useMemo(() => history.map((sample) => sample.memory), [history]);
  const memoryUsed = stats?.memoryUsed ?? info.memory.total - info.memory.available;
  const memoryTotal = stats?.memoryTotal ?? info.memory.total;

  return (
    <dl className="sys-sheet">
      <Meter
        label="Processor"
        reading={stats ? formatPercent(stats.cpu) : ''}
        readingTestId="system-cpu"
        sparkTestId="system-cpu-spark"
        values={cpu}
      >
        <span>{info.cpu.model}</span>
        <span>
          {info.cpu.cores} {info.cpu.cores === 1 ? 'core' : 'cores'}, load <span className="tabular">{loadText(info.cpu.load)}</span>
        </span>
      </Meter>
      <Meter
        label="Memory"
        reading={formatPercent(memoryTotal > 0 ? memoryUsed / memoryTotal : 0)}
        readingTestId="system-memory"
        sparkTestId="system-memory-spark"
        values={memory}
      >
        <span data-testid="system-memory-used">
          {formatBytes(memoryUsed)} used of {formatBytes(memoryTotal)}
        </span>
        <span>{formatBytes(Math.max(0, memoryTotal - memoryUsed))} available</span>
      </Meter>

      <div className="sys-fact sys-disk" data-wide={2}>
        <dt className="sys-fact__label">File system of the home folder</dt>
        <dd className="sys-disk__body selectable">
          <span className="sys-disk__type" data-testid="system-fs-type">
            {info.fs.type}
          </span>
          <span className="sys-disk__where">
            <span data-testid="system-fs-device">{info.fs.device}</span> mounted at{' '}
            <span data-testid="system-fs-mount">{info.fs.mount}</span>
          </span>
          <span
            className="sys-disk__bar"
            role="meter"
            aria-label="Disk space used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(usedShare * 100)}
          >
            <span className="sys-disk__used" style={{ width: `${Math.min(100, usedShare * 100)}%` }} />
          </span>
          <span className="sys-disk__figures tabular">
            <span data-testid="system-fs-used">{formatBytes(used)} used</span>
            <span data-testid="system-fs-free">{formatBytes(info.fs.free)} free</span>
          </span>
        </dd>
      </div>
      <div className="sys-fact sys-clone" data-wide={2}>
        <dt className="sys-fact__label">How a project is copied for an agent</dt>
        <dd className="sys-clone__body selectable">
          <span className="sys-disk__type" data-testid="system-clone-strategy">
            {info.clone.strategy}
          </span>
          <span className="sys-clone__reason" data-testid="system-clone-reason">
            {info.clone.reason}
          </span>
        </dd>
      </div>

      <Fact label="Operating system" testId="system-os">
        {info.os.name} {info.os.version}
      </Fact>
      <Fact label="Kernel" testId="system-kernel-fact">
        {info.kernel}
      </Fact>
      <Fact label="Architecture" testId="system-arch">
        {info.arch}
      </Fact>
      <Fact label="Hostname" testId="system-hostname">
        {info.hostname}
      </Fact>
      <Fact label="Uptime" testId="system-uptime">
        {formatUptime(uptime)}
      </Fact>
      <Fact label="Node" testId="system-node">
        {info.node}
      </Fact>
      <Fact label="Agent runner" testId="system-runner">
        {info.agentRunner.available === 'claude'
          ? `claude ${info.agentRunner.claudeVersion ?? ''}`.trim()
          : 'demo'}
      </Fact>
      <Fact label="Agents at work" testId="system-agents">
        {stats?.agentsRunning ?? 0}
      </Fact>
      <Fact label="Home folder" wide={4} testId="system-home">
        {info.home}
      </Fact>
    </dl>
  );
}

/** Why this desktop sits on Linux, each point resting on something this machine reports. */
function Grounds({ info }: { info: SystemInfo }) {
  const launchApp = useShellStore((state) => state.launchApp);
  const changes = useActivityStore((state) => state.entries.length);
  const lastBench = useBench((state) => state.last);
  const workspaces = useWorkspaceList();
  const newest = workspaces.find((workspace) => !/-bench-\d+(-\d+)?$/.test(workspace.name));

  const cloneFact = lastBench
    ? `${formatMs(summarise(lastBench.result).medianMs)} per copy of ${lastBench.result.clones[0]!.files} files, the median of the last test`
    : newest
      ? `${formatMs(newest.clone.ms)} for ${newest.name}, the newest workspace`
      : 'not timed yet, the test below does it';
  const changesFact =
    changes === 0
      ? 'no file has changed since this page loaded'
      : `${changes >= ACTIVITY_CAP ? `${ACTIVITY_CAP} or more` : changes} ${changes === 1 ? 'change' : 'changes'} reported since this page loaded`;

  return (
    <section className="sys-grounds" aria-labelledby="sys-grounds-title">
      <h2 className="sys-title" id="sys-grounds-title">
        Why agents work on Linux here
      </h2>
      <ul className="sys-grounds__list">
        <li className="sys-ground">
          <h3 className="sys-ground__name">A real file system</h3>
          <p className="sys-ground__text">
            Agents write ordinary files in the home folder. The kernel tells the server about each change, and the
            server tells every open window, in milliseconds.
          </p>
          <p className="sys-ground__fact" data-testid="ground-fs">
            {info.fs.type}, {formatBytes(info.fs.free)} free; {changesFact}
          </p>
        </li>
        <li className="sys-ground">
          <h3 className="sys-ground__name">A real shell</h3>
          <p className="sys-ground__text">
            A Terminal window is a pseudo-terminal running your shell on {info.hostname}. Whatever runs there runs on
            this machine, on the same files the agents see.
          </p>
          <button type="button" className="sys-quiet" data-testid="open-terminal" onClick={() => launchApp('terminal')}>
            <Glyph name="terminal" size={14} />
            Open a Terminal
          </button>
        </li>
        <li className="sys-ground">
          <h3 className="sys-ground__name">Cheap separate workspaces</h3>
          <p className="sys-ground__text">
            Every agent gets its own copy of a project, so two agents never write over each other and nothing reaches
            the project until it is merged.
          </p>
          <p className="sys-ground__fact" data-testid="ground-clone">
            {info.clone.strategy}; {cloneFact}
          </p>
        </li>
      </ul>
    </section>
  );
}

export default function SystemApp({ setTitle }: AppProps) {
  const info = useSystemStore((state) => state.info);
  const stats = useSystemStore((state) => state.stats);
  const history = useSystemStore((state) => state.history);

  useEffect(() => setTitle('System'), [setTitle]);
  useEffect(() => {
    refreshInfo();
    const timer = window.setInterval(refreshInfo, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  if (!info) return <section className="system" data-testid="app-system" aria-busy="true" />;

  const platform = info.os.platform === 'linux' ? 'Linux' : info.os.platform;
  return (
    <section className="system" data-testid="app-system">
      <div className="sys-page">
        <header className="sys-head">
          <h1 className="sys-head__os selectable" data-testid="system-headline">
            {info.os.name} {info.os.version}
          </h1>
          <p className="sys-head__kernel selectable">
            {platform} <span data-testid="system-kernel">{info.kernel}</span>
          </p>
        </header>
        <Sheet info={info} stats={stats} history={history} />
        <Grounds info={info} />
        <Benchmark info={info} onFinished={refreshInfo} />
      </div>
    </section>
  );
}
