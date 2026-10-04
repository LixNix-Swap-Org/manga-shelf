// The user's language choice: this device's mirror ('mangashelf_locale') plus users.locale on the server or in the
// device core. A choice made signed out or offline stays pending and is sent after the next /auth/me.
import { deviceLanguage, followDevice, getLanguage, getStoredLanguage, isAvailable, setLanguage } from './index.js';
import { apiFetch, getApiBase, isLocalMode } from '../utils/api.js';

export const PENDING_KEY = 'mangashelf_locale_pending';
const REOPEN_KEY = 'mangashelf_reopen_account';
const FOCUS_KEY = 'mangashelf_focus_language';
// the focus mark only bridges the remount right after a switch
const FOCUS_MAX_AGE_MS = 10000;

let target = null;

function read(storage, key) {
  try { return globalThis[storage]?.getItem(key) ?? null; } catch (_) { return null; }
}

function write(storage, key, value) {
  try {
    if (value === null) globalThis[storage]?.removeItem(key);
    else globalThis[storage]?.setItem(key, value);
  } catch (_) { /* storage unavailable */ }
}

function readPending() {
  try {
    const value = JSON.parse(read('localStorage', PENDING_KEY) || 'null');
    return value && typeof value === 'object' && 'locale' in value ? value : null;
  } catch (_) {
    return null;
  }
}

// the server (or the device collection) a pending choice belongs to
const currentBase = () => (isLocalMode() ? 'local' : getApiBase());

/** App: the signed-in user whose users.locale follows a switch (null signed out; offline users only queue it). */
export function setLanguageTarget(user) {
  target = user ? { offline: Boolean(user.offline), username: typeof user.username === 'string' ? user.username : null } : null;
}

/** Logout and ended sessions: a queued choice must not reach the next account on this device. */
export const clearPendingLanguage = () => write('localStorage', PENDING_KEY, null);

async function putLocale(locale) {
  try {
    const res = await apiFetch('/api/auth/profile', { method: 'PUT', body: { locale } });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function sendOrQueue(locale) {
  if (target && !target.offline && await putLocale(locale)) {
    write('localStorage', PENDING_KEY, null);
    return true;
  }
  write('localStorage', PENDING_KEY, JSON.stringify({ locale, user: target ? target.username : null, base: currentBase() }));
  return false;
}

// a choice made signed out goes to the next login; one made by an account only back to that account on that server
const pendingFor = (pending, user) => pending.user === null || (pending.user === user.username && pending.base === currentBase());

/**
 * Switch UI: '' follows the device again, a language code becomes the user's choice. Resolves once applied with the
 * active language; a catalog that did not load (offline, never opened) leaves everything as it was and sends nothing.
 */
export async function chooseLanguage(code) {
  const locale = code && isAvailable(code) ? code : null;
  const wanted = locale || deviceLanguage();
  if (locale) await setLanguage(locale, { persist: true });
  else await followDevice();
  // a queued choice the UI never applied would switch the account later without warning
  if (getLanguage() !== wanted) return getLanguage();
  // the remount for the new language already happened: the server write runs on its own
  sendOrQueue(locale).catch(() => {});
  return getLanguage();
}

/**
 * After /auth/me (or the cached user offline): a pending choice is sent instead of adopted; else users.locale wins,
 * NULL follows the device. A user object without the field (older server) changes nothing.
 */
export async function syncUserLanguage(user) {
  if (!user || !('locale' in user)) return getLanguage();
  setLanguageTarget(user);
  let pending = readPending();
  if (pending && !pendingFor(pending, user)) {
    clearPendingLanguage();
    pending = null;
  }
  if (pending) {
    if (!user.offline && await putLocale(pending.locale)) clearPendingLanguage();
    return getLanguage();
  }
  if (typeof user.locale === 'string' && isAvailable(user.locale)) {
    if (user.locale !== getLanguage() || getStoredLanguage() !== user.locale) await setLanguage(user.locale, { persist: true });
  } else if (user.locale === null && getStoredLanguage()) {
    await followDevice();
  }
  return getLanguage();
}

/** The account dialog reopens on its language tab after the remount a switch causes. */
export const markReopenAccount = (tab) => write('sessionStorage', REOPEN_KEY, tab);

/** Taken once by the shelf when it mounts. */
export function takeReopenAccount() {
  const tab = read('sessionStorage', REOPEN_KEY);
  if (tab) write('sessionStorage', REOPEN_KEY, null);
  return tab;
}

/** LanguageSelect: focus comes back to the select after the remount a switch causes. */
export const markFocusLanguage = () => write('sessionStorage', FOCUS_KEY, String(Date.now()));

/** Taken once by the LanguageSelect that mounts next; true only right after a switch. */
export function takeFocusLanguage(now = Date.now()) {
  const at = Number(read('sessionStorage', FOCUS_KEY));
  if (!at) return false;
  write('sessionStorage', FOCUS_KEY, null);
  return now - at >= 0 && now - at < FOCUS_MAX_AGE_MS;
}
