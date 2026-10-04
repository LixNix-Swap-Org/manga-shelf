import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { shouldRegisterServiceWorker, isLogoutPending } from './appShell'
import { apiFetch, isAppMode } from './utils/api'
import { startPrefetch, PREFETCH_MANGAS } from './utils/dataCache'
import { watchServiceWorkerUpdates } from './hooks/usePwaInstall'
import { installDeepLinkBridge } from './app/deepLink'
import './index.css'

const appBuild = isAppMode()

// The shelf list loads in parallel with the session check; useMangaList takes the answer once (a 401 is ignored there).
// Not while a logout is outstanding: the old session must not be used again. The app build first picks its server.
if (!appBuild && window.location.pathname === '/' && navigator.onLine !== false && !isLogoutPending()) {
  startPrefetch(PREFETCH_MANGAS, () => apiFetch('/api/mangas'))
}

// manga-shelf://connect links the shells receive before the app has mounted
if (appBuild) installDeepLinkBridge(window)

// the shells (Capacitor: mobile/, Electron: desktop/) plug in storage, links and native adapters before the first render
const shellReady = import.meta.env.VITE_APP_MODE === 'app'
  ? Promise.all([
      import('./app/shell/electron.js').then((m) => m.installElectronShell(window)),
      import('./app/shell/capacitor.js').then((m) => m.installCapacitorShell())
    ]).catch((err) => console.warn('[App] Hülle nicht geladen:', err?.message || err))
  : Promise.resolve()

shellReady.then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})

// Service worker (offline start, install prompt): production builds on a secure origin only (HTTPS or localhost), never
// in the app build (the shells bundle the files). Browsers have no navigator.serviceWorker on plain http://LAN-IP, so the
// offline copy then only works while the tab stays open. Test it locally with `vite build && vite preview`.
// watchServiceWorkerUpdates shows the "Neue Version verfügbar" toast and activates the waiting worker on "Neu laden".
const swSupported = 'serviceWorker' in navigator
if (!appBuild && shouldRegisterServiceWorker({ prod: import.meta.env.PROD, secure: window.isSecureContext, supported: swSupported })) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(() => watchServiceWorkerUpdates())
      .catch((err) => {
        console.warn('[PWA] Service worker registration failed:', err);
      });
  });
} else if (swSupported && !import.meta.env.PROD) {
  // A worker left over from an earlier dev session would keep serving cached dev modules
  navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {})
} else if (!appBuild && import.meta.env.PROD && !window.isSecureContext) {
  console.info('[PWA] Offline-Start und App-Installation brauchen HTTPS (oder localhost).')
}
