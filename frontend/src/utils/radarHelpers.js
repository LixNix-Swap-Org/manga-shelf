import { formatGermanDate, GERMAN_MONTHS } from './collectionHelpers.js';
import { createSearch, prepareQuery } from './search.js';

// Same groups as the backend (core/handlers/mangaPassion.js import guard, core/radar.js isPreordered)
export const OWNED_STATUSES = ['Vorhanden', 'Gelesen'];
export const ORDERED_STATUSES = ['Vorbestellt', 'Bestellt'];
export const UPCOMING_STATUS = 'Erscheint bald';
export const MISSING_STATUS = 'Fehlt';

/** 'owned' | 'ordered' | 'upcoming' | 'missing' | null for a stored volume status. */
export const volumeStatusGroup = (status) => {
  if (OWNED_STATUSES.includes(status)) return 'owned';
  if (ORDERED_STATUSES.includes(status)) return 'ordered';
  if (status === UPCOMING_STATUS) return 'upcoming';
  if (status === MISSING_STATUS) return 'missing';
  return null;
};

export const isOrderedStatus = (status) => ORDERED_STATUSES.includes(status);

/** Which import buttons a calendar card offers for the matched volume's status. */
export const mpCardActions = (status) => {
  switch (volumeStatusGroup(status)) {
    case 'owned':
    case 'ordered':
      return { preorder: false, cart: false };
    case 'missing':
      return { preorder: true, cart: false };
    default:
      return { preorder: true, cart: true };
  }
};

/** Status chips of the personal radar; every radar item belongs to exactly one non-ALL chip. */
export const RADAR_STATUS_CHIPS = [
  { id: 'ALL', label: 'Alle Status' },
  { id: 'Vorbestellt', label: 'Vorbestellt' },
  { id: 'Erscheint bald', label: 'Erscheint bald' },
  { id: 'Geplant', label: 'Noch nicht bestellt' }
];

export const radarStatusChipOf = (status) => {
  if (isOrderedStatus(status)) return 'Vorbestellt';
  if (status === UPCOMING_STATUS) return 'Erscheint bald';
  return 'Geplant';
};

const matchesStatusChip = (status, chip) =>
  chip === 'ALL' || !RADAR_STATUS_CHIPS.some(c => c.id === chip) || radarStatusChipOf(status) === chip;

/** Label of the "received" button: a volume that was never ordered is bought, not delivered. */
export const deliveredLabel = (status) => (status === MISSING_STATUS ? 'Gekauft' : 'Geliefert');

const mpSearchIndex = createSearch(item => ({ primary: [item.title], secondary: [item.volume_number, item.publisher] }));

/** Manga-Passion calendar entries after the print-only / my-series / publisher / text filters. */
export const filterMpItems = (items, { mpPrintOnly, mpMySeriesOnly, mpPublisherFilter, mpSearch }) => {
  const query = prepareQuery(mpSearch);
  return items.filter(item => {
    if (mpPrintOnly && item.is_digital) return false;
    if (mpMySeriesOnly && !item.in_collection) return false;
    if (mpPublisherFilter !== 'ALL' && String(item.publisher || '').toLowerCase() !== mpPublisherFilter.toLowerCase()) return false;
    return !query || mpSearchIndex.matches(item, query);
  });
};

const NO_DATE_KEY = 'Ohne Datum';
const MONTH_ONLY_RE = /^(\d{4})-(\d{1,2})$/;

const monthOnlyLabel = (key) => {
  const [, y, m] = MONTH_ONLY_RE.exec(key);
  return `${GERMAN_MONTHS[Number(m) - 1] || m} ${y} (Tag noch offen)`;
};

