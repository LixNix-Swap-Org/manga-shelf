// Read-only offline copy of the collection (IndexedDB, no dependencies).
//
// Stored per browser: the last known user, the series list and every series detail as served by
// GET /api/offline-snapshot. It is wiped on logout and when the server says the session is invalid,
// so data does not stay readable on a shared device. Nothing here ever writes back to the server.

const DB_NAME = 'mangashelf-offline';
const STORE = 'kv';
const DB_VERSION = 1;
const SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

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
export const loadUser = () => safe(() => get('user'));
export const loadMangaList = () => safe(() => get('mangas'), []);
export const loadMangaDetail = (id) => safe(() => get(`manga:${id}`));
export const loadMeta = () => safe(() => get('meta'));

/** Replaces the offline copy with a fresh /api/offline-snapshot response. */
export function saveSnapshot(snapshot) {
  return safe(async () => {
    const entries = [
      ['user', snapshot.user],
      ['mangas', snapshot.mangas],
      ['meta', { generated_at: snapshot.generated_at, synced_at: Date.now() }]
    ];
    for (const [id, detail] of Object.entries(snapshot.details || {})) entries.push([`manga:${id}`, detail]);
    // clear stale series (deleted on the server) in the same pass
    await run('readwrite', (s) => { s.clear(); for (const [k, v] of entries) s.put(v, k); });
  });
}

/** Keeps a freshly viewed series detail in the offline copy without a full re-sync. */
export const updateCachedManga = (detail) => safe(() => put([[`manga:${detail.id}`, detail]]));

/** Called on logout / invalid session. Also drops the old shopping-list cache (own data, same privacy rule). */
let clearGeneration = 0; // bumped on logout/401: a sync that started before it must not store its snapshot afterwards

export async function clearOfflineData() {
  clearGeneration++;
  await safe(() => run('readwrite', (s) => { s.clear(); }));
  try {
    localStorage.removeItem('mangashelf_shopping_cache');
    localStorage.removeItem('mangashelf_shopping_meta');
  } catch (_) { /* storage unavailable */ }
}

/**
 * Downloads a fresh snapshot (throttled) and warms the service-worker cache with the app code and covers,
 * so the app can start and show the collection without network. Returns true if a sync happened.
 */
export async function syncOfflineCopy({ force = false } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const meta = await loadMeta();
  if (!force && meta?.synced_at && Date.now() - meta.synced_at < SYNC_MIN_INTERVAL_MS) return false;

  const generation = clearGeneration;
  let snapshot;
  try {
    const res = await fetch('/api/offline-snapshot');
    if (!res.ok) return false;
    snapshot = await res.json();
  } catch (_) {
    return false;
  }
  if (generation !== clearGeneration) return false; // logged out while the download ran
  await saveSnapshot(snapshot);
  warmCaches(snapshot);
  return true;
}

function warmCaches(snapshot) {
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1500));
  idle(async () => {
    // lazy route chunks (incl. login for a cold start after the session expired): only cached by the service worker once fetched online
    await Promise.allSettled([import('../Dashboard'), import('../MangaDetail'), import('../Login')]);
    if (navigator.connection?.saveData) return;
    // Only the series covers (the dashboard): volume covers can add up to dozens of MB on a big collection and
    // are cached by the service worker when they are viewed. Covers that are already cached are skipped.
    const queue = [...new Set(snapshot.mangas.map((m) => m.cover_image).filter((u) => u && u.startsWith('/uploads/')))];
    const worker = async () => {
      while (queue.length) {
        const url = queue.shift();
        try {
          if (typeof caches !== 'undefined' && await caches.match(url)) continue;
          await fetch(url);
        } catch (_) { /* offline again: stop quietly */ return; }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  });
}

/** "vor 5 Min." style label for the offline banner / footer. */
export function formatAge(timestamp) {
  const ms = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!ms || Number.isNaN(ms)) return 'unbekannt';
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins} Min.`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  return `vor ${Math.round(hours / 24)} Tagen`;
}
