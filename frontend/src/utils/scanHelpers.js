import { getVolumeDisplayTitle } from './volumeHelpers.js';
import { formatDayMonth, formatTime } from './format.js';
import { createSearch, prepareQuery } from './search.js';

/** Series name of a catalogue hit: the catalogue's series if it knows one, else the book title (the DNB title is often only the volume title). */
export const scanSeriesTitle = (book) => String(book?.series || book?.title || '').trim();

/**
 * Prefill for "Neuen Manga anlegen" from an ISBN lookup (`/api/lookup/isbn`): series fields plus the scanned volume.
 * Open Library answers an unknown ISBN with a 1x1 placeholder unless `default=false` is set, so a missing cover 404s instead.
 */
export const buildScanPrefill = (book, isbn) => {
  const cover = book?.cover_url
    ? (/openlibrary\.org/.test(book.cover_url) && !/default=/.test(book.cover_url) ? `${book.cover_url}?default=false` : book.cover_url)
    : '';
  return {
    form: {
      title: scanSeriesTitle(book),
      author: book?.author || '',
      publisher: book?.publisher || '',
      cover_image: cover
    },
    volume: {
      enabled: true,
      volume_number: book?.volume_number_known ? String(book.volume_number) : '',
      status: 'Vorhanden',
      isbn: isbn || '',
      price: book?.price != null ? String(book.price) : '',
      pages: book?.pages ? String(book.pages) : '',
      release_year: book?.release_year ? String(book.release_year) : '',
      publisher: book?.publisher || ''
    }
  };
};

/** Body for `POST /api/volumes` from the scanned-volume form of the add dialog. */
export const buildScanVolumePayload = (mangaId, vol) => ({
  manga_id: mangaId,
  volume_number: String(vol.volume_number).trim(),
  status: vol.status || 'Vorhanden',
  isbn: vol.isbn || null,
  price: vol.price || null,
  pages: vol.pages || null,
  release_year: vol.release_year || null,
  publisher: vol.publisher || null
});

/**
 * Total volumes to prefill from a catalogue hit. For a running series the catalogue only knows the volumes released so far
 * (a fresh Dragon Maid scan listed "1"), which would show "1/1 complete"; leave it open instead.
 */
export const prefillTotalVolumes = (item, previous = '') => {
  if (!item?.total_volumes) return previous;
  if (/laufend|ongoing|releasing/i.test(String(item.status || ''))) return previous;
  return String(item.total_volumes);
};

/** Stored statuses that mean "in the collection" ('Gelesen' is the legacy alias of 'Vorhanden'). */
export const OWNED_STATUSES = ['Vorhanden', 'Gelesen'];

const isbnDigits = (value) => String(value || '').replace(/[^0-9X]/gi, '').toUpperCase();

const ean13CheckDigit = (twelve) => {
  const sum = [...twelve].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return String((10 - (sum % 10)) % 10);
};