// month-only entries after the dated ones of that month, undated entries last
const dateSortKey = (key) => {
  if (key === NO_DATE_KEY) return '9999';
  const m = MONTH_ONLY_RE.exec(key);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-99` : key;
};

/** Groups calendar entries by release day (sorted); month-only and undated entries get their own groups. */
export const groupMpItemsByDate = (items) => {
  const dateMap = new Map();
  items.forEach(item => {
    const dKey = item.date || NO_DATE_KEY;
    if (!dateMap.has(dKey)) dateMap.set(dKey, []);
    dateMap.get(dKey).push(item);
  });
  return Array.from(dateMap.keys())
    .sort((a, b) => dateSortKey(a).localeCompare(dateSortKey(b)))
    .map(dKey => ({
      dateKey: dKey,
      dateLabel: dKey === NO_DATE_KEY
        ? 'Erscheinungsdatum unbestätigt'
        : MONTH_ONLY_RE.test(dKey) ? monthOnlyLabel(dKey) : formatGermanDate(dKey),
      items: dateMap.get(dKey)
    }));
};

const radarSearchIndex = createSearch(item => ({
  primary: [item.manga_title],
  secondary: [item.volume_number, item.effective_publisher]
}));

/** Entries of one personal radar group after the publisher / status / text filters. */
export const filterRadarItems = (items, { radarPublisherFilter, radarStatusFilter, radarSearch }) => {
  const query = prepareQuery(radarSearch);
  return items.filter(item => {
    const matchPub = radarPublisherFilter === 'ALL' ||
      String(item.effective_publisher || '').toLowerCase() === radarPublisherFilter.toLowerCase();
    return matchPub && matchesStatusChip(item.status, radarStatusFilter) && (!query || radarSearchIndex.matches(item, query));
  });
};

/** Radar month groups with their filtered items (visibleItems); groups without a match are dropped. */
export const selectVisibleRadarGroups = (groups, filters) => (groups || [])
  .map(group => ({ ...group, visibleItems: filterRadarItems(group.items || [], filters) }))
  .filter(group => group.visibleItems.length > 0);

/** 'loading' | 'error' | 'idle' | 'empty' | 'list': what a radar list shows; a failed load is never "empty". */
export const radarViewState = ({ loading, error, hasData, count }) => {
  if (loading) return 'loading';
  if (!hasData) return error ? 'error' : 'idle';
  return count > 0 ? 'list' : 'empty';
};

/** Keeps a publisher filter only while the loaded list still has that publisher; a failed load (no list) keeps it. */
export const reconcilePublisherFilter = (filter, publishers, key = 'name') => {
  if (filter === 'ALL' || !Array.isArray(publishers) || publishers.length === 0) return filter;
  const wanted = String(filter).toLowerCase();
  return publishers.some(p => String(p?.[key] ?? '').toLowerCase() === wanted) ? filter : 'ALL';
};

/** Select options for a publisher filter: the active value stays selectable (count 0) when the list lacks it. */
export const publisherOptions = (publishers, key, filter) => {
  const options = (publishers || []).map(p => ({ value: p[key], label: `${p[key]} (${p.count})` }));
  if (filter !== 'ALL' && !options.some(o => String(o.value).toLowerCase() === String(filter).toLowerCase())) {
    options.push({ value: filter, label: `${filter} (0)` });
  }
  return options;
};

// the range GET /manga-passion/releases accepts
// same window as the server (GET /manga-passion/releases answers 400 outside it)
const THIS_YEAR = new Date().getFullYear();
export const RADAR_MIN_YEAR = THIS_YEAR - 5;
export const RADAR_MAX_YEAR = THIS_YEAR + 3;

/** Year options around the current year, always including the selected one, without gaps. */
export const buildYearOptions = (currentYear, selectedYear) => {
  const sel = Number.isFinite(selectedYear) ? selectedYear : currentYear;
  const from = Math.max(RADAR_MIN_YEAR, Math.min(currentYear - 2, sel));
  const to = Math.min(RADAR_MAX_YEAR, Math.max(currentYear + 3, sel));
  const years = [];
  for (let y = from; y <= to; y++) years.push(y);
  return years;
};

/** Month `delta` months away, or null outside the supported years. */
export const shiftMonth = (year, month, delta) => {
  const index = year * 12 + (month - 1) + delta;
  const y = Math.floor(index / 12);
  if (y < RADAR_MIN_YEAR || y > RADAR_MAX_YEAR) return null;
  return { year: y, month: (index % 12) + 1 };
};

export const isCurrentMonth = (year, month, now = new Date()) =>
  year === now.getFullYear() && month === now.getMonth() + 1;

export const mpMonthKey = (year, month) => `${year}-${month}`;

/** True when the loaded calendar belongs to the selected month (counts of another month must not show). */
export const mpMatchesSelection = (mpData, year, month) =>
  Boolean(mpData) && (mpData.year == null || (Number(mpData.year) === year && Number(mpData.month) === month));

/** Whether the radar view should load the selected month by itself (never again after a failure of that month). */
export const shouldAutoFetchMp = ({ active, offline, hasData, loading, failedKey, year, month }) =>
  Boolean(active) && !offline && !hasData && !loading && failedKey !== mpMonthKey(year, month);

/** Request ids: only the newest request of a sequence may update state. */
export const createRequestSequence = () => {
  let current = 0;
  return { next: () => ++current, isCurrent: (id) => id === current };
};

export const withId = (set, id) => new Set(set).add(id);
export const withoutId = (set, id) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

/** YYYY-MM-DD of the local calendar day (toISOString() gives the UTC day, wrong after local midnight). */
export const localISODate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** German short date for YYYY-MM-DD, YYYY-MM (or YYYY-M) and YYYY; other text is returned unchanged. */
export const formatReleaseDate = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return '–';
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(text);
  if (!m) return text;
  const [, y, mo, d] = m;
  if (d) return `${d.padStart(2, '0')}.${mo.padStart(2, '0')}.${y}`;
  if (mo) return `${mo.padStart(2, '0')}.${y}`;
  return y;
};

/** Series key of a calendar title, like the backend's titleKey() after dropping the eBook suffix. */
export const mpSeriesKey = (title) => String(title || '')
  .replace(/\s*\(eBook\)/i, '')
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]/gu, '');

const plainTitle = (title) => String(title || '').replace(/\s*\(eBook\)/i, '').trim().toLowerCase();

/** Whether the import of title `a` lands in the series of title `b` (same rule as the backend's findSeriesForImport). */
export const sameMpSeries = (a, b) => {
  if (plainTitle(a) && plainTitle(a) === plainTitle(b)) return true;
  const key = mpSeriesKey(a);
  return key.length >= 4 && key === mpSeriesKey(b);
};

/** Calendar entries after a successful import: the series link reaches every entry of that series, the volume only the clicked one. */
export const applyImportToMpItems = (items, imported, result, targetStatus) => items.map(it => {
  if (it.id === imported.id) {
    return {
      ...it,
      in_collection: true,
      match_kind: it.match_kind === 'prefix' || !it.match_kind ? 'exact' : it.match_kind,
      user_manga_id: result.manga_id,
      user_volume_id: result.volume_id,
      user_volume_status: result.status || targetStatus
    };
  }
  if (!it.user_manga_id && sameMpSeries(imported.title, it.title)) {
    return { ...it, in_collection: true, match_kind: 'exact', user_manga_id: result.manga_id };
  }
  return it;
});

/** Message for an import the server did not apply as asked, or that joined an existing series. */
export const importNotice = (item, result) => {
  const name = `„${item.title}“ ${item.volume_number ?? ''}`.trim();
  if (result?.skipped_owned) return `${name} ist bereits im Regal – Status nicht geändert.`;
  if (result?.skipped_ordered) return `${name} ist bereits bestellt – Status nicht geändert.`;
  if (result?.series_created === false && (!item.user_manga_id || item.match_kind === 'prefix')) {
    return `${name} wurde zur vorhandenen Reihe hinzugefügt.`;
  }
  return null;
};
