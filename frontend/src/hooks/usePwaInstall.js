import { useState, useEffect } from 'react';
import { notify } from '../utils/notify';
import { reloadForStaleChunk } from '../appShell';

export const IOS_HINT_KEY = 'mangashelf_ios_install_hint';
export const IOS_HINT_TEXT = 'Für Offline im Laden: Teilen → Zum Home-Bildschirm';
export const UPDATE_TEXT = 'Neue Version verfügbar';
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const isStandalone = (win = globalThis.window) => Boolean(
  win?.matchMedia?.('(display-mode: standalone)').matches || win?.navigator?.standalone === true
);

/** iPhone/iPad Safari (iPadOS reports a Mac with touch); other iOS browsers cannot add to the home screen before iOS 16.4. */
export function isIosSafari(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || '');
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav?.maxTouchPoints) > 1);
  return ios && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

/** Plain HTTP on a LAN address: no service worker, no install, no live camera. localhost counts as secure. */
export function needsHttps(win = globalThis.window) {
  if (!win || win.isSecureContext !== false) return false;
  return !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(String(win.location?.hostname || ''));
}

/** Shows the add-to-home-screen hint once on iOS Safari outside the installed app. */
export function maybeShowIosInstallHint({ win = globalThis.window, storage = globalThis.localStorage } = {}) {
  if (!isIosSafari(win?.navigator) || isStandalone(win)) return false;
  try {
    if (storage?.getItem(IOS_HINT_KEY)) return false;
    storage?.setItem(IOS_HINT_KEY, String(Date.now()));
  } catch (_) {
    return false;
  }
  notify.info(IOS_HINT_TEXT, { duration: 0 });
  return true;
}

let watcher = null;

/**
 * Offers a waiting service worker as a toast ('Neu laden' posts SKIP_WAITING), reloads once the new worker took over
 * and checks for updates when the app returns to the foreground, at most hourly. Safe to call more than once.
 */
export function watchServiceWorkerUpdates({
  container = globalThis.navigator?.serviceWorker,
  win = globalThis.window,
  doc = globalThis.document,
  reload = () => globalThis.location.reload(),
  now = () => Date.now()
} = {}) {
  if (watcher) return watcher;
  if (!container || typeof container.getRegistration !== 'function') return Promise.resolve(null);
  const hadController = Boolean(container.controller);
  let reloading = false;
  container.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    reload();
  });
  win?.addEventListener?.('vite:preloadError', (event) => {
    if (reloadForStaleChunk({ reload })) event.preventDefault();
  });

  const offered = new WeakSet();
  const offer = (worker) => {
    if (!worker || offered.has(worker) || !container.controller) return;
    offered.add(worker);
    notify.info(UPDATE_TEXT, {
      duration: 0,
      action: { label: 'Neu laden', onClick: () => worker.postMessage({ type: 'SKIP_WAITING' }) }
    });
  };

  const track = (worker) => {
    if (!worker) return;
    if (worker.state === 'installed') offer(worker);
    else worker.addEventListener('statechange', () => { if (worker.state === 'installed') offer(worker); });
  };

  watcher = container.getRegistration().then((reg) => {
    if (!reg) return null;
    if (reg.waiting) offer(reg.waiting);
    // the update check of register() often runs already when the watcher attaches
    track(reg.installing);
    reg.addEventListener('updatefound', () => track(reg.installing));
    let lastCheck = now();
    doc?.addEventListener?.('visibilitychange', () => {
      if (doc.visibilityState !== 'visible' || now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
      lastCheck = now();
      Promise.resolve(reg.update()).catch(() => {});
    });
    return reg;
  }).catch(() => null);
  return watcher;
}

export function resetServiceWorkerWatcher() {
  watcher = null;
}

/** "Install app" prompt of the browser (PWA), the iOS home-screen hint and the update prompt. */
export default function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isInstallable, setIsInstallable] = useState(false);
  const [isInstalledApp, setIsInstalledApp] = useState(() => isStandalone(window));

  useEffect(() => {
    const handleBeforeInstall = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setIsInstallable(true);
    };
    const handleAppInstalled = () => {
      setIsInstallable(false);
      setDeferredPrompt(null);
      setIsInstalledApp(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleAppInstalled);
    watchServiceWorkerUpdates();
    maybeShowIosInstallHint();

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstallable(false);
    }
    setDeferredPrompt(null);
  };

  return { isInstallable, isInstalledApp, handleInstallClick };
}
