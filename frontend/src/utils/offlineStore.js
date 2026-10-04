// Read-only offline copy of the collection (IndexedDB, no dependencies).
//
// Stored per browser: the last known user, the series list and every series detail as served by
// GET /api/offline-snapshot. It is wiped on logout and when the server says the session is invalid,
// so data does not stay readable on a shared device. Nothing here ever writes back to the server.
// The shopping-list cache (localStorage) is kept here too, so its keys sit next to clearOfflineData.

import { LEGACY_QUEUE_KEY } from './shoppingQueue.js';
import { apiFetch, assetUrl, TIMEOUTS } from './api.js';
import { formatRelative } from './format.js';

// The scan helpers stay out of the start chunk: the index is built during the background sync and read by the scanners
const isbnTools = () => import('./scanHelpers.js');

const DB_NAME = 'mangashelf-offline';
const STORE = 'kv';
const DB_VERSION = 1;
const SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
const WARM_MAX_COVERS = 300;
const WARM_MAX_BYTES = 50 * 1024 * 1024;

export const OFFLINE_SYNCED_EVENT = 'mangashelf:offline-synced';
export const SHOPPING_CACHE_KEY = 'mangashelf_shopping_cache';
export const SHOPPING_META_KEY = 'mangashelf_shopping_meta';
export const SHOP_SESSION_KEY = 'mangashelf_shop_session';
const ISBN_INDEX_KEY = 'isbn-index';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB nicht verfügbar'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const get = (key) => run('readonly', (s) => s.get(key));
const put = (entries) => run('readwrite', (s) => { for (const [k, v] of entries) s.put(v, k); });

/** Never throws: offline support is a bonus and must not break the online app. */
async function safe(fn, fallback = null) {
  try { return await fn(); } catch (err) { console.warn('[Offline]', err.message || err); return fallback; }
}

export const saveUser = (user) => safe(() => put([['user', { id: user.id, username: user.username, role: user.role }]]));
export const loadUser = () => safe(async () => (await get('user')) ?? null);
export const loadMangaList = () => safe(async () => (await get('mangas')) ?? [], []);
export const loadMangaDetail = (id) => safe(async () => (await get(`manga:${id}`)) ?? null);
export const loadMeta = () => safe(async () => (await get('meta')) ?? null);

let localIndex = null;

async function isbnIndexEntries(details) {
  try {
    return [[ISBN_INDEX_KEY, (await isbnTools()).buildIsbnIndexRecord(details)]];
  } catch (err) {
    console.warn('[Offline] ISBN-Index nicht gebaut:', err?.message || err);
    return [];
  }
}

/**
 * Replaces the offline copy with a fresh /api/offline-snapshot response. Resolves to the new synced_at, or null
 * (also when a logout happened since `generation` was taken).
 */
export function saveSnapshot(snapshot, { generation } = {}) {
  return safe(async () => {
    const syncedAt = Date.now();
    const entries = [
      ['user', snapshot.user],
      ['mangas', snapshot.mangas],
      ['meta', { generated_at: snapshot.generated_at, synced_at: syncedAt }],
      ...await isbnIndexEntries(snapshot.details)
    ];
    if (generation !== undefined && generation !== clearGeneration) return null;
    for (const [id, detail] of Object.entries(snapshot.details || {})) entries.push([`manga:${id}`, detail]);
    // clear stale series (deleted on the server) in the same pass
    await run('readwrite', (s) => { s.clear(); for (const [k, v] of entries) s.put(v, k); });
    localIndex = null;
    return syncedAt;
  });
}

/** The ISBN index of the offline copy, read once per session (built from the details for a copy without one). */
export function loadLocalIsbnIndex() {
  if (!localIndex) {
    const pending = (async () => {
      let record = await get(ISBN_INDEX_KEY);
      if (!record) {
        const list = (await get('mangas')) ?? [];
        const details = (await Promise.all(list.map((m) => get(`manga:${m.id}`)))).filter(Boolean);
        record = (await isbnTools()).buildIsbnIndexRecord(details);
      }
      const meta = await get('meta');
      return { map: new Map(record.entries.map((e) => [e[0], e])), titles: record.titles || {}, syncedAt: meta?.synced_at ?? null };
    })().catch((err) => {
      console.warn('[Offline]', err?.message || err);
      if (localIndex === pending) localIndex = null;
      return null;
    });
    localIndex = pending;
  }
  return localIndex;
}

/**
 * The volume of the offline copy carrying this ISBN: { manga: { id, title }, volume, syncedAt }, or null.
 * `volume` has the fields classifyShopScan reads (id, status, owned_by_me, owners, display_title).
 */
