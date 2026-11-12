import { useEffect } from 'react';
import { api } from '../../lib/api';
import { useAgentsStore } from '../../stores/agents';
import { useConnectionStore } from '../../stores/connection';

/** Streams already fetched, as "<agent>@<when the socket opened>": once per job and connection. */
const replayed = new Set<string>();

/**
 * Fills in the part of a job's stream this page did not hear live: everything
 * before the page loaded, and whatever passed while the socket was down.
 */
export function useAgentReplay(agentId: string | undefined): void {
  const known = useAgentsStore((state) => (agentId ? agentId in state.agents : false));
  const since = useConnectionStore((state) => state.since);
  useEffect(() => {
    if (!agentId || !known || since === null) return;
    const key = `${agentId}@${since}`;
    if (replayed.has(key)) return;
    replayed.add(key);
    api.agents.events(agentId).then(
      ({ events }) => useAgentsStore.getState().appendEvents(agentId, events),
      () => replayed.delete(key),
    );
  }, [agentId, known, since]);
}
