import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { CloneStrategyInfo, Workspace, WorkspacesResponse } from '@shared/protocol';

interface WorkspacesState {
  /** Workspaces by id. Live frames keep it current; replaceAll fills in the ones made earlier. */
  workspaces: Record<string, Workspace>;
  /** How this machine clones a project; null until api.workspaces.list() has been stored. */
  strategy: CloneStrategyInfo | null;
  /** Stores the answer of api.workspaces.list(). */
  replaceAll(response: WorkspacesResponse): void;
  /** Adds or updates one workspace ('workspace' frames). */
  upsert(workspace: Workspace): void;
  /** Forgets a workspace ('workspace-removed' frames). */
  remove(id: string): void;
}

export const useWorkspacesStore = create<WorkspacesState>((set) => ({
  workspaces: {},
  strategy: null,
  replaceAll: (response) =>
    set({
      workspaces: Object.fromEntries(response.workspaces.map((workspace) => [workspace.id, workspace])),
      strategy: response.strategy,
    }),
  upsert: (workspace) => set((state) => ({ workspaces: { ...state.workspaces, [workspace.id]: workspace } })),
  remove: (id) =>
    set((state) => {
      const { [id]: _removed, ...workspaces } = state.workspaces;
      return { workspaces };
    }),
}));

/** All workspaces, newest first. */
export function useWorkspaceList(): Workspace[] {
  return useWorkspacesStore(
    useShallow((state) => Object.values(state.workspaces).sort((a, b) => b.createdAt - a.createdAt)),
  );
}
