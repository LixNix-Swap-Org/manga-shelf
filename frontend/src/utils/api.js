import { getActiveBase, setActiveBase, getToken, setToken } from '../app/connection.js';

/** Dispatched on window when the server says the session is gone; App clears the offline copy and logs out. */
export const SESSION_EXPIRED_EVENT = 'mangashelf:session-expired';

/**
 * Client timeouts in ms; 0 means none (the server's own limits apply).
 * auth: startup and logout checks. read: plain GETs (default). write: plain writes (default).
 * lookup / remote: requests the server answers from Manga Passion, ISBN sources or a remote download (its worst case
 * chains several 6-20 s upstream calls). long: jobs that run on the server (autofill, batch and gap import, gap check,
 * CSV import, snapshots). upload: FormData bodies (default) and restores, whose transfer time grows with the size.
 */
export const TIMEOUTS = {
  auth: 4000,
  write: 8000,
  read: 15000,
  lookup: 90000,
  remote: 90000,
  long: 600000,
  upload: 0
};

// 401s from these endpoints do not mean "the session ended": wrong credentials, the logout itself, the startup
// check (App handles /auth/me itself), the password change and the setup routes.
const SESSION_EXEMPT = ['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/password', '/api/setup'];
const SESSION_END_CODES = new Set(['AUTH_REQUIRED', 'SESSION_INVALID']);
const GATEWAY = new Set([502, 503, 504]);
const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:|^\/\//i;

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

/** '' in the browser build (same origin); the active server in the app build. */
export function getApiBase() {
  return isAppMode() ? getActiveBase() : '';
}

/** Switches the server (a different origin drops the token); the token is only kept in the app build. */
export function setServer({ base, token } = {}) {
  if (base !== undefined) setActiveBase(base);
  if (token === null || token === '') setToken(null);
  else if (token !== undefined && isAppMode()) setToken(token);
}

/** Keeps the session token of a login / password change answer (app build only; the browser build uses the cookie). */
export function rememberToken(data) {
  if (isAppMode() && typeof data?.token === 'string' && data.token) setToken(data.token);
}

export function apiUrl(path) {
  if (typeof path !== 'string' || ABSOLUTE_URL.test(path)) return path;
  return `${getApiBase()}${path}`;
}

const isServerPath = (path) => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');

/** Server paths (/uploads/...) for <img src> and links; absolute, data: and blob: URLs stay as they are. */
export function assetUrl(path) {
  if (!isAppMode() || !isServerPath(path)) return path;
  return `${getApiBase()}${path}`;
}

/**
 * src (and crossOrigin) for an <img> of a possibly server-side path. The app build loads server images in CORS mode:
 * /uploads answers with Cross-Origin-Resource-Policy same-origin, which only a CORS request from an app origin passes.
 */
export function assetImgProps(path) {
  const src = assetUrl(path);
  return isAppMode() && isServerPath(path) ? { src, crossOrigin: 'anonymous' } : { src };
}

/** JSON body of a response, or null for a missing, non-JSON (captive portal, proxy page) or unreadable one. */
export async function readJson(res) {
  if (!res) return null;
  const type = res.headers?.get?.('content-type') || '';
  if (!type.includes('application/json')) return null;
  try { return await res.json(); } catch (_) { return null; }
}

function statusMessage(status) {
  if (GATEWAY.has(status)) return MESSAGES.gateway;
  return MESSAGES[status] || `Anfrage fehlgeschlagen (HTTP ${status})`;
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
  const serverText = typeof data?.error === 'string' && data.error.trim() ? data.error : '';
  const message = serverText || (fallback ? (res.status ? `${fallback} (HTTP ${res.status})` : fallback) : statusMessage(res.status));
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
  if (typeof FormData !== 'undefined' && body instanceof FormData) return TIMEOUTS.upload;
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
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  };
}

function failure(error, link, signal) {
  if (link.timedOut()) return new ApiError(MESSAGES.timeout, { code: 'TIMEOUT', cause: error });
  if (signal?.aborted || isAbortError(error)) return error;
  return new ApiError(MESSAGES.network, { code: 'NETWORK', cause: error });
}

async function send(path, { body, headers, timeout, signal, ...init } = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const jsonBody = body !== undefined && body !== null && !isRawBody(body);
  const merged = { ...(jsonBody ? { 'Content-Type': 'application/json' } : {}), ...headers };
  const app = isAppMode();
  if (app) {
    const token = getToken();
    merged['X-Client'] = 'app';
    if (token) merged.Authorization = `Bearer ${token}`;
  }
  const options = { ...init };
  if (Object.keys(merged).length) options.headers = merged;
  if (body !== undefined && body !== null) options.body = jsonBody ? JSON.stringify(body) : body;
  if (app) options.credentials = 'omit';

  const link = linkSignal(signal, timeout ?? defaultTimeout(method, body));
  options.signal = link.signal;
  let res;
  try {
    res = await globalThis.fetch(apiUrl(path), options);
  } catch (e) {
    link.clear();
    throw failure(e, link, signal);
  }
  if (res.status === 401) await reportUnauthorized(path, res);
  return { res, link };
}

/**
 * fetch through the client (server base, bearer token in the app build, timeout, session-expiry check). Resolves to the
 * Response for every HTTP status; rejects with ApiError NETWORK/TIMEOUT, or the AbortError of the caller's signal.
 * Plain objects as `body` are sent as JSON. Timeout and caller signal cover the request until the headers arrive.
 */
export async function apiFetch(path, options) {
  const { res, link } = await send(path, options);
  link.clear();
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
        throw new ApiError(MESSAGES.notJson, { status: res.status, code: 'NOT_JSON' });
      }
    }
    const text = await res.text().catch(() => '');
    if (!text.trim()) return null;
    throw new ApiError(MESSAGES.notJson, { status: res.status, code: 'NOT_JSON' });
  } catch (e) {
    if (e instanceof ApiError || isAbortError(e)) throw e;
    throw failure(e, link, options.signal);
  } finally {
    link.clear();
  }
}

export const get = (path, options) => request('GET', path, undefined, options);
export const post = (path, body, options) => request('POST', path, body, options);
export const put = (path, body, options) => request('PUT', path, body, options);
export const del = (path, options) => request('DELETE', path, undefined, options);
export const upload = (path, formData, options) => request('POST', path, formData, options);

const api = { get, post, put, del, upload, request, fetch: apiFetch };
export default api;
