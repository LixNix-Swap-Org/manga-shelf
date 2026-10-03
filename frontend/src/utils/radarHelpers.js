import { formatGermanDate } from './collectionHelpers.js';

/** Manga-Passion calendar entries after the print-only / my-series / publisher / text filters. */
export const filterMpItems = (items, { mpPrintOnly, mpMySeriesOnly, mpPublisherFilter, mpSearch }) => items.filter(item => {
  if (mpPrintOnly && item.is_digital) return false;
  if (mpMySeriesOnly && !item.in_collection) return false;
  if (mpPublisherFilter !== 'ALL' && item.publisher.toLowerCase() !== mpPublisherFilter.toLowerCase()) return false;
  if (mpSearch) {
    const q = mpSearch.toLowerCase();
    const matchTitle = (item.title || '').toLowerCase().includes(q);
    const matchPub = (item.publisher || '').toLowerCase().includes(q);
    const matchVol = String(item.volume_number || '').toLowerCase().includes(q);
    if (!matchTitle && !matchPub && !matchVol) return false;
  }
  return true;
});

/** Groups calendar entries by release day (sorted), entries without a date go to one "unconfirmed" group. */
export const groupMpItemsByDate = (items) => {
  const mpDateGroups = [];
  const dateMap = new Map();
  items.forEach(item => {
    const dKey = item.date || 'Ohne Datum';
    if (!dateMap.has(dKey)) dateMap.set(dKey, []);
    dateMap.get(dKey).push(item);
  });
  Array.from(dateMap.keys()).sort().forEach(dKey => {
    mpDateGroups.push({
      dateKey: dKey,
      dateLabel: dKey !== 'Ohne Datum' ? formatGermanDate(dKey) : 'Erscheinungsdatum unbestätigt',
      items: dateMap.get(dKey)
    });
  });
  return mpDateGroups;
};

/** Entries of one personal radar group after the publisher / status / text filters. */
export const filterRadarItems = (items, { radarPublisherFilter, radarStatusFilter, radarSearch }) => items.filter(item => {
  const matchPub = radarPublisherFilter === 'ALL' || 
    item.effective_publisher.toLowerCase() === radarPublisherFilter.toLowerCase();
  const matchStatus = radarStatusFilter === 'ALL' || 
    item.status === radarStatusFilter;
  const matchSearch = !radarSearch || 
    item.manga_title.toLowerCase().includes(radarSearch.toLowerCase()) || 
    String(item.volume_number).includes(radarSearch) ||
    (item.effective_publisher && item.effective_publisher.toLowerCase().includes(radarSearch.toLowerCase()));
  return matchPub && matchStatus && matchSearch;
});
