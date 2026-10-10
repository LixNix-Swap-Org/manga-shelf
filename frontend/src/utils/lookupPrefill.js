import { normalizeLookupStatus } from '../hooks/useMangaData';
import { prefillTotalVolumes } from './scanHelpers';
import { isMpEdition, workKeyOfHit } from './editions';

const SOURCE_LABELS = { anilist: 'AniList', mal: 'MyAnimeList' };
const knownValue = (value) => (value && value !== 'Unbekannt' ? value : '');

/** Badges of a non-Manga-Passion lookup hit: its own source, then the sources the server merged into it (also_on). */
export function lookupSourceLabels(item) {
  const own = item?.source_label || SOURCE_LABELS[item?.source];
  const merged = (Array.isArray(item?.also_on) ? item.also_on : []).map((source) => SOURCE_LABELS[source]).filter(Boolean);
  return [...new Set([own, ...merged].filter(Boolean))];
}

/** The add form after applying a lookup hit to `base` (the current form, or at least its edition language). */
export function hitToForm(hit, base = {}) {
  const form = {
    ...base,
    title: hit.title || base.title,
    alt_title: hit.alt_title || base.alt_title,
    author: hit.author || base.author,
    publisher: knownValue(hit.publisher) || base.publisher,
    status: normalizeLookupStatus(hit.status, base.status),
    total_volumes: prefillTotalVolumes(hit, base.total_volumes),
    description: hit.description || base.description,
    cover_image: hit.cover_image || base.cover_image,
    manga_passion_id: isMpEdition(base) ? (hit.manga_passion_id || null) : null,
    work_key: hit.source === 'manga_passion' ? null : (hit.work_key || workKeyOfHit(hit))
  };
  return Object.fromEntries(Object.entries(form).filter(([, value]) => value !== undefined));
}
