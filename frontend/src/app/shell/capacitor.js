// The iOS/Android shell (Capacitor 7, mobile/). The plugins come from window.mangashelfNative, set by mobile's
// native-bridge.js before the app's module runs; without it (browser, Electron) installCapacitorShell does nothing.
// main.jsx awaits installCapacitorShell() before the first render of the app build.
import {
  setStorageAdapter, loadServers, SERVERS_KEY, ACTIVE_KEY, PENDING_LOGOUTS_KEY, LEGACY_BASE_KEY, LEGACY_TOKEN_KEY
} from '../serverStore.js';
import { checkConnection } from '../connection.js';
import { setOpenExternal, openExternal } from '../openExternal.js';
import { receiveDeepLink, buildShareLink } from '../deepLink.js';
import { setLocalAdapters } from '../../local/localTransport.js';
import { createCapacitorAdapters, bytesToBase64 } from '../../local/capacitor.js';
import { notify } from '../../utils/notify.js';
import { t } from '../../i18n/index.js';

export const TOKEN_PREFIX = 'server-token:';
// whole values that carry tokens; the server list keeps its tokens apart (TOKEN_PREFIX + server id)
const SECURE_KEYS = new Set([PENDING_LOGOUTS_KEY, LEGACY_TOKEN_KEY]);
const MIGRATED_KEYS = [SERVERS_KEY, ACTIVE_KEY, PENDING_LOGOUTS_KEY, LEGACY_BASE_KEY, LEGACY_TOKEN_KEY];
const STATUS_BAR_COLOR = '#0b0f19';

export const nativeBridge = (win = globalThis.window) => (win?.mangashelfNative?.plugins ? win.mangashelfNative : null);

/**
 * Storage adapter of app/serverStore.js: the server list in Preferences, every token (and the pending logouts) in the
 * secure storage. Operations run one after another, so a logout written after a login can never be overtaken.
 */
export function createServerStorage(bridge) {
  const { Preferences, SecureStorage } = bridge.plugins;
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  const prefGet = async (key) => (await Preferences.get({ key }))?.value ?? null;
  const tokenKeys = async () => (await SecureStorage.keys()).filter((k) => k.startsWith(TOKEN_PREFIX));

  async function withTokens(raw) {
    let list;
    try { list = JSON.parse(raw); } catch (_) { return raw; }
    if (!Array.isArray(list)) return raw;
    const merged = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || !entry.tokenRef) {
        merged.push(entry);
        continue;
      }
      const { tokenRef: _ref, ...server } = entry;
      let secret = null;
      try { secret = JSON.parse(await SecureStorage.getItem(TOKEN_PREFIX + server.id) || 'null'); } catch (_) { secret = null; }
      merged.push(secret?.token ? { ...server, token: secret.token, ...(secret.tokenOrigins ? { tokenOrigins: secret.tokenOrigins } : {}) } : server);
    }
    return JSON.stringify(merged);
  }

  async function setServers(value) {
    const list = JSON.parse(value);
    if (!Array.isArray(list)) throw new TypeError(t('Serverliste ist keine Liste'));
    const keep = new Set();
    const stripped = [];
    for (const entry of list) {
      const { token, tokenOrigins, ...server } = entry || {};
      if (token && server.id) {
        await SecureStorage.setItem(TOKEN_PREFIX + server.id, JSON.stringify({ token, ...(tokenOrigins ? { tokenOrigins } : {}) }));
        keep.add(TOKEN_PREFIX + server.id);
        stripped.push({ ...server, tokenRef: true });
      } else {
        stripped.push(server);
      }
    }
    await Preferences.set({ key: SERVERS_KEY, value: JSON.stringify(stripped) });
    for (const key of await tokenKeys()) if (!keep.has(key)) await SecureStorage.removeItem(key);
  }

  return {
    get: (key) => serial(async () => {
      if (SECURE_KEYS.has(key)) return (await SecureStorage.getItem(key)) ?? null;
      const raw = await prefGet(key);
      return key === SERVERS_KEY && raw ? withTokens(raw) : raw;
    }),
    set: (key, value) => serial(async () => {
      if (SECURE_KEYS.has(key)) return SecureStorage.setItem(key, value);
      if (key === SERVERS_KEY) return setServers(value);
      return Preferences.set({ key, value });
    }),
    remove: (key) => serial(async () => {
      if (SECURE_KEYS.has(key)) return SecureStorage.removeItem(key);
      await Preferences.remove({ key });
      if (key === SERVERS_KEY) for (const tokenKey of await tokenKeys()) await SecureStorage.removeItem(tokenKey);
      return undefined;
    })
  };
}

