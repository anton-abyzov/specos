import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { agentColor } from '../../design/color';
import { AppIcon, Glyph } from '../../design/icons';
import { hasDragPath, readDragPath } from '../../lib/dnd';
import { isAgentActive, useAgentsStore } from '../../stores/agents';
import { baseName, projectName } from '../agent/format';
import { ProjectPicker, type ProjectPickerHandle } from '../agent/ProjectPicker';
import { StreamScroller } from '../agent/Stream';
import type { AppProps } from '../registry';
import { Reply } from './Reply';
import { activeConversation, useChatStore, type Conversation, type Turn } from './store';
import './chat.css';

const SUGGESTIONS = [
  'Summarise what is in this project and list the open questions.',
  'Tidy the notes: fix the headings and remove what is said twice.',
  'Write a README that explains this folder to someone new.',
];

/** Turns in the order they were sent, gathered into the rows they are drawn in. */
function rowsOf(turns: Turn[]): Turn[][] {
  const rows: Turn[][] = [];
  for (const turn of turns) {
    const last = rows.at(-1);
    if (last && last[0]!.row === turn.row) last.push(turn);
    else rows.push([turn]);
  }
  return rows;
}

function ConversationItem({ conversation, selected }: { conversation: Conversation; selected: boolean }) {
  const select = useChatStore((state) => state.select);
  const remove = useChatStore((state) => state.remove);
  // The hues of the agents of this conversation that are at work, for the marks beside its name.
  const running = useAgentsStore(
    useShallow((state) =>
      conversation.turns.flatMap((turn) => {
        const agent = turn.jobId ? state.agents[turn.jobId] : undefined;
        return agent && isAgentActive(agent) ? [agent.hue] : [];
      }),
    ),
  );
  const count = conversation.turns.length;
  return (
    <li className="chat-list__item" data-selected={selected || undefined}>
      <button
        type="button"
        className="chat-list__open"
        data-testid="chat-conversation"
        aria-current={selected || undefined}
        onClick={() => select(conversation.id)}
      >
        <span className="chat-list__title">{conversation.title}</span>
        <span className="chat-list__meta">
          {conversation.project ? projectName(conversation.project) : 'scratch'}
          {count > 0 && ` · ${count} ${count === 1 ? 'message' : 'messages'}`}
          {running.map((hue, index) => (
            <span key={index} className="chat-list__live" style={{ background: agentColor(hue).solid }} />
          ))}
        </span>
      </button>
      <button
        type="button"
        className="chat-list__remove"
        aria-label={`Delete “${conversation.title}”`}
        title="Delete conversation"
        onClick={() => remove(conversation.id)}
      >
        <Glyph name="close" size={12} />
      </button>
    </li>
  );
}

