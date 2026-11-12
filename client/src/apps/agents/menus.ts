import { api } from '../../lib/api';
import { isAgentActive, useAgentsStore } from '../../stores/agents';
import type { Menu } from '../registry';
import { stopAgent } from '../agent/actions';

/** The menu bar entries of the Agents app: things done to many jobs at once. */
export function agentsMenus(): Menu[] {
  const agents = Object.values(useAgentsStore.getState().agents);
  const running = agents.filter(isAgentActive);
  const finished = agents.filter((agent) => !isAgentActive(agent));
  return [
    {
      label: 'Agents',
      items: [
        {
          label: 'Stop all running',
          disabled: running.length === 0,
          action: () => running.forEach((agent) => stopAgent(agent.id)),
        },
        {
          label: 'Remove all finished',
          disabled: finished.length === 0,
          action: () => finished.forEach((agent) => void api.agents.remove(agent.id).catch(() => undefined)),
        },
      ],
    },
  ];
}
