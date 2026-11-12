/**
 * Chat's conversations. A conversation is a chain of agent jobs: each message
 * the user sends is a turn that starts one. Only the turns and the ids of
 * their jobs are kept in the browser; what the agents said replays from the
 * server.
 */
import { create } from 'zustand';
import type { AgentInfo } from '@shared/protocol';
import { ApiRequestError } from '../../lib/api';
import { isAgentActive, useAgentsStore } from '../../stores/agents';
import { openAgentWindow, startAgent, stopAgent, type AgentIdentity } from '../agent/actions';
import { shortPrompt } from '../agent/format';

export interface Turn {
  key: string;
  prompt: string;
  at: number;
  /** Turns that share a row were started while one of them was still running, and are drawn side by side. */
  row: number;
  project: string | null;
  attachments: string[];
  /** The job this turn started; null until the server has answered. */
  jobId: string | null;
  /** Who answers, known from the moment the message is sent. */
  identity: AgentIdentity | null;
  /** True when the turn carries on in the workspace of the one before it. */
  continued: boolean;
  /** Why the job could not be started. */
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  /** The project the next agent gets a copy of; null for a scratch workspace. */
  project: string | null;
  turns: Turn[];
  createdAt: number;
}

interface ChatState {
  /** Newest first. There is always at least one. */
  conversations: Conversation[];
  activeId: string;
  /** What is typed and not sent, per conversation. Not saved. */
  drafts: Record<string, string>;

  /** Starts a conversation, or goes to the one that is still empty. */
  newConversation(): void;
  select(id: string): void;
  /** Moves to the next (1) or the previous (-1) conversation in the list. */
  step(direction: 1 | -1): void;
  remove(id: string): void;
  setProject(project: string | null): void;
  setDraft(text: string): void;
  /** Sends a message in the active conversation. The turn exists when this returns. */
  send(prompt: string, attachments: string[], options?: { openWindow?: boolean }): void;
  /** Sends a turn that could not be started once more. */
  retry(key: string): void;
  /** Stops the reply that started last and is still running. Returns whether there was one. */
  stopLatest(): boolean;
}

const STORAGE_KEY = 'specos.chat.v1';
const TITLE_CHARS = 44;

const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const blank = (project: string | null = null): Conversation => ({
  id: newId(),
  title: 'New conversation',
  project,
  turns: [],
  createdAt: Date.now(),
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isProject = (value: unknown): value is string | null => value === null || typeof value === 'string';

function readTurn(value: unknown): Turn | null {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.prompt !== 'string') return null;
  const identity = isRecord(value.identity) ? value.identity : null;
  const jobId = typeof value.jobId === 'string' ? value.jobId : null;
  return {
    key: value.key,
    prompt: value.prompt,
    at: typeof value.at === 'number' ? value.at : 0,
    row: typeof value.row === 'number' ? value.row : 0,
    project: isProject(value.project) ? value.project : null,
    attachments: Array.isArray(value.attachments) ? value.attachments.filter((path) => typeof path === 'string') : [],
    jobId,
    identity:
      identity && typeof identity.name === 'string' && typeof identity.hue === 'number'
        ? { name: identity.name, hue: identity.hue }
        : null,
    continued: value.continued === true,
    // A turn saved without a job was still on its way when the page went away.
    ...(typeof value.error === 'string'
      ? { error: value.error }
      : jobId === null
        ? { error: 'The page was reloaded before this message reached the server.' }
        : {}),
  };
}

function load(): Pick<ChatState, 'conversations' | 'activeId'> {
  let conversations: Conversation[] = [];
  let activeId = '';
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (isRecord(saved) && Array.isArray(saved.conversations)) {
      conversations = saved.conversations.flatMap((value): Conversation[] => {
        if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.turns)) return [];
        return [
          {
            id: value.id,
            title: typeof value.title === 'string' ? value.title : 'Conversation',
            project: isProject(value.project) ? value.project : null,
            turns: value.turns.flatMap((turn) => readTurn(turn) ?? []),
            createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
          },
        ];
      });
      if (typeof saved.activeId === 'string') activeId = saved.activeId;
    }
  } catch {
    // Unreadable or blocked storage: start with an empty chat.
  }
  if (conversations.length === 0) conversations = [blank()];
  if (!conversations.some((conversation) => conversation.id === activeId)) activeId = conversations[0]!.id;
  return { conversations, activeId };
}

function failureText(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'The job could not be started.';
}

