import { normalizePubName, getSeriesProgress } from './volumeHelpers.js';
import { formatDate, monthNames } from './format.js';
import { createSearch, prepareQuery, naturalCollator } from './search.js';
import { isWishedSeries } from './priority.js';
import { COLLECTING_OPTIONS, collectingOf, splitAuthors, authorShelfPath } from './seriesMeta.js';
import { collectTags, hasAllTags, splitTags } from './tags.js';
import { mangaStatusLabel, collectingLabel } from './enumLabels.js';
import { t } from '../i18n/index.js';
import { editionCurrency, editionLanguage } from './editions.js';

export const GERMAN_MONTHS = monthNames('long');

/** 'YYYY-MM-DD' -> 'Freitag, 02. Oktober 2026'; other input is returned unchanged. */
export const formatGermanDate = (dateStr) => {
  if (!dateStr) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr).trim()) ? formatDate(dateStr, { long: true }) : dateStr;
};

/** Badge classes for a series status. */
export const getStatusBadge = (status) => {
  switch (status) {
    case 'Abgeschlossen':
      return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
    case 'Pausiert':
      return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    case 'Geplant':
      return 'bg-purple-500/20 text-purple-300 border-purple-500/40';
    case 'Abgebrochen':
      return 'bg-rose-500/20 text-rose-300 border-rose-500/40';
    default:
      return 'bg-sky-500/20 text-sky-300 border-sky-500/40';
  }
};

/**
 * Reading state of a series, based on owned volumes only: GET /api/mangas counts owned_volumes live and
 * read_volume_count only for owned volumes. Wishlist-only series (0 owned) are neither read nor unread.
 */
export const getReadState = (m) => {
  const owned = Math.max(0, Number(m?.owned_volumes) || 0);
  const read = Math.min(owned, Math.max(0, Number(m?.read_volume_count) || 0));
  const pct = owned === 0 ? 0 : Math.min(100, Math.round((read / owned) * 100));
  return { owned, read, pct, complete: owned > 0 && read >= owned, hasUnread: owned > 0 && read < owned };
};

/** Reading progress of a series (0 - 100 %). */
export const getMangaProgress = (m) => getReadState(m).pct;

/** Publishers of the collection, deduplicated case-insensitively and canonicalized. */
export const getAvailablePublishers = (mangas) => {
  const pubMap = new Map();
  mangas.forEach(m => {
    const raw = m.publisher && m.publisher.trim();
    if (!raw) return;
    const canonical = normalizePubName(raw);
    const key = canonical.toLowerCase();
    if (!pubMap.has(key)) {
      pubMap.set(key, canonical);
    }
  });
  return Array.from(pubMap.values()).sort(naturalCollator.compare);
};

/**
 * The option of availablePublishers a (possibly stale, differently cased) stored publisher filter stands for,
 * or 'ALL' when that publisher is no longer in the collection.
 */
export const sanitizePublisherFilter = (value, availablePublishers) => {
  if (!value || value === 'ALL') return 'ALL';
  const key = normalizePubName(value).toLowerCase();
  return availablePublishers.find(p => p.toLowerCase() === key) || 'ALL';
};

// i18n
const SERIES_STATUSES = ['Laufend', 'Abgeschlossen', 'Pausiert', 'Geplant', 'Abgebrochen'];

/** Series counts per status filter chip (WISHLIST = wished series, see isWishedSeries). */
export const getFilterCounts = (mangas) => {
  const counts = { ALL: mangas.length, UNREAD: 0, READ_ALL: 0, WISHLIST: 0 };
  for (const s of SERIES_STATUSES) counts[s] = 0;
  for (const m of mangas) {
    if (SERIES_STATUSES.includes(m.status)) counts[m.status]++;
    const { complete, hasUnread } = getReadState(m);
    if (hasUnread) counts.UNREAD++;
    if (complete) counts.READ_ALL++;
    if (isWishedSeries(m)) counts.WISHLIST++;
  }
  return counts;
};

// i18n
export const STATUS_TABS = [
  { id: 'ALL', label: 'Alle' },
  { id: 'Laufend', label: 'Laufend' },
  { id: 'Abgeschlossen', label: 'Abgeschlossen' },
  { id: 'UNREAD', label: 'Ungelesen' },
  { id: 'READ_ALL', label: 'Gelesen' },
  { id: 'WISHLIST', label: 'Wunschliste' },
  { id: 'Pausiert', label: 'Pausiert' },
  { id: 'Geplant', label: 'Geplant' },
  { id: 'Abgebrochen', label: 'Abgebrochen' }
];

export const isStatusFilter = (value) => STATUS_TABS.some(t => t.id === value);

