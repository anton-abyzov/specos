import { Glyph } from '../../design/icons';
import { useShellStore } from '../../stores/shell';

/** The launcher's place in the menu bar: a way in for the pointer, and a reminder of the shortcut. */
export function LauncherButton() {
  const open = useShellStore((state) => state.launcherOpen);
  const toggleLauncher = useShellStore((state) => state.toggleLauncher);
  return (
    <button
      type="button"
      className="status-item launcher-button"
      data-testid="launcher-button"
      aria-label="Open Launcher"
      aria-haspopup="dialog"
      aria-expanded={open}
      title="Launcher (Ctrl K)"
      onClick={toggleLauncher}
    >
      <Glyph name="search" size={14} />
      <span className="launcher-button__keys">Ctrl K</span>
    </button>
  );
}