/** Moves what an earlier app build kept in localStorage into the native storage once. */
export async function migrateLocalStorage(adapter, storage = globalThis.localStorage) {
  let values;
  try {
    values = MIGRATED_KEYS.map((key) => [key, storage?.getItem(key) ?? null]).filter(([, value]) => value !== null);
  } catch (_) {
    return false;
  }
  if (!values.length || (await adapter.get(SERVERS_KEY)) !== null) return false;
  for (const [key, value] of values) await adapter.set(key, value);
  for (const [key] of values) storage.removeItem(key);
  return true;
}

const keyFieldNear = (el) => el?.closest?.('[data-provider]')?.querySelector?.('input[type="password"]') || null;

/**
 * Links leave through @capacitor/browser (in-app Safari / Custom Tab); `{ preferApp: true }` uses AppLauncher so app links
 * reach an installed app (in-app browser as fallback). From an API key card the key field gets the focus back when the
 * browser closes. The shell never reads the clipboard; only the 'Link einfügen' button does, on tap.
 */
export function installExternalLinks(bridge, { doc = globalThis.document } = {}) {
  const { Browser, App, AppLauncher } = bridge.plugins;
  let lastTarget = null;
  let returnFocus = null;
  const refocus = () => {
    const field = returnFocus;
    returnFocus = null;
    if (field?.isConnected) field.focus();
  };
  const inAppBrowser = (url) => Browser.open({ url });
  // openUrl resolves { completed: false } when no app or browser took the link
  const systemOpener = (url) => Promise.resolve().then(() => AppLauncher.openUrl({ url }))
    .then((res) => (res?.completed === false ? inAppBrowser(url) : res), () => inAppBrowser(url));
  setOpenExternal((url, options) => {
    const viaApp = Boolean(options?.preferApp && typeof AppLauncher?.openUrl === 'function');
    returnFocus = viaApp ? null : keyFieldNear(lastTarget) || keyFieldNear(doc.activeElement);
    Promise.resolve(viaApp ? systemOpener(url) : inAppBrowser(url)).catch((err) => {
      returnFocus = null;
      notify.error(t('Link ließ sich nicht öffnen: {reason}', { reason: err?.message || url }));
    });
  });
  const onPointer = (e) => { lastTarget = e.target; };
  doc.addEventListener('pointerdown', onPointer, true);
  doc.addEventListener('click', onPointer, true);
  const listeners = [Browser.addListener?.('browserFinished', refocus), App.addListener?.('resume', refocus)];
  return {
    refocus,
    stop() {
      doc.removeEventListener('pointerdown', onPointer, true);
      doc.removeEventListener('click', onPointer, true);
      for (const l of listeners) Promise.resolve(l).then((h) => h?.remove?.()).catch(() => {});
    }
  };
}

const fileName = (name) => [...String(name || 'download')]
  .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch)).join('').slice(0, 120) || 'download';

