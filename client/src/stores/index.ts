/** Every store in one place, for imports and for window.__specos.stores. */
import { useActivityStore } from './activity';
import { useAgentsStore } from './agents';
import { useConnectionStore } from './connection';
import { useShellStore } from './shell';
import { useSystemStore } from './system';
import { useWorkspacesStore } from './workspaces';

export const stores = {
  activity: useActivityStore,
  agents: useAgentsStore,
  connection: useConnectionStore,
  shell: useShellStore,
  system: useSystemStore,
  workspaces: useWorkspacesStore,
};

export type Stores = typeof stores;
