// Connection manager of the app build (VITE_APP_MODE=app): which saved server is active, which of its addresses
// answers, and the session token of that server. In the browser build it is inert (same origin, cookie session).
import {
  normalizeBase, originOf, hostLabel, getActiveServer, getActiveServerId, setActiveServerId, findServerByUrl, saveServer,
  updateServer, loadServers, subscribeServers, isSecureEnough
} from './serverStore.js';
import { storedModeIsLocal, subscribeMode, getLocalProfile } from '../local/profile.js';

export { normalizeBase };

export const PROBE_TIMEOUT_MS = 3000;
export const RECHECK_INTERVAL_MS = 30000;
export const HEALTHY = new Set(['ok', 'degraded']);

const appBuild = () => Boolean(import.meta.env) && import.meta.env.VITE_APP_MODE === 'app';

const WEB_STATE = Object.freeze({ state: 'online', baseUrl: '', server: null, lastError: null, checkedAt: null });
export const LOCAL_SERVER_NAME = 'Auf diesem Gerät';
const localMode = () => appBuild() && storedModeIsLocal();
// the standalone mode has no server: always "online", the pill names the device (and the profile)
const localState = () => {
  const profile = getLocalProfile();
  return { state: 'online', baseUrl: '', server: { id: 'local', name: profile?.name ? `${LOCAL_SERVER_NAME} · ${profile.name}` : LOCAL_SERVER_NAME, urls: [], local: true }, lastError: null, checkedAt: null };
};
let localSnapshot = null;

// the address of the active server that answered last in this session (else its lastOkUrl or its first address)
let session = { serverId: null, baseUrl: '' };
let conn = { state: 'connecting', baseUrl: '', server: null, lastError: null, checkedAt: null };
const listeners = new Set();

function emit() {
  for (const listener of [...listeners]) listener();
}

function setConn(patch) {
  conn = { ...conn, ...patch, server: getActiveServer(), baseUrl: getActiveBase() };
  emit();
}

subscribeServers(() => {
  conn = { ...conn, server: getActiveServer(), baseUrl: getActiveBase() };
  emit();
});

subscribeMode(() => {
  localSnapshot = null;
  emit();
});

export function getActiveBase() {
  const server = getActiveServer();
  if (!server) return '';
  if (session.serverId === server.id && server.urls.includes(session.baseUrl)) return session.baseUrl;
  return server.lastOkUrl && server.urls.includes(server.lastOkUrl) ? server.lastOkUrl : server.urls[0];
}

/**
 * Makes this address the active one. An address of another saved server activates that server; an unknown address
 * becomes a new server entry (without a token: a base switch never carries a token to another server). '' clears it.
 * An invalid address throws. Returns the stored value.
 */
export function setActiveBase(url) {
  const base = normalizeBase(url);
  if (!base && typeof url === 'string' && url.trim()) throw new TypeError(`Ungültige Serveradresse: ${url}`);
  if (!base) {
    setActiveServerId(null);
    session = { serverId: null, baseUrl: '' };
    setConn({});
    return '';
  }
  let server = getActiveServer();
  if (!server || !server.urls.includes(base)) {
    server = findServerByUrl(base) ?? saveServer({ name: hostLabel(base), urls: [base] });
    setActiveServerId(server.id);
  }
  session = { serverId: server.id, baseUrl: base };
  setConn({});
  return base;
}

/** True when the token of `server` may go to `base`: an origin where the user signed in, https or a local address. */
export function tokenAllowedAt(server, base) {
  if (!server?.token || !base) return false;
  return (server.tokenOrigins || []).includes(originOf(base)) && isSecureEnough(base);
}

/** The server has a session, but not for the address in use: a new sign-in there is needed first. */
export const needsLoginAtAddress = (server = getActiveServer(), base = getActiveBase()) => Boolean(server?.token && base)
  && !tokenAllowedAt(server, base);

/** The session token of the active server; '' without one or when the address in use is not one it was issued for. */
export function getToken() {
  const server = getActiveServer();
  return tokenAllowedAt(server, getActiveBase()) ? server.token : '';
}

/**
 * Stores the token of a sign-in at the active address (that origin is trusted with it from now on); null or '' removes
 * it (the server entry stays).
 */
export function setToken(token) {
  const server = getActiveServer();
  if (!server) return;
  if (typeof token !== 'string' || !token) {
    updateServer(server.id, { token: undefined });
  } else {
    // a new session is trusted only where it was signed in, not at the addresses of an earlier one
    const origin = originOf(getActiveBase());
    updateServer(server.id, { token, tokenOrigins: origin ? [origin] : [] });
  }
  setConn({});
}

/** A 401 for the address in use: forgets the token only when it was sent there (another address keeps its session). */
export function dropRejectedToken() {
  if (getToken()) setToken(null);
}

/** Switches to a saved server; its last good address is used until the next check. */
export function activateServer(id) {
  const server = setActiveServerId(id);
  session = { serverId: server?.id ?? null, baseUrl: '' };
  setConn({ state: server ? 'connecting' : 'offline', lastError: null });
  return server;
}