/** Status chips to show: 'Alle', every chip with series, and the active chip even when its count dropped to 0. */
export const getStatusTabs = (filterCounts, statusFilter) =>
  STATUS_TABS
    .map(tab => ({ ...tab, count: filterCounts[tab.id] || 0 }))
    .filter(tab => tab.id === 'ALL' || tab.count > 0 || tab.id === statusFilter);

/** Sort choices of the collection toolbar ('progress' = reading progress, 'completion' = collection progress of the card). */
// i18n
export const SORT_OPTIONS = [
  { value: 'newest_first', label: 'Zuletzt hinzugefügt' },
  { value: 'title_asc', label: 'Titel (A → Z)' },
  { value: 'title_desc', label: 'Titel (Z → A)' },
  { value: 'progress_desc', label: 'Lesefortschritt (höchster %)' },
  { value: 'progress_asc', label: 'Ungelesen zuerst' },
  { value: 'completion_desc', label: 'Sammlung komplett (höchster %)' },
  { value: 'completion_asc', label: 'Sammlung komplett (niedrigster %)' },
  { value: 'volumes_desc', label: 'Meiste Bände' },
  { value: 'value_desc', label: 'Höchster Wert (€)' },
  { value: 'publisher_asc', label: 'Verlag (A → Z)' },
  { value: 'oldest_first', label: 'Zuerst hinzugefügt' }
];

export const isSortOption = (value) => SORT_OPTIONS.some(o => o.value === value);

const byTitle = (a, b) => naturalCollator.compare(a.title || '', b.title || '');

// series without a target (no total, no numbered volume) have no collection % and always go last
const byCompletion = (a, b, dir) => {
  const pa = getSeriesProgress(a).pct;
  const pb = getSeriesProgress(b).pct;
  if (pa === null || pb === null) return (pa === null) - (pb === null) || byTitle(a, b);
  return dir * (pa - pb) || byTitle(a, b);
};

const compareBy = (sortBy) => (a, b) => {
  switch (sortBy) {
    case 'newest_first':
      return (b.id || 0) - (a.id || 0);
    case 'oldest_first':
      return (a.id || 0) - (b.id || 0);
    case 'progress_desc':
      return getMangaProgress(b) - getMangaProgress(a) || byTitle(a, b);
    case 'progress_asc':
      return getMangaProgress(a) - getMangaProgress(b) || byTitle(a, b);
    case 'completion_desc':
      return byCompletion(a, b, -1);
    case 'completion_asc':
      return byCompletion(a, b, 1);
    case 'title_desc':
      return byTitle(b, a);
    case 'publisher_asc':
      return naturalCollator.compare(normalizePubName(a.publisher) || 'ZZZ', normalizePubName(b.publisher) || 'ZZZ') || byTitle(a, b);
    case 'volumes_desc':
      return (b.owned_volumes || 0) - (a.owned_volumes || 0) || byTitle(a, b);
    case 'value_desc':
      return (b.total_value || 0) - (a.total_value || 0) || byTitle(a, b);
    case 'title_asc':
    default:
      return byTitle(a, b);
  }
};

// volume_search: ISBNs, named volumes and notes of the series (offline copy rows, or merged by withVolumeSearch)
const volumeTerms = (value) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : []);

export const seriesSearch = createSearch(m => ({
  primary: [m.title, m.alt_title],
  secondary: [m.author, m.publisher, m.publisher ? normalizePubName(m.publisher) : null, m.tags, ...splitTags(m.tags), ...volumeTerms(m.volume_search)]
}));

/**
 * The list with the search index of GET /api/mangas/volume-search (id -> text, see volumeSearchMap) merged in as
 * volume_search. Rows without an entry stay the same object, so their search index is reused.
 */
export const withVolumeSearch = (mangas, index) => {
  if (!index?.size || !Array.isArray(mangas)) return mangas;
  return mangas.map((m) => {
    const text = index.get(String(m.id));
    return text === undefined || text === m.volume_search ? m : { ...m, volume_search: text };
  });
};

export { COLLECTING_OPTIONS, collectingOf, splitAuthors, authorShelfPath };

/** Collection filter of the toolbar ("Sammelstand"); counts come from getCollectCounts. */
// i18n
export const COLLECT_FILTERS = [
  { id: 'ALL', label: 'Alle Reihen' },
  { id: 'gaps', label: 'Mit Lücken' },
  { id: 'preorder', label: 'Mit Vorbestellungen' },
  { id: 'complete', label: 'Komplett' },
  { id: 'pausiert', label: 'Pausiert' },
  { id: 'abgebrochen', label: 'Nicht mehr gesammelt' }
];
export const isCollectFilter = (value) => COLLECT_FILTERS.some(f => f.id === value);
/** Shown label of a collect filter; the collecting states use collectingLabel ('Pausiert' in its collecting sense). */
export const collectFilterLabel = (f) => (f.id === 'pausiert' || f.id === 'abgebrochen' ? collectingLabel(f.id) : t(f.label));

