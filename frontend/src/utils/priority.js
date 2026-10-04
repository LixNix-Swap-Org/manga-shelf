// Wish priority of volumes (volumes.priority) and series (mangas.wish_priority): 0 none, 1 low, 2 medium, 3 high.
// No React imports: the node:test suites load this module directly.
import { t } from '../i18n/index.js';

// i18n
export const PRIORITY_OPTIONS = [
  { value: 0, label: 'Keine' },
  { value: 1, label: 'Niedrig' },
  { value: 2, label: 'Mittel' },
  { value: 3, label: 'Hoch' }
];

/** Badge text of a volume priority on the shopping list. */
// i18n
export const PRIORITY_LABELS = { 1: '★ niedrig', 2: '★★ mittel', 3: '★★★ hoch' };

/** Lower-case word for running text: 'Wunschliste · hoch'. */
// i18n
export const PRIORITY_WORDS = { 0: 'ohne Priorität', 1: 'niedrig', 2: 'mittel', 3: 'hoch' };

export const DEFAULT_WISH_PRIORITY = 2;

const BADGE_CLASSES = {
  0: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
  1: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  2: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  3: 'bg-rose-500/15 text-rose-300 border-rose-500/40'
};

/** Border / background / text classes of a priority badge (unknown values look like 0). */
export const priorityBadgeClass = (priority) => BADGE_CLASSES[Number(priority)] || BADGE_CLASSES[0];

/** 0..3 or null for anything else (null, '', 'x', 4). */
export const normalizeWishPriority = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null;
};

/**
 * A wished series: wish_priority set and no owned volume. Uses the server's `wished` (GET /api/mangas) when present,
 * so list, chip, shopping list and statistics follow one rule.
 */
export const isWishedSeries = (m) => {
  if (!m) return false;
  if (m.wished !== undefined && m.wished !== null) return Boolean(Number(m.wished));
  return normalizeWishPriority(m.wish_priority) !== null && !(Number(m.owned_volumes) > 0);
};

/** "Wunschliste · hoch" for a wished series, '' otherwise. */
export const wishLabel = (m) => {
  if (!isWishedSeries(m)) return '';
  const p = normalizeWishPriority(m.wish_priority);
  return p === null || p === 0 ? t('Wunschliste') : t('Wunschliste · {priority}', { priority: t(PRIORITY_WORDS[p]) });
};

const publisherKey = (publisher, normalizePubName) => {
  const raw = String(publisher || '');
  // i18n-ignore: stored publisher value of the server's chips, compared as data
  return ((normalizePubName ? normalizePubName(raw) : raw.trim()) || 'Unbekannt').toLowerCase();
};

/**
 * Wished series of the shopping list (wished_series) filtered like the volume cards: publisher chip and search on title
 * and publisher. prioritySort keeps the server order (priority, then title) but is applied again for a stable result.
 */
export const filterWishedSeries = (list, { search = '', publisherFilter = 'ALL', normalizePubName, prioritySort = false, matches } = {}) => {
  const pub = String(publisherFilter || 'ALL').toLowerCase();
  const filtered = (Array.isArray(list) ? list : []).filter((s) => {
    if (publisherFilter !== 'ALL' && publisherKey(s.publisher, normalizePubName) !== pub) return false;
    return !search || !matches || matches(s, search);
  });
  return prioritySort ? [...filtered].sort((a, b) => (b.wish_priority || 0) - (a.wish_priority || 0)) : filtered;
};

/**
 * Publisher chips of the shopping list including the wished series: the chips from the volumes (with their counts)
 * plus wished_count, and chips for publishers that only have wished series. Order: volume chips first.
 */
export const mergeWishedPublisherChips = (chips, wishedSeries, normalizePubName) => {
  const result = (Array.isArray(chips) ? chips : []).map((c) => ({ ...c, wished_count: 0 }));
  for (const s of Array.isArray(wishedSeries) ? wishedSeries : []) {
    const key = publisherKey(s.publisher, normalizePubName);
    let chip = result.find((c) => String(c.publisher || '').toLowerCase() === key);
    if (!chip) {
      // i18n-ignore: stored publisher value (chip value and filter key), the display translates it
      chip = { publisher: normalizePubName ? normalizePubName(s.publisher || '') || 'Unbekannt' : (s.publisher || 'Unbekannt'), count: 0, total_price: 0, wished_count: 0 };
      result.push(chip);
    }
    chip.wished_count += 1;
  }
  return result;
};
