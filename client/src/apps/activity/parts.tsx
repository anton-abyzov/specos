import type { ReactNode } from 'react';
import type { Actor } from '@shared/protocol';
import { agentVars } from '../../design/color';
import { AgentIcon, Glyph, type GlyphName } from '../../design/icons';
import { splitPath } from './model';

/** Who made a change: the user's own mark, the agent's sigil, or a merge mark in the agent's colour. */
export function Avatar({ actor, size = 22 }: { actor: Actor; size?: number }) {
  if (actor.type === 'agent') return <AgentIcon hue={actor.hue} seed={actor.agentId} size={size} />;
  if (actor.type === 'merge') {
    return (
      <span className="act-avatar act-avatar--merge" style={{ ...agentVars(actor.hue), width: size, height: size }}>
        <Glyph name="merge" size={Math.round(size * 0.62)} />
      </span>
    );
  }
  return (
    <span className="act-avatar act-avatar--me" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">
      me
    </span>
  );
}

export const actorName = (actor: Actor): string => (actor.type === 'me' ? 'Me' : actor.name);

/** "+4 −1" in mono; the minus is a real minus sign, as wide as the plus. */
export function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="act-counts tabular" data-testid="counts" aria-label={`${additions} added, ${deletions} removed`}>
      <span className="act-counts__add" data-zero={additions === 0 || undefined}>
        +{additions}
      </span>
      <span className="act-counts__del" data-zero={deletions === 0 || undefined}>
        −{deletions}
      </span>
    </span>
  );
}

/** A file name with its folder muted in front of it; the folder gives way first when space runs out. */
export function PathLabel({ path }: { path: string }) {
  const { name, folder } = splitPath(path);
  return (
    <span className="act-path" title={path}>
      {folder && (
        <span className="act-path__folder">
          {/* The folder is cut from its left end; bdi keeps its slashes where they belong. */}
          <bdi>{folder}</bdi>
        </span>
      )}
      <span className="act-path__name">{name}</span>
    </span>
  );
}

interface ActionProps {
  glyph?: GlyphName;
  children: ReactNode;
  onClick(): void;
  disabled?: boolean;
  title?: string;
  testId?: string;
}

/** The quiet button used for everything that is not the one primary action. */
export function Action({ glyph, children, onClick, disabled, title, testId }: ActionProps) {
  return (
    <button type="button" className="act-action" onClick={onClick} disabled={disabled} title={title} data-testid={testId}>
      {glyph && <Glyph name={glyph} size={14} />}
      {children}
    </button>
  );
}

/** A centred note for a pane with nothing to draw. */
export function Blank({ glyph, title, children }: { glyph: GlyphName; title: string; children?: ReactNode }) {
  return (
    <div className="act-blank">
      <Glyph name={glyph} size={22} className="act-blank__glyph" />
      <p className="act-blank__title">{title}</p>
      {children && <div className="act-blank__text">{children}</div>}
    </div>
  );
}
