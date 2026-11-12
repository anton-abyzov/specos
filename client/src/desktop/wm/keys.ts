/**
 * Keyboard shortcuts of the window manager. Browsers keep some combinations
 * for themselves in a normal tab (Ctrl+W, Ctrl+1 to 4), so every desktop
 * shortcut also works with Alt held.
 */
import { DESKTOP_COUNT, useShellStore } from '../../stores/shell';
import { focusedWindow, useWindowsStore } from './store';

const DIGIT = /^Digit([1-9])$/;

/** True when the key was typed into something that uses Escape itself: a field, an editor, a terminal. */
function typingTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/** Runs the shortcut for this key, if there is one. Returns whether it was handled. */
function shortcut(event: KeyboardEvent): boolean {
  const state = useWindowsStore.getState();
  const focused = focusedWindow(state);
  const { ctrlKey: ctrl, altKey: alt, shiftKey: shift, metaKey: meta, code } = event;

  if (code === 'F3' && !ctrl && !alt && !meta) {
    state.setOverview(!state.overviewOpen);
    return true;
  }

  const desktop = DIGIT.exec(code);
  if (ctrl && desktop && Number(desktop[1]) <= DESKTOP_COUNT) {
    const index = Number(desktop[1]) - 1;
    if (shift && alt) {
      if (focused && !state.overviewOpen) state.moveToDesktop(focused.id, index);
    } else if (!shift) {
      state.setDesktop(index);
    } else {
      return false;
    }
    return true;
  }
  // The overview has its own keys; window commands wait until it is closed.
  if (state.overviewOpen) return false;

  if (ctrl && alt && !shift) {
    if (code === 'KeyT') {
      state.toggleTiling();
      return true;
    }
    if (!focused) return false;
    if (code === 'ArrowLeft') state.snap(focused.id, 'left');
    else if (code === 'ArrowRight') state.snap(focused.id, 'right');
    else if (code === 'ArrowUp') state.snap(focused.id, 'full');
    else if (code === 'ArrowDown') state.unsnap(focused.id);
    else return false;
    return true;
  }

  if (alt) return false;
  if (code === 'Backquote' && ctrl) {
    state.cycle(shift ? -1 : 1);
    return true;
  }
  if (shift || !focused) return false;
  // Inside a terminal Ctrl+W and Ctrl+M belong to the shell; Cmd+W and the Window menu still close it.
  if (ctrl && !meta && event.target instanceof Element && event.target.closest('.xterm')) return false;
  if (code === 'KeyW' && (ctrl || meta)) {
    state.close(focused.id);
    return true;
  }
  if (code === 'KeyM' && ctrl) {
    state.minimise(focused.id);
    return true;
  }
  return false;
}

/** Starts listening for the window manager's shortcuts. Returns the function that stops it. */
export function bindKeys(): () => void {
  // Capture phase: the shortcuts work even while an app holds the keyboard focus.
  const onKeyDown = (event: KeyboardEvent) => {
    // The launcher owns the keyboard while it is open.
    if (useShellStore.getState().launcherOpen) return;
    if (event.defaultPrevented || !shortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  // Escape is different: menus, fields and terminals use it first, so it is heard last.
  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || typingTarget(event)) return;
    if (useShellStore.getState().launcherOpen) return;
    const state = useWindowsStore.getState();
    const focused = focusedWindow(state);
    if (!state.overviewOpen && focused?.mode === 'fullscreen') state.toggleFullscreen(focused.id);
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keydown', onEscape);
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keydown', onEscape);
  };
}
