import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { AgentInfo, AgentsResponse, AgentStreamEvent } from '@shared/protocol';

/** Stream events kept per agent; older ones are dropped from memory, never from the server. */
export const AGENT_EVENTS_CAP = 4000;

const NO_EVENTS: AgentStreamEvent[] = [];

interface AgentsState {
  /** Every job the server knows, by id. */
  agents: Record<string, AgentInfo>;
  /** Each job's stream, ordered by seq. Filled live, and by loadEvents for older history. */
  events: Record<string, AgentStreamEvent[]>;
  /** Which runner the server will use for new jobs; null until the first load. */
  runner: AgentsResponse['runner'] | null;
  /** True once GET /api/agents has answered. */
  loaded: boolean;
  /** The name and colour the server will give the next new jobs, in order. */
  upcoming: Array<Pick<AgentInfo, 'name' | 'hue'>>;

  /** Replaces the list with the server's (first load and after a reconnect). */
  replaceAll(response: AgentsResponse): void;
  /** Adds or updates one job ('agent' frames). */
  upsert(agent: AgentInfo): void;
  /** Forgets a job and its stream ('agent-removed' frames). */
  remove(id: string): void;
  /** Appends stream events, ignoring any seq already held. */
  appendEvents(id: string, events: AgentStreamEvent[]): void;
  /** Stores the server's forecast of the next identities. */
  setUpcoming(upcoming: Array<Pick<AgentInfo, 'name' | 'hue'>>): void;
  /** Takes the next forecast identity for a job that is being started; undefined when none is left. */
  takeUpcoming(): Pick<AgentInfo, 'name' | 'hue'> | undefined;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: {},
  events: {},
  runner: null,
  loaded: false,
  upcoming: [],

  replaceAll: (response) =>
    set((state) => {
      const agents = Object.fromEntries(response.agents.map((agent) => [agent.id, agent]));
      const events = Object.fromEntries(Object.entries(state.events).filter(([id]) => id in agents));
      return { agents, events, runner: response.runner, loaded: true, upcoming: response.upcoming ?? [] };
    }),

  upsert: (agent) => set((state) => ({ agents: { ...state.agents, [agent.id]: agent } })),

  remove: (id) =>
    set((state) => {
      const { [id]: _agent, ...agents } = state.agents;
      const { [id]: _events, ...events } = state.events;
      return { agents, events };
    }),

  appendEvents: (id, incoming) =>
    set((state) => {
      const held = state.events[id] ?? NO_EVENTS;
      const lastSeq = held.at(-1)?.seq ?? -Infinity;
      // The live stream arrives in order, so the common case is a plain append.
      const inOrder = incoming.every((event, index) => event.seq > (index === 0 ? lastSeq : incoming[index - 1]!.seq));
      let next: AgentStreamEvent[];
      if (inOrder) {
        next = [...held, ...incoming];
      } else {
        const bySeq = new Map(held.map((event) => [event.seq, event]));
        for (const event of incoming) bySeq.set(event.seq, event);
        next = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      }
      return { events: { ...state.events, [id]: next.slice(-AGENT_EVENTS_CAP) } };
    }),

  setUpcoming: (upcoming) => set({ upcoming }),

  takeUpcoming: () => {
    const [next, ...rest] = get().upcoming;
    if (next) set({ upcoming: rest });
    return next;
  },
}));

/** An agent that is still working: these count in the menu bar and pulse in the dock. */
export function isAgentActive(agent: Pick<AgentInfo, 'status'>): boolean {
  return agent.status === 'starting' || agent.status === 'running';
}

/** All jobs, oldest first, so new ones appear at the end of lists and the dock. */
export function useAgentList(): AgentInfo[] {
  return useAgentsStore(useShallow((state) => Object.values(state.agents).sort((a, b) => a.startedAt - b.startedAt)));
}

export function useAgent(id: string | undefined): AgentInfo | undefined {
  return useAgentsStore((state) => (id ? state.agents[id] : undefined));
}

/** The stream of one job. The array is stable until a new event arrives. */
export function useAgentEvents(id: string | undefined): AgentStreamEvent[] {
  return useAgentsStore((state) => (id ? state.events[id] : undefined) ?? NO_EVENTS);
}

export function useRunningAgentCount(): number {
  return useAgentsStore((state) => Object.values(state.agents).filter(isAgentActive).length);
}