export const useChatStore = create<ChatState>((set, get) => {
  const patchTurn = (key: string, patch: Partial<Turn>) =>
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.turns.some((turn) => turn.key === key)
          ? { ...conversation, turns: conversation.turns.map((turn) => (turn.key === key ? { ...turn, ...patch } : turn)) }
          : conversation,
      ),
    }));

  /** Sends the turn's job to the server and records the answer on the turn. */
  const launch = (turn: Turn, continueFrom: string | undefined, openWindow: boolean): AgentIdentity | null => {
    const { identity, job } = startAgent({
      prompt: turn.prompt,
      ...(continueFrom ? { continueFrom } : turn.project ? { project: turn.project } : {}),
      ...(turn.attachments.length > 0 ? { attachments: turn.attachments } : {}),
    });
    job.then(
      (agent) => {
        patchTurn(turn.key, { jobId: agent.id, identity: { name: agent.name, hue: agent.hue } });
        if (openWindow) openAgentWindow(agent.id);
      },
      (error: unknown) => patchTurn(turn.key, { error: failureText(error) }),
    );
    return identity ?? null;
  };

  const agentOf = (turn: Turn): AgentInfo | undefined =>
    turn.jobId ? useAgentsStore.getState().agents[turn.jobId] : undefined;
  /** A turn whose job is at work, or still on its way to the server. */
  const atWork = (turn: Turn): boolean => {
    if (turn.error) return false;
    if (turn.jobId === null) return true;
    const agent = agentOf(turn);
    return agent ? isAgentActive(agent) : false;
  };

  return {
    ...load(),
    drafts: {},

    newConversation() {
      const { conversations, activeId } = get();
      const empty = conversations.find((conversation) => conversation.turns.length === 0);
      if (empty) return set({ activeId: empty.id });
      const current = conversations.find((conversation) => conversation.id === activeId);
      const next = blank(current?.project ?? null);
      set({ conversations: [next, ...conversations], activeId: next.id });
    },

    select: (id) => {
      if (get().conversations.some((conversation) => conversation.id === id)) set({ activeId: id });
    },

    step(direction) {
      const { conversations, activeId } = get();
      const index = conversations.findIndex((conversation) => conversation.id === activeId);
      const next = conversations[(index + direction + conversations.length) % conversations.length];
      if (next) set({ activeId: next.id });
    },

    remove(id) {
      const { conversations, activeId, drafts } = get();
      const index = conversations.findIndex((conversation) => conversation.id === id);
      if (index === -1) return;
      const left = conversations.filter((conversation) => conversation.id !== id);
      const kept = left.length > 0 ? left : [blank()];
      const { [id]: _draft, ...restDrafts } = drafts;
      set({
        conversations: kept,
        activeId: activeId === id ? kept[Math.min(index, kept.length - 1)]!.id : activeId,
        drafts: restDrafts,
      });
    },

    setProject: (project) =>
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === state.activeId ? { ...conversation, project } : conversation,
        ),
      })),

    setDraft: (text) => set((state) => ({ drafts: { ...state.drafts, [state.activeId]: text } })),

    send(prompt, attachments, options = {}) {
      const state = get();
      const conversation = state.conversations.find((entry) => entry.id === state.activeId);
      if (!conversation || prompt.trim() === '') return;
      const last = conversation.turns.at(-1);
      // While an agent of this conversation is at work, a new message gets a second agent beside it.
      const parallel = conversation.turns.some(atWork);
      const earlier = last && !parallel && last.project === conversation.project ? agentOf(last) : undefined;

      const turn: Turn = {
        key: newId(),
        prompt,
        at: Date.now(),
        row: last ? (parallel ? last.row : last.row + 1) : 0,
        project: conversation.project,
        attachments,
        jobId: null,
        identity: null,
        continued: earlier !== undefined,
      };
      turn.identity = launch(turn, earlier?.id, options.openWindow === true);

      set({
        conversations: state.conversations.map((entry) =>
          entry.id === conversation.id
            ? {
                ...entry,
                title: entry.turns.length === 0 ? shortPrompt(prompt, TITLE_CHARS) : entry.title,
                turns: [...entry.turns, turn],
              }
            : entry,
        ),
        drafts: { ...state.drafts, [conversation.id]: '' },
      });
    },

    retry(key) {
      for (const conversation of get().conversations) {
        const index = conversation.turns.findIndex((turn) => turn.key === key);
        const turn = conversation.turns[index];
        if (!turn?.error) continue;
        const before = conversation.turns[index - 1];
        const earlier = turn.continued && before ? agentOf(before) : undefined;
        const fresh: Turn = { ...turn, at: Date.now(), jobId: null, error: undefined };
        patchTurn(key, { ...fresh, identity: launch(fresh, earlier?.id, false) });
        return;
      }
    },

    stopLatest() {
      const { conversations, activeId } = get();
      const conversation = conversations.find((entry) => entry.id === activeId);
      const running = conversation?.turns.filter((turn) => {
        const agent = agentOf(turn);
        return agent !== undefined && isAgentActive(agent);
      });
      const latest = running?.at(-1);
      if (!latest?.jobId) return false;
      stopAgent(latest.jobId);
      return true;
    },
  };
});

// Saved on every change: the list is small and a reload must find the turn that was just sent.
useChatStore.subscribe((state, previous) => {
  if (state.conversations === previous.conversations && state.activeId === previous.activeId) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ conversations: state.conversations, activeId: state.activeId }));
  } catch {
    // Storage is full or blocked: the conversations still work for this page.
  }
});

export function activeConversation(state: ChatState): Conversation {
  return state.conversations.find((conversation) => conversation.id === state.activeId) ?? state.conversations[0]!;
}
