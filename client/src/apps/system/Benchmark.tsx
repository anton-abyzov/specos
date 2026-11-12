import { useEffect, useRef, type CSSProperties } from 'react';
import type { CloneReport, SystemInfo } from '@shared/protocol';
import { Glyph } from '../../design/icons';
import { BENCH_COUNTS, summarise, useBench } from './bench';
import { formatBarMs, formatBytes, formatMs, formatWhen } from './format';

/** Height of the tallest bar, in pixels. */
const BAR_MAX = 104;
const BAR_MIN = 3;

function Bars({ clones, count }: { clones: Array<CloneReport | undefined>; count: number }) {
  const slowest = Math.max(0, ...clones.map((clone) => clone?.ms ?? 0));
  const narrow = count > 10;
  return (
    <ol className="bench-bars" data-testid="bench-bars" data-narrow={narrow || undefined} style={{ '--bench-count': count } as CSSProperties}>
      {Array.from({ length: count }, (_, index) => {
        const clone = clones[index];
        return (
          <li
            key={index}
            className="bench-bar"
            data-testid={clone ? 'bench-bar' : 'bench-bar-waiting'}
            data-ms={clone?.ms}
            aria-label={clone ? `Workspace ${index + 1}: ${formatMs(clone.ms)}` : `Workspace ${index + 1}: waiting`}
          >
            <span className="bench-bar__ms tabular" data-testid={clone ? 'bench-bar-ms' : undefined}>
              {clone ? formatBarMs(clone.ms, narrow) : ''}
            </span>
            {clone ? (
              <span
                className="bench-bar__fill"
                style={{ height: Math.max(BAR_MIN, (clone.ms / slowest) * BAR_MAX) }}
              />
            ) : (
              <span className="bench-bar__stub" />
            )}
            <span className="bench-bar__index tabular">{index + 1}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Figure({ label, testId, children }: { label: string; testId: string; children: string }) {
  return (
    <div className="sys-fact">
      <dt className="sys-fact__label">{label}</dt>
      <dd className="sys-fact__value selectable tabular" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/** One click: N workspaces of the sample project, timed one by one, then removed again. */
export function Benchmark({ info, onFinished }: { info: SystemInfo; onFinished(): void }) {
  const count = useBench((state) => state.count);
  const running = useBench((state) => state.running);
  const last = useBench((state) => state.last);
  const error = useBench((state) => state.error);
  const { setCount, start } = useBench.getState();

  // The clones used and freed disk space: the facts above are read again when a run ends.
  const finishedId = last?.result.id;
  const seen = useRef(finishedId);
  useEffect(() => {
    if (seen.current === finishedId) return;
    seen.current = finishedId;
    onFinished();
  }, [finishedId, onFinished]);

  const arrived = running ? running.clones.filter(Boolean).length : 0;
  const summary = last ? summarise(last.result) : null;

  return (
    <section className="sys-bench" aria-labelledby="sys-bench-title" data-testid="bench" data-running={running !== null || undefined}>
      <div className="sys-bench__head">
        <div className="sys-bench__intro">
          <h2 className="sys-title" id="sys-bench-title">
            How fast an agent gets its own copy
          </h2>
          <p className="sys-bench__status" data-testid="bench-status" aria-live="polite">
            {running
              ? `Creating workspace ${Math.min(running.count, arrived + 1)} of ${running.count}`
              : last
                ? `Measured ${formatWhen(last.at)}, ${last.result.count} ${last.result.strategy} copies of ${last.result.project}`
                : `Copies a sample project with the ${info.clone.strategy} strategy, times each copy and removes them again.`}
          </p>
        </div>
        <div className="sys-bench__controls">
          <div className="bench-counts" role="radiogroup" aria-label="How many workspaces">
            {BENCH_COUNTS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={option === count}
                className="bench-counts__option tabular"
                data-testid={`bench-count-${option}`}
                disabled={running !== null}
                onClick={() => setCount(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <button type="button" className="sys-primary" data-testid="bench-run" disabled={running !== null} onClick={start}>
            <Glyph name={running ? 'clock' : 'play'} size={14} />
            {running ? `Creating ${arrived} of ${running.count}` : `Create ${count} agent workspaces`}
          </button>
        </div>
      </div>

      {error && (
        <p className="sys-bench__error" role="alert" data-testid="bench-error">
          The test did not run: {error}
        </p>
      )}

      <div className="sys-bench__chart">
        {running ? (
          <Bars clones={running.clones} count={running.count} />
        ) : last ? (
          <Bars clones={last.result.clones} count={last.result.clones.length} />
        ) : (
          <Bars clones={[]} count={count} />
        )}
        <p className="sys-bench__axis">milliseconds per workspace, in the order they were created</p>
      </div>

      {summary && last && !running && (
        <dl className="sys-sheet sys-sheet--figures" data-testid="bench-totals">
          <div className="sys-fact sys-fact--lead" data-wide={2}>
            <dt className="sys-fact__label">Total for {last.result.count} workspaces</dt>
            <dd className="sys-bench__total tabular selectable" data-testid="bench-total">
              {formatMs(summary.totalMs)}
            </dd>
          </div>
          <Figure label="Average each" testId="bench-average">
            {formatMs(summary.averageMs)}
          </Figure>
          <Figure label="Median each" testId="bench-median">
            {formatMs(summary.medianMs)}
          </Figure>
          <Figure label="Files per copy" testId="bench-files">
            {String(summary.files)}
          </Figure>
          <Figure label="Size per copy" testId="bench-bytes">
            {formatBytes(summary.bytes)}
          </Figure>
          <Figure label="Extra disk used, all copies" testId="bench-disk">
            {formatBytes(summary.diskBytes)}
          </Figure>
          <Figure label="Strategy" testId="bench-strategy">
            {last.result.strategy}
          </Figure>
        </dl>
      )}
    </section>
  );
}
