import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Design system token CSS custom properties — must be imported before index.css
// so Tailwind utilities can build on the same variables.
import '../../../packages/ui/tokens.css';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register service worker for PWA app-shell caching and offline support.
// Only active in production builds — Vite HMR in dev mode conflicts with SW
// interception.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[sw] Registration failed:', err);
    });
  });
}