/**
 * GET <url>/api/health without credentials. Resolves to { ok: true, url, instanceId, version } or
 * { ok: false, url, error } with error 'unreachable' | 'timeout' | 'not-manga-shelf' | 'other-instance' | 'unhealthy'.
 */
export async function probeUrl(url, { instanceId = null, fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const base = normalizeBase(url);
  if (!base) return { ok: false, url, error: 'invalid' };
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timedOut = false;
  const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  try {
    const res = await fetchImpl(`${base}/api/health`, {
      credentials: 'omit', cache: 'no-store', ...(controller ? { signal: controller.signal } : {})
    });
    let body = null;
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    const name = body && typeof body === 'object' ? body.name : undefined;
    if (!body || typeof body !== 'object' || typeof body.status !== 'string' || (name && name !== 'Manga Shelf') || (instanceId && !name)) {
      return { ok: false, url: base, error: 'not-manga-shelf' };
    }
    // a known server has to name itself: a responder that leaves the instance id out is not it
    if (instanceId && body.instance_id !== instanceId) {
      return { ok: false, url: base, error: 'other-instance', instanceId: body.instance_id ?? null };
    }
    if (!HEALTHY.has(body.status)) return { ok: false, url: base, error: 'unhealthy', status: body.status };
    return { ok: true, url: base, instanceId: body.instance_id || null, version: body.version || null, status: body.status };
  } catch (_) {
    return { ok: false, url: base, error: timedOut ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Probes the addresses in order and resolves to the first healthy one, else { ok: false, results }. */
export async function probeServer(server, options = {}) {
  const results = [];
  for (const url of server?.urls || []) {
    const result = await probeUrl(url, { instanceId: server.instanceId || null, ...options });
    if (result.ok) return { ...result, results: [...results, result] };
    results.push(result);
  }
  return { ok: false, url: null, error: results.at(-1)?.error || 'unreachable', results };
}

export const PROBE_ERRORS = {
  invalid: 'Ungültige Adresse',
  unreachable: 'nicht erreichbar',
  timeout: 'keine Antwort (3 s)',
  'not-manga-shelf': 'kein Manga-Shelf-Server',
  'other-instance': 'gehört zu einem anderen Manga-Shelf-Server',
  unhealthy: 'Server meldet einen Fehler'
};

let inFlight = null;

/** Re-probes the active server; concurrent calls share one run. Resolves to the connection state. */
export function checkConnection({ fetchImpl } = {}) {
  if (!appBuild()) return Promise.resolve(WEB_STATE);
  if (localMode()) return Promise.resolve(getConnection());
  if (inFlight) return inFlight;
  inFlight = (async () => {
    await loadServers();
    const server = getActiveServer();
    if (!server) {
      setConn({ state: 'offline', lastError: 'Kein Server ausgewählt', checkedAt: Date.now() });
      return conn;
    }
    setConn({ state: 'connecting' });
    const result = await probeServer(server, fetchImpl ? { fetchImpl } : {});
    if (getActiveServerId() !== server.id) return conn;
    if (result.ok) {
      session = { serverId: server.id, baseUrl: result.url };
      updateServer(server.id, { lastOkUrl: result.url, lastOkAt: Date.now(), ...(result.instanceId ? { instanceId: result.instanceId } : {}) });
      setConn({ state: 'online', lastError: null, checkedAt: Date.now() });
    } else {
      setConn({ state: 'offline', lastError: PROBE_ERRORS[result.error] || PROBE_ERRORS.unreachable, checkedAt: Date.now() });
    }
    return conn;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

export function getConnection() {
  if (!appBuild()) return WEB_STATE;
  if (localMode()) {
    localSnapshot ??= localState();
    return localSnapshot;
  }
  return conn;
}

export function subscribeConnection(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Re-probes on start, on `online`, when the page becomes visible (at most every 30 s) and marks the connection offline
 * on `offline`. Inert in the browser build. Returns a stop function.
 */
export function startConnectionManager({ win = globalThis.window, doc = globalThis.document, now = () => Date.now() } = {}) {
  if (!appBuild() || !win) return () => {};
  let lastCheck = 0;
  const check = () => { lastCheck = now(); return checkConnection(); };
  const onOnline = () => { check(); };
  const onOffline = () => { if (!localMode()) setConn({ state: 'offline', lastError: 'Keine Netzwerkverbindung', checkedAt: now() }); };
  const onVisible = () => {
    if (doc?.visibilityState !== 'visible' || now() - lastCheck < RECHECK_INTERVAL_MS) return;
    check();
  };
  win.addEventListener('online', onOnline);
  win.addEventListener('offline', onOffline);
  doc?.addEventListener('visibilitychange', onVisible);
  return () => {
    win.removeEventListener('online', onOnline);
    win.removeEventListener('offline', onOffline);
    doc?.removeEventListener('visibilitychange', onVisible);
  };
}

/** Test helper: forget the address chosen in this session. */
export function resetConnection() {
  session = { serverId: null, baseUrl: '' };
  inFlight = null;
  conn = { state: 'connecting', baseUrl: '', server: null, lastError: null, checkedAt: null };
  emit();
}
