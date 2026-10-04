// The old per-user queue of offline purchases (`mangashelf_pending_purchases:<userId>` in localStorage). Purchases now go
// through the outbox (utils/outbox.js), which moves these entries over once (outbox.migrateLegacy). Also the list
// helpers of the shopping list.

export const LEGACY_QUEUE_KEY = 'mangashelf_pending_purchases';
const QUEUE_PREFIX = `${LEGACY_QUEUE_KEY}:`;

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
