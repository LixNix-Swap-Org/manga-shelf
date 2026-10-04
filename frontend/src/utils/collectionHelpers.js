import { normalizePubName, getSeriesProgress } from './volumeHelpers.js';
import { formatDate, monthNames } from './format.js';
import { createSearch, prepareQuery, naturalCollator } from './search.js';

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

const SERIES_STATUSES = ['Laufend', 'Abgeschlossen', 'Pausiert', 'Geplant', 'Abgebrochen'];

/** Series counts per status filter chip. */
export const getFilterCounts = (mangas) => {
  const counts = { ALL: mangas.length, UNREAD: 0, READ_ALL: 0 };
  for (const s of SERIES_STATUSES) counts[s] = 0;
  for (const m of mangas) {
    if (SERIES_STATUSES.includes(m.status)) counts[m.status]++;
    const { complete, hasUnread } = getReadState(m);
    if (hasUnread) counts.UNREAD++;
    if (complete) counts.READ_ALL++;
  }
  return counts;
};

export const STATUS_TABS = [
  { id: 'ALL', label: 'Alle' },
  { id: 'Laufend', label: 'Laufend' },
  { id: 'Abgeschlossen', label: 'Abgeschlossen' },
  { id: 'UNREAD', label: 'Ungelesen' },
  { id: 'READ_ALL', label: 'Gelesen' },
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
export const SORT_OPTIONS = [
  { value: 'newest_first', label: '✨ Zuletzt hinzugefügt' },
  { value: 'title_asc', label: '🔤 Titel (A → Z)' },
  { value: 'title_desc', label: '🔤 Titel (Z → A)' },
  { value: 'progress_desc', label: '📖 Lesefortschritt (höchster %)' },
  { value: 'progress_asc', label: '📖 Ungelesen zuerst' },
  { value: 'completion_desc', label: '📈 Sammlung komplett (höchster %)' },
  { value: 'completion_asc', label: '📉 Sammlung komplett (niedrigster %)' },
  { value: 'volumes_desc', label: '📚 Meiste Bände' },
  { value: 'value_desc', label: '💰 Höchster Wert (€)' },
  { value: 'publisher_asc', label: '🏢 Verlag (A → Z)' },
  { value: 'oldest_first', label: '⏳ Zuerst hinzugefügt' }
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

// volume_search (ISBNs, notes, named volumes of the series) is used when the list response carries it
const volumeTerms = (value) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : []);

export const seriesSearch = createSearch(m => ({
  primary: [m.title, m.alt_title],
  secondary: [m.author, m.publisher, m.publisher ? normalizePubName(m.publisher) : null, m.tags, ...volumeTerms(m.volume_search)]
}));

/**
 * Search, status/publisher filter and sort of the series list. With a search, title-prefix hits come first, then
 * title hits, then hits in other fields, then typo hits; the chosen sort orders each of these groups.
 */
export const filterAndSortMangas = (mangas, { search, statusFilter, publisherFilter, sortBy }) => {
  const query = prepareQuery(search);
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
      } else if (statusFilter && statusFilter !== 'ALL' && m.status !== statusFilter) {
        return false;
      }

      if (publisherKey !== null && normalizePubName(m.publisher).toLowerCase() !== publisherKey) return false;
      return true;
    })
    .sort(query ? (a, b) => ranks.get(a) - ranks.get(b) || compare(a, b) : compare);
};

/** Totals for the quick-stats bar. */
export const getCollectionTotals = (mangas) => {
  let owned = 0;
  let val = 0;
  let completed = 0;
  for (let i = 0; i < mangas.length; i++) {
    const m = mangas[i];
    owned += (m.owned_volumes || 0);
    val += (m.total_value || 0);
    if (m.status === 'Abgeschlossen') completed++;
  }
  return {
    totalOwnedVolumes: owned,
    totalCollectionValue: val,
    completedSeries: completed
  };
};
