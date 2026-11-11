import { useMemo } from 'react';
import { APPS, type Menu } from '../apps/registry';
import { setTheme } from '../lib/theme';
import { useShellStore } from '../stores/shell';
import { useTheme } from '../stores/theme';
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
  const windowCommand = useShellStore((state) => state.windowCommand);

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
        { label: 'Tile windows', checked: tiling, action: toggleTiling },
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
          { label: 'Minimise', disabled: noWindow, action: () => windowCommand('minimise') },
          { label: 'Full screen', disabled: noWindow, action: () => windowCommand('fullscreen') },
          { label: 'Close', disabled: noWindow, action: () => windowCommand('close') },
          { label: '', separator: true },
          { label: 'Tile windows', checked: tiling, action: toggleTiling },
        ],
      },
    ];
  }, [activeAppId, activeWindowId, tiling, toggleTiling, windowCommand]);

  return (
    <header className="menubar" data-testid="menubar">
      <MenuStrip lead={lead} title={activeAppId ? APPS[activeAppId].name : 'Desktop'} menus={menus} />
      <div className="menubar__status">
        <ConnectionNotice />
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
