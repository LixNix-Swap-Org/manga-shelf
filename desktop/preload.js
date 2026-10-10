/* global window */
// Bridge between the main process and the page (sandboxed preload, context isolation). The app build uses it through
// frontend/src/app/shell/electron.js; the local server's web build only gets the events.
const { contextBridge, ipcRenderer } = require('electron');

const APP_ORIGIN = 'app://manga-shelf';
const OPEN_API_KEYS_EVENT = 'mangashelf:open-api-keys';
const isAppBuild = window.location.origin === APP_ORIGIN || window.location.href.startsWith(APP_ORIGIN + '/');

let cache = null;
const readAll = () => {
    if (!cache) {
        try { cache = { ...(ipcRenderer.sendSync('desktop:store-all') || {}) }; } catch (_) { cache = {}; }
    }
    return cache;
};

const storage = isAppBuild ? {
    getSync: (key) => {
        const all = readAll();
        return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
    },
    get: async (key) => storage.getSync(key),
    set: async (key, value) => {
        readAll()[key] = String(value);
        await ipcRenderer.invoke('desktop:store-set', String(key), String(value));
    },
    remove: async (key) => {
        delete readAll()[key];
        await ipcRenderer.invoke('desktop:store-remove', String(key));
    }
} : null;

const subscribe = (channel, callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
};

// "Quellen & Schlüssel…" from the menu: App.jsx opens the AccountModal keys tab (in-page event on "/", else navigates)
// and calls preventDefault()
ipcRenderer.on('desktop:open-api-keys', () => {
    const event = new CustomEvent(OPEN_API_KEYS_EVENT, { cancelable: true });
    const unhandled = window.dispatchEvent(event);
    if (unhandled) ipcRenderer.send('desktop:open-api-keys-unhandled');
});

// system UI language (app.getLocale()) for the page's language detection; read once per page load
let locale = null;
try { locale = ipcRenderer.sendSync('desktop:locale') || null; } catch (_) { locale = null; }

let watchAllowed;
try { watchAllowed = ipcRenderer.sendSync('desktop:watch-allowed') === true; } catch (_) { watchAllowed = false; }
const WATCH_PLATFORMS = { darwin: 'macos', win32: 'windows', linux: 'linux' };
const invokeOr = (fallback, channel, ...args) => ipcRenderer.invoke(channel, ...args).catch(() => fallback);
const PREFS_REFUSED = { ok: false, code: 'not_allowed' };

const watch = watchAllowed ? {
    platform: WATCH_PLATFORMS[process.platform],
    status: () => invokeOr({ ok: true, available: false, reason: 'unreadable', connected: false }, 'desktop:watch-status'),
    login: () => invokeOr({ ok: false, code: 'failed' }, 'desktop:watch-login'),
    sync: (options) => invokeOr({ ok: false, code: 'network' }, 'desktop:watch-sync', { force: Boolean(options && options.force) }),
    logout: () => invokeOr({ ok: true }, 'desktop:watch-logout'),
    prefs: {
        get: (key) => invokeOr(PREFS_REFUSED, 'desktop:watch-prefs-get', key),
        set: (key, value) => invokeOr(PREFS_REFUSED, 'desktop:watch-prefs-set', key, value),
        remove: (key) => invokeOr(PREFS_REFUSED, 'desktop:watch-prefs-remove', key)
    },
    onForeground: (callback) => {
        if (typeof callback !== 'function') return () => {};
        let active = true;
        const off = subscribe('desktop:watch-foreground', () => callback());
        invokeOr(false, 'desktop:watch-foreground-now').then((now) => { if (active && now === true) callback(); });
        return () => {
            active = false;
            off();
        };
    }
} : null;

contextBridge.exposeInMainWorld('mangashelfDesktop', {
    platform: process.platform,
    locale,
    ...(watch ? { watch } : {}),
    appBuild: isAppBuild,
    storage,
    openExternal: (url) => ipcRenderer.send('desktop:open-external', String(url)),
    onOpenUrl: (callback) => {
        const off = subscribe('desktop:open-url', callback);
        ipcRenderer.invoke('desktop:take-pending-url').then((url) => { if (url) callback(url); }).catch(() => {});
        return off;
    },
    onResume: (callback) => subscribe('desktop:resume', callback),
    setMode: (mode) => ipcRenderer.send('desktop:set-mode', String(mode)),
    setupToken: () => ipcRenderer.invoke('desktop:setup-token'),
    info: () => ipcRenderer.invoke('desktop:info')
});
