import type { Menu } from '../registry';
import { useChatStore } from './store';

/** Chat's menu bar entries. They act on the store, so they work whichever element has the keyboard. */
export function chatMenus(): Menu[] {
  const chat = useChatStore.getState();
  return [
    {
      label: 'Conversation',
      items: [
        { label: 'New conversation', shortcut: 'Ctrl+N', action: () => chat.newConversation() },
        { label: 'Previous conversation', shortcut: 'Ctrl+Up', action: () => chat.step(-1) },
        { label: 'Next conversation', shortcut: 'Ctrl+Down', action: () => chat.step(1) },
        { label: '', separator: true },
        { label: 'Stop the running reply', shortcut: 'Esc', action: () => void chat.stopLatest() },
        { label: 'Delete this conversation', action: () => chat.remove(useChatStore.getState().activeId) },
      ],
    },
  ];
}