const isValidIsbn10 = (d) => {
  if (!/^\d{9}[\dX]$/.test(d)) return false;
  const sum = [...d].reduce((acc, c, i) => acc + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
  return sum % 11 === 0;
};

/** Comparable ISBN: digits only, a valid ISBN-10 converted to its ISBN-13 (as the server normalises). */
export const toIsbn13 = (value) => {
  const d = isbnDigits(value);
  if (d.length === 10 && isValidIsbn10(d)) {
    const core = `978${d.slice(0, 9)}`;
    return core + ean13CheckDigit(core);
  }
  return d;
};

/** "Naruto Band 3", "Naruto Band 3 (Collectors Edition)": title plus the shared display name of the volume. */
const volumeLabel = (title, vol) => `${title || ''} ${vol?.display_title || getVolumeDisplayTitle(vol || {})}`.trim();

const itemTitle = (it) => it.manga_title ?? it.title ?? '';

const ownerNames = (owners) => (Array.isArray(owners) ? owners : [])
  .map((o) => (typeof o === 'string' ? o : o?.username))
  .filter(Boolean);

/**
 * Einkaufsmodus: macht aus einer ISBN-Antwort (`/api/lookup/isbn`) einen Eintrag für die Scan-Liste.
 * kind: `buy` (steht auf der Einkaufsliste, `itemId` zum Abhaken), `owned`, `partner` (nur andere Benutzer besitzen ihn),
 * `check` (Reihe bekannt, Band unklar/andere Reihe), `new` (Reihe fehlt in der Sammlung), `unknown` (kein Katalogtreffer).
 */
export const classifyShopScan = (isbn, data, shoppingItems = []) => {
  const clean = isbnDigits(isbn);
  const key = toIsbn13(clean);
  const fromList = shoppingItems.find((it) => isbnDigits(it.isbn) && toIsbn13(it.isbn) === key);
  const entry = (kind, label, extra = {}) => ({ isbn: clean, kind, label, ...extra });
  const buyEntry = (it) => entry('buy', volumeLabel(itemTitle(it), it), { itemId: it.id, price: it.price ?? null });
  if (fromList) return buyEntry(fromList);

  const book = data?.book;
  const name = scanSeriesTitle(book) || 'Unbekannt';
  const mv = data?.matched_volume;
  if (!data?.found) return entry('unknown', clean);
  const seriesTitle = data.matched_manga?.title || name;
  if (mv && OWNED_STATUSES.includes(mv.status)) {
    // owned_by_me is missing in older answers: then the shared status decides as before
    if (mv.owned_by_me === false) {
      const names = ownerNames(mv.owners);
      return entry('partner', `${volumeLabel(seriesTitle, mv)}: bei ${names.length ? names.join(', ') : 'anderen'} vorhanden`);
    }
    return entry('owned', volumeLabel(seriesTitle, mv));
  }
  const onList = mv && shoppingItems.find((it) => it.id === mv.id);
  if (onList) return buyEntry(onList);
  if (data.matched_manga && book?.volume_number_known === false && !mv) {
    return entry('check', `${data.matched_manga.title}: Bandnummer im Katalog unbekannt, bitte selbst prüfen`);
  }
  if (data.matched_manga) {
    return entry('check', mv
      ? `${volumeLabel(data.matched_manga.title, mv)} (Status ${mv.status})`
      : `${volumeLabel(data.matched_manga.title, { volume_number: book?.volume_number ?? '' })}: fehlt noch und steht nicht auf der Einkaufsliste`);
  }
  if (data.matched_candidates?.length > 0) {
    return entry('check', `${name} passt zu mehreren Reihen (${data.matched_candidates.map((c) => c.title).join(', ')})`);
  }
  return entry('new', `${name}: Reihe noch nicht in der Sammlung`);
};

/**
 * ISBN index over the offline copy (series details with their volumes, as stored by offlineStore):
 * Map of ISBN-13 to { manga: {id, title}, volume }. Accepts an array or an id-keyed object of details.
 */
export const buildIsbnIndex = (details) => {
  const index = new Map();
  const list = Array.isArray(details) ? details : Object.values(details || {});
  for (const detail of list) {
    if (!detail || !Array.isArray(detail.volumes)) continue;
    const manga = { id: detail.id, title: detail.title };
    for (const volume of detail.volumes) {
      const key = toIsbn13(volume?.isbn);
      if (key && !index.has(key)) index.set(key, { manga, volume });
    }
  }
  return index;
};

/**
 * Compact ISBN index over series details: { titles: { mangaId: title }, entries: [[isbn13, mangaId, volumeId,
 * display title, status, owned_by_me (1/0/null), owner names]] }. The first volume with an ISBN wins.
 */
export function buildIsbnIndexRecord(details) {
  const titles = {};
  const entries = [];
  const seen = new Set();
  for (const detail of Array.isArray(details) ? details : Object.values(details || {})) {
    if (!detail || !Array.isArray(detail.volumes)) continue;
    for (const volume of detail.volumes) {
      const key = toIsbn13(volume?.isbn);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      titles[detail.id] = detail.title ?? '';
      const owners = (Array.isArray(volume.owners) ? volume.owners : []).map((o) => o?.username).filter(Boolean);
      const mine = typeof volume.owned_by_me === 'boolean' ? Number(volume.owned_by_me) : null;
      entries.push([key, detail.id, volume.id, getVolumeDisplayTitle(volume), volume.status ?? null, mine, owners]);
    }
  }
  return { titles, entries };
}

export const findVolumeByIsbn = (index, isbn) => {
  const key = toIsbn13(isbn);
  return (key && index?.get(key)) || null;
};

/**
 * Scan result for a volume of the offline copy ({ manga, volume }), without the server. Anything but a `buy` carries
 * the note in its label and `offline: true` (a later server check may replace it); `source` says where it came from.
 */
export const classifyLocalHit = (isbn, hit, shoppingItems = [], { note = 'offline geprüft', source = 'offline' } = {}) => {
  const clean = isbnDigits(isbn);
  const result = classifyShopScan(clean, { found: true, matched_manga: hit.manga, matched_volume: hit.volume, book: {} }, shoppingItems);
  return result.kind === 'buy' ? result : { ...result, label: `${result.label} (${note})`, offline: true, source };
};

/** Label note of a scan answered from the offline copy before asking the server. */
export const localSourceNote = (age) => `Stand Offline-Kopie${age ? ` ${age}` : ''}`;

/** Scan result without the server: shopping list first, then the offline copy; a miss is `offline` (not checked). */
export const classifyShopScanOffline = (isbn, index, shoppingItems = []) => {
  const clean = isbnDigits(isbn);
  const listed = classifyShopScan(clean, { found: false }, shoppingItems);
  if (listed.kind === 'buy') return listed;
  const hit = index instanceof Map ? findVolumeByIsbn(index, clean) : index;
  if (!hit) return { isbn: clean, kind: 'offline', label: `${clean} – offline, nicht geprüft`, offline: true };
  return classifyLocalHit(clean, hit, shoppingItems);
};

/** How a failed ISBN lookup is handled: `offline` (check locally, can be re-scanned), `auth` or `error` (show the message). */
export const lookupFailureKind = (status) => {
  if (status === 401) return 'auth';
  if (status >= 500 || status === 408 || status === 429) return 'offline';
  return 'error';
};

const REPLACEABLE_KINDS = new Set(['unknown', 'offline']);
const isReplaceable = (e) => REPLACEABLE_KINDS.has(e.kind) || Boolean(e.offline);

/** False while the ISBN is in the list with a usable result or a running lookup (no second lookup). */
export const canStartLookup = (list, isbn) => {
  const existing = list.find((e) => e.isbn === isbn);
  return !existing || (!existing.done && !existing.booking && isReplaceable(existing));
};

/**
 * Adds a scan result to the list (newest first). A result for an ISBN already in the list replaces a `pending`
 * placeholder or an unchecked/offline entry in place; booked or booking entries and other results stay.
 */
export const mergeScanEntry = (list, entry) => {
  const i = list.findIndex((e) => e.isbn === entry.isbn);
  if (i === -1) return [entry, ...list];
  const old = list[i];
  if (old.done || old.booking) return list;
  const replace = old.kind === 'pending' ? entry.kind !== 'pending' : isReplaceable(old) && (entry.kind !== old.kind || !entry.offline);
  if (!replace) return list;
  const next = list.slice();
  next[i] = entry;
  return next;
};

export const removeScanEntry = (list, isbn) => list.filter((e) => e.isbn !== isbn);

/** Outcome of handleQuickBuy: a plain 'ok' | 'queued' | 'failed', or { status, error, httpStatus } in batch mode. */
export const normalizeBuyOutcome = (outcome) => {
  if (outcome && typeof outcome === 'object') {
    const status = ['ok', 'queued'].includes(outcome.status) ? outcome.status : 'failed';
    return { status, error: outcome.error || '', httpStatus: outcome.httpStatus ?? null, batch: true };
  }
  return { status: ['ok', 'queued'].includes(outcome) ? outcome : 'failed', error: '', httpStatus: null, batch: false };
};

/** Stop a batch after this result? Always after a session/permission error, and after any failure of a hook that alerts itself. */
export const shouldStopBooking = (result) => result.status === 'failed'
  && (!result.batch || result.httpStatus === 401 || result.httpStatus === 403);

/** Applies booking results ({ isbn, status, error, httpStatus }) to the scan list: only successes and queued buys become done. */
export const applyBookingResults = (list, results) => {
  const byIsbn = new Map(results.map((r) => [r.isbn, r]));
  return list.map((e) => {
    const r = byIsbn.get(e.isbn);
    if (!r) return e;
    const { booking: _booking, error: _error, failed: _failed, queued: _queued, ...rest } = e;
    if (r.status === 'ok') return { ...rest, done: true };
    if (r.status === 'queued') return { ...rest, done: true, queued: true };
    if (r.httpStatus === 404) return { ...rest, done: true, gone: true };
    return { ...rest, failed: true, error: r.error || 'nicht gebucht' };
  });
};

export const markScanBooking = (list, isbns) => {
  const set = new Set(isbns);
  return list.map((e) => (set.has(e.isbn) ? { ...e, booking: true } : e));
};

/** One line for the end of a batch booking, or '' when everything went through. */
export const bookingSummary = (results, total) => {
  const ok = results.filter((r) => r.status === 'ok').length;
  const queued = results.filter((r) => r.status === 'queued').length;
  const failed = results.filter((r) => r.status === 'failed' && r.httpStatus !== 404);
  const gone = results.filter((r) => r.httpStatus === 404 && r.status === 'failed').length;
  const skipped = total - results.length;
  if (!failed.length && !skipped && !gone) return '';
  const parts = [`${ok + queued} von ${total} gebucht`];
  if (queued) parts.push(`${queued} vorgemerkt`);
  if (gone) parts.push(`${gone} nicht mehr auf der Liste`);
  if (skipped) parts.push(`${skipped} nicht versucht`);
  const errors = [...new Set(failed.map((r) => r.error).filter(Boolean))];
  return `${parts.join(', ')}${errors.length ? `. Fehler: ${errors.join('; ')}` : ''}`;
};

// localStorage: iOS may kill a backgrounded home-screen app (e.g. while the camera takes a photo), which ends a sessionStorage
export const SCAN_LIST_KEY = 'mangashelf_shop_session';
export const SCAN_LIST_TTL_MS = 12 * 60 * 60 * 1000;

/** Scan list of this store visit; [] when missing, broken, too old or from another user. */
export const loadScanList = (storage, { userId = null, now = Date.now() } = {}) => {
  try {
    const raw = storage?.getItem(SCAN_LIST_KEY);
    if (!raw) return [];
    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.entries) || typeof saved.savedAt !== 'number') return [];
    if (now - saved.savedAt > SCAN_LIST_TTL_MS) return [];
    if (userId != null && saved.userId != null && String(saved.userId) !== String(userId)) return [];
    return saved.entries
      .filter((e) => e && typeof e.isbn === 'string' && typeof e.kind === 'string')
      .map(({ booking: _booking, ...e }) => (e.kind === 'pending'
        ? { isbn: e.isbn, kind: 'offline', label: `${e.isbn} – nicht geprüft`, offline: true }
        : e));
  } catch (_) {
    return [];
  }
};

