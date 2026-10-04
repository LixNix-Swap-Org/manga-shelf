import { getActiveBase, setActiveBase, getToken, setToken } from '../app/connection.js';
import { storedModeIsLocal } from '../local/profile.js';
import { localTransport, localUploadUrl } from '../local/localTransport.js';
import { serverText } from '../i18n/serverText.js';
import { t } from '../i18n/index.js';

/** Dispatched on window when the server says the session is gone; App clears the offline copy and logs out. */
export const SESSION_EXPIRED_EVENT = 'mangashelf:session-expired';

// Client timeouts in ms; 0 means none (the server's own limits apply). lookup / remote wait for upstream calls
// (several 6-20 s in the worst case), long is for server jobs (imports, snapshots), upload for restores (none) and
// FormData bodies (uploadTimeout(bytes)).
export const TIMEOUTS = {
  auth: 4000,
  write: 8000,
  read: 15000,
  lookup: 90000,
  remote: 90000,
  long: 600000,
  upload: 0
};

const UPLOAD_MIN_MS = 120000;
const UPLOAD_BYTES_PER_MS = 50; // 50 kB/s

/** FormData bodies: max(120 s, size at 50 kB/s), at most TIMEOUTS.long; a hung upload never stays pending for good. */
export function uploadTimeout(bytes) {
  const size = Number(bytes) > 0 ? Number(bytes) : 0;
  return Math.min(TIMEOUTS.long, Math.max(UPLOAD_MIN_MS, Math.ceil(size / UPLOAD_BYTES_PER_MS)));
}

function formDataBytes(form) {
  let bytes = 0;
  try {
    for (const [, value] of form.entries()) {
      bytes += typeof value === 'string' ? value.length : (Number(value?.size) || 0);
    }
  } catch (_) { /* entries() unsupported */ }
  return bytes;
}

// 401s from these endpoints do not mean "the session ended": wrong credentials, the logout itself, the startup
// check (App handles /auth/me itself), the password change and the setup routes.
const SESSION_EXEMPT = ['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/password', '/api/setup'];
const SESSION_END_CODES = new Set(['AUTH_REQUIRED', 'SESSION_INVALID']);
const GATEWAY = new Set([502, 503, 504]);
const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:|^\/\//i;

// i18n
export const MESSAGES = {
  network: 'Netzwerkfehler – Server nicht erreichbar.',
  timeout: 'Zeitüberschreitung – der Server antwortet nicht.',
  gateway: 'Server nicht erreichbar',
  notJson: 'Unerwartete Antwort vom Server.',
  401: 'Sitzung abgelaufen – bitte neu anmelden.',
  403: 'Keine Berechtigung für diese Aktion.',
  404: 'Nicht gefunden.',
  413: 'Die Datei ist zu groß.',
  429: 'Zu viele Anfragen – bitte kurz warten.'
};

