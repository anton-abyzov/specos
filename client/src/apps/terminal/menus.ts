/**
 * The Terminal's menus, and the table that lets them reach the terminal in a
 * given window. Kept free of xterm so the menu bar does not load it.
 */
import type { Menu } from '../registry';
import { useShellStore } from '../../stores/shell';

/** What a terminal window lets the menu bar do to it. */
export interface TerminalCommands {
  copy(): void;
  paste(): void;
  selectAll(): void;
  clear(): void;
  restart(): void;
  focus(): void;
}

/** The open terminals by window id. A window registers itself while it is mounted. */
export const terminalWindows = new Map<string, TerminalCommands>();

/** True where the browser lets a page read the clipboard (a secure origin). */
const canReadClipboard = (): boolean => typeof navigator.clipboard?.readText === 'function';

export function terminalMenus(windowId: string): Menu[] {
  /** Runs a command on this window's terminal, then gives it the keyboard back. */
  const run = (command: Exclude<keyof TerminalCommands, 'focus'>) => () => {
    const terminal = terminalWindows.get(windowId);
    terminal?.[command]();
    terminal?.focus();
  };
  return [
    {
      label: 'Shell',
      items: [
        { label: 'New terminal', action: () => useShellStore.getState().launchApp('terminal') },
        { label: 'Restart shell', action: run('restart') },
        { label: '', separator: true },
        { label: 'Clear scrollback', action: run('clear') },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Copy', shortcut: 'Ctrl Shift C', action: run('copy') },
        { label: 'Paste', shortcut: 'Ctrl Shift V', disabled: !canReadClipboard(), action: run('paste') },
        { label: '', separator: true },
        { label: 'Select all', action: run('selectAll') },
      ],
    },
  ];
}
