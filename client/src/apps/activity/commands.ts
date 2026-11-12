/**
 * Commands the menu bar sends to an Activity window. The registry only knows
 * a window id, so the window listens here for what its menus ask of it.
 */
export type ActivityCommand = 'show-all' | 'show-mine' | 'find' | 'reload' | 'next-change' | 'previous-change' | 'merge';

const listeners = new Map<string, (command: ActivityCommand) => void>();

/** Called by the window; returns the function that stops listening. */
export function onActivityCommand(windowId: string, listener: (command: ActivityCommand) => void): () => void {
  listeners.set(windowId, listener);
  return () => {
    if (listeners.get(windowId) === listener) listeners.delete(windowId);
  };
}

export function sendActivityCommand(windowId: string, command: ActivityCommand): void {
  listeners.get(windowId)?.(command);
}
