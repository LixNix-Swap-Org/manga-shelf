// The series a person opened last, newest first, for the quick access ("Zuletzt geöffnet"). Kept per account in
// localStorage on this device; a blocked storage just means no list.
const KEY_PREFIX = 'mangashelf_recent_series';
export const RECENT_LIMIT = 5;

const keyOf = (userId) => `${KEY_PREFIX}:${userId ?? 'local'}`;

export function getRecentSeries(userId) {
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(keyOf(userId)) || '[]');
    return Array.isArray(list) ? list.filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, RECENT_LIMIT) : [];
  } catch (_) {
    return [];
  }
}

export function rememberRecentSeries(userId, mangaId) {
  const id = Number(mangaId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  const next = [id, ...getRecentSeries(userId).filter((x) => x !== id)].slice(0, RECENT_LIMIT);
  try { globalThis.localStorage?.setItem(keyOf(userId), JSON.stringify(next)); } catch (_) { /* storage blocked */ }
}
