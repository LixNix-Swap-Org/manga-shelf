import { apiFetch } from './api.js';

// Purchases made in the shop while the server was unreachable. Each user has an own queue in localStorage
// (`mangashelf_pending_purchases:<userId>`), so a purchase is only ever sent with the session of the person who
// made it. An entry leaves the queue once the server confirmed it (or the volume no longer exists).

export const LEGACY_QUEUE_KEY = 'mangashelf_pending_purchases';
const QUEUE_PREFIX = `${LEGACY_QUEUE_KEY}:`;
const PUT_TIMEOUT_MS = 8000;

export const queueKey = (userId) => `${QUEUE_PREFIX}${userId}`;

const storageOr = (storage) => storage ?? globalThis.localStorage;
const hasUser = (userId) => userId !== null && userId !== undefined && userId !== '';

/** Today as YYYY-MM-DD in local time (toISOString would give the previous day shortly after midnight in CET/CEST). */
export function localToday(date = new Date()) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function normalizeEntry(raw, userId) {
  if (!raw || typeof raw !== 'object') return null;
  const volumeId = Number(raw.volumeId);
  if (!Number.isInteger(volumeId) || volumeId <= 0) return null;
  const purchasedAt = typeof raw.purchasedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.purchasedAt) ? raw.purchasedAt : null;
  return { volumeId, userId, purchasedAt };
}

/** The user's queue; unreadable or foreign content counts as empty. */
export function readQueue(userId, storage) {
  if (!hasUser(userId)) return [];
  try {
    const parsed = JSON.parse(storageOr(storage).getItem(queueKey(userId)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e) => normalizeEntry(e, userId)).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function writeQueue(userId, entries, storage) {
  const s = storageOr(storage);
  if (entries.length) s.setItem(queueKey(userId), JSON.stringify(entries));
  else s.removeItem(queueKey(userId));
}

export const pendingVolumeIds = (userId, storage) => new Set(readQueue(userId, storage).map((e) => e.volumeId));
export const pendingCount = (userId, storage) => readQueue(userId, storage).length;

/** Adds a purchase to the user's queue. Returns false when it could not be stored (no user, storage full or blocked). */
export function enqueuePurchase(userId, volumeId, { storage, purchasedAt = localToday() } = {}) {
  if (!hasUser(userId)) return false;
  const entry = normalizeEntry({ volumeId, purchasedAt }, userId);
  if (!entry) return false;
  try {
    const queue = readQueue(userId, storage);
    if (!queue.some((e) => e.volumeId === entry.volumeId)) queue.push(entry);
    writeQueue(userId, queue, storage);
    return true;
  } catch (_) {
    return false;
  }
}

function removeFromQueue(userId, volumeId, storage) {
  try {
    writeQueue(userId, readQueue(userId, storage).filter((e) => e.volumeId !== volumeId), storage);
  } catch (_) { /* stays queued; owned: true is idempotent */ }
}

/**
 * Old queues held bare volume ids without the user who bought them. They cannot be attributed safely, so they are
 * dropped instead of being replayed under whoever logs in next. Returns the number of dropped purchases.
 */
export function discardLegacyQueue(storage) {
  try {
    const s = storageOr(storage);
    const raw = s.getItem(LEGACY_QUEUE_KEY);
    if (raw === null) return 0;
    s.removeItem(LEGACY_QUEUE_KEY);
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch (_) {
      return 0;
    }
  } catch (_) {
    return 0;
  }
}

// A purchase is the buyer's own ownership (POST /owners): it never touches other owners' rows or the volume row
export const purchaseBody = (purchasedAt) => JSON.stringify(
  purchasedAt ? { owned: true, purchase_date: purchasedAt } : { owned: true }
);

export const purchaseUrl = (volumeId) => `/api/volumes/${volumeId}/owners`;

const isGatewayStatus = (status) => status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);

/** Result of a queued purchase: 'done' leaves the queue, 'drop' leaves it as failed, 'keep' is retried later. */
export function classifyPurchaseResponse(res) {
  if (!res) return 'keep';
  if (res.ok || res.status === 404) return 'done';
  if (res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500) return 'keep';
  return 'drop';
}

/** Result of a live quick buy: 'ok', 'queue' (server not reachable), 'auth' (session gone) or 'error'. */
export function classifyQuickBuy(res) {
  if (!res) return 'queue';
  if (res.ok) return 'ok';
  if (res.status === 401) return 'auth';
  if (res.status === 408 || res.status === 429 || res.status >= 500) return 'queue';
  return 'error';
}

/** fetch with a timeout; an exceeded timeout rejects like a network error. Without fetchImpl it uses the API client. */
export async function fetchWithTimeout(url, options = {}, { fetchImpl, timeoutMs = PUT_TIMEOUT_MS } = {}) {
  if (!fetchImpl) return apiFetch(url, { ...options, timeout: timeoutMs });
  if (typeof AbortController === 'undefined') return fetchImpl(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const sendPurchase = (volumeId, purchasedAt, opts) => fetchWithTimeout(purchaseUrl(volumeId), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: purchaseBody(purchasedAt)
}, opts);

const inFlight = new Map();

/**
 * Sends the user's queued purchases. Only one flush per user runs at a time; a second caller gets the running one.
 * Entries added while it runs are sent in the same flush. The queue is re-read before every change, so an entry
 * added meanwhile is never overwritten. Resolves to { synced, dropped, kept } (lists of entries).
 */
export function flushPurchaseQueue({ userId, storage, fetchImpl, timeoutMs } = {}) {
  if (!hasUser(userId)) return Promise.resolve({ synced: [], dropped: [], kept: [] });
  const key = queueKey(userId);
  const running = inFlight.get(key);
  if (running) return running;
  const promise = runFlush(userId, storage, { fetchImpl, timeoutMs }).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function runFlush(userId, storage, fetchOpts) {
  const result = { synced: [], dropped: [], kept: [] };
  const attempted = new Set();
  let unreachable = false;
  while (!unreachable) {
    const next = readQueue(userId, storage).filter((e) => !attempted.has(e.volumeId));
    if (!next.length) break;
    for (const entry of next) {
      attempted.add(entry.volumeId);
      let res = null;
      try {
        res = await sendPurchase(entry.volumeId, entry.purchasedAt, fetchOpts);
      } catch (_) {
        unreachable = true;
      }
      const outcome = classifyPurchaseResponse(res);
      if (outcome === 'keep') {
        result.kept.push(entry);
        if (res && isGatewayStatus(res.status)) unreachable = true;
        if (unreachable) break;
        continue;
      }
      removeFromQueue(userId, entry.volumeId, storage);
      (outcome === 'done' ? result.synced : result.dropped).push({ ...entry, status: res.status });
    }
  }
  return result;
}

/** Shopping list without the given volume ids, totals adjusted (publisher chips stay as the server sent them). */
export function withoutVolumes(data, volumeIds) {
  if (!data || !Array.isArray(data.items) || !volumeIds || !volumeIds.size) return data;
  const removed = data.items.filter((item) => volumeIds.has(item.id));
  if (!removed.length) return data;
  const items = data.items.filter((item) => !volumeIds.has(item.id));
  const removedCost = removed.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
  return {
    ...data,
    total_missing: items.length,
    total_cost: Math.max(0, Math.round(((Number(data.total_cost) || 0) - removedCost) * 100) / 100),
    items
  };
}