/** Persists the scan list; an empty list removes the key. Resolves false when the storage is unavailable. */
export const saveScanList = (storage, entries, { userId = null, now = Date.now() } = {}) => {
  try {
    if (!storage) return false;
    if (!entries.length) storage.removeItem(SCAN_LIST_KEY);
    else storage.setItem(SCAN_LIST_KEY, JSON.stringify({ savedAt: now, userId, entries }));
    return true;
  } catch (_) {
    return false;
  }
};

/** Drops open 'buy' entries whose volume is no longer on the shopping list (bought elsewhere or removed). */
export const reconcileScanList = (list, items) => {
  if (!Array.isArray(items)) return list;
  const ids = new Set(items.map((it) => it.id));
  const next = list.filter((e) => e.kind !== 'buy' || e.done || e.booking || ids.has(e.itemId));
  return next.length === list.length ? list : next;
};

// Chip key as the server builds it (services/radar.js: normalised publisher or 'Unbekannt')
const publisherKey = (publisher, normalizePubName) => {
  const raw = String(publisher || '');
  return ((normalizePubName ? normalizePubName(raw) : raw.trim()) || 'Unbekannt').toLowerCase();
};

const shoppingSearch = createSearch((item) => ({
  primary: [item.manga_title, getVolumeDisplayTitle(item)],
  secondary: [item.volume_number, item.effective_publisher]
}));

