import { create } from 'zustand';
import type { ProjectsResponse } from '@shared/protocol';
import { api } from '../../lib/api';

export type Project = ProjectsResponse['projects'][number];

interface ProjectsState {
  /** Folders directly under Projects/, by name. */
  projects: Project[];
  /** Asks the server again; the list on screen stays until the answer is in. */
  refresh(): void;
}

export const useProjects = create<ProjectsState>((set) => ({
  projects: [],
  refresh() {
    api.projects().then(
      ({ projects }) => set({ projects: [...projects].sort((a, b) => a.name.localeCompare(b.name)) }),
      () => undefined,
    );
  },
}));
