import { isAgentActive, useAgentsStore } from '../../stores/agents';
import { useShellStore } from '../../stores/shell';
import type { Menu } from '../registry';
import { openWorkspace, stopAgent, viewChanges } from './actions';
import { latestInChain } from './chain';

/** The menu bar entries of an agent's own window. */
export function agentMenus(windowId: string): Menu[] {
  const agentId = useShellStore.getState().agentWindows.find((entry) => entry.windowId === windowId)?.agentId;
  const agents = useAgentsStore.getState().agents;
  const agent = agentId ? latestInChain(agents, agentId) : undefined;
  return [
    {
      label: 'Agent',
      items: [
        { label: 'Stop', disabled: !agent || !isAgentActive(agent), action: () => agent && stopAgent(agent.id) },
        { label: '', separator: true },
        { label: 'Open workspace in Files', disabled: !agent, action: () => agent && openWorkspace(agent.workspace) },
        { label: 'View changes', disabled: !agent, action: () => agent && viewChanges(agent.workspace) },
        { label: 'Show all agents', action: () => void useShellStore.getState().launchApp('agents') },
      ],
    },
  ];
}
