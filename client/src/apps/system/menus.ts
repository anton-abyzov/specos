import type { Menu } from '../registry';
import { useShellStore } from '../../stores/shell';
import { useBench } from './bench';

/**
 * The menu bar's menus while the System window is in front. The bar builds
 * them once per window, so the items do not depend on the benchmark's state:
 * starting a test while one runs does nothing.
 */
export function systemMenus(): Menu[] {
  return [
    {
      label: 'Machine',
      items: [
        { label: 'Create agent workspaces', action: () => useBench.getState().start() },
        { label: '', separator: true },
        { label: 'Open a Terminal', action: () => useShellStore.getState().launchApp('terminal') },
      ],
    },
  ];
}