export async function lookupLocalIsbn(isbn) {
  const key = (await isbnTools()).toIsbn13(isbn);
  if (!key) return null;
  const index = await loadLocalIsbnIndex();
  const entry = index?.map.get(key);
  if (!entry) return null;
  const [, mangaId, volumeId, displayTitle, status, mine, owners] = entry;
  return {
    manga: { id: mangaId, title: index.titles[mangaId] ?? '' },
    volume: { id: volumeId, display_title: displayTitle, status, owners, ...(mine === null ? {} : { owned_by_me: Boolean(mine) }) },
    syncedAt: index.syncedAt
  };
}

/** Keeps a freshly viewed series detail in the offline copy without a full re-sync. */
export const updateCachedManga = (detail) => safe(() => put([[`manga:${detail.id}`, detail]]));

let clearGeneration = 0; // bumped on logout/401: a download that started before it must not be stored afterwards
let syncInFlight = null;
let followUp = null;

export const getClearGeneration = () => clearGeneration;

function notifySynced(syncedAt) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OFFLINE_SYNCED_EVENT, { detail: { synced_at: syncedAt } }));
}

/**
 * Called on logout / invalid session. Also drops the shopping-list cache (same privacy rule) and the old
 * queue format without a user. The per-user purchase queues stay: they are only ever sent by their own user.
 */
export async function clearOfflineData() {
  clearGeneration++;
  syncInFlight = null;
  followUp = null;
  localIndex = null;
  await safe(() => run('readwrite', (s) => { s.clear(); }));
  try {
    localStorage.removeItem(SHOPPING_CACHE_KEY);
    localStorage.removeItem(SHOPPING_META_KEY);
    localStorage.removeItem(LEGACY_QUEUE_KEY);
    localStorage.removeItem(SHOP_SESSION_KEY);
  } catch (_) { /* storage unavailable */ }
  notifySynced(null);
}

const SHOPPING_ITEM_FIELDS = [
  'id', 'manga_id', 'volume_number', 'type', 'notes', 'isbn', 'price', 'priority', 'target_price',
  'manga_title', 'manga_cover', 'effective_publisher'
];

/** What the shopping list needs offline: no `others` section and no fields the list does not show. */
export function slimShoppingList(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  return {
    total_missing: data?.total_missing ?? items.length,
    total_cost: data?.total_cost ?? 0,
    publishers: Array.isArray(data?.publishers) ? data.publishers : [],
    items: items.map((item) => Object.fromEntries(SHOPPING_ITEM_FIELDS.filter((f) => f in item).map((f) => [f, item[f]])))
  };
}

export function readShoppingCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHOPPING_CACHE_KEY) || 'null');
    return parsed && Array.isArray(parsed.items) ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function readShoppingCacheTimestamp() {
  try {
    return JSON.parse(localStorage.getItem(SHOPPING_META_KEY) || 'null')?.timestamp || null;
  } catch (_) {
    return null;
  }
}

/**
 * Stores the shopping list for offline use, unless a logout happened since `generation` was taken.
 * Returns the stored timestamp, or null when nothing was written (logout, storage full or blocked).
 */
export function writeShoppingCache(data, generation = clearGeneration) {
  if (generation !== clearGeneration) return null;
  try {
    const timestamp = new Date().toISOString();
    localStorage.setItem(SHOPPING_CACHE_KEY, JSON.stringify(slimShoppingList(data)));
    localStorage.setItem(SHOPPING_META_KEY, JSON.stringify({ timestamp }));
    return timestamp;
  } catch (err) {
    console.warn('[Offline] Einkaufsliste nicht gespeichert:', err?.name || err);
    return null;
  }
}