/**
 * Still something to buy: a missing volume, or a known total that is not reached yet. A dropped series has no gaps;
 * a complete one (spec A2) neither, even when a stale missing entry is left over.
 */
export const hasCollectionGaps = (m) => {
  if (collectingOf(m) === 'abgebrochen' || isSeriesComplete(m)) return false;
  if ((Number(m?.missing_count) || 0) > 0) return true;
  const total = Number(m?.total_volumes) || 0;
  return total > 0 && (Number(m?.regular_owned ?? m?.owned_volumes) || 0) < total;
};

export const matchesCollectFilter = (m, filter) => {
  switch (filter) {
    case 'gaps': return hasCollectionGaps(m);
    case 'preorder': return (Number(m?.preorder_count) || 0) > 0;
    case 'complete': return isSeriesComplete(m);
    case 'pausiert':
    case 'abgebrochen': return collectingOf(m) === filter;
    default: return true;
  }
};

export const getCollectCounts = (mangas) => {
  const counts = {};
  for (const f of COLLECT_FILTERS) counts[f.id] = 0;
  for (const m of mangas) {
    for (const f of COLLECT_FILTERS) if (matchesCollectFilter(m, f.id)) counts[f.id]++;
  }
  return counts;
};

const authorKey = (name) => String(name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export const matchesAuthor = (m, author) => {
  const key = authorKey(author);
  return !key || splitAuthors(m?.author).some(a => authorKey(a) === key);
};

/** Genres/tags of the collection with series counts for the toolbar: [{ tag, count }], most used first. */
export const getAvailableTags = (mangas) => collectTags(mangas);

/** The tag filter as kept in the URL ("Abenteuer,Fantasy") and in state (['Abenteuer', 'Fantasy']). */
export const parseTagFilter = (value) => (Array.isArray(value) ? splitTags(value) : splitTags(String(value || '').split(',')));
export const formatTagFilter = (tags) => parseTagFilter(tags).join(',');

// Search, filters and sort of the series list (tags: AND). A search ranks title-prefix, title, other-field and typo
// hits in that order; the chosen sort orders each group.
export const filterAndSortMangas = (mangas, { search, statusFilter, publisherFilter, sortBy, collectFilter = 'ALL', authorFilter = '', tagFilter = [], languageFilter = 'ALL' }) => {
  const query = prepareQuery(search);
  const tags = parseTagFilter(tagFilter);
  const publisherKey = publisherFilter && publisherFilter !== 'ALL' ? normalizePubName(publisherFilter).toLowerCase() : null;
  const ranks = new Map();
  const compare = compareBy(sortBy);
  return mangas
    .filter(m => {
      if (query) {
        const rank = seriesSearch.rank(m, query);
        if (rank === null) return false;
        ranks.set(m, rank);
      }

      if (statusFilter === 'UNREAD') {
        if (!getReadState(m).hasUnread) return false;
      } else if (statusFilter === 'READ_ALL') {
        if (!getReadState(m).complete) return false;
      } else if (statusFilter === 'WISHLIST') {
        if (!isWishedSeries(m)) return false;
      } else if (statusFilter && statusFilter !== 'ALL' && m.status !== statusFilter) {
        return false;
      }

      if (publisherKey !== null && normalizePubName(m.publisher).toLowerCase() !== publisherKey) return false;
      if (!matchesCollectFilter(m, collectFilter)) return false;
      if (authorFilter && !matchesAuthor(m, authorFilter)) return false;
      if (tags.length && !hasAllTags(m, tags)) return false;
      if (languageFilter && languageFilter !== 'ALL' && editionLanguage(m) !== languageFilter) return false;
      return true;
    })
    .sort(query ? (a, b) => ranks.get(a) - ranks.get(b) || compare(a, b) : compare);
};

/**
 * A completely collected series, the rule of the statistics (completed_series, spec A2): the total number of volumes is
 * known and at least that many regular volumes are owned. The publication status does not count.
 */
export function isSeriesComplete(m) {
  const total = Number(m?.total_volumes) || 0;
  return total > 0 && (Number(m?.regular_owned ?? m?.owned_volumes) || 0) >= total;
}

// i18n
export const GROUP_OPTIONS = [
  { value: 'none', label: 'Keine Gruppierung' },
  { value: 'publisher', label: 'Verlag' },
  { value: 'author', label: 'Autor' },
  { value: 'status', label: 'Erscheinungsstatus' }
];
export const isGroupOption = (value) => GROUP_OPTIONS.some(o => o.value === value);

// i18n
const GROUP_FALLBACK = { publisher: 'Ohne Verlag', author: 'Ohne Autor', status: 'Ohne Status' };

const displayGroupLabel = (label, groupBy, empty) => {
  if (empty) return t(label);
  return groupBy === 'status' ? mangaStatusLabel(label) : label;
};

const groupLabelOf = (m, groupBy) => {
  if (groupBy === 'publisher') return m.publisher ? normalizePubName(m.publisher) : '';
  if (groupBy === 'author') return splitAuthors(m.author).join(', ');
  if (groupBy === 'status') return m.status ? String(m.status) : '';
  return '';
};

// Sections [{ key, label, items }] of a sorted list, keeping its order inside; sections are alphabetical (status:
// chip order), the one without a value last; 'none' gives a single unlabeled section. Sorting uses the stored values,
// the label is the shown text (status through mangaStatusLabel, the fallback through t()).
export const groupMangas = (list, groupBy) => {
  if (!isGroupOption(groupBy) || groupBy === 'none') return [{ key: 'all', label: '', items: list }];
  const sections = new Map();
  for (const m of list) {
    const label = groupLabelOf(m, groupBy);
    const key = label ? label.toLowerCase() : '';
    if (!sections.has(key)) sections.set(key, { key: key || '~', label: label || GROUP_FALLBACK[groupBy], items: [], empty: !label });
    sections.get(key).items.push(m);
  }
  const rank = (s) => (groupBy === 'status' && SERIES_STATUSES.includes(s.label) ? SERIES_STATUSES.indexOf(s.label) : SERIES_STATUSES.length);
  return Array.from(sections.values())
    .sort((a, b) => (a.empty - b.empty) || (rank(a) - rank(b)) || naturalCollator.compare(a.label, b.label))
    .map(({ empty, ...section }) => ({ ...section, label: displayGroupLabel(section.label, groupBy, empty) }));
};

/** Edition language filter: 'ALL' or an ISO 639-1 code (URL ?lang=en). */
export const isLanguageFilter = (value) => value === 'ALL' || /^[a-z]{2}$/.test(String(value || ''));

/** Filter state kept in the URL next to localStorage, so Back and shared links keep it ('q' stays in sessionStorage). */
export const FILTER_DEFAULTS = { status: 'ALL', publisher: 'ALL', collect: 'ALL', author: '', tags: '', lang: 'ALL', sort: 'title_asc', group: 'none' };
const FILTER_VALID = {
  status: isStatusFilter,
  publisher: (v) => v.length <= 300,
  collect: isCollectFilter,
  author: (v) => v.length <= 300,
  tags: (v) => v.length <= 500,
  lang: (v) => isLanguageFilter(v),
  sort: isSortOption,
  group: isGroupOption
};

const parseParams = (search) => {
  try {
    return new URLSearchParams(search || '');
  } catch (_) {
    return new URLSearchParams();
  }
};

/** The valid filter values of a query string; absent or invalid keys are left out. */
export const readFilterParams = (search) => {
  const params = parseParams(search);
  const out = {};
  for (const key of Object.keys(FILTER_DEFAULTS)) {
    const value = params.get(key);
    if (value !== null && value.trim() !== '' && FILTER_VALID[key](value)) out[key] = value;
  }
  return out;
};

/** Query string with the filter values set (defaults removed); other parameters such as view stay. */
export const writeFilterParams = (search, filters) => {
  const params = parseParams(search);
  for (const key of Object.keys(FILTER_DEFAULTS)) {
    const value = filters[key];
    if (value === undefined) continue;
    if (value === null || value === '' || value === FILTER_DEFAULTS[key]) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
};
/** Totals for the quick-stats bar; the value counts euro editions only (no conversion, see getOtherCurrencyTotals). */
export const getCollectionTotals = (mangas) => {
  let owned = 0;
  let val = 0;
  let completed = 0;
  for (let i = 0; i < mangas.length; i++) {
    const m = mangas[i];
    owned += (m.owned_volumes || 0);
    if (editionCurrency(m) === 'EUR') val += (m.total_value || 0);
    if (isSeriesComplete(m)) completed++;
  }
  return {
    totalOwnedVolumes: owned,
    totalCollectionValue: val,
    completedSeries: completed
  };
};

/**
 * Owned value of the editions in other currencies than the euro: [{ currency, value }], largest first. `valueOf` reads
 * another amount (a shopping item's price); rows carry the currency of their series.
 */
export const getOtherCurrencyTotals = (mangas, valueOf = (m) => m.total_value) => {
  const sums = new Map();
  for (const m of mangas || []) {
    const currency = editionCurrency(m);
    const value = Number(valueOf(m));
    if (currency === 'EUR' || !(value > 0)) continue;
    sums.set(currency, (sums.get(currency) || 0) + value);
  }
  return [...sums].map(([currency, value]) => ({ currency, value })).sort((a, b) => b.value - a.value);
};
