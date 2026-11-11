import { Dock } from './Dock';
import { MenuBar } from './MenuBar';
import { Wallpaper } from './Wallpaper';
import './desktop.css';

/** The whole screen: wallpaper at the back, then windows, then the menu bar and dock. */
export function Desktop() {
  return (
    <main className="desktop" data-testid="desktop">
      <Wallpaper />
      {/* The window manager renders its windows into this layer. */}
      <div className="desktop__windows" data-testid="windows-layer" />
      <MenuBar />
      <Dock />
    </main>
  );
}
