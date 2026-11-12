/**
 * The Editor's menus, and the table that lets them reach the buffer in a
 * given window. Kept free of CodeMirror so the menu bar does not load it.
 */
import type { Menu } from '../registry';
import { useShellStore } from '../../stores/shell';

/** What an editor window with a file open lets the menu bar do to it. */
export interface EditorCommands {
  save(): void;
  reload(): void;
  undo(): void;
  redo(): void;
  find(): void;
  selectAll(): void;
  togglePreview(): void;
  focus(): void;
}

/** The open buffers by window id. A window registers itself while it has a file open. */
export const editorWindows = new Map<string, EditorCommands>();

export function editorMenus(windowId: string): Menu[] {
  const run = (command: Exclude<keyof EditorCommands, 'focus'>) => () => editorWindows.get(windowId)?.[command]();
  const shell = () => useShellStore.getState();
  return [
    {
      label: 'File',
      items: [
        { label: 'Open…', shortcut: 'Ctrl K', action: () => shell().toggleLauncher() },
        { label: 'New editor window', action: () => shell().launchApp('editor') },
        { label: '', separator: true },
        { label: 'Save', shortcut: 'Ctrl S', action: run('save') },
        { label: 'Reload from disk', action: run('reload') },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl Z', action: run('undo') },
        { label: 'Redo', shortcut: 'Ctrl Shift Z', action: run('redo') },
        { label: '', separator: true },
        { label: 'Find and replace', shortcut: 'Ctrl F', action: run('find') },
        { label: 'Select all', shortcut: 'Ctrl A', action: run('selectAll') },
      ],
    },
    {
      label: 'View',
      items: [{ label: 'Show or hide the Markdown preview', shortcut: 'Ctrl Shift V', action: run('togglePreview') }],
    },
  ];
}
