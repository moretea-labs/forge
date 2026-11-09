import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('FORGE_DESKTOP_ROOT_REQUIRED');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// macOS WKWebView can stall its initial composited frame when the full
// application stylesheet blocks the very first paint. A native Tauri probe
// reproduces this with eager CSS and displays the identical styles when
// loaded after the initial frame. Keep one stylesheet and one React root.
requestAnimationFrame(() => requestAnimationFrame(() => {
  void import('./styles.css').then(() => {
    requestAnimationFrame(() => document.getElementById('forge-first-paint')?.remove());
  }).catch((error) => {
    const indicator = document.getElementById('forge-first-paint');
    if (indicator) indicator.textContent = 'Forge 界面样式加载失败';
    console.error('FORGE_DESKTOP_STYLESHEET_LOAD_FAILED', error);
  });
}));