/** Shopping items matching the publisher chip and the search, optionally sorted by priority (never sorts in place). */
export const filterShoppingItems = (items, { search = '', publisherFilter = 'ALL', normalizePubName, prioritySort = false } = {}) => {
  const query = prepareQuery(search);
  const pub = String(publisherFilter || 'ALL').toLowerCase();
  const filtered = (items || []).filter((item) => {
    const matchPub = publisherFilter === 'ALL' || publisherKey(item.effective_publisher || '', normalizePubName) === pub;
    return matchPub && (!query || shoppingSearch.matches(item, query));
  });
  return prioritySort ? filtered.sort((a, b) => (b.priority || 0) - (a.priority || 0)) : filtered;
};

/** Publisher chips counted from the items currently on the list; chips without items disappear. */
export const recountPublishers = (data, normalizePubName) => {
  const publishers = Array.isArray(data?.publishers) ? data.publishers : [];
  const counts = new Map();
  for (const item of data?.items || []) {
    const key = publisherKey(item.effective_publisher, normalizePubName);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return publishers
    .map((p) => ({ ...p, count: counts.get(String(p.publisher || '').toLowerCase()) || 0 }))
    .filter((p) => p.count > 0);
};

/** The chip filter to apply: 'ALL' once the selected publisher has no chip any more. */
export const resolvePublisherFilter = (filter, publishers) => {
  if (!filter || filter === 'ALL') return 'ALL';
  const wanted = String(filter).toLowerCase();
  return (publishers || []).some((p) => String(p.publisher || '').toLowerCase() === wanted) ? filter : 'ALL';
};

/** "heute, 14:05 Uhr" or "03.10., 14:05 Uhr" (with the year when it differs) for the cache age. */
export const formatShoppingStand = (timestamp, now = new Date()) => {
  const d = new Date(timestamp);
  if (!timestamp || Number.isNaN(d.getTime())) return '';
  const time = formatTime(d);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `heute, ${time} Uhr`;
  return `${formatDayMonth(d, today)}, ${time} Uhr`;
};

const ISBN_BARCODE = /^97[89]\d{10}$/;
export const isIsbnBarcode = (value) => ISBN_BARCODE.test(String(value || ''));

const isValidIsbn13 = (d) => /^\d{13}$/.test(d) && ean13CheckDigit(d.slice(0, 12)) === d[12];

/**
 * What another app shared to MangaShelf (share target ?share_text=&share_url=): { isbn } for the first ISBN-13/10 with
 * a valid check digit, { mpUrl } for a manga-passion.de link, else null.
 */
export const parseSharedScan = ({ text = '', url = '' } = {}) => {
  const all = `${text || ''} ${url || ''}`;
  const mp = all.match(/https?:\/\/(?:www\.)?manga-passion\.de\/[^\s"'<>]+/i);
  // plain or hyphenated tokens first, then digit groups separated by spaces
  const candidates = [...all.split(/[^\dXx-]+/), ...(all.match(/\d[\d\s-]{8,20}[\dXx]/g) || [])];
  for (const candidate of candidates) {
    const digits = isbnDigits(candidate);
    if (digits.length === 13 && isValidIsbn13(digits)) return { isbn: digits };
    if (digits.length === 10 && isValidIsbn10(digits)) return { isbn: toIsbn13(digits) };
  }
  return mp ? { mpUrl: mp[0] } : null;
};

/** Best barcode of a BarcodeDetector result: the 978/979 EAN-13, then any EAN-13, EAN-8/UPC, then the first one. */
export const pickIsbnBarcode = (barcodes) => {
  const list = (Array.isArray(barcodes) ? barcodes : []).filter((b) => b && b.rawValue);
  const hit = list.find((b) => isIsbnBarcode(b.rawValue))
    ?? list.find((b) => b.format === 'ean_13')
    ?? list.find((b) => ['ean_8', 'upc_a', 'upc_e'].includes(b.format))
    ?? list[0];
  return hit ? hit.rawValue : null;
};

/** Canvas size for decoding: at most `maxDim` on the longer side, never upscaled. */
export const computeScaledSize = (width, height, maxDim) => {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const scale = Math.min(1, maxDim / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
};
