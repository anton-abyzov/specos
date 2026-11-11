import type { PointerEvent } from 'react';
import { Dock } from './Dock';
import { MenuBar } from './MenuBar';
import { Wallpaper } from './Wallpaper';
import { WindowLayer } from './wm/WindowLayer';
import { useWindowsStore } from './wm/store';
import './desktop.css';

/** A press on the bare desktop (the wallpaper lets it through) puts the desktop itself in front. */
function onPointerDown(event: PointerEvent<HTMLElement>) {
  if (event.target === event.currentTarget) useWindowsStore.getState().blur();
}

/** The whole screen: wallpaper at the back, then windows, then the menu bar and dock. */
export function Desktop() {
  return (
    <main className="desktop" data-testid="desktop" onPointerDown={onPointerDown}>
      <Wallpaper />
      <WindowLayer />
      <MenuBar />
      <Dock />
    </main>
  );
}
