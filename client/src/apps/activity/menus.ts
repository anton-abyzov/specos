import type { Menu } from '../registry';
import { sendActivityCommand } from './commands';

/** The menu bar's menus while an Activity window is in front. */
export function activityMenus(windowId: string): Menu[] {
  const send = sendActivityCommand.bind(null, windowId);
  return [
    {
      label: 'View',
      items: [
        { label: 'All changes', action: () => send('show-all') },
        { label: 'My changes', action: () => send('show-mine') },
        { label: 'Filter by path', shortcut: '/', action: () => send('find') },
        { label: '', separator: true },
        { label: 'Next change', shortcut: 'J', action: () => send('next-change') },
        { label: 'Previous change', shortcut: 'K', action: () => send('previous-change') },
        { label: '', separator: true },
        { label: 'Reload the journal', action: () => send('reload') },
      ],
    },
    {
      label: 'Workspace',
      items: [{ label: "Merge this agent's work back", shortcut: 'M', action: () => send('merge') }],
    },
  ];
}
