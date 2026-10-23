import { normalizeLookupStatus } from '../hooks/useMangaData';
import { prefillTotalVolumes } from './scanHelpers';
import { isMpEdition, workKeyOfHit } from './editions';

const SOURCE_LABELS = { anilist: 'AniList', mal: 'MyAnimeList' };
const knownValue = (value) => (value && value !== 'Unbekannt' ? value : '');
const ownLabel = (item) => item?.source_label || SOURCE_LABELS[item?.source];

/** Badges of a non-Manga-Passion lookup hit: its own source, then the sources the server merged into it (also_on). */
export function lookupSourceLabels(item) {
  const own = ownLabel(item);
  const merged = (Array.isArray(item?.also_on) ? item.also_on : []).map((source) => SOURCE_LABELS[source]).filter(Boolean);
  return [...new Set([own, ...merged].filter(Boolean))];
}

/** Badges of the sources the server folded into a hit (also_on), without the hit's own source. */
export const alsoOnLabels = (item) => lookupSourceLabels(item).filter((label) => label !== ownLabel(item));

/** The add form after applying a lookup hit to `base` (the current form, or at least its edition language). */
export function hitToForm(hit, base = {}) {
  const form = {
    ...base,
    title: hit.title || base.title,
    alt_title: hit.alt_title || base.alt_title,
    author: hit.author || base.author,
    publisher: knownValue(hit.publisher) || base.publisher,
    status: normalizeLookupStatus(hit.status, base.status),
    // a manhwa or manhua hit suggests the webtoon format (no hit switches a chosen format back); its print volume count
    // says nothing about the webtoon
    total_volumes: hit.series_format === 'webtoon' ? base.total_volumes : prefillTotalVolumes(hit, base.total_volumes),
    format: hit.series_format === 'webtoon' ? 'webtoon' : base.format,
    total_chapters: hit.total_chapters ? String(hit.total_chapters) : base.total_chapters,
    tags: hit.tags || '',
    description: hit.description || base.description,
    cover_image: hit.cover_image || base.cover_image,
    manga_passion_id: isMpEdition({ ...base, format: hit.series_format === 'webtoon' ? 'webtoon' : base.format }) ? (hit.manga_passion_id || null) : null,
    work_key: hit.source === 'manga_passion' ? (hit.work_key || null) : (hit.work_key || workKeyOfHit(hit))
  };
  return Object.fromEntries(Object.entries(form).filter(([, value]) => value !== undefined));
}

/** Volumes released so far of a running series hit whose total the prefill leaves open, else null. */
export function releasedSoFar(hit) {
  const count = Number(hit?.total_volumes);
  return Number.isInteger(count) && count > 0 && prefillTotalVolumes(hit, '') === '' ? count : null;
}
