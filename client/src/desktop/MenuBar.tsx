import { useMemo } from 'react';
import { APPS, type Menu } from '../apps/registry';
import { setTheme } from '../lib/theme';
import { useShellStore } from '../stores/shell';
import { useTheme } from '../stores/theme';
import { LauncherButton } from './launcher/LauncherButton';
import { MenuStrip, type StripMenu } from './menubar/MenuStrip';
import { SpecOSMark } from './menubar/SpecOSMark';
import {
  AgentsPill,
  Clock,
  ConnectionNotice,
  DesktopSwitcher,
  SystemBadge,
  SystemMeters,
  ThemeToggle,
  TilingToggle,
} from './menubar/status';
import './menubar.css';

/** Menu ids must be unique in the strip; app menus are namespaced by their label. */
const toStripMenu = (menu: Menu): StripMenu => ({ ...menu, id: `app-${menu.label.toLowerCase().replace(/\s+/g, '-')}` });

/**
 * The bar across the top: SpecOS menu, the active app's name and menus on the
 * left; desktops, agents, machine load, the system badge, theme and clock on
 * the right.
 */
export function MenuBar() {
  const theme = useTheme();
  const activeAppId = useShellStore((state) => state.activeAppId);
  const activeWindowId = useShellStore((state) => state.activeWindowId);
  const tiling = useShellStore((state) => state.tiling);
  const launchApp = useShellStore((state) => state.launchApp);
  const toggleTiling = useShellStore((state) => state.toggleTiling);
  const toggleLauncher = useShellStore((state) => state.toggleLauncher);
  const toggleOverview = useShellStore((state) => state.toggleOverview);
  const windowCommand = useShellStore((state) => state.windowCommand);
  const moveWindowToDesktop = useShellStore((state) => state.moveWindowToDesktop);
  const desktop = useShellStore((state) => state.desktop);
  const overviewOpen = useShellStore((state) => state.overviewOpen);

  const lead = useMemo<StripMenu>(
    () => ({
      id: 'specos',
      label: 'SpecOS',
      content: <SpecOSMark />,
      items: [
        { label: 'About SpecOS', action: () => launchApp('system') },
        { label: '', separator: true },
        { label: 'Light appearance', checked: theme === 'light', action: () => setTheme('light') },
        { label: 'Dark appearance', checked: theme === 'dark', action: () => setTheme('dark') },
        { label: '', separator: true },
        { label: 'Tile windows', shortcut: 'Ctrl Alt T', checked: tiling, action: toggleTiling },
        { label: '', separator: true },
        { label: 'Open Launcher', shortcut: 'Ctrl K', action: toggleLauncher },
      ],
    }),
    [theme, tiling, launchApp, toggleTiling, toggleLauncher],
  );

  const menus = useMemo<StripMenu[]>(() => {
    const app = activeAppId ? APPS[activeAppId] : null;
    const appMenus = app?.menus && activeWindowId ? app.menus(activeWindowId).map(toStripMenu) : [];
    // Window commands act on the front window, so they need one.
    const noWindow = activeWindowId === null;
    return [
      ...appMenus,
      {
        id: 'window',
        label: 'Window',
        items: [
          { label: 'Minimise', shortcut: 'Ctrl M', disabled: noWindow, action: () => windowCommand('minimise') },
          { label: 'Full screen', shortcut: 'Ctrl Alt ↑', disabled: noWindow, action: () => windowCommand('fullscreen') },
          { label: 'Close', shortcut: 'Ctrl W', disabled: noWindow, action: () => windowCommand('close') },
          { label: '', separator: true },
          { label: 'Snap to the left half', shortcut: 'Ctrl Alt ←', disabled: noWindow, action: () => windowCommand('snap-left') },
          { label: 'Snap to the right half', shortcut: 'Ctrl Alt →', disabled: noWindow, action: () => windowCommand('snap-right') },
          { label: 'Restore size', shortcut: 'Ctrl Alt ↓', disabled: noWindow, action: () => windowCommand('restore') },
          { label: '', separator: true },
          { label: 'Next window', shortcut: 'Ctrl `', disabled: noWindow, action: () => windowCommand('next-window') },
          ...[0, 1, 2, 3].map((index) => ({
            label: `Move to desktop ${index + 1}`,
            shortcut: `Ctrl Shift Alt ${index + 1}`,
            disabled: noWindow || index === desktop,
            action: () => moveWindowToDesktop(index),
          })),
          { label: '', separator: true },
          { label: 'Tile windows', shortcut: 'Ctrl Alt T', checked: tiling, action: toggleTiling },
          { label: 'Overview', shortcut: 'F3', checked: overviewOpen, action: toggleOverview },
        ],
      },
    ];
  }, [activeAppId, activeWindowId, desktop, tiling, overviewOpen, toggleTiling, toggleOverview, windowCommand, moveWindowToDesktop]);

  return (
    <header className="menubar" data-testid="menubar">
      <MenuStrip lead={lead} title={activeAppId ? APPS[activeAppId].name : 'Desktop'} menus={menus} />
      <div className="menubar__status">
        <ConnectionNotice />
        <LauncherButton />
        <TilingToggle />
        <DesktopSwitcher />
        <AgentsPill />
        <SystemMeters />
        <SystemBadge />
        <ThemeToggle />
        <Clock />
      </div>
    </header>
  );
}
