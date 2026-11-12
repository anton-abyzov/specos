/**
 * The commands a Files window answers to, wherever they come from: the menu
 * bar, the context menu, the toolbar or the keyboard. The menu bar only knows
 * a window id, so each window registers its handler here.
 */
import type { Menu } from '../registry';

export type FilesCommand =
  | 'new-file'
  | 'new-folder'
  | 'open'
  | 'open-in-editor'
  | 'peek'
  | 'rename'
  | 'delete'
  | 'copy-path'
  | 'go-up'
  | 'go-home'
  | 'go-projects'
  | 'go-workspaces'
  | 'toggle-hidden';

const handlers = new Map<string, (command: FilesCommand) => void>();

/** Called by a Files window while it is mounted; returns the function that unregisters it. */
export function registerFilesWindow(windowId: string, handler: (command: FilesCommand) => void): () => void {
  handlers.set(windowId, handler);
  return () => {
    if (handlers.get(windowId) === handler) handlers.delete(windowId);
  };
}

const run = (windowId: string, command: FilesCommand) => () => handlers.get(windowId)?.(command);

/** The menus the menu bar shows while a Files window is in front. */
export function filesMenus(windowId: string): Menu[] {
  const rule = { label: '', separator: true };
  return [
    {
      label: 'File',
      items: [
        { label: 'New file', shortcut: 'Ctrl N', action: run(windowId, 'new-file') },
        { label: 'New folder', shortcut: 'Ctrl Shift N', action: run(windowId, 'new-folder') },
        rule,
        { label: 'Open', shortcut: 'Enter', action: run(windowId, 'open') },
        { label: 'Open in Editor', action: run(windowId, 'open-in-editor') },
        { label: 'Peek', shortcut: 'Space', action: run(windowId, 'peek') },
        rule,
        { label: 'Rename', shortcut: 'F2', action: run(windowId, 'rename') },
        { label: 'Delete', shortcut: 'Del', action: run(windowId, 'delete') },
        rule,
        { label: 'Copy path', action: run(windowId, 'copy-path') },
      ],
    },
    {
      label: 'Go',
      items: [
        { label: 'Up one folder', shortcut: 'Backspace', action: run(windowId, 'go-up') },
        rule,
        { label: 'Home', action: run(windowId, 'go-home') },
        { label: 'Projects', action: run(windowId, 'go-projects') },
        { label: 'Workspaces', action: run(windowId, 'go-workspaces') },
      ],
    },
    {
      label: 'View',
      items: [{ label: 'Show or hide hidden files', action: run(windowId, 'toggle-hidden') }],
    },
  ];
}
