// Saved servers of the app build: { id, name, urls[], token?, tokenOrigins?, instanceId?, lastOkUrl?, lastOkAt? } plus
// the active id and the logouts that have not reached their server yet ({ serverId, token, urls, instanceId? }).
// Reads are synchronous from memory; writes go to a storage adapter (localStorage here, secure storage in the shells).

export const SERVERS_KEY = 'mangashelf_servers';
export const ACTIVE_KEY = 'mangashelf_active_server';
export const PENDING_LOGOUTS_KEY = 'mangashelf_pending_logouts';
// single-server format of the first app builds: migrated once
export const LEGACY_BASE_KEY = 'mangashelf_server_base';
export const LEGACY_TOKEN_KEY = 'mangashelf_server_token';

/** http(s) origin plus path without trailing slash ('https://host/manga'), or '' for anything else. */
export function normalizeBase(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  let parsed;
  try { parsed = new URL(url.trim()); } catch (_) { return ''; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export const originOf = (url) => {
  try { return new URL(url).origin; } catch (_) { return ''; }
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// home-network names: mDNS, the Fritz!Box, common router defaults and RFC 8375 / ICANN's private-use .internal
const HOME_SUFFIXES = ['.local', '.localhost', '.fritz.box', '.lan', '.home.arpa', '.internal'];

function localHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || HOME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host === '::1') return true;
  // IPv6 link-local fe80::/10 and unique local fc00::/7
  if (/^fe[89ab][0-9a-f]?:/.test(host) || /^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
  const m = IPV4.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

/**
 * https, or plain http to a home-network host (loopback, RFC 1918, CGNAT 100.64/10 as used by Tailscale, link-local,
 * IPv6 ULA, .local/.fritz.box/.lan/.home.arpa/.internal): the only addresses a token goes to.
 */
export function isSecureEnough(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return false; }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && localHost(parsed.hostname);
}

export const INSECURE_URL_TEXT = 'Unverschlüsselte Adressen (http://) sind nur im Heimnetz erlaubt (z. B. 192.168.x.x, 10.x.x.x, name.local oder fritz.box) – bitte https:// verwenden';

/** Adapter over localStorage; getSync lets the store hydrate without waiting. */
export function localStorageAdapter(getStorage = () => globalThis.localStorage) {
  const storage = () => {
    try { return getStorage() ?? null; } catch (_) { return null; }
  };
  const getSync = (key) => {
    try { return storage()?.getItem(key) ?? null; } catch (_) { return null; }
  };
  return {
    getSync,
    get: async (key) => getSync(key),
    set: async (key, value) => { try { storage()?.setItem(key, value); } catch (_) { /* storage unavailable */ } },
    remove: async (key) => { try { storage()?.removeItem(key); } catch (_) { /* storage unavailable */ } }
  };
}

let adapter = localStorageAdapter();
let state = null;
const listeners = new Set();

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

function newId() {
  const random = globalThis.crypto?.randomUUID?.();
  return random || `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function hostLabel(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

export function normalizeUrls(urls) {
  const list = Array.isArray(urls) ? urls : String(urls ?? '').split(/[\s,]+/);
  return [...new Set(list.map(normalizeBase).filter(Boolean))];
}

function normalizeServer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const urls = normalizeUrls(raw.urls);
  if (!urls.length) return null;
  const entry = { id: text(raw.id) || newId(), name: text(raw.name) || hostLabel(urls[0]), urls };
  if (text(raw.instanceId)) entry.instanceId = raw.instanceId.trim();
  const lastOk = normalizeBase(raw.lastOkUrl);
  if (lastOk && urls.includes(lastOk)) entry.lastOkUrl = lastOk;
  if (Number.isFinite(raw.lastOkAt)) entry.lastOkAt = raw.lastOkAt;
  // the origins where the user signed in, only together with the token; an entry from before this field trusts the
  // address it used last
  if (!text(raw.token)) return entry;
  const own = new Set(urls.map(originOf));
  const origins = Array.isArray(raw.tokenOrigins) ? raw.tokenOrigins : [originOf(entry.lastOkUrl || urls[0])];
  const kept = [...new Set(origins.filter((o) => typeof o === 'string' && own.has(o)))];
  if (kept.length) {
    entry.tokenOrigins = kept;
    entry.token = raw.token;
  }
  return entry;
}

function normalizePending(raw) {
  if (!raw || typeof raw !== 'object' || !text(raw.serverId) || !text(raw.token)) return null;
  const urls = normalizeUrls(raw.urls);
  if (!urls.length) return null;
  return { serverId: raw.serverId, token: raw.token, urls, ...(text(raw.instanceId) ? { instanceId: raw.instanceId.trim() } : {}) };
}

function parseList(raw, normalize) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.map(normalize).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function parse(rawServers, rawActive, rawPending) {
  const servers = parseList(rawServers, normalizeServer);
  const activeId = servers.some((s) => s.id === rawActive) ? rawActive : null;
  return { servers, activeId, pendingLogouts: parseList(rawPending, normalizePending) };
}

function legacyServer(rawBase, rawToken) {
  const base = normalizeBase(rawBase);
  if (!base) return null;
  let token = '';
  try {
    const entry = JSON.parse(rawToken || 'null');
    if (entry && typeof entry.token === 'string' && entry.origin === originOf(base)) token = entry.token;
  } catch (_) { /* old plain format: never sent */ }
  return normalizeServer({ name: hostLabel(base), urls: [base], token, tokenOrigins: [originOf(base)] });
}

async function persist() {
  const snapshot = state;
  try {
    await adapter.set(SERVERS_KEY, JSON.stringify(snapshot.servers));
    if (snapshot.activeId) await adapter.set(ACTIVE_KEY, snapshot.activeId);
    else await adapter.remove(ACTIVE_KEY);
    if (snapshot.pendingLogouts.length) await adapter.set(PENDING_LOGOUTS_KEY, JSON.stringify(snapshot.pendingLogouts));
    else await adapter.remove(PENDING_LOGOUTS_KEY);
  } catch (err) {
    console.warn('[Server] Serverliste nicht gespeichert:', err?.message || err);
  }
}

function commit(next) {
  state = next;
  persist();
  for (const listener of [...listeners]) listener(state);
}

function hydrate(rawServers, rawActive, rawBase, rawToken, rawPending) {
  const parsed = parse(rawServers, rawActive, rawPending);
  if (!parsed.servers.length && rawBase) {
    const migrated = legacyServer(rawBase, rawToken);
    if (migrated) {
      state = { servers: [migrated], activeId: migrated.id, pendingLogouts: parsed.pendingLogouts };
      persist();
      adapter.remove(LEGACY_BASE_KEY);
      adapter.remove(LEGACY_TOKEN_KEY);
      return state;
    }
  }
  state = parsed;
  return state;
}

function current() {
  if (state) return state;
  if (typeof adapter.getSync === 'function') {
    return hydrate(adapter.getSync(SERVERS_KEY), adapter.getSync(ACTIVE_KEY),
      adapter.getSync(LEGACY_BASE_KEY), adapter.getSync(LEGACY_TOKEN_KEY), adapter.getSync(PENDING_LOGOUTS_KEY));
  }
  return { servers: [], activeId: null, pendingLogouts: [] };
}

/** Reads the list through the adapter (the shells' secure storage is async). */
export async function loadServers() {
  if (state) return state;
  const [rawServers, rawActive, rawBase, rawToken, rawPending] = await Promise.all(
    [SERVERS_KEY, ACTIVE_KEY, LEGACY_BASE_KEY, LEGACY_TOKEN_KEY, PENDING_LOGOUTS_KEY].map((key) => adapter.get(key).catch(() => null))
  );
  if (state) return state;
  hydrate(rawServers, rawActive, rawBase, rawToken, rawPending);
  for (const listener of [...listeners]) listener(state);
  return state;
}

/** Swaps the storage (Capacitor Preferences, Electron safeStorage): { get, set, remove } with string values, async. */
export function setStorageAdapter(next) {
  adapter = next || localStorageAdapter();
  state = null;
}

export const getServers = () => current().servers;
export const getServer = (id) => current().servers.find((s) => s.id === id) ?? null;
export const getActiveServerId = () => current().activeId;
export const getActiveServer = () => getServer(current().activeId);
export const findServerByUrl = (url) => {
  const base = normalizeBase(url);
  return base ? current().servers.find((s) => s.urls.includes(base)) ?? null : null;
};
export const findServerByInstance = (instanceId) => (instanceId
  ? current().servers.find((s) => s.instanceId === instanceId) ?? null
  : null);

/**
 * Adds or updates a server. Unknown fields of an existing entry (token, instanceId) stay unless given. The token only
 * stays valid for the origins where the user signed in (tokenOrigins) that are still among the addresses.
 */
export function saveServer(input, { replace = false } = {}) {
  const { servers, activeId, pendingLogouts } = current();
  const existing = input?.id ? servers.find((s) => s.id === input.id) : null;
  const merged = normalizeServer(replace ? input : { ...existing, ...input });
  if (!merged) throw new TypeError('Mindestens eine gültige Adresse (http:// oder https://) angeben.');
  const next = existing ? servers.map((s) => (s.id === existing.id ? merged : s)) : [...servers, merged];
  commit({ servers: next, activeId, pendingLogouts });
  return merged;
}

export function updateServer(id, patch) {
  const server = getServer(id);
  if (!server) return null;
  const next = { ...server, ...patch };
  for (const [key, value] of Object.entries(patch)) if (value === undefined || value === null || value === '') delete next[key];
  return saveServer(next, { replace: true });
}

/** Removes a server together with its outstanding logouts (ServerScreen tries to send them first). */
export function removeServer(id) {
  const { servers, activeId, pendingLogouts } = current();
  if (!servers.some((s) => s.id === id)) return false;
  commit({
    servers: servers.filter((s) => s.id !== id),
    activeId: activeId === id ? null : activeId,
    pendingLogouts: pendingLogouts.filter((p) => p.serverId !== id)
  });
  return true;
}

export function setActiveServerId(id) {
  const { servers, activeId, pendingLogouts } = current();
  const nextId = id && servers.some((s) => s.id === id) ? id : null;
  if (nextId === activeId) return getActiveServer();
  commit({ servers, activeId: nextId, pendingLogouts });
  return getActiveServer();
}

export const getPendingLogouts = (serverId) => current().pendingLogouts.filter((p) => p.serverId === serverId);
export const getAllPendingLogouts = () => current().pendingLogouts;

/**
 * Logout of a server: its token leaves the entry at once and waits in a pending record until the logout reached one of
 * the addresses where it was valid. Returns the record, or null for a server without a token.
 */
export function beginLogout(serverId) {
  const { servers, activeId, pendingLogouts } = current();
  const server = servers.find((s) => s.id === serverId);
  if (!server?.token) return null;
  const trusted = new Set(server.tokenOrigins || []);
  const urls = server.urls.filter((u) => trusted.has(originOf(u)) && isSecureEnough(u));
  const record = normalizePending({ serverId, token: server.token, urls, instanceId: server.instanceId });
  const { token: _token, tokenOrigins: _origins, ...rest } = server;
  commit({
    servers: servers.map((s) => (s.id === serverId ? rest : s)),
    activeId,
    pendingLogouts: record ? [...pendingLogouts.filter((p) => p.token !== record.token), record] : pendingLogouts
  });
  return record;
}

/** The logout of this record reached its server (or is given up). */
export function settlePendingLogout(record) {
  const { servers, activeId, pendingLogouts } = current();
  const next = pendingLogouts.filter((p) => !(p.serverId === record.serverId && p.token === record.token));
  if (next.length !== pendingLogouts.length) commit({ servers, activeId, pendingLogouts: next });
}

export function discardPendingLogouts(serverId) {
  for (const record of getPendingLogouts(serverId)) settlePendingLogout(record);
}

/** Forgets every server (also used by tests). */
export function resetServers() {
  commit({ servers: [], activeId: null, pendingLogouts: [] });
}

export function subscribeServers(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
