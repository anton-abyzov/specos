/**
 * Lets an app keep its window open when it is asked to close, for example to
 * ask about unsaved changes first. The guard answers whether the window may
 * close now; an app that says no shows its own question and, once it is
 * answered, closes the window with `close(id, true)`.
 */
type CloseGuard = () => boolean;

const guards = new Map<string, CloseGuard>();

/** Registers the guard of one window. Returns the function that removes it. */
export function setCloseGuard(windowId: string, guard: CloseGuard): () => void {
  guards.set(windowId, guard);
  return () => {
    if (guards.get(windowId) === guard) guards.delete(windowId);
  };
}

/** Whether the window may close now. A window without a guard always may. */
export function mayClose(windowId: string): boolean {
  return guards.get(windowId)?.() ?? true;
}