export class ApiError extends Error {
  constructor(message, { status = 0, code = null, data = null, ref = null, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
    this.ref = ref;
    if (cause !== undefined) this.cause = cause;
  }

  /** No HTTP answer at all (network error or timeout). */
  get isNetwork() { return this.status === 0; }

  get isTimeout() { return this.code === 'TIMEOUT'; }
}

export const isAbortError = (e) => e?.name === 'AbortError';

// written out in full so Vite can replace it at build time; import.meta.env is missing when Node loads this module
export const isAppMode = () => Boolean(import.meta.env) && import.meta.env.VITE_APP_MODE === 'app';

/** App build without a server: requests below /api go to the core on the device. */
export const isLocalMode = () => isAppMode() && storedModeIsLocal();

/** '' in the browser build (same origin) and in the local mode; the active server in the app build. */
export function getApiBase() {
  return isAppMode() && !storedModeIsLocal() ? getActiveBase() : '';
}

/** Switches the server (a different origin drops the token); the token is only kept in the app build. */
export function setServer({ base, token } = {}) {
  if (base !== undefined) setActiveBase(base);
  if (token === null || token === '') setToken(null);
  else if (token !== undefined && isAppMode()) setToken(token);
}

/**
 * Keeps the session token of a login / password change answer (app build only; the browser build uses the cookie).
 * `{ rotate: true }` for a new token of the same session (password change, end all sessions): the trusted addresses stay.
 */
export function rememberToken(data, options) {
  if (isAppMode() && typeof data?.token === 'string' && data.token) setToken(data.token, options);
}

export function apiUrl(path) {
  if (typeof path !== 'string' || ABSOLUTE_URL.test(path)) return path;
  return `${getApiBase()}${path}`;
}

const isServerPath = (path) => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');

/** Server paths (/uploads/...) for <img src> and links; absolute, data: and blob: URLs stay as they are. */
export function assetUrl(path) {
  if (!isAppMode() || !isServerPath(path)) return path;
  if (storedModeIsLocal()) return localUploadUrl(path) || path;
  return `${getApiBase()}${path}`;
}

/**
 * src (and crossOrigin) for an <img> of a possibly server-side path. The app build loads server images in CORS mode:
 * /uploads answers with Cross-Origin-Resource-Policy same-origin, which only a CORS request from an app origin passes.
 */
export function assetImgProps(path) {
  const src = assetUrl(path);
  return isAppMode() && !storedModeIsLocal() && isServerPath(path) ? { src, crossOrigin: 'anonymous' } : { src };
}

/** JSON body of a response, or null for a missing, non-JSON (captive portal, proxy page) or unreadable one. */
export async function readJson(res) {
  if (!res) return null;
  const type = res.headers?.get?.('content-type') || '';
  if (!type.includes('application/json')) return null;
  try { return await res.json(); } catch (_) { return null; }
}

function statusMessage(status) {
  if (GATEWAY.has(status)) return t(MESSAGES.gateway);
  return MESSAGES[status] ? t(MESSAGES[status]) : t('Anfrage fehlgeschlagen (HTTP {status})', { status });
}

/**
 * ApiError for a failed response: the server's `error` and `code`, else the fallback with the status
 * ('Fehler beim Speichern (HTTP 502)'), else a German text for the status. Proxies answer with HTML, which is ignored.
 */
export async function errorFromResponse(res, fallback) {
  let data = null;
  try {
    const text = await res.text();
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch (_) { /* not JSON */ }
  const text = serverText(data);
  const message = text || (fallback ? (res.status ? `${fallback} (HTTP ${res.status})` : fallback) : statusMessage(res.status));
  return new ApiError(message, {
    status: res.status,
    code: typeof data?.code === 'string' ? data.code : null,
    ref: typeof data?.ref === 'string' ? data.ref : null,
    data
  });
}

function isSessionWatched(path) {
  if (typeof path !== 'string' || ABSOLUTE_URL.test(path)) return false;
  const pathname = path.split(/[?#]/)[0];
  if (!pathname.startsWith('/api/')) return false;
  return !SESSION_EXEMPT.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function notifySessionExpired(url) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { url, status: 401 } }));
}

const announced = new WeakSet();

/** True when the client already reported this 401 as an ended session (App shows the login); false for other 401s. */
export const sessionEndAnnounced = (res) => Boolean(res) && typeof res === 'object' && announced.has(res);

async function reportUnauthorized(path, res) {
  if (!isSessionWatched(path)) return;
  const body = await readJson(typeof res.clone === 'function' ? res.clone() : res);
  if (!SESSION_END_CODES.has(body?.code)) return;
  announced.add(res);
  notifySessionExpired(path);
}

const isRawBody = (body) => typeof body === 'string'
  || (typeof FormData !== 'undefined' && body instanceof FormData)
  || (typeof Blob !== 'undefined' && body instanceof Blob)
  || (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
  || body instanceof ArrayBuffer;

function defaultTimeout(method, body) {
  if (typeof FormData !== 'undefined' && body instanceof FormData) return uploadTimeout(formDataBytes(body));
  return method === 'GET' || method === 'HEAD' ? TIMEOUTS.read : TIMEOUTS.write;
}

/** Caller signal plus timeout; Safari 14 has neither AbortSignal.timeout nor AbortSignal.any. */
function linkSignal(signal, timeout) {
  if (typeof AbortController === 'undefined') return { signal, timedOut: () => false, clear() {} };
  const controller = new AbortController();
  let timedOut = false;
  const timer = timeout > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeout) : null;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const stopTimer = () => clearTimeout(timer);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    stopTimer,
    clear: () => {
      stopTimer();
      signal?.removeEventListener?.('abort', onAbort);
    }
  };
}

const originOf = (url, base) => {
  try { return new URL(url, base).origin; } catch (_) { return null; }
};

/**
 * The bearer token only goes to the origin of the active server, never to another host or its http:// variant, and only
 * when the user signed in at that origin (connection.getToken).
 */
function tokenFor(url) {
  const token = getToken();
  const base = getActiveBase();
  if (!token || !base) return '';
  const target = originOf(url, base);
  return target && target === originOf(base) ? token : '';
}

function failure(error, link, signal) {
  if (link.timedOut()) return new ApiError(t(MESSAGES.timeout), { code: 'TIMEOUT', cause: error });
  if (signal?.aborted || isAbortError(error)) return error;
  return new ApiError(t(MESSAGES.network), { code: 'NETWORK', cause: error });
}

const NO_LINK = { timedOut: () => false, stopTimer() {}, clear() {} };

