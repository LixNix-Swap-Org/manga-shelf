// In-memory copies of server answers that survive route changes (shelf -> series -> back), per user. The views render
// the copy at once and revalidate it; the ETag of the copy goes out as If-None-Match, so an unchanged answer is a
// bodiless 304. Cleared with the offline copy on logout and session end. The offline copy (IndexedDB) is the second level.

export const PREFETCH_MANGAS = 'GET /api/mangas';
export const LIST_KEY = 'mangas';
export const detailKey = (id) => `manga:${id}`;
export const cacheOwner = (user) => user?.id ?? user?.username ?? null;

const MAX_ENTRIES = 60;
const entries = new Map();
const prefetches = new Map();

const slot = (owner, key) => `${owner ?? ''}\u0000${key}`;

/** { data, etag, at } or null. */
export function readCache(owner, key) {
  return entries.get(slot(owner, key)) ?? null;
}

export function writeCache(owner, key, data, etag = null) {
  const id = slot(owner, key);
  entries.delete(id);
  const entry = { data, etag: etag || null, at: Date.now() };
  entries.set(id, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  return entry;
}

/** A 304 confirmed the copy: it counts as fresh again. */
export function touchCache(owner, key) {
  const entry = entries.get(slot(owner, key));
  if (entry) entry.at = Date.now();
  return entry ?? null;
}

export function dropCache(owner, key) {
  entries.delete(slot(owner, key));
}

export function clearDataCache() {
  entries.clear();
  prefetches.clear();
}

/** Request headers that let the server answer 304 for the copy. */
export const revalidateHeaders = (entry) => (entry?.etag ? { 'If-None-Match': entry.etag } : undefined);

/** Starts a request before the page that needs it is loaded (startup); the first takePrefetch() gets its promise. */
export function startPrefetch(key, run) {
  if (prefetches.has(key)) return;
  const promise = Promise.resolve().then(run).catch(() => null);
  prefetches.set(key, { promise, at: Date.now() });
}

/** The prefetched response promise (resolving to null on failure), once, and only while it is young. */
export function takePrefetch(key, maxAgeMs = 30000) {
  const entry = prefetches.get(key);
  if (!entry) return null;
  prefetches.delete(key);
  return Date.now() - entry.at <= maxAgeMs ? entry.promise : null;
}
