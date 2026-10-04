// Session, logout and update helpers for App.jsx / main.jsx.
import { TIMEOUTS, apiFetch, readJson } from './utils/api';
import { setToken } from './app/connection';

export { readJson };

/** Same name as UPLOADS_CACHE in public/sw.js (the service worker cannot import it). */
export const UPLOADS_CACHE = 'mangashelf-uploads-v2';
const UPLOADS_CACHE_PREFIX = 'mangashelf-uploads-';
export const LOGOUT_PENDING_KEY = 'mangashelf_logout_pending';
export const SEARCH_STORAGE_KEY = 'mangashelf_search';
export const UPDATE_AVAILABLE_EVENT = 'mangashelf:update-available';
const CHUNK_RELOAD_KEY = 'mangashelf_chunk_reload_at';
const CHUNK_RELOAD_GUARD_MS = 30000;
export const STARTUP_TIMEOUT_MS = TIMEOUTS.auth;
export const BEFORE_LOGOUT_EVENT = 'mangashelf:before-logout';
export const PURCHASE_RECORDED_EVENT = 'mangashelf:purchase-recorded';
const BEFORE_LOGOUT_TIMEOUT_MS = 10000;

export const MESSAGES = {
  sessionExpired: 'Deine Sitzung ist abgelaufen – bitte melde dich neu an.',
  logoutPending: 'Abmelden wird beim nächsten Verbindungsaufbau abgeschlossen. Bis dahin bleibt die Sitzung auf dem Server gültig.',
  purchasesQueued: 'Vorgemerkte Käufe werden bei deiner nächsten Anmeldung auf diesem Gerät übertragen.',
  cookieRejected: 'Anmeldung erfolgreich, aber das Sitzungs-Cookie wurde nicht gespeichert – HTTPS/Proxy-Einstellungen (COOKIE_SECURE, X-Forwarded-Proto) prüfen.',
  loginUnconfirmed: 'Anmeldung erfolgreich, aber der Server antwortet gerade nicht. Bitte erneut versuchen.',
  adminExists: 'Ein Administrator wurde bereits angelegt – bitte melde dich an.'
};

const storageOf = (name) => {
  try { return globalThis[name] ?? null; } catch (_) { return null; }
};

export function isLogoutPending(storage = storageOf('localStorage')) {
  try { return storage?.getItem(LOGOUT_PENDING_KEY) === '1'; } catch (_) { return false; }
}

export function markLogoutPending(storage = storageOf('localStorage')) {
  try { storage?.setItem(LOGOUT_PENDING_KEY, '1'); } catch (_) { /* storage unavailable */ }
}

export function clearLogoutPending(storage = storageOf('localStorage')) {
  try { storage?.removeItem(LOGOUT_PENDING_KEY); } catch (_) { /* storage unavailable */ }
}

/** POST /api/auth/logout; true only when the server answered 2xx (a 5xx from a proxy means it never arrived). */
export async function postLogout({ timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
  try {
    const res = await apiFetch('/api/auth/logout', { method: 'POST', timeout: timeoutMs });
    if (res.ok) setToken(null);
    return res.ok;
  } catch (_) {
    return false;
  }
}

/** Sends a logout that could not reach the server earlier. Resolves true when nothing is pending any more. */
export async function flushPendingLogout(options) {
  if (!isLogoutPending()) return true;
  const ok = await postLogout(options);
  if (ok) clearLogoutPending();
  return ok;
}

/**
 * Fires BEFORE_LOGOUT_EVENT and waits (at most `timeoutMs`) for the work listeners hand to `event.detail.waitUntil()`,
 * e.g. quick buys still in their undo window, which need the session that the logout ends.
 */
export async function runBeforeLogout({ target = globalThis.window, timeoutMs = BEFORE_LOGOUT_TIMEOUT_MS } = {}) {
  if (!target || typeof target.dispatchEvent !== 'function') return;
  const pending = [];
  const waitUntil = (work) => { pending.push(Promise.resolve(work)); };
  target.dispatchEvent(new CustomEvent(BEFORE_LOGOUT_EVENT, { detail: { waitUntil } }));
  if (!pending.length) return;
  let timer;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })
  ]);
  clearTimeout(timer);
}

/** Drops the cached cover and gallery images (logout / 401): they belong to the signed-out user's collection. */
export async function clearUploadsCache(cacheStorage = storageOf('caches')) {
  if (!cacheStorage) return;
  try {
    const keys = await cacheStorage.keys();
    await Promise.all(keys.filter((k) => k.startsWith(UPLOADS_CACHE_PREFIX)).map((k) => cacheStorage.delete(k)));
  } catch (_) { /* Cache Storage unavailable (insecure origin, private mode) */ }
}

export function clearSearchState(storage = storageOf('sessionStorage')) {
  try { storage?.removeItem(SEARCH_STORAGE_KEY); } catch (_) { /* storage unavailable */ }
}

/** In-app path to return to after the login; only internal paths, never /login itself. */
export function safeRedirectTarget(from) {
  const pathname = typeof from === 'string' ? from : from?.pathname;
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) return '/';
  if (pathname === '/login' || pathname.startsWith('/login/')) return '/';
  if (typeof from === 'string') return from;
  return `${pathname}${from.search || ''}${from.hash || ''}`;
}

const CHUNK_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading (CSS )?chunk \S+ failed/i;

/** A lazy route chunk that no longer exists on the server (the tab still runs the previous release). */
export function isChunkLoadError(error) {
  if (!error) return false;
  return error.name === 'ChunkLoadError' || CHUNK_ERROR.test(String(error.message || error));
}

/**
 * Reloads the page once to pick up the new release. Returns false (no reload) when the last such reload was less
 * than 30 s ago, so a server that keeps failing cannot cause a reload loop.
 */
export function reloadForStaleChunk({ storage = storageOf('sessionStorage'), now = Date.now(), reload } = {}) {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(CHUNK_RELOAD_KEY)) || 0;
    if (now - last < CHUNK_RELOAD_GUARD_MS) return false;
    storage.setItem(CHUNK_RELOAD_KEY, String(now));
  } catch (_) {
    return false;
  }
  (reload ?? (() => globalThis.location.reload()))();
  return true;
}

/** The service worker only works on secure origins (HTTPS or localhost); in dev it would cache Vite modules. */
export function shouldRegisterServiceWorker({ prod, secure, supported }) {
  return Boolean(prod && secure && supported);
}
