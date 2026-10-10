import { seriesSearch } from './collectionHelpers';
import { editionLanguage } from './editions';

export const MAX_ONLINE_HITS = 10;

const sameId = (a, b) => a !== null && a !== undefined && a !== '' && String(a) === String(b);

/** How a hit relates to the collection for the default edition `language`: { kind: 'owned' | 'otherEdition' | 'similar', manga } or null. */
export function matchHit(hit, mangas, { language } = {}) {
  if (!hit || !Array.isArray(mangas) || mangas.length === 0) return null;
  const list = mangas.filter(Boolean);
  if (hit.manga_passion_id) {
    const owned = list.find((m) => sameId(m.manga_passion_id, hit.manga_passion_id));
    if (owned) return { kind: 'owned', manga: owned };
  }
  if (hit.work_key) {
    const editions = list.filter((m) => m.work_key && m.work_key === hit.work_key);
    const own = editions.find((m) => editionLanguage(m) === language);
    if (own) return { kind: 'owned', manga: own };
    if (editions.length > 0) return { kind: 'otherEdition', manga: editions[0] };
  }
  if (!hit.title) return null;
  let best = null;
  let bestRank = 2;
  for (const m of list) {
    const rank = seriesSearch.rank(m, hit.title);
    if (rank !== null && rank < bestRank) {
      best = m;
      bestRank = rank;
      if (rank === 0) break;
    }
  }
  return best ? { kind: 'similar', manga: best } : null;
}

/** The hits the online section shows: at most ten, in the order of the answer. */
export const visibleHits = (hits) => (Array.isArray(hits) ? hits.filter((h) => h && typeof h === 'object').slice(0, MAX_ONLINE_HITS) : []);

/** Seconds of a Retry-After header (delta seconds or an HTTP date), else `fallback`. */
export function retryAfterSeconds(value, fallback = 60, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return Math.max(1, Number(text));
  const at = Date.parse(text);
  if (Number.isFinite(at)) return Math.max(1, Math.ceil((at - now) / 1000));
  return fallback;
}
