// Outbox: read / owned / status toggles and purchases, applied optimistically and sent now or kept (IndexedDB, per
// user and server) and replayed later. Only idempotent set operations, coalesced per (kind, volume, target user), so a
// replay never toggles twice. 401 keeps an entry, other 4xx drop it with a toast, 5xx / network retry with backoff.
// The serverless device core answers finally at once: its entries are never kept.
import { apiFetch, isAppMode, isLocalMode, readJson, TIMEOUTS } from './api.js';
import { getActiveServerId } from '../app/serverStore.js';
import { getLocalProfile } from '../local/profile.js';
import {
  loadOutboxEntries, putOutboxEntries, deleteOutboxEntries, updateOutboxEntriesById, deleteOutboxEntriesById, patchCachedManga
} from './offlineStore.js';
import { readCache, writeCache, detailKey, LIST_KEY, cacheOwner } from './dataCache.js';
import { applyVolumeChange, applyDetailToList } from './volumePatch.js';
import { readQueue, queueKey } from './shoppingQueue.js';
import { notify } from './notify.js';
import { formatCount } from './format.js';

export const OUTBOX_KINDS = ['read', 'owned', 'status', 'purchase'];
export const OUTBOX_SYNCED_EVENT = 'mangashelf:outbox-synced';
export const WEB_SERVER_ID = 'web';
export const LOCAL_SERVER_ID = 'local';
export const FALLBACK_KEY = 'mangashelf_outbox';
export const OUTBOX_LOCK = 'mangashelf-outbox';
const MAX_RETRY_MS = 5 * 60 * 1000;
const FIRST_RETRY_MS = 5000;

const DATE = /^\d{4}-\d{2}(-\d{2})?$/;
const READ_AT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const hasValue = (v) => v !== null && v !== undefined && v !== '';
const group = (kind) => (kind === 'purchase' ? 'owned' : kind);

/** The scope of a local profile: 'local:<profile id>' (profiles switch, their entries never mix). */
export const localServerId = (profileId = getLocalProfile()?.id) => `${LOCAL_SERVER_ID}:${profileId ?? ''}`;

export const isLocalServerId = (serverId) => String(serverId).startsWith(`${LOCAL_SERVER_ID}:`);

/**
 * The server the entries of this session belong to: the active server in the app build, the local profile in its
 * mode without a server (never mixed with the server that was active before), 'web' in the browser.
 */
export const currentServerId = () => {
  if (isLocalMode()) return localServerId();
  return isAppMode() ? getActiveServerId() : WEB_SERVER_ID;
};

/** Where the entries of a removed server wait until a server with the same instance id is added again. */
export const retiredServerId = (instanceId) => `removed:${instanceId}`;

/** A volume the user bought (shopping list quick buy or own ownership) that the server has not confirmed yet. */
export const isPurchaseEntry = (e) => e.kind === 'purchase'
  || (e.kind === 'owned' && e.value === true && String(e.targetUserId) === String(e.userId));

export const outboxKey = (e) => [e.serverId, e.userId, group(e.kind), e.volumeId, e.targetUserId].join('|');

