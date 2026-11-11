/** How one launcher result is drawn: as a large tile, a chip or a line. */
import type { CSSProperties, ReactNode } from 'react';
import { agentVars } from '../../design/color';
import { AgentIcon, AppIcon, Glyph } from '../../design/icons';
import { isAgentActive } from '../../stores/agents';
import { glyphFor } from './files';
import type { LauncherItem, Marks, Section } from './search';

/** The text with its matched characters marked. */
function Marked({ text, marks }: { text: string; marks: Marks }) {
  if (marks.length === 0) return <>{text}</>;
  const marked = new Set(marks);
  const runs: ReactNode[] = [];
  // Neighbouring characters of the same kind become one run, so a match is one <mark>, not one per letter.
  for (let start = 0; start < text.length; ) {
    const on = marked.has(start);
    let end = start + 1;
    while (end < text.length && marked.has(end) === on) end += 1;
    const run = text.slice(start, end);
    runs.push(on ? <mark key={start}>{run}</mark> : run);
    start = end;
  }
  return <>{runs}</>;
}

function ItemIcon({ item, size }: { item: LauncherItem; size: number }) {
  if (item.kind === 'app') return <AppIcon id={item.app.id} size={size} />;
  if (item.kind === 'agent') {
    return <AgentIcon hue={item.agent.hue} seed={item.agent.id} running={isAgentActive(item.agent)} size={size} />;
  }
  return (
    <span className="launcher-item__glyph" data-kind={item.kind}>
      <Glyph name={item.kind === 'file' ? glyphFor(item.file) : item.action.glyph} size={16} />
    </span>
  );
}

/** What sits at the right end of a line: an agent's state, or the shortcut that does the same thing. */
function Aside({ item }: { item: LauncherItem }) {
  if (item.kind === 'agent') return <span className="launcher-item__status">{item.agent.status}</span>;
  if (item.kind === 'action' && item.action.shortcut) return <kbd className="launcher-key">{item.action.shortcut}</kbd>;
  return null;
}

interface ItemProps {
  item: LauncherItem;
  layout: Section['layout'];
  /** The DOM id the field points at through aria-activedescendant. */
  id: string;
  selected: boolean;
  onPick(item: LauncherItem, forceEditor: boolean): void;
}

export function Item({ item, layout, id, selected, onPick }: ItemProps) {
  const style: CSSProperties | undefined = item.kind === 'agent' ? agentVars(item.agent.hue) : undefined;
  const iconSize = layout === 'grid' ? 84 : layout === 'chips' ? 36 : 28;
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      className={`launcher-item launcher-item--${layout}`}
      data-testid="launcher-item"
      data-key={item.key}
      data-kind={item.kind}
      data-selected={selected || undefined}
      data-solid
      style={style}
      onClick={(event) => onPick(item, event.ctrlKey || event.metaKey)}
    >
      {/* The selection: a sheet with the clipped corner. Its edge is a filter on the plate, since a clipped box cannot carry one. */}
      <span className="launcher-item__plate">
        <span className="launcher-item__sheet" />
      </span>
      <span className="launcher-item__icon">
        <ItemIcon item={item} size={iconSize} />
      </span>
      <span className="launcher-item__text">
        <span className="launcher-item__title">
          <Marked text={item.title} marks={item.titleMarks} />
        </span>
        {layout !== 'grid' && item.detail !== '' && (
          <span className="launcher-item__detail" data-kind={item.kind}>
            <Marked text={item.detail} marks={item.detailMarks} />
          </span>
        )}
      </span>
      {layout === 'list' && (
        <span className="launcher-item__aside">
          <Aside item={item} />
        </span>
      )}
    </li>
  );
}
