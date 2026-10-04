// Electron shell of the app build (desktop/, client mode on app://manga-shelf/). desktop/preload.js exposes
// window.mangashelfDesktop; this module plugs it into the app before it mounts: saved servers and tokens in
// safeStorage (serverStore adapter), links in the system browser, manga-shelf://connect links from the OS, and a
// connection check after the computer wakes up. Downloads (<a download>) get a save dialog from the main process.
import { setStorageAdapter } from '../serverStore.js';
import { setOpenExternal } from '../openExternal.js';
import { checkConnection } from '../connection.js';
import { OPEN_URL_EVENT } from '../deepLink.js';

export const electronBridge = (win = globalThis.window) => win?.mangashelfDesktop ?? null;

export const isElectronShell = (win = globalThis.window) => Boolean(electronBridge(win)?.appBuild);

/** serverStore adapter over the preload storage ({ getSync, get, set, remove }, string values). */
export function electronStorageAdapter(storage) {
  return {
    getSync: (key) => storage.getSync(key),
    get: async (key) => storage.get(key),
    set: async (key, value) => storage.set(key, value),
    remove: async (key) => storage.remove(key)
  };
}

function deliverUrl(win, url) {
  if (typeof url !== 'string' || !url) return;
  if (typeof win.mangashelfOpenUrl === 'function') win.mangashelfOpenUrl(url);
  else win.dispatchEvent(new CustomEvent(OPEN_URL_EVENT, { detail: { url } }));
}

/**
 * Wires the shell; call before the app mounts (after installDeepLinkBridge). Returns false outside Electron's app
 * build (browser, local server's web build, Capacitor), else a function that removes the listeners.
 */
export function installElectronShell(win = globalThis.window, { recheck = checkConnection } = {}) {
  const bridge = electronBridge(win);
  if (!bridge || !bridge.appBuild) return false;
  if (bridge.storage) setStorageAdapter(electronStorageAdapter(bridge.storage));
  setOpenExternal((url) => bridge.openExternal(url));
  const offUrl = bridge.onOpenUrl?.((url) => deliverUrl(win, url));
  const offResume = bridge.onResume?.(() => { Promise.resolve(recheck()).catch(() => {}); });
  return () => {
    offUrl?.();
    offResume?.();
  };
}