/** Applies a change to the stored shopping list (keeps its timestamp); does nothing without a stored list. */
export function updateShoppingCache(change) {
  const cached = readShoppingCache();
  if (!cached) return false;
  try {
    localStorage.setItem(SHOPPING_CACHE_KEY, JSON.stringify(slimShoppingList(change(cached))));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Downloads a fresh snapshot (throttled) and warms the service-worker cache with the app code and covers,
 * so the app can start and show the collection without network. Resolves to true if a snapshot was stored.
 * Only one download runs at a time. A plain call during a running sync gets its result; a forced call (data just
 * changed) gets one follow-up sync after it, shared by all forced calls that arrive meanwhile.
 */
export function syncOfflineCopy({ force = false } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false);
  if (!syncInFlight) return startSync(force);
  if (!force) return (followUp ?? syncInFlight).promise;
  if (!followUp) {
    const generation = clearGeneration;
    const record = { generation };
    record.promise = syncInFlight.promise.then(() => {
      if (followUp === record) followUp = null;
      return generation === clearGeneration ? startSync(true) : false;
    });
    followUp = record;
  }
  return followUp.promise;
}

function startSync(force) {
  const generation = clearGeneration;
  const promise = runSync(force, generation)
    .catch(() => false)
    .finally(() => { if (syncInFlight?.promise === promise) syncInFlight = null; });
  syncInFlight = { generation, promise };
  return promise;
}

async function runSync(force, generation) {
  const meta = await loadMeta();
  if (!force && meta?.synced_at && Date.now() - meta.synced_at < SYNC_MIN_INTERVAL_MS) return false;

  let snapshot;
  try {
    const res = await apiFetch('/api/offline-snapshot', { timeout: TIMEOUTS.long });
    if (!res.ok) return false;
    snapshot = await res.json();
  } catch (_) {
    return false;
  }
  if (generation !== clearGeneration) return false; // logged out while the download ran
  const syncedAt = await saveSnapshot(snapshot, { generation });
  if (!syncedAt || generation !== clearGeneration) return false;
  notifySynced(syncedAt);
  requestPersistentStorage();
  warmCaches(snapshot);
  return true;
}

let persistRequested = false;

/**
 * Asks the browser once per session to keep this origin's storage: Safari otherwise deletes the offline copy of a
 * site that was not opened for seven days. Resolves true when the storage is (now) persistent.
 */
export async function requestPersistentStorage(storageManager = globalThis.navigator?.storage) {
  if (persistRequested || typeof storageManager?.persist !== 'function') return false;
  persistRequested = true;
  try {
    if (typeof storageManager.persisted === 'function' && await storageManager.persisted()) return true;
    return Boolean(await storageManager.persist());
  } catch (_) {
    return false;
  }
}

function warmCaches(snapshot) {
  const idle = typeof globalThis.requestIdleCallback === 'function'
    ? (cb) => globalThis.requestIdleCallback(cb)
    : (cb) => setTimeout(cb, 1500);
  idle(async () => {
    // lazy route chunks (incl. login for a cold start after the session expired): only cached by the service worker once fetched online
    await Promise.allSettled([import('../Dashboard'), import('../MangaDetail'), import('../Login')]);
    // Only the series covers (the dashboard): volume covers are cached by the service worker when they are viewed.
    await warmCovers((snapshot.mangas || []).map((m) => m.cover_image));
  });
}

const SLOW_CONNECTIONS = new Set(['slow-2g', '2g', '3g']);

/** Cover pre-loading is skipped on mobile data, slow links and with the data saver on. */
export function coverWarmupAllowed(connection) {
  if (!connection) return true;
  if (connection.saveData) return false;
  if (connection.type === 'cellular') return false;
  return !SLOW_CONNECTIONS.has(connection.effectiveType);
}

async function storageNearlyFull(storageManager) {
  if (typeof storageManager?.estimate !== 'function') return false;
  try {
    const { usage, quota } = await storageManager.estimate();
    return quota > 0 && usage / quota > 0.8;
  } catch (_) {
    return false;
  }
}

async function responseBytes(res) {
  const length = Number(res?.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > 0) return length;
  try { return (await res.blob()).size; } catch (_) { return 0; }
}

/**
 * Fetches series covers that are not cached yet, so the service worker stores them. Stops at a cover count and byte
 * budget per sync; already cached covers do not count. Returns the number of covers fetched.
 */
export async function warmCovers(urls, options = {}) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const connection = 'connection' in options ? options.connection : nav.connection;
  if (!coverWarmupAllowed(connection)) return 0;
  if (await storageNearlyFull('storage' in options ? options.storage : nav.storage)) return 0;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cacheStorage = 'caches' in options ? options.caches : (typeof caches !== 'undefined' ? caches : null);
  const maxCovers = options.maxCovers ?? WARM_MAX_COVERS;
  const maxBytes = options.maxBytes ?? WARM_MAX_BYTES;

  const queue = [...new Set((urls || []).filter((u) => typeof u === 'string' && u.startsWith('/uploads/')))];
  let fetched = 0;
  let bytes = 0;
  const worker = async () => {
    while (queue.length && fetched < maxCovers && bytes < maxBytes) {
      const url = queue.shift();
      try {
        if (cacheStorage && await cacheStorage.match(url)) continue;
        fetched++;
        const size = await responseBytes(await fetchImpl(assetUrl(url)));
        bytes += size;
      } catch (_) { /* offline again: stop quietly */ return; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return fetched;
}

/** "vor 5 Min." style label for the offline banner / footer. */
export function formatAge(timestamp) {
  return formatRelative(timestamp) ?? 'unbekannt';
}
