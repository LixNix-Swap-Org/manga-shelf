import { normalizePubName } from './volumeHelpers.js';

export const GERMAN_MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
];

export const formatGermanDate = (dateStr) => {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  const weekdays = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const weekday = weekdays[d.getDay()] || '';
  const day = parts[2];
  const monthName = GERMAN_MONTHS[Number(parts[1]) - 1] || parts[1];
  const year = parts[0];
  return `${weekday}, ${day}. ${monthName} ${year}`;
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
    default:
      return 'bg-sky-500/20 text-sky-300 border-sky-500/40';
  }
};

/** Reading progress of a series (0 - 100 %). */
export const getMangaProgress = (m) => {
  const total = m.owned_volumes || m.volume_count || 0;
  if (total === 0) return 0;
  const read = m.read_volume_count || 0;
  return Math.min(100, Math.round((read / total) * 100));
};

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
  return Array.from(pubMap.values()).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
};

/** Series counts per status filter chip. */
export const getFilterCounts = (mangas) => ({
  ALL: mangas.length,
  Laufend: mangas.filter(m => m.status === 'Laufend').length,
  Abgeschlossen: mangas.filter(m => m.status === 'Abgeschlossen').length,
  UNREAD: mangas.filter(m => {
    const total = m.owned_volumes || m.volume_count || 0;
    return total > 0 && (m.read_volume_count || 0) < total;
  }).length,
  READ_ALL: mangas.filter(m => {
    const total = m.owned_volumes || m.volume_count || 0;
    return total > 0 && (m.read_volume_count || 0) >= total;
  }).length,
  Pausiert: mangas.filter(m => m.status === 'Pausiert').length,
  Geplant: mangas.filter(m => m.status === 'Geplant').length,
});

/** Search, status/publisher filter and sort of the series list. */
export const filterAndSortMangas = (mangas, { search, statusFilter, publisherFilter, sortBy }) => {
  return mangas
    .filter(m => {
      const q = search.toLowerCase().trim();
      const matchesSearch = 
        !q ||
        m.title.toLowerCase().includes(q) || 
        (m.alt_title && m.alt_title.toLowerCase().includes(q)) ||
        (m.author && m.author.toLowerCase().includes(q)) ||
        (m.publisher && m.publisher.toLowerCase().includes(q));
      
      if (!matchesSearch) return false;

      // Status Filter logic
      if (statusFilter === 'UNREAD') {
        const total = m.owned_volumes || m.volume_count || 0;
        if (total === 0 || (m.read_volume_count || 0) >= total) return false;
      } else if (statusFilter === 'READ_ALL') {
        const total = m.owned_volumes || m.volume_count || 0;
        if (total === 0 || (m.read_volume_count || 0) < total) return false;
      } else if (statusFilter !== 'ALL' && m.status !== statusFilter) {
        return false;
      }

      // Publisher Filter logic
      if (publisherFilter !== 'ALL') {
        const p = normalizePubName(m.publisher);
        if (p.toLowerCase() !== publisherFilter.toLowerCase()) return false;
      }
      return true;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'newest_first':
          return (b.id || 0) - (a.id || 0);
        case 'oldest_first':
          return (a.id || 0) - (b.id || 0);
        case 'progress_desc':
          return getMangaProgress(b) - getMangaProgress(a) || (a.title || '').localeCompare(b.title || '');
        case 'progress_asc':
          return getMangaProgress(a) - getMangaProgress(b) || (a.title || '').localeCompare(b.title || '');
        case 'title_desc':
          return (b.title || '').localeCompare(a.title || '');
        case 'publisher_asc':
          return (a.publisher || 'ZZZ').localeCompare(b.publisher || 'ZZZ') || (a.title || '').localeCompare(b.title || '');
        case 'volumes_desc':
          return (b.owned_volumes || 0) - (a.owned_volumes || 0);
        case 'value_desc':
          return (b.total_value || 0) - (a.total_value || 0);
        case 'title_asc':
        default:
          return (a.title || '').localeCompare(b.title || '');
      }
    });
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