let idCounter = 0;
const newId = (now) => `${now.toString(36)}-${(++idCounter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** A valid entry (with key, id, ts) or null. */
export function normalizeOutboxEntry(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || !OUTBOX_KINDS.includes(raw.kind)) return null;
  const volumeId = Number(raw.volumeId);
  if (!Number.isInteger(volumeId) || volumeId <= 0) return null;
  if (!hasValue(raw.userId) || !hasValue(raw.serverId)) return null;
  let value;
  if (raw.kind === 'status') {
    if (typeof raw.value !== 'string' || !raw.value.trim()) return null;
    value = raw.value.trim();
  } else {
    value = raw.kind === 'purchase' ? true : Boolean(raw.value);
  }
  const entry = {
    kind: raw.kind,
    volumeId,
    userId: raw.userId,
    serverId: String(raw.serverId),
    targetUserId: hasValue(raw.targetUserId) ? raw.targetUserId : raw.userId,
    value,
    ts: Number.isFinite(raw.ts) ? raw.ts : now,
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(now),
    attempts: Number.isInteger(raw.attempts) && raw.attempts > 0 ? raw.attempts : 0,
    deferred: Boolean(raw.deferred)
  };
  if ((entry.kind === 'purchase' || entry.kind === 'owned') && typeof raw.purchase_date === 'string' && DATE.test(raw.purchase_date)) {
    entry.purchase_date = raw.purchase_date;
  }
  if (entry.kind === 'read' && entry.value && typeof raw.read_at === 'string' && READ_AT.test(raw.read_at)) entry.read_at = raw.read_at;
  if (Number.isFinite(raw.nextAt)) entry.nextAt = raw.nextAt;
  if (raw.mangaId !== undefined && raw.mangaId !== null) entry.mangaId = raw.mangaId;
  entry.key = outboxKey(entry);
  return entry;
}

/** The list with `entry` replacing an older entry of the same key (a later toggle wins), in time order. */
export function coalesceEntries(entries, entry) {
  return [...entries.filter((e) => e.key !== entry.key), entry].sort((a, b) => a.ts - b.ts);
}

/** { path, method, body } of the idempotent request for an entry. */
export function outboxRequest(entry) {
  const base = `/api/volumes/${entry.volumeId}`;
  if (entry.kind === 'read') {
    const body = { user_id: entry.targetUserId, read: entry.value, is_read: entry.value };
    if (entry.read_at) body.read_at = entry.read_at;
    return { path: `${base}/read`, method: 'POST', body };
  }
  if (entry.kind === 'status') return { path: base, method: 'PUT', body: { status: entry.value } };
  const body = { owned: entry.value };
  if (entry.value && entry.purchase_date) body.purchase_date = entry.purchase_date;
  if (String(entry.targetUserId) !== String(entry.userId)) body.user_id = entry.targetUserId;
  return { path: `${base}/owners`, method: 'POST', body };
}

/**
 * 'done' (2xx, or 404: the volume is gone), 'auth' (401: kept for the next login), 'retry' (no answer, 408, 429, 5xx)
 * or 'drop'. An entry of the local mode is never retried: the device core's 507/423/409 are final (no replay runs there).
 */
export function classifyOutboxResponse(res, entry = null) {
  if (entry && isLocalServerId(entry.serverId)) return res && (res.ok || res.status === 404) ? 'done' : 'drop';
  if (!res) return 'retry';
  if (res.ok || res.status === 404) return 'done';
  if (res.status === 401) return 'auth';
  if (res.status === 408 || res.status === 429 || res.status >= 500) return 'retry';
  return 'drop';
}

const serverUnusable = (res) => !res || [408, 429, 502, 503, 504].includes(res.status) || (res.status >= 520 && res.status <= 530);

export const retryDelay = (attempts) => Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1));

/** Entries of the old per-user purchase queue (shoppingQueue, localStorage) as outbox purchases. */
export function legacyPurchaseEntries({ userId, serverId }, storage) {
  return readQueue(userId, storage).map((e, i) => normalizeOutboxEntry({
    kind: 'purchase', volumeId: e.volumeId, userId, serverId, targetUserId: userId, value: true,
    ...(e.purchasedAt ? { purchase_date: e.purchasedAt } : {}), ts: i, deferred: true
  })).filter(Boolean);
}

const inScope = (scope) => (e) => String(e.userId) === String(scope.userId) && e.serverId === String(scope.serverId);
const scopeId = (scope) => `${scope.serverId}|${scope.userId}`;

/** localStorage store: used when IndexedDB is unavailable (old browsers, private mode). */
export function localOutboxStorage(getStorage = () => globalThis.localStorage) {
  const readAll = () => {
    try {
      const list = JSON.parse(getStorage()?.getItem(FALLBACK_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  };
  const writeAll = (list) => {
    if (list.length) getStorage()?.setItem(FALLBACK_KEY, JSON.stringify(list));
    else getStorage()?.removeItem(FALLBACK_KEY);
  };
  return {
    load: async () => readAll(),
    put: async (entries) => {
      const keys = new Set(entries.map((e) => e.key));
      writeAll([...readAll().filter((e) => !keys.has(e.key)), ...entries]);
    },
    delete: async (keys) => {
      const drop = new Set(keys);
      writeAll(readAll().filter((e) => !drop.has(e.key)));
    },
    // only rows that still hold this entry (another tab may have stored a newer change under the key)
    update: async (entries) => {
      const byKey = new Map(entries.map((e) => [e.key, e]));
      writeAll(readAll().map((row) => (byKey.get(row.key)?.id === row.id ? byKey.get(row.key) : row)));
    },
    remove: async (entries) => {
      const ids = new Map(entries.map((e) => [e.key, e.id]));
      writeAll(readAll().filter((row) => ids.get(row.key) !== row.id));
    }
  };
}

/** IndexedDB (offlineStore's 'outbox' store), falling back to localStorage; entries of the fallback move into IndexedDB. */
export function defaultOutboxStorage() {
  const local = localOutboxStorage();
  let useLocal = false;
  const attempt = async (idb, fallback) => {
    if (!useLocal) {
      try { return await idb(); } catch (err) {
        useLocal = true;
        console.warn('[Outbox] IndexedDB nicht verfügbar, nutze localStorage:', err?.message || err);
      }
    }
    return fallback();
  };
  return {
    load: () => attempt(async () => {
      const rows = await loadOutboxEntries();
      const stranded = await local.load();
      if (stranded.length) {
        await putOutboxEntries(stranded.map((e) => normalizeOutboxEntry(e)).filter(Boolean));
        await local.delete(stranded.map((e) => e.key));
        return [...rows, ...stranded];
      }
      return rows;
    }, () => local.load()),
    put: (entries) => attempt(() => putOutboxEntries(entries), () => local.put(entries)),
    delete: (keys) => attempt(() => deleteOutboxEntries(keys), () => local.delete(keys)),
    update: (entries) => attempt(() => updateOutboxEntriesById(entries), () => local.update(entries)),
    remove: (entries) => attempt(() => deleteOutboxEntriesById(entries), () => local.remove(entries))
  };
}

/** navigator.locks where available: one replay per scope at a time across the tabs of this browser. */
function defaultLock(name, fn) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (!locks || typeof locks.request !== 'function') return fn();
  try {
    return locks.request(name, () => fn());
  } catch (_) {
    return fn();
  }
}

// Outbox over a storage { load, put, delete } and a sender (entry -> Response, rejects when unreachable). flush(scope)
// sends in time order, one at a time per scope; it stops when the server is unusable (no answer, gateway, 429, 401),
// and a waiting change (backoff, 500) holds back only later changes of its volume.
export function createOutbox({ storage, send, now = () => Date.now(), onFlushed, lock = defaultLock } = {}) {
  let entries = [];
  let ready = null;
  let loaded = false;
  const listeners = new Set();
  const flights = new Map();
  const waiters = new Map();
  // ids added in this tab whose write has not finished: a reload from the storage must not lose them
  const unsaved = new Set();

  const emit = () => { for (const listener of [...listeners]) listener(); };
  const warn = (err) => console.warn('[Outbox]', err?.message || err);
  const persist = (list) => Promise.resolve(storage.put(list)).catch(warn);
  const unpersist = (keys) => Promise.resolve(storage.delete(keys)).catch(warn);
  // settled entries: only the row that still holds this entry changes (another tab may have a newer one)
  const persistSettled = (list) => Promise.resolve(storage.update ? storage.update(list) : storage.put(list)).catch(warn);
  const unpersistSettled = (list) => Promise.resolve(storage.remove ? storage.remove(list) : storage.delete(list.map((e) => e.key))).catch(warn);

  function load() {
    if (!ready) {
      ready = Promise.resolve()
        .then(() => storage.load())
        .then((rows) => {
          let merged = (rows || []).map((row) => normalizeOutboxEntry(row)).filter(Boolean).sort((a, b) => a.ts - b.ts);
          for (const e of entries) merged = coalesceEntries(merged, e);
          entries = merged;
          loaded = true;
          emit();
        })
        .catch((err) => {
          loaded = true;
          console.warn('[Outbox]', err?.message || err);
        });
    }
    return ready;
  }

  const list = (scope) => entries.filter(inScope(scope));

  /**
   * Takes the scope's entries from the storage again (other tabs add, replace and send entries too): a stored newer
   * change wins, an entry another tab already sent is gone, entries of this tab that are still being written stay.
   */
  async function reload(scope) {
    let rows;
    try { rows = await storage.load(); } catch (err) {
      warn(err);
      return;
    }
    const match = inScope(scope);
    const stored = new Map();
    for (const row of rows || []) {
      const e = normalizeOutboxEntry(row);
      if (e && match(e)) stored.set(e.key, e);
    }
    const merged = new Map();
    for (const e of entries.filter(match)) {
      const row = stored.get(e.key);
      if (row) merged.set(e.key, row.id === e.id || e.ts > row.ts ? e : row);
      else if (unsaved.has(e.id)) merged.set(e.key, e);
    }
    for (const [key, row] of stored) if (!merged.has(key)) merged.set(key, row);
    entries = [...entries.filter((e) => !match(e)), ...merged.values()].sort((a, b) => a.ts - b.ts);
    emit();
  }

  /** Adds an entry to the loaded outbox at once; `persisted` resolves to false when the storage refused it. */
  function addNow(raw) {
    const entry = normalizeOutboxEntry({ ...raw, ts: now() }, { now: now() });
    if (!entry) throw new TypeError('Ungültige Outbox-Änderung');
    entries = coalesceEntries(entries, entry);
    unsaved.add(entry.id);
    emit();
    const persisted = Promise.resolve()
      .then(() => storage.put([entry]))
      .then(() => true, (err) => {
        warn(err);
        return false;
      })
      .finally(() => unsaved.delete(entry.id));
    return { entry, persisted };
  }

  /** Adds (or replaces) an entry. Resolves to { entry, stored }; stored is false when the storage refused it. */
  async function add(raw) {
    if (!loaded) await load();
    const { entry, persisted } = addNow(raw);
    return { entry, stored: await persisted };
  }

  /** Removes one entry (unless a newer change of the same key replaced it). */
  function discard(entry) {
    settle(entry, null);
  }

  /** Resolves with { entry, outcome, res } once a flush attempted this entry. */
  function track(id) {
    return new Promise((resolve) => { waiters.set(id, resolve); });
  }

  function settle(entry, patch) {
    const current = entries.find((e) => e.key === entry.key);
    if (!current || current.id !== entry.id) return;
    if (patch === null) {
      entries = entries.filter((e) => e !== current);
      unpersistSettled([current]);
    } else {
      const next = { ...current, ...patch };
      entries = entries.map((e) => (e === current ? next : e));
      persistSettled([next]);
    }
    emit();
  }

  // Null while the stored row still holds this entry, else { newer } (newer stored change, or null if another tab sent
  // it), so an older value never follows a newer one; a replay holds no lock against other tabs' forced flushes.
  async function superseded(entry) {
    if (unsaved.has(entry.id)) return null;
    let rows;
    try { rows = await storage.load(); } catch (_) { return null; }
    const row = (rows || []).find((r) => r?.key === entry.key);
    if (row?.id === entry.id) return null;
    const newer = row ? normalizeOutboxEntry(row) : null;
    const current = entries.find((e) => e.key === entry.key);
    if (current?.id !== entry.id) return { newer: null };
    entries = entries.filter((e) => e !== current);
    if (newer) entries = coalesceEntries(entries, newer);
    emit();
    return { newer };
  }

  async function run(scope, { force, fresh }) {
    // no await when loaded: the first request starts synchronously (a quick buy right before the page unloads)
    if (!loaded) await load();
    if (fresh) await reload(scope);
    const result = { items: [], synced: [], dropped: [], kept: [], unauthorized: false };
    const attempted = new Set();
    // a volume whose change has to wait keeps its later changes waiting too (order per volume), others go on
    const waiting = new Set();
    let stop = false;
    while (!stop) {
      const next = list(scope).filter((e) => !attempted.has(e.id));
      if (!next.length) break;
      for (const entry of next) {
        attempted.add(entry.id);
        if (waiting.has(entry.volumeId) || (!force && entry.nextAt && entry.nextAt > now())) {
          waiting.add(entry.volumeId);
          result.kept.push(entry);
          continue;
        }
        if (!force) {
          const gone = await superseded(entry);
          if (gone) {
            // the newer change is sent by the tab that made it, or by the next replay
            if (gone.newer) attempted.add(gone.newer.id);
            continue;
          }
        }
        let res = null;
        try { res = await send(entry); } catch (_) { res = null; }
        const outcome = classifyOutboxResponse(res, entry);
        const item = { entry, outcome, res };
        result.items.push(item);
        if (outcome === 'done') {
          settle(entry, null);
          result.synced.push(entry);
        } else if (outcome === 'drop') {
          settle(entry, null);
          result.dropped.push({ ...entry, status: res?.status ?? null });
        } else {
          const attempts = entry.attempts + 1;
          settle(entry, outcome === 'retry'
            ? { attempts, deferred: true, nextAt: now() + retryDelay(attempts) }
            : { deferred: true });
          result.kept.push(entry);
          waiting.add(entry.volumeId);
          if (outcome === 'auth') result.unauthorized = true;
          // no answer, a gateway or rate limit: the server is not usable now; a 500 only concerns this change
          if (outcome === 'auth' || serverUnusable(res)) stop = true;
        }
        waiters.get(entry.id)?.(item);
        waiters.delete(entry.id);
        if (stop) break;
      }
    }
    return result;
  }

  /**
   * A forced flush (a change the user just made) starts its first request at once. A replay first takes the lock of
   * the scope (one tab at a time) and reloads the scope from the storage, so it never sends another tab's older value.
   */
  function flush(scope, { force = false } = {}) {
    if (!scope || !hasValue(scope.userId) || !hasValue(scope.serverId)) {
      return Promise.resolve({ items: [], synced: [], dropped: [], kept: [], unauthorized: false });
    }
    const id = scopeId(scope);
    const running = flights.get(id);
    if (running) return running;
    const work = force ? run(scope, { force, fresh: false }) : Promise.resolve(lock(`${OUTBOX_LOCK}:${id}`, () => run(scope, { force, fresh: true })));
    const promise = work
      .then((result) => {
        onFlushed?.(result, scope);
        return result;
      })
      .finally(() => flights.delete(id));
    flights.set(id, promise);
    return promise;
  }

  /** Moves the user's old purchase queue (shoppingQueue) into the outbox once. Returns the number of moved purchases. */
  async function migrateLegacy(scope, legacyStorage = globalThis.localStorage) {
    if (!hasValue(scope?.userId) || !hasValue(scope?.serverId)) return 0;
    let legacy;
    try { legacy = legacyPurchaseEntries(scope, legacyStorage); } catch (_) { return 0; }
    if (!legacy.length) return 0;
    await load();
    const base = now();
    const added = [];
    for (const [i, raw] of legacy.entries()) {
      if (entries.some((e) => e.key === raw.key)) continue;
      const entry = { ...raw, ts: base + i };
      entries = coalesceEntries(entries, entry);
      added.push(entry);
    }
    emit();
    if (added.length) await persist(added);
    try { legacyStorage?.removeItem(queueKey(scope.userId)); } catch (_) { /* read again next time; keys coalesce */ }
    return added.length;
  }

  return {
    load,
    isLoaded: () => loaded,
    add,
    addNow,
    discard,
    track,
    untrack: (id) => waiters.delete(id),
    flush,
    migrateLegacy,
    list,
    count: (scope, kinds) => list(scope).filter((e) => !kinds || kinds.includes(e.kind)).length,
    has: (scope, predicate) => list(scope).some(predicate),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Entries of a server, of every user. */
    countServer: (serverId) => entries.filter((e) => e.serverId === String(serverId)).length,
    /** Drops every entry of a server (the server was removed from the app). */
    async dropServer(serverId) {
      await load();
      const gone = entries.filter((e) => e.serverId === String(serverId));
      if (!gone.length) return 0;
      entries = entries.filter((e) => e.serverId !== String(serverId));
      emit();
      await unpersist(gone.map((e) => e.key));
      return gone.length;
    },
    /** Moves the entries of one server id to another (a removed server was added again); a newer change there wins. */
    async moveServer(fromId, toId) {
      await load();
      const moving = entries.filter((e) => e.serverId === String(fromId));
      if (!moving.length || String(fromId) === String(toId)) return 0;
      let next = entries.filter((e) => e.serverId !== String(fromId));
      const moved = [];
      for (const e of moving) {
        const entry = normalizeOutboxEntry({ ...e, serverId: toId });
        const there = next.find((x) => x.key === entry.key);
        if (there && there.ts >= entry.ts) continue;
        next = coalesceEntries(next, entry);
        moved.push(entry);
      }
      entries = next;
      emit();
      await unpersist(moving.map((e) => e.key));
      if (moved.length) await persist(moved);
      return moved.length;
    }
  };
}

/** Only an entry of the current mode and server is sent: a server's entry never reaches the device core, nor the reverse. */
export function sendEntry(entry) {
  if (entry.serverId !== String(currentServerId())) return Promise.resolve(null);
  const { path, method, body } = outboxRequest(entry);
  return apiFetch(path, { method, body, timeout: TIMEOUTS.write });
}

/**
 * Toasts for a replay (queued changes that went through, or that the server refused) and OUTBOX_SYNCED_EVENT, on which
 * views refetch. Changes sent right away stay quiet: their caller refreshes itself.
 */
export function reportFlush(result, target = globalThis.window) {
  const replayed = result.synced.filter((e) => e.deferred);
  const refused = result.dropped.filter((e) => e.deferred);
  if (replayed.length) notify.success(`${formatCount(replayed.length, 'Änderung', 'Änderungen')} übertragen`);
  if (refused.length) {
    notify.error(`${formatCount(refused.length, 'vorgemerkte Änderung', 'vorgemerkte Änderungen')} vom Server abgelehnt`);
  }
  if ((replayed.length || refused.length) && typeof target?.dispatchEvent === 'function') {
    target.dispatchEvent(new CustomEvent(OUTBOX_SYNCED_EVENT, { detail: { synced: replayed, dropped: refused } }));
  }
}

/**
 * Applies a change to the in-memory copies (detail and shelf list) and to the offline copy, so other views and an
 * offline restart show it before the server confirmed it. The copies lose their ETag: the next fetch is a full one.
 */
export function applyChangeToCaches({ user, mangaId, change }) {
  if (mangaId === undefined || mangaId === null) return Promise.resolve(false);
  const me = { id: user?.id, username: user?.username };
  const owner = cacheOwner(user);
  const entry = readCache(owner, detailKey(mangaId));
  if (entry?.data) {
    const detail = applyVolumeChange(entry.data, change, me);
    if (detail !== entry.data) {
      writeCache(owner, detailKey(mangaId), detail);
      const list = readCache(owner, LIST_KEY);
      if (Array.isArray(list?.data)) writeCache(owner, LIST_KEY, applyDetailToList(list.data, detail, me));
    }
  }
  return patchCachedManga(mangaId, (detail, list) => {
    if (!detail) return {};
    const next = applyVolumeChange(detail, change, me);
    return { detail: next, list: list ? applyDetailToList(list, next, me) : undefined };
  });
}

let shared = null;

/** The outbox of this page (IndexedDB, sends through utils/api.js). */
export function getOutbox() {
  if (!shared) shared = createOutbox({ storage: defaultOutboxStorage(), send: sendEntry, onFlushed: (result) => reportFlush(result) });
  return shared;
}

/** Forgets the page's outbox instance (tests; the stored entries stay). */
export function resetOutbox() {
  shared = null;
}

export const outboxScope = (userId) => ({ userId, serverId: currentServerId() });

// Records a change and sends it now unless `offline`; resolves to { status: 'sent'|'queued'|'failed'|'auth', res, entry }.
// 'failed' (4xx or device-core refusal) left the outbox: the caller reverts its optimistic state.
export async function submitChange(change, { userId, offline: wantsQueue = false, outbox = getOutbox() } = {}) {
  const scope = outboxScope(userId);
  // the device core needs no network: a change of the local mode is never queued
  const offline = wantsQueue && !isLocalServerId(scope.serverId);
  const raw = { ...change, userId, serverId: scope.serverId, deferred: offline };
  let entry;
  let persisted;
  let first = null;
  if (outbox.isLoaded()) {
    ({ entry, persisted } = outbox.addNow(raw));
    // started before any await, so the request leaves even when the page unloads right after the click
    if (!offline) first = { tracked: outbox.track(entry.id), flushing: outbox.flush(scope, { force: true }) };
  } else {
    let stored;
    ({ entry, stored } = await outbox.add(raw));
    persisted = Promise.resolve(stored);
  }
  const stored = await persisted;
  // a change that could neither be sent nor stored must not stay behind in memory only
  const queued = (res) => {
    if (stored) return { status: 'queued', res, entry };
    outbox.discard(entry);
    return { status: 'failed', res: null, entry, reason: 'storage' };
  };
  if (offline) return queued(null);
  for (let round = 0; round < 2; round++) {
    const { tracked, flushing } = first ?? { tracked: outbox.track(entry.id), flushing: outbox.flush(scope, { force: true }) };
    first = null;
    const item = await Promise.race([tracked, flushing.then(() => null)]);
    outbox.untrack(entry.id);
    if (item) {
      if (item.outcome === 'done') return { status: 'sent', res: item.res, entry };
      if (item.outcome === 'drop') return { status: 'failed', res: item.res, entry };
      if (item.outcome === 'auth') return stored ? { status: 'auth', res: item.res, entry } : queued(item.res);
      return queued(item.res);
    }
    if ((await flushing).unauthorized) break;
  }
  return outbox.has(scope, (e) => e.id === entry.id) ? queued(null) : { status: 'sent', res: null, entry };
}

/** The id of the user the server's session belongs to now (GET /api/auth/me), false without a session, null when unknown. */
export async function sessionUserId() {
  try {
    const res = await apiFetch('/api/auth/me', { timeout: TIMEOUTS.auth });
    if (res.status === 401) return false;
    if (!res.ok) return null;
    return (await readJson(res))?.user?.id ?? null;
  } catch (_) {
    return null;
  }
}

// Replays the outbox on start, `online`, page visible, `subscribe` reconnects and backoff end; returns a stop function.
// Except at start a replay first asks whose session this is, so entries survive a user switch in another tab.
export function startOutboxSync({
  userId, isOnline = () => true, subscribe, outbox = getOutbox(), win = globalThis.window, doc = globalThis.document,
  legacyStorage = globalThis.localStorage, confirmUser = sessionUserId
}) {
  if (!hasValue(userId)) return () => {};
  let stopped = false;
  let timer = null;
  let failedChecks = 0;
  const scope = () => outboxScope(userId);
  const schedule = (minDelay = 0) => {
    clearTimeout(timer);
    const waits = outbox.list(scope()).map((e) => e.nextAt).filter(Number.isFinite);
    if (!waits.length && !minDelay) return;
    const due = waits.length ? Math.min(...waits) - Date.now() : 0;
    timer = setTimeout(() => { replay(); }, Math.max(1000, minDelay, due));
  };
  const replay = async ({ confirm = true } = {}) => {
    if (stopped || !isOnline() || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    if (confirm) {
      await outbox.load();
      if (!outbox.count(scope())) return;
      const current = await confirmUser();
      if (stopped) return;
      // no answer (server restarting, network): the backoff chain goes on; another user's session ends it
      if (current === null || current === undefined) {
        failedChecks += 1;
        schedule(retryDelay(failedChecks));
        return;
      }
      failedChecks = 0;
      if (String(current) !== String(userId)) return;
    }
    await outbox.flush(scope());
    if (!stopped) schedule();
  };
  const onVisible = () => { if (doc?.visibilityState === 'visible') replay(); };
  const onOnline = () => { replay(); };
  win?.addEventListener?.('online', onOnline);
  doc?.addEventListener?.('visibilitychange', onVisible);
  const unsubscribe = subscribe ? subscribe(() => replay()) : null;
  outbox.migrateLegacy(scope(), legacyStorage).finally(() => replay({ confirm: false }));
  return () => {
    stopped = true;
    clearTimeout(timer);
    win?.removeEventListener?.('online', onOnline);
    doc?.removeEventListener?.('visibilitychange', onVisible);
    unsubscribe?.();
  };
}
