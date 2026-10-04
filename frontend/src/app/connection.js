// Server address and session token of the app build (VITE_APP_MODE=app). Kept in localStorage for now; the app shell
// replaces this with secure storage (Keychain / Keystore / safeStorage).
export const BASE_KEY = 'mangashelf_server_base';
export const TOKEN_KEY = 'mangashelf_server_token';

function storage() {
  try { return globalThis.localStorage ?? null; } catch (_) { return null; }
}

function read(key) {
  try { return storage()?.getItem(key) || ''; } catch (_) { return ''; }
}

function write(key, value) {
  try {
    if (value) storage()?.setItem(key, value);
    else storage()?.removeItem(key);
  } catch (_) { /* storage unavailable */ }
}

/** http(s) origin plus path without trailing slash ('https://host/manga'), or '' for anything else. */
export function normalizeBase(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  let parsed;
  try { parsed = new URL(url.trim()); } catch (_) { return ''; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function getActiveBase() {
  return normalizeBase(read(BASE_KEY));
}

const originOf = (base) => (base ? new URL(base).origin : '');

function readTokenEntry() {
  try {
    const entry = JSON.parse(read(TOKEN_KEY));
    return entry && typeof entry.token === 'string' && typeof entry.origin === 'string' ? entry : null;
  } catch (_) {
    return null;
  }
}

/** Stores the server base; an empty value clears it, an invalid address throws. Returns the stored value. */
export function setActiveBase(url) {
  const base = normalizeBase(url);
  if (!base && typeof url === 'string' && url.trim()) throw new TypeError(`Ungültige Serveradresse: ${url}`);
  const entry = readTokenEntry();
  if (entry && entry.origin !== originOf(base)) write(TOKEN_KEY, '');
  write(BASE_KEY, base);
  return base;
}

/** The token of the active server; '' when it was issued by another origin (a base switch never carries it over). */
export function getToken() {
  const entry = readTokenEntry();
  return entry && entry.origin === originOf(getActiveBase()) ? entry.token : '';
}

/** Binds the token to the active server's origin; null or '' removes it. */
export function setToken(token) {
  write(TOKEN_KEY, typeof token === 'string' && token
    ? JSON.stringify({ origin: originOf(getActiveBase()), token })
    : '');
}
