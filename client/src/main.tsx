import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/base.css';
import { App } from './App';
import { startEvents } from './lib/events';

// Outside React on purpose: the socket lives as long as the page, not as long as a component.
startEvents();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