export default function ChatApp({ focused, setTitle }: AppProps) {
  const conversations = useChatStore((state) => state.conversations);
  const conversation = useChatStore(activeConversation);
  const draft = useChatStore((state) => state.drafts[state.activeId] ?? '');
  const chat = useChatStore.getState();

  const [attachments, setAttachments] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<ProjectPickerHandle>(null);
  const rows = useMemo(() => rowsOf(conversation.turns), [conversation.turns]);

  useEffect(() => {
    setTitle(conversation.turns.length > 0 ? `Chat · ${conversation.title}` : 'Chat');
  }, [setTitle, conversation.title, conversation.turns.length]);

  // The composer has the keyboard whenever this window does.
  useEffect(() => {
    if (focused) composer.current?.focus();
  }, [focused, conversation.id]);

  useEffect(() => setAttachments([]), [conversation.id]);

  // The field is as tall as what is typed, up to a few lines.
  useLayoutEffect(() => {
    const field = composer.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 168)}px`;
  }, [draft]);

  const send = (openWindow: boolean) => {
    if (draft.trim() === '') return;
    chat.send(draft.trim(), attachments, { openWindow });
    setAttachments([]);
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const field = event.currentTarget;
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      send(event.ctrlKey || event.metaKey);
    } else if (event.key === 'ArrowUp' && draft === '' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const last = conversation.turns.at(-1) ?? conversations.find((entry) => entry.turns.length > 0)?.turns.at(-1);
      if (last) {
        event.preventDefault();
        chat.setDraft(last.prompt);
      }
    } else if (event.key === '@' && !event.ctrlKey && !event.metaKey) {
      // "@" at the start of a word picks a project; inside a word it is just a character.
      const before = field.value[field.selectionStart - 1];
      if (before === undefined || /\s/.test(before)) {
        event.preventDefault();
        picker.current?.open();
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const command = (event.ctrlKey || event.metaKey) && !event.altKey;
    if (command && !event.shiftKey && event.code === 'KeyN') {
      event.preventDefault();
      chat.newConversation();
    } else if (command && !event.shiftKey && event.code === 'KeyP') {
      event.preventDefault();
      picker.current?.open();
    } else if (command && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      chat.step(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Escape' && chat.stopLatest()) {
      event.preventDefault();
    }
  };

  // A click that neither selects text nor lands on a control gives the keyboard back to the composer.
  const onMouseUp = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest('button, input, textarea, a, [role="option"]')) return;
    if (window.getSelection()?.isCollapsed !== false) composer.current?.focus();
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!hasDragPath(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  };
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    const path = readDragPath(event.dataTransfer);
    setDropping(false);
    if (!path) return;
    event.preventDefault();
    setAttachments((held) => (held.includes(path) ? held : [...held, path]));
    composer.current?.focus();
  };

  return (
    <section
      className="chat"
      data-testid="app-chat"
      onKeyDown={onKeyDown}
      onMouseUp={onMouseUp}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="chat__layout">
      <nav className="chat-list" aria-label="Conversations">
        <button type="button" className="chat-list__new" data-testid="chat-new" onClick={() => chat.newConversation()}>
          <Glyph name="plus" size={14} />
          New conversation
          <kbd>Ctrl N</kbd>
        </button>
        <ul className="chat-list__items" data-testid="chat-conversations">
          {conversations.map((entry) => (
            <ConversationItem key={entry.id} conversation={entry} selected={entry.id === conversation.id} />
          ))}
        </ul>
      </nav>

      <div className="chat__main">
        {rows.length === 0 ? (
          <div className="chat-empty" data-testid="chat-empty">
            <AppIcon id="chat" size={44} />
            <h1 className="chat-empty__title">Say what you want done.</h1>
            <p className="chat-empty__text">
              Each message starts an agent in its own copy of the project. The reply streams here while it works, and
              nothing touches the project until you merge it.
            </p>
            <ul className="chat-empty__ideas">
              {SUGGESTIONS.map((idea) => (
                <li key={idea}>
                  <button
                    type="button"
                    className="chat-empty__idea"
                    data-testid="chat-idea"
                    onClick={() => {
                      chat.setDraft(idea);
                      composer.current?.focus();
                    }}
                  >
                    {idea}
                  </button>
                </li>
              ))}
            </ul>
            <dl className="chat-empty__keys">
              <div>
                <dt>
                  <kbd>Enter</kbd>
                </dt>
                <dd>send</dd>
              </div>
              <div>
                <dt>
                  <kbd>Ctrl Enter</kbd>
                </dt>
                <dd>send and open the agent’s window</dd>
              </div>
              <div>
                <dt>
                  <kbd>@</kbd>
                </dt>
                <dd>choose a project</dd>
              </div>
              <div>
                <dt>
                  <kbd>Esc</kbd>
                </dt>
                <dd>stop the running reply</dd>
              </div>
            </dl>
          </div>
        ) : (
          <StreamScroller className="chat__scroll" resetKey={`${conversation.id}:${conversation.turns.length}`}>
            <div className="chat__turns" data-testid="chat-turns">
              {rows.map((row) => (
                <div
                  key={row[0]!.key}
                  className="chat-row"
                  data-testid="chat-row"
                  data-agents={row.length}
                  style={{ '--agents': row.length } as CSSProperties}
                >
                  {row.map((turn) => (
                    <div key={turn.key} className="chat-turn">
                      <div className="stream-prompt selectable" data-testid="chat-user-message">
                        {turn.prompt}
                        {turn.attachments.length > 0 && (
                          <span className="stream-prompt__attached">
                            {turn.attachments.map((path) => (
                              <span key={path} title={path}>
                                <Glyph name="file" size={11} />
                                {baseName(path)}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                      <Reply turn={turn} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </StreamScroller>
        )}

        <div className="chat-composer" data-dropping={dropping || undefined}>
          {attachments.length > 0 && (
            <ul className="chat-composer__attachments" data-testid="chat-attachments">
              {attachments.map((path) => (
                <li key={path} className="chat-composer__attachment" title={path}>
                  <Glyph name="file" size={12} />
                  <span>{baseName(path)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${baseName(path)}`}
                    onClick={() => setAttachments((held) => held.filter((entry) => entry !== path))}
                  >
                    <Glyph name="close" size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={composer}
            className="chat-composer__field"
            data-testid="chat-input"
            rows={1}
            placeholder="Message an agent"
            aria-label="Message"
            value={draft}
            spellCheck={false}
            onChange={(event) => chat.setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          <div className="chat-composer__bar">
            <ProjectPicker
              ref={picker}
              value={conversation.project}
              placement="up"
              onChange={chat.setProject}
              onClose={() => composer.current?.focus()}
            />
            <span className="chat-composer__hint">
              <kbd>Enter</kbd> send <kbd>Shift Enter</kbd> new line
            </span>
            <button
              type="button"
              className="chat-composer__send"
              data-testid="chat-send"
              aria-label="Send"
              title="Send"
              disabled={draft.trim() === ''}
              onClick={() => send(false)}
            >
              <Glyph name="send" size={15} />
            </button>
          </div>
          {dropping && (
            <div className="chat-composer__drop" data-testid="chat-drop">
              <Glyph name="plus" size={14} />
              Drop to attach to the next message
            </div>
          )}
        </div>
      </div>
      </div>
    </section>
  );
}