function blobToBase64(blob) {
  if (typeof FileReader === 'undefined' || !(blob instanceof globalThis.Blob)) return blob.arrayBuffer().then((buf) => bytesToBase64(new Uint8Array(buf)));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const objectUrlBlobs = new Map();

/**
 * Remembers the Blob behind each blob: URL. The app CSP (connect-src 'self' http: https:) blocks fetching blob: and
 * data: URLs, so saveFile takes the Blob from here instead.
 */
export function installObjectUrls(urlApi = globalThis.URL) {
  if (typeof urlApi?.createObjectURL !== 'function' || urlApi.createObjectURL.tracksBlobs) return false;
  const create = urlApi.createObjectURL;
  const revoke = urlApi.revokeObjectURL;
  const createObjectURL = (obj) => {
    const url = create.call(urlApi, obj);
    if (typeof Blob !== 'undefined' && obj instanceof Blob) objectUrlBlobs.set(url, obj);
    return url;
  };
  createObjectURL.tracksBlobs = true;
  urlApi.createObjectURL = createObjectURL;
  urlApi.revokeObjectURL = (url) => {
    objectUrlBlobs.delete(url);
    return revoke?.call(urlApi, url);
  };
  return true;
}

function dataUrlBlob(url) {
  const comma = url.indexOf(',');
  if (comma < 0) throw new TypeError(t('Ungültige data:-Adresse'));
  const meta = url.slice(5, comma);
  const body = decodeURIComponent(url.slice(comma + 1));
  const base64 = /;base64$/i.test(meta);
  const bytes = base64 ? Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(body);
  return new Blob([bytes], { type: base64 ? meta.slice(0, -7) : meta });
}

// CapacitorHttp replaces window.fetch; anything that is not http(s) goes to WebKit's own fetch
const webFetch = (...args) => (globalThis.CapacitorWebFetch || globalThis.fetch)(...args);

async function fileData(source, fetchImpl) {
  if (typeof source !== 'string') return source;
  const known = objectUrlBlobs.get(source);
  if (known) return known;
  if (/^data:/i.test(source)) return dataUrlBlob(source);
  return (await fetchImpl(source)).blob();
}

/** A downloaded file (backup ZIP, CSV): written to the cache and handed to the share sheet ("In Dateien sichern"). */
export async function saveFile(bridge, blob, name, { fetchImpl = webFetch } = {}) {
  const { Filesystem, Share } = bridge.plugins;
  const directory = bridge.constants.Directory.Cache;
  const data = await fileData(blob, fetchImpl);
  const path = `downloads/${fileName(name)}`;
  await Filesystem.writeFile({ path, directory, data: await blobToBase64(data), recursive: true });
  const { uri } = await Filesystem.getUri({ path, directory });
  try {
    await Share.share({ title: fileName(name), files: [uri] });
  } catch (err) {
    if (!/cancel/i.test(String(err?.message || err))) throw err;
  }
  return uri;
}

/**
 * <a download href="blob:…"> (utils/api.js downloadFile, BackupExportModal) does nothing in a WebView: such clicks go
 * to saveFile. Links with target="_blank" open in the in-app browser unless the app handled the click itself.
 */
export function installLinkClicks(bridge, { doc = globalThis.document, win = globalThis.window } = {}) {
  const onClick = (e) => {
    if (e.defaultPrevented || (e.button !== undefined && e.button !== 0)) return;
    const link = e.target?.closest?.('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (link.hasAttribute('download') && /^(blob|data):/i.test(href)) {
      e.preventDefault();
      saveFile(bridge, href, link.getAttribute('download') || 'download')
        .catch((err) => notify.error(t('Datei konnte nicht gespeichert werden: {reason}', { reason: err?.message || err })));
      return;
    }
    if (link.target === '_blank' && /^https?:/i.test(link.href) && link.origin !== win?.location?.origin) {
      e.preventDefault();
      openExternal(link.href);
    }
  };
  doc.addEventListener('click', onClick);
  return () => doc.removeEventListener('click', onClick);
}

/** Android's back button: Back in the app (closes the top dialog, see useDialogA11y), at the start the app goes to the background. */
export function backButtonHandler(bridge, win = globalThis.window) {
  const { App } = bridge.plugins;
  return ({ canGoBack } = {}) => {
    if (canGoBack) win.history.back();
    else if (typeof App.minimizeApp === 'function') App.minimizeApp();
    else App.exitApp();
  };
}

/** navigator.vibrate is missing in iOS's WebView: utils/haptics.js patterns go to the Haptics plugin there. */
export function installHaptics(bridge, nav = globalThis.navigator) {
  if (!nav || typeof nav.vibrate === 'function') return false;
  const { Haptics } = bridge.plugins;
  const { ImpactStyle, NotificationType } = bridge.constants;
  Object.defineProperty(nav, 'vibrate', {
    configurable: true,
    value: (pattern) => {
      const run = Array.isArray(pattern)
        ? Haptics.notification({ type: pattern[0] >= 50 ? NotificationType.Error : NotificationType.Success })
        : Haptics.impact({ style: ImpactStyle.Light });
      Promise.resolve(run).catch(() => {});
      return true;
    }
  });
  return true;
}

async function styleStatusBar(bridge) {
  const { StatusBar } = bridge.plugins;
  const steps = [
    () => StatusBar.setStyle({ style: bridge.constants.StatusBarStyle.Dark }),
    ...(bridge.platform === 'android'
      ? [() => StatusBar.setOverlaysWebView({ overlay: false }), () => StatusBar.setBackgroundColor({ color: STATUS_BAR_COLOR })]
      : [])
  ];
  for (const step of steps) await Promise.resolve().then(step).catch(() => {});
}

function deliverShare(share, win) {
  const link = buildShareLink(share);
  if (typeof win.mangashelfOpenUrl === 'function') win.mangashelfOpenUrl(link);
  else receiveDeepLink(link, win);
}

/** Android: text shared to the app (ShareIntentPlugin, retained until this listener subscribes) as a share link. */
export function installShareIntent(bridge, win = globalThis.window) {
  const { ShareIntent } = bridge.plugins;
  if (bridge.platform !== 'android' || typeof ShareIntent?.addListener !== 'function') return false;
  Promise.resolve(ShareIntent.addListener('shareReceived', ({ text, subject } = {}) => {
    deliverShare({ text: text || '', subject: subject || '' }, win);
  })).catch((err) => console.warn('[App] Teilen-Empfang nicht verfügbar:', err?.message || err));
  return true;
}

/**
 * iOS: what the share extension left in the App Group (SharedInbox drains it when the app becomes active, retained
 * until this listener subscribes), as a share link like on Android.
 */
export function installSharedInbox(bridge, win = globalThis.window) {
  const { SharedInbox } = bridge.plugins;
  if (bridge.platform !== 'ios' || typeof SharedInbox?.addListener !== 'function') return false;
  Promise.resolve(SharedInbox.addListener('shareReceived', ({ text, url } = {}) => {
    if (!text && !url) return;
    deliverShare({ text: text || '', url: url || '' }, win);
  })).catch((err) => console.warn('[App] Teilen-Empfang nicht verfügbar:', err?.message || err));
  return true;
}

/**
 * Wires the native plugins into the app; resolves to false outside Capacitor. Storage adapter (+ hydrated server
 * list), standalone adapters, links, downloads, back button, deep links, network and foreground checks.
 */
export async function installCapacitorShell({ win = globalThis.window, doc = globalThis.document, bridge = nativeBridge(win) } = {}) {
  if (!bridge) return false;
  const { App, Network } = bridge.plugins;
  const storage = createServerStorage(bridge);
  let legacy = null;
  try { legacy = win.localStorage; } catch (_) { /* storage blocked */ }
  await migrateLocalStorage(storage, legacy).catch((err) => console.warn('[App] Übernahme der Serverliste fehlgeschlagen:', err?.message || err));
  setStorageAdapter(storage);
  await loadServers();
  setLocalAdapters(await createCapacitorAdapters(bridge));

  installExternalLinks(bridge, { doc });
  installObjectUrls(win.URL);
  installLinkClicks(bridge, { win, doc });
  installHaptics(bridge, win.navigator);
  styleStatusBar(bridge);

  App.addListener('backButton', backButtonHandler(bridge, win));
  App.addListener('appUrlOpen', ({ url } = {}) => { receiveDeepLink(url, win); });
  installShareIntent(bridge, win);
  installSharedInbox(bridge, win);
  App.addListener('appStateChange', ({ isActive } = {}) => { if (isActive) checkConnection(); });
  Network.addListener('networkStatusChange', () => { checkConnection(); });
  const launch = await Promise.resolve(App.getLaunchUrl?.()).catch(() => null);
  if (launch?.url) receiveDeepLink(launch.url, win);
  return true;
}
