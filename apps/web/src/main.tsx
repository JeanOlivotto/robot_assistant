import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DesktopBubble } from './components/DesktopBubble';
import { DESKTOP } from './lib/desktop';
import './styles.css';

// Service worker: recebe as notificações push mesmo com o app fechado (no computador, quem avisa é a bolha).
if ('serviceWorker' in navigator && !DESKTOP) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
if (DESKTOP) document.documentElement.classList.add(`desktop-${DESKTOP}`);

createRoot(document.getElementById('root')!).render(
  <StrictMode>{DESKTOP === 'bolha' ? <DesktopBubble /> : <App />}</StrictMode>,
);
