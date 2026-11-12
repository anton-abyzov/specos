import { memo, useMemo, useState, type CSSProperties } from 'react';
import { foldHunk, type DiffLine, type ParsedPatch } from './patch';

interface DiffProps {
  parsed: ParsedPatch;
  /** Added to this patch's change numbers, when several patches share one view. */
  changeOffset?: number;
  /** The change J and K stopped on, in the view's numbering. */
  activeChange?: number | null;
}

const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '−', context: '' };
const SPOKEN: Record<DiffLine['kind'], string> = { add: 'added', del: 'removed', context: '' };

const Line = memo(function Line({ line, change, active }: { line: DiffLine; change?: number; active: boolean }) {
  return (
    <div
      className="diff__line"
      data-kind={line.kind}
      data-change={change}
      data-active={active || undefined}
      data-testid={line.kind === 'context' ? undefined : `diff-${line.kind}`}
    >
      <span className="diff__no" aria-hidden="true">
        {line.oldNo ?? ''}
      </span>
      <span className="diff__no" aria-hidden="true">
        {line.newNo ?? ''}
      </span>
      <span className="diff__sign" aria-label={SPOKEN[line.kind] || undefined}>
        {SIGN[line.kind]}
      </span>
      <span className="diff__text selectable">
        {line.segments
          ? line.segments.map((segment, index) =>
              segment.changed ? (
                <mark key={index} className="diff__word">
                  {segment.text}
                </mark>
              ) : (
                segment.text
              ),
            )
          : line.text}
        {line.noNewline && <span className="diff__eof"> no newline at the end</span>}
      </span>
    </div>
  );
});

/**
 * One file's unified diff. Hunk headers are hairline rules, added and removed
 * lines carry a sign as well as a tint, and long unchanged runs stay folded
 * until asked for.
 */
export const Diff = memo(function Diff({ parsed, changeOffset = 0, activeChange = null }: DiffProps) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const hunks = useMemo(() => parsed.hunks.map((hunk, index) => ({ hunk, items: foldHunk(hunk, index) })), [parsed]);
  const digits = String(parsed.maxLine).length;

  const renderLine = (line: DiffLine, key: string) => {
    const change = line.change === undefined ? undefined : line.change + changeOffset;
    return <Line key={key} line={line} change={change} active={change !== undefined && change === activeChange} />;
  };

  return (
    <div className="diff" role="group" aria-label="Diff" style={{ '--diff-digits': digits } as CSSProperties}>
      {hunks.map(({ hunk, items }, hunkIndex) => (
        <div className="diff__hunk" key={hunkIndex}>
          <div className="diff__rule">
            <span className="diff__range">{hunk.header}</span>
            {hunk.section && <span className="diff__section">{hunk.section}</span>}
          </div>
          {items.map((item, itemIndex) => {
            if (item.type === 'line') return renderLine(item.line, `${hunkIndex}:${itemIndex}`);
            if (unfolded.has(item.id)) {
              return item.lines.map((line, lineIndex) => renderLine(line, `${item.id}:${lineIndex}`));
            }
            return (
              <button
                key={item.id}
                type="button"
                className="diff__fold"
                onClick={() => setUnfolded((held) => new Set(held).add(item.id))}
              >
                Show {item.lines.length} unchanged lines
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
});