async function send(path, { body, headers, timeout, signal, ...init } = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  if (isLocalMode() && isServerPath(path)) {
    try {
      return { res: await localTransport(method, path, body, { signal }), link: NO_LINK };
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw e;
      throw new ApiError(e?.message || t(MESSAGES.network), { code: 'LOCAL', cause: e });
    }
  }
  const jsonBody = body !== undefined && body !== null && !isRawBody(body);
  const merged = { ...(jsonBody ? { 'Content-Type': 'application/json' } : {}), ...headers };
  const app = isAppMode();
  const url = apiUrl(path);
  if (app) {
    const token = tokenFor(url);
    merged['X-Client'] = 'app';
    // an explicit Authorization (the pending logout of another session) is kept as given
    if (token && !merged.Authorization) merged.Authorization = `Bearer ${token}`;
  }
  const options = { ...init };
  if (Object.keys(merged).length) options.headers = merged;
  if (body !== undefined && body !== null) options.body = jsonBody ? JSON.stringify(body) : body;
  if (app) options.credentials = 'omit';

  const link = linkSignal(signal, timeout ?? defaultTimeout(method, body));
  options.signal = link.signal;
  let res;
  try {
    res = await globalThis.fetch(url, options);
  } catch (e) {
    link.clear();
    throw failure(e, link, signal);
  }
  if (res.status === 401) await reportUnauthorized(path, res);
  return { res, link };
}

// fetch through the client (base, bearer token, timeout, session-expiry check); plain-object bodies go as JSON.
// Resolves to the Response for any HTTP status; rejects with ApiError NETWORK/TIMEOUT or the caller's AbortError.
// The timeout ends with the headers; the caller's signal also aborts the body read.
export async function apiFetch(path, options) {
  const { res, link } = await send(path, options);
  link.stopTimer();
  return res;
}

/**
 * Request that resolves to the parsed JSON (null for an empty answer) and rejects with ApiError for every failure.
 * options: { signal, timeout, headers, fallback } — `fallback` is the error text when the server sends none.
 */
export async function request(method, path, body, { fallback, ...options } = {}) {
  const { res, link } = await send(path, { ...options, method, body });
  try {
    if (!res.ok) throw await errorFromResponse(res, fallback);
    if (res.status === 204 || res.status === 205) return null;
    const type = res.headers?.get?.('content-type') || '';
    if (type.includes('application/json')) {
      try {
        return await res.json();
      } catch (e) {
        if (link.timedOut() || options.signal?.aborted) throw failure(e, link, options.signal);
        throw new ApiError(t(MESSAGES.notJson), { status: res.status, code: 'NOT_JSON' });
      }
    }
    const text = await res.text().catch(() => '');
    if (!text.trim()) return null;
    throw new ApiError(t(MESSAGES.notJson), { status: res.status, code: 'NOT_JSON' });
  } catch (e) {
    if (e instanceof ApiError || isAbortError(e)) throw e;
    throw failure(e, link, options.signal);
  } finally {
    link.clear();
  }
}

/** File name of a Content-Disposition header (filename* first), else the fallback. */
export function downloadName(res, fallback = 'download') {
  const header = res?.headers?.get?.('content-disposition') || '';
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch (_) { /* malformed: try the plain name */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : fallback;
}

function saveBlob(blob, name, doc) {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Downloads a server file. Browser build: a plain link (cookie auth), resolves to null. App build: a link has no
// bearer token, so it is fetched into a blob; onProgress(loaded, total), total 0 when unknown.
// Resolves to { filename, bytes }; rejects with ApiError or the AbortError of `signal`.
export async function downloadFile(path, { filename, onProgress, signal, doc = globalThis.document } = {}) {
  if (!isAppMode()) {
    const link = doc.createElement('a');
    link.href = apiUrl(path);
    if (filename) link.download = filename;
    doc.body.appendChild(link);
    link.click();
    link.remove();
    return null;
  }
  const res = await apiFetch(path, { signal, timeout: TIMEOUTS.long });
  if (!res.ok) throw await errorFromResponse(res, t('Download fehlgeschlagen'));
  const total = Number(res.headers?.get?.('content-length')) || 0;
  const type = res.headers?.get?.('content-type') || 'application/octet-stream';
  let blob;
  try {
    if (onProgress && typeof res.body?.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      onProgress(0, total);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress(loaded, total);
      }
      blob = new Blob(chunks, { type });
    } else {
      blob = await res.blob();
    }
  } catch (e) {
    if (signal?.aborted || isAbortError(e)) throw e;
    throw new ApiError(t(MESSAGES.network), { code: 'NETWORK', cause: e });
  }
  const name = downloadName(res, filename || 'download');
  saveBlob(blob, name, doc);
  return { filename: name, bytes: blob.size };
}

export const get = (path, options) => request('GET', path, undefined, options);
export const post = (path, body, options) => request('POST', path, body, options);
export const put = (path, body, options) => request('PUT', path, body, options);
export const del = (path, options) => request('DELETE', path, undefined, options);
export const upload = (path, formData, options) => request('POST', path, formData, options);

const api = { get, post, put, del, upload, request, fetch: apiFetch };
export default api;
