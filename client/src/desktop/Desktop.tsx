import { useState, type PointerEvent } from 'react';
import { Dock } from './Dock';
import { Launcher } from './Launcher';
import { MenuBar } from './MenuBar';
import { Overview } from './Overview';
import { QuickLook } from './QuickLook';
import { Wallpaper } from './Wallpaper';
import { WindowLayer } from './wm/WindowLayer';
import { useWindowsStore } from './wm/store';
import './desktop.css';

/** A press on the bare desktop (the wallpaper lets it through) puts the desktop itself in front. */
function onPointerDown(event: PointerEvent<HTMLElement>) {
  if (event.target === event.currentTarget) useWindowsStore.getState().blur();
}

/** The whole screen: wallpaper at the back, then windows, the menu bar and dock, and the launcher over all of it. */
export function Desktop() {
  const overviewOpen = useWindowsStore((state) => state.overviewOpen);
  // The windows stay above the menu bar and dock until the overview has faded out
  // completely, so they never dip under its backdrop on the way back.
  const [overviewShown, setOverviewShown] = useState(false);
  if (overviewOpen && !overviewShown) setOverviewShown(true);

  return (
    <main
      className="desktop"
      data-testid="desktop"
      data-overview={overviewShown || undefined}
      onPointerDown={onPointerDown}
    >
      <Wallpaper />
      <WindowLayer />
      <MenuBar />
      <Dock />
      <Overview onClosed={() => setOverviewShown(false)} />
      <QuickLook />
      <Launcher />
    </main>
  );
}
