import { useEffect } from 'react';
import { setTheme } from './lib/theme';

export function App() {
  useEffect(() => {
    // Test and screenshot hook. Later tasks add openApp and the stores.
    window.__specos = { ...(window.__specos ?? {}), setTheme };
  }, []);
  return <main data-testid="desktop">SpecOS</main>;
}
