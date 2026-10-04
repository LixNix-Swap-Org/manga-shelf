import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { shouldRegisterServiceWorker, UPDATE_AVAILABLE_EVENT, isLogoutPending } from './appShell'
import { apiFetch } from './utils/api'
import { startPrefetch, PREFETCH_MANGAS } from './utils/dataCache'
import './index.css'

// The shelf list loads in parallel with the session check; useMangaList takes the answer once (a 401 is ignored there).
// Not while a logout is outstanding: the old session must not be used again.
if (window.location.pathname === '/' && navigator.onLine !== false && !isLogoutPending()) {
  startPrefetch(PREFETCH_MANGAS, () => apiFetch('/api/mangas'))
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Service worker (offline start, install prompt): production builds on a secure origin only (HTTPS or localhost).
// Browsers have no navigator.serviceWorker on plain http://LAN-IP, so the offline copy then only works while the tab
// stays open. Test it locally with `vite build && vite preview`.
const swSupported = 'serviceWorker' in navigator
if (shouldRegisterServiceWorker({ prod: import.meta.env.PROD, secure: window.isSecureContext, supported: swSupported })) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        reg.onupdatefound = () => {
          const installingWorker = reg.installing;
          if (installingWorker) {
            installingWorker.onstatechange = () => {
              if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                window.dispatchEvent(new CustomEvent(UPDATE_AVAILABLE_EVENT));
              }
            };
          }
        };
      })
      .catch((err) => {
        console.warn('[PWA] Service worker registration failed:', err);
      });
  });
} else if (swSupported && !import.meta.env.PROD) {
  // A worker left over from an earlier dev session would keep serving cached dev modules
  navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {})
} else if (import.meta.env.PROD && !window.isSecureContext) {
  console.info('[PWA] Offline-Start und App-Installation brauchen HTTPS (oder localhost).')
}
