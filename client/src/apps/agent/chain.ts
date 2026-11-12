import type { AgentInfo } from '@shared/protocol';

type Agents = Record<string, AgentInfo>;

/**
 * A job and its follow-ups are one agent at work in one workspace. The chain
 * is every job of that agent the server still lists, first to last.
 */
export function chainOf(agents: Agents, agentId: string): AgentInfo[] {
  const start = agents[agentId];
  if (!start) return [];
  const chain = [start];
  const seen = new Set([start.id]);
  // Back to the job that made the workspace.
  for (let earlier = start.continues ? agents[start.continues] : undefined; earlier && !seen.has(earlier.id); ) {
    chain.unshift(earlier);
    seen.add(earlier.id);
    earlier = earlier.continues ? agents[earlier.continues] : undefined;
  }
  // Forward through the follow-ups; when a job was continued twice the newer one is followed.
  const all = Object.values(agents);
  for (;;) {
    const last = chain.at(-1)!;
    const next = all
      .filter((agent) => agent.continues === last.id && !seen.has(agent.id))
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!next) return chain;
    chain.push(next);
    seen.add(next.id);
  }
}

export function latestInChain(agents: Agents, agentId: string): AgentInfo | undefined {
  return chainOf(agents, agentId).at(-1);
}
