import { useEffect } from 'react';
import { Desktop } from './desktop/Desktop';
import { setTheme } from './lib/theme';

export function App() {
  useEffect(() => {
    // Test and screenshot hook.
    window.__specos = { ...(window.__specos ?? {}), setTheme };
  }, []);
  return <Desktop />;
}
