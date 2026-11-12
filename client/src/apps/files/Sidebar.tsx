import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { agentVars } from '../../design/color';
import { Glyph, type GlyphName } from '../../design/icons';
import { api } from '../../lib/api';
import { isAgentActive, useAgentsStore } from '../../stores/agents';
import { useWorkspaceList, useWorkspacesStore } from '../../stores/workspaces';
import { dropHandlers, type ColumnActions } from './Column';
import { isWithin } from './kinds';
import { loadFolder, useFilesStore, useListing } from './store';

interface SidebarProps {
  /** The folder the columns end at; the place that contains it is marked. */
  current: string;
  dropTarget: string | null;
  onGo(path: string): void;
  actions: Pick<ColumnActions, 'moveInto' | 'setDropTarget'>;
}

const PLACES: Array<{ path: string; label: string; glyph: GlyphName }> = [
  { path: '', label: 'Home', glyph: 'home' },
  { path: 'Projects', label: 'Projects', glyph: 'folder' },
  { path: 'Workspaces', label: 'Workspaces', glyph: 'branch' },
];

/** Places on the left: the three fixed ones, then every project and every agent's copy, live. */
export function Sidebar({ current, dropTarget, onGo, actions }: SidebarProps) {
  const projects = useListing('Projects');
  const workspaces = useWorkspaceList();
  const agents = useAgentsStore((state) => state.agents);
  const activity = useFilesStore((state) => state.activity);

  useEffect(() => {
    void loadFolder('Projects');
    // Workspaces made before this page opened are not in the store yet.
    api.workspaces.list().then(
      (response) => useWorkspacesStore.getState().replaceAll(response),
      () => undefined,
    );
  }, []);

  const projectFolders = (projects?.entries ?? []).filter((entry) => entry.kind === 'dir' && !entry.hidden);
  // The most specific place that holds the current folder is the one that is marked.
  const targets = [...PLACES.map((place) => place.path), ...projectFolders.map((entry) => entry.path), ...workspaces.map((workspace) => workspace.path)];
  const marked = targets.filter((path) => isWithin(current, path)).sort((a, b) => b.length - a.length)[0];

  const item = (path: string, label: string, lead: ReactNode, trail?: ReactNode, style?: CSSProperties) => (
    <li key={path}>
      <button
        type="button"
        className="files-place"
        data-testid="files-place"
        data-path={path}
        data-current={marked === path || undefined}
        data-drop={dropTarget === `place:${path}` || undefined}
        style={style}
        title={path || 'Home'}
        onClick={() => onGo(path)}
        {...dropHandlers(path, {
          moveInto: actions.moveInto,
          setDropTarget: (folder) => actions.setDropTarget(folder === null ? null : `place:${folder}`),
        })}
      >
        {lead}
        <span className="files-place__label">{label}</span>
        {trail}
      </button>
    </li>
  );

  return (
    <nav className="files-sidebar" data-testid="files-sidebar" aria-label="Places">
      <ul className="files-sidebar__list">
        {PLACES.map((place) => item(place.path, place.label, <Glyph name={place.glyph} size={16} className="files-place__glyph" />))}
      </ul>

      <h3 className="files-sidebar__heading">Projects</h3>
      {projectFolders.length === 0 ? (
        <p className="files-sidebar__empty">Folders in Projects show up here.</p>
      ) : (
        <ul className="files-sidebar__list" data-testid="files-projects">
          {projectFolders.map((entry) =>
            item(
              entry.path,
              entry.name,
              <Glyph name="folder" size={16} className="files-place__glyph" />,
              activity[entry.path] && <span className="files-place__dot" />,
            ),
          )}
        </ul>
      )}

      <h3 className="files-sidebar__heading">Agent copies</h3>
      {workspaces.length === 0 ? (
        <p className="files-sidebar__empty">When an agent gets its own copy of a project, it is listed here.</p>
      ) : (
        <ul className="files-sidebar__list" data-testid="files-workspaces">
          {workspaces.map((workspace) => {
            const agent = workspace.agentId ? agents[workspace.agentId] : undefined;
            return item(
              workspace.path,
              workspace.name,
              <span
                className="files-place__agent"
                data-owned={agent ? '' : undefined}
                data-running={(agent && isAgentActive(agent)) || undefined}
              />,
              agent && <span className="files-place__owner">{agent.name}</span>,
              agent ? agentVars(agent.hue) : undefined,
            );
          })}
        </ul>
      )}
    </nav>
  );
}
