import { Wallpaper } from './Wallpaper';
import './desktop.css';

/** The whole screen: wallpaper at the back, then windows, then the shell chrome. */
export function Desktop() {
  return (
    <main className="desktop" data-testid="desktop">
      <Wallpaper />
    </main>
  );
}
