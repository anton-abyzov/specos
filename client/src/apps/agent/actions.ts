/**
 * What the agent surfaces (Chat, Agents, the agent window) do with a job:
 * start it, show it, and open what it works on in the other apps.
 */
import type { AgentInfo, StartAgentRequest, Workspace } from '@shared/protocol';
import { api } from '../../lib/api';
import { useAgentsStore } from '../../stores/agents';
import { useShellStore } from '../../stores/shell';

export type AgentIdentity = Pick<AgentInfo, 'name' | 'hue'>;

const shell = () => useShellStore.getState();

export const openAgentWindow = (agentId: string): string => shell().launchApp('agent', { agentId });
export const openWorkspace = (workspace: Workspace): string => shell().launchApp('files', { path: workspace.path });
export const openFile = (path: string): string => shell().launchApp('editor', { path });
export const viewChanges = (workspace: Workspace): string => shell().launchApp('activity', { workspaceId: workspace.id });

/** Starts that have been sent and not yet answered. The forecast is only refreshed when none is. */
let starting = 0;

export interface Launch {
  /** Who the job will be, known before the server answers: the forecast, or the agent it continues. */
  identity: AgentIdentity | undefined;
  job: Promise<AgentInfo>;
}

/**
 * Starts a job. The identity is returned at once so the caller can draw the
 * agent in the same frame as the keypress; the job itself follows.
 */
export function startAgent(request: StartAgentRequest): Launch {
  const store = useAgentsStore.getState();
  const earlier = request.continueFrom ? store.agents[request.continueFrom] : undefined;
  const identity: AgentIdentity | undefined = earlier ? { name: earlier.name, hue: earlier.hue } : store.takeUpcoming();

  starting += 1;
  const job = api.agents.start(request).then(
    (agent) => {
      starting -= 1;
      const agents = useAgentsStore.getState();
      // The socket usually told the store first, and may already know more than this answer does.
      if (!agents.agents[agent.id]) agents.upsert(agent);
      if (starting === 0) refreshUpcoming();
      return agent;
    },
    (error: unknown) => {
      starting -= 1;
      if (starting === 0) refreshUpcoming();
      throw error;
    },
  );
  return { identity, job };
}

function refreshUpcoming(): void {
  api.agents.list().then(
    (response) => {
      if (starting === 0) useAgentsStore.getState().setUpcoming(response.upcoming ?? []);
    },
    () => undefined,
  );
}

/** A request whose outcome arrives on the events socket; a failure leaves the job as it was. */
export function stopAgent(agentId: string): void {
  api.agents.stop(agentId).catch(() => undefined);
}
