// Pure helpers shared by Dashboard and MangaDetail (no React / no component state).

// Known canonical German publishers map for clean display
export const CANONICAL_PUBLISHERS = {
  'altraverse': 'Altraverse',
  'carlsen manga': 'Carlsen Manga',
  'crunchyroll': 'Crunchyroll',
  'dani books': 'Dani Books',
  'dark horse manga': 'Dark Horse Manga',
  'egmont manga': 'Egmont Manga',
  'hayabusa': 'Hayabusa',
  'kazé manga': 'Kazé Manga',
  'kaze manga': 'Kazé Manga',
  'manga cult': 'Manga Cult',
  'manga jam session': 'Manga JAM Session',
  'panini verlag gmbh': 'Panini Verlags GmbH',
  'panini verlags gmbh': 'Panini Verlags GmbH',
  'panini': 'Panini Verlags GmbH',
  'panini manga': 'Panini Verlags GmbH',
  'papertoons': 'Papertoons',
  'schreiber&leser': 'Schreiber&Leser',
  'schreiber & leser': 'Schreiber&Leser',
  'tokyopop': 'TOKYOPOP'
};

export const normalizePubName = (name) => {
  if (!name || typeof name !== 'string') return '';
  const trimmed = name.trim();
  // Manga Passion writes the imprint as "Carlsen Manga!"; the trailing "!" must not create a second publisher
  const lower = trimmed.toLowerCase().replace(/\s*!+$/, '');
  return CANONICAL_PUBLISHERS[lower] || trimmed.replace(/\s*!+$/, '');
};

/** Derives the entry type from vol.type, falling back to keywords in volume_number / notes. */
export const inferVolumeType = (vol) => {
  if (vol.type) return vol.type;
  const num = String(vol.volume_number).toLowerCase();
  const notes = (vol.notes || '').toLowerCase();
  if (num.includes('schuber')) return 'schuber';
  if (num.includes('special edition') || num.includes('limited edition') || num.includes('spezial edition')
    || notes.includes('special edition') || notes.includes('limited edition')) return 'special_edition';
  if (num.includes('special') || num.includes('extra') || num.includes('sonderband')) return 'special';
  return 'volume';
};

/** Trailing integer of a volume number: "5" -> 5, "Schuber 8" -> 8, "1-5" / "Special" -> null. */
export const volumeNumberOf = (vol) => {
  const m = String(vol.volume_number || '').trim().match(/^(?:\D*?\s)?(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
};

/**
 * Number of a regular volume as the backend counts it: "5" and "Band 5" -> 5. "Starter 1", "Vol. 3" or a
 * special edition -> null (volumeNumberOf is broader and would count those as regular volumes).
 */
export const regularVolumeNumber = (vol) => {
  if (inferVolumeType(vol) !== 'volume') return null;
  const m = String(vol.volume_number ?? '').trim().match(/^(?:band\s+)?(\d+)$/i);
  return m ? parseInt(m[1], 10) : null;
};

/**
 * Is an official gap entry already covered by something in the collection? Type and number together decide:
 * Collectors Edition 5 is not covered by Band 5, "Schuber 8" covers the official "8 (Schuber)".
 */
export const isGapCovered = (gap, volumes) => {
  const type = gap.type || 'volume';
  const key = String(gap.volume_number || '').trim().toLowerCase();
  const numeric = /^\d+$/.test(key);
  const sameType = volumes.filter(v => inferVolumeType(v) === type);

  if (sameType.some(v => String(v.volume_number || '').trim().toLowerCase() === key)) return true;
  if (numeric && sameType.some(v => volumeNumberOf(v) === parseInt(key, 10))) return true;

  // named entries / titled volumes: match by title in notes or number. A special edition's title ("Collectors
  // Edition") is shared by many entries, and numbered schuber are handled above, so neither is matched by name.
  const title = String(gap.title || '').trim().toLowerCase();
  if (title && type !== 'special_edition' && !(type !== 'volume' && numeric)) {
    // compare like with like (a Leerschuber is not covered by a regular volume); a bare number is no name match
    const named = sameType.some(v => {
      const notes = String(v.notes || '').trim().toLowerCase();
      const num = String(v.volume_number || '').trim().toLowerCase();
      return (notes && (notes.includes(title) || title.includes(notes)))
        || (num && !/^\d+$/.test(num) && (num.includes(title) || title.includes(num)));
    });
    if (named) return true;
  }

  // range bundles ("21-25") are covered once every single volume of the range is owned; schuber ranges never count as gaps
  const range = key.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (range) {
    const start = parseInt(range[1], 10);
    const end = parseInt(range[2], 10);
    const regular = volumes.filter(v => inferVolumeType(v) === 'volume');
    let allOwned = true;
    for (let k = start; k <= end; k++) {
      if (!regular.some(v => String(v.volume_number || '').trim() === String(k))) { allOwned = false; break; }
    }
    if (allOwned) return true;
    if (type === 'schuber') return true;
  }
  return false;
};

/**
 * detectedGaps entries are either a plain volume number (114) or a label with the official title
 * ("26 (Abenteuer auf der Insel des Gottes)", "East Blue Leerschuber"). Returns the volume number
 * of numbered entries and null for labels without one (schuber, specials).
 */
export const gapVolumeNumber = (gap) => {
  if (typeof gap === 'number') return Number.isInteger(gap) ? gap : null;
  const match = String(gap).trim().match(/^(\d+)(?:\s*\(.*\))?$/);
  return match ? parseInt(match[1], 10) : null;
};

/**
 * Collection progress of a series. Only regular volumes count towards completion (schuber and extras are
 * "+N"), and the target grows with the highest owned volume number: an ongoing series whose stored total is
 * stale ("21 / 18") shows 21 / 21 instead of an impossible ratio.
 * Accepts the /api/mangas row (regular_owned, max_regular_number, extras_owned) or getVolumeProgressCounts().
 * Without extras_owned (older rows) extras are owned minus regular, which also counts duplicates.
 * An incomplete series never shows 100 %, a started one never 0 %.
 */
export const getSeriesProgress = ({ regular_owned, max_regular_number, total_volumes, owned_volumes, extras_owned }) => {
  const all = owned_volumes || 0;
  const regular = regular_owned ?? all;
  const total = Math.max(total_volumes || 0, max_regular_number || 0);
  let pct = null;
  if (total > 0) {
    pct = Math.min(100, Math.round((regular / total) * 100));
    if (regular < total) pct = Math.min(pct, 99);
    if (regular > 0) pct = Math.max(pct, 1);
  }
  const extras = extras_owned !== undefined && extras_owned !== null ? Number(extras_owned) || 0 : all - regular;
  return { owned: regular, total, extras: Math.max(0, extras), pct };
};

/** The getSeriesProgress input for the volumes of one series (same rules as GET /api/mangas). */
export const getVolumeProgressCounts = (volumes) => {
  const owned = (volumes || []).filter(v => v.status === 'Vorhanden');
  const regularNumbers = new Set();
  let extras = 0;
  for (const v of owned) {
    const n = regularVolumeNumber(v);
    if (n !== null && n >= 1) regularNumbers.add(n);
    else extras++;
  }
  return {
    regular_owned: regularNumbers.size,
    max_regular_number: [...regularNumbers].reduce((max, n) => Math.max(max, n), 0),
    extras_owned: extras,
    owned_volumes: owned.length
  };
};

export const getVolumeSortInfo = (vol) => {
  const rawType = inferVolumeType(vol);

  // Check for number in volume_number
  const match = String(vol.volume_number).match(/(\d+(\.\d+)?)/);
  const num = match ? parseFloat(match[1]) : (parseFloat(vol.volume_number) || 999999);

  let rank = 1;
  let subRank = 0;
  if (rawType === 'volume') {
    rank = 1;
    subRank = 0;
  } else if (rawType === 'special_edition') {
    if (match) {
      rank = 1;
      subRank = 1;
    } else {
      rank = 1.5;
      subRank = 1;
    }
  } else if (rawType === 'schuber') {
    rank = 2;
    subRank = 2;
  } else if (rawType === 'special') {
    rank = 3;
    subRank = 3;
  } else if (isNaN(parseFloat(vol.volume_number)) && !match) {
    rank = 4;
    subRank = 4;
  }

  return { rank, num, subRank, raw: String(vol.volume_number), type: rawType };
};

/** Comparator of the "Band-Nr." sorts. Schuber and specials stay last in both directions. */
export const compareVolumesByNumber = (a, b, descending = false) => {
  const infoA = getVolumeSortInfo(a);
  const infoB = getVolumeSortInfo(b);
  if (infoA.rank !== infoB.rank) return infoA.rank - infoB.rank;
  if (infoA.num !== infoB.num) return descending ? infoB.num - infoA.num : infoA.num - infoB.num;
  if (infoA.subRank !== infoB.subRank) return infoA.subRank - infoB.subRank;
  return descending
    ? infoB.raw.localeCompare(infoA.raw, undefined, { numeric: true })
    : infoA.raw.localeCompare(infoB.raw, undefined, { numeric: true });
};
const EDITION_PATTERNS = [
  [/collector'?s?\s*edition/i, 'Collectors Edition', 'COLL'],
  [/limited\s*edition|limitierte?\s*edition/i, 'Limited Edition', 'LTD'],
  [/special\s*edition|spezial\s*edition|sonderausgabe/i, 'Special Edition', 'SE'],
  [/premium\s*edition/i, 'Premium Edition', 'PREM'],
  [/deluxe/i, 'Deluxe Edition', 'DLX'],
  [/variant/i, 'Variant', 'VAR']
];

/**
 * Which kind of special edition is this? Looks at the volume number and notes ("Collectors Edition",
 * "Limited Edition" ...). Falls back to the generic "Special Edition". Returns { label, short }.
 */
export const getEditionLabel = (vol) => {
  const text = `${vol.volume_number || ''} ${vol.notes || ''}`;
  for (const [pattern, label, short] of EDITION_PATTERNS) {
    if (pattern.test(text)) return { label, short };
  }
  return { label: 'Special Edition', short: 'SE' };
};

/** The number of a special edition ("Band 5 Limited Edition" -> "5"), or '' when its name has no number. */
export const getSpecialEditionNumber = (vol) => {
  const match = String(vol.volume_number ?? '').match(/\d+(\.\d+)?/);
  return match ? match[0] : '';
};

const EDITION_WORDS = /collector'?s?\s*edition|limited\s*edition|limitierte?\s*edition|special\s*edition|spezial\s*edition|sonderausgabe|premium\s*edition|deluxe(\s*edition)?/gi;

export const getVolumeDisplayTitle = (vol) => {
  const type = inferVolumeType(vol);
  const numStr = String(vol.volume_number ?? '').trim();
  if (type === 'schuber') {
    // "Vollschuber 1-5" / "Leerschuber 6-10" already say what they are; plain numbers become "Schuber 8",
    // or "Sammelschuber 15" when the notes name the kind of slipcase
    if (numStr.toLowerCase().includes('schuber')) return numStr;
    const kind = String(vol.notes || '').match(/\b(\w*schuber)\b/i);
    return `${kind ? kind[1].charAt(0).toUpperCase() + kind[1].slice(1) : 'Schuber'} ${numStr}`.trim();
  }
  if (type === 'special_edition') {
    const { label } = getEditionLabel(vol);
    const num = getSpecialEditionNumber(vol);
    if (num) return `Band ${num} (${label})`;
    const rest = numStr.replace(EDITION_WORDS, '').trim();
    if (!rest) return label;
    // a name that already says what it is ("Variant Cover") stays as typed
    return EDITION_PATTERNS.some(([pattern]) => pattern.test(numStr)) ? numStr : `${numStr} (${label})`;
  }
  if (type === 'special') {
    const lower = numStr.toLowerCase();
    if (!numStr) return 'Special';
    return (lower.startsWith('special') || lower.startsWith('extra') || lower.startsWith('sonderband')) ? numStr : `Special ${numStr}`;
  }
  if (!numStr) return 'Band ?';
  return /^\d+(\.\d+)?$/.test(numStr) ? `Band ${numStr}` : numStr;
};

export const VOLUME_CONDITIONS = ['Neuwertig', 'Sehr gut', 'Gut', 'Akzeptabel', 'Mängelexemplar'];
/** Filter value for "no condition recorded"; not a word, so it cannot collide with an imported condition. */
export const CONDITION_NONE = '__NONE__';

export const matchesConditionFilter = (vol, filter) => {
  if (!filter || filter === 'ALL') return true;
  const condition = vol.condition === null || vol.condition === undefined ? '' : String(vol.condition).trim();
  return filter === CONDITION_NONE ? condition === '' : condition === filter;
};

export const getSpinePublisherTheme = (publisherName) => {
  const pub = (publisherName || '').toLowerCase().trim();
  if (pub.includes('carlsen')) {
    return {
      bg: 'from-blue-700 via-sky-900 to-slate-950',
      border: 'border-blue-400/40',
      text: 'text-blue-100',
      accentBadge: 'bg-red-600 text-white font-bold',
      accentName: 'Carlsen'
    };
  }
  if (pub.includes('manga cult')) {
    return {
      bg: 'from-neutral-800 via-neutral-900 to-black',
      border: 'border-neutral-500/50',
      text: 'text-neutral-100',
      accentBadge: 'bg-white text-black font-extrabold',
      accentName: 'Manga Cult'
    };
  }
  if (pub.includes('altraverse')) {
    return {
      bg: 'from-orange-600 via-amber-800 to-slate-950',
      border: 'border-orange-400/40',
      text: 'text-orange-100',
      accentBadge: 'bg-orange-700 text-white font-bold',
      accentName: 'Altraverse'
    };
  }
  if (pub.includes('crunchyroll')) {
    return {
      bg: 'from-amber-600 via-orange-700 to-slate-950',
      border: 'border-amber-400/40',
      text: 'text-amber-100',
      accentBadge: 'bg-amber-500 text-slate-950 font-bold',
      accentName: 'Crunchyroll'
    };
  }
  if (pub.includes('kazé') || pub.includes('kaze')) {
    return {
      bg: 'from-yellow-600 via-amber-800 to-slate-950',
      border: 'border-yellow-400/40',
      text: 'text-yellow-100',
      accentBadge: 'bg-yellow-400 text-slate-950 font-bold',
      accentName: 'Kazé'
    };
  }
  if (pub.includes('tokyopop')) {
    return {
      bg: 'from-red-700 via-rose-900 to-slate-950',
      border: 'border-red-400/40',
      text: 'text-rose-100',
      accentBadge: 'bg-red-600 text-white font-bold',
      accentName: 'TOKYOPOP'
    };
  }
  if (pub.includes('egmont') || pub.includes('ema')) {
    return {
      bg: 'from-red-800 via-slate-850 to-slate-950',
      border: 'border-red-500/40',
      text: 'text-red-100',
      accentBadge: 'bg-red-700 text-white font-bold',
      accentName: 'Egmont'
    };
  }
  if (pub.includes('papertoons')) {
    return {
      bg: 'from-purple-800 via-violet-900 to-slate-950',
      border: 'border-purple-400/40',
      text: 'text-purple-100',
      accentBadge: 'bg-purple-700 text-white font-bold',
      accentName: 'Papertoons'
    };
  }
  if (pub.includes('hayabusa')) {
    return {
      bg: 'from-pink-800 via-rose-950 to-slate-950',
      border: 'border-pink-400/40',
      text: 'text-pink-100',
      accentBadge: 'bg-pink-700 text-white font-bold',
      accentName: 'Hayabusa'
    };
  }
  if (pub.includes('panini')) {
    return {
      bg: 'from-emerald-800 via-teal-950 to-slate-950',
      border: 'border-emerald-400/40',
      text: 'text-emerald-100',
      accentBadge: 'bg-emerald-700 text-white font-bold',
      accentName: 'Panini'
    };
  }
  return {
    bg: 'from-slate-700 via-slate-850 to-slate-950',
    border: 'border-slate-600/40',
    text: 'text-slate-100',
    accentBadge: 'bg-brand-700 text-white font-bold',
    accentName: publisherName || 'Manga'
  };
};

/** Whether `userId` has read the volume; falls back to the caller's own flag when the API sent no reader list. */
export const hasUserRead = (vol, userId, currentUserId) =>
  vol.read_users
    ? vol.read_users.some(u => String(u.user_id ?? u.id) === String(userId))
    : (Boolean(vol.is_read) && String(userId) === String(currentUserId));

const gapMapKey = (volumeNumber) => {
  const key = String(volumeNumber ?? '').trim().toLowerCase();
  return /^\d+$/.test(key) ? String(parseInt(key, 10)) : key;
};

/**
 * Official data (price, date, cover) of the missing regular volumes, keyed by number. Ghost entries and the gap
 * dialog only stand for regular volumes, so a Collectors Edition or Schuber with the same number never lands here.
 */
export const buildMpGapMap = (gaps) => {
  const map = new Map();
  for (const g of Array.isArray(gaps) ? gaps : []) {
    if ((g.type || 'volume') !== 'volume') continue;
    const key = gapMapKey(g.volume_number);
    if (key && !map.has(key)) map.set(key, g);
  }
  return map;
};

export const getRegularGapMeta = (mpGapMap, volumeNumber) => mpGapMap?.get(gapMapKey(volumeNumber));

/** The gap check runs on an edition the search only guessed; its data must not be imported before confirming. */
export const isGapEditionUnconfirmed = (mpGapData) => Boolean(mpGapData?.matched && mpGapData.link_confirmed === false);

/** "Bandzahl anpassen" only for a confirmed edition; for a guess "Edition bestätigen" does the same and links it. */
export const canFixVolumeCount = (mpGapData) =>
  Boolean(mpGapData?.discrepancy && mpGapData.edition?.id && !isGapEditionUnconfirmed(mpGapData));

/** Hint for the gap check state: request error, backend message without a match, stale or incomplete data. */
export const gapStatusText = (mpGapData, error) => {
  if (error) return error;
  if (!mpGapData) return null;
  if (mpGapData.success === false || mpGapData.matched === false) return mpGapData.message || null;
  if (mpGapData.stale) return 'Daten evtl. veraltet – Manga Passion nicht erreichbar';
  if (mpGapData.incomplete) return 'Manga-Passion-Daten evtl. unvollständig';
  return null;
};

/**
 * Gaps as { label, type }: label is what the banner shows ("26 (Titel)", "5 (Collectors Edition)", 114), type
 * decides how it is drawn (only regular volumes get ghost entries) and imported. Uses the official edition when
 * Manga Passion matched, otherwise counts the regular volumes 1..max(total, highest owned number).
 */
export const detectGapEntries = (mpGapData, volumes, totalVolumes) => {
  if (mpGapData && mpGapData.matched && Array.isArray(mpGapData.gaps)) {
    return mpGapData.gaps
      .filter(g => !isGapCovered(g, volumes))
      .map(g => {
        const match = String(g.volume_number).trim().match(/^(\d+)$/);
        const label = match
          ? (g.title ? `${match[1]} (${g.title.trim()})` : parseInt(match[1], 10))
          : (g.title || g.volume_number);
        return { label, type: g.type || 'volume' };
      });
  }

  const existing = new Set();
  let maxFound = 0;
  for (const v of volumes) {
    const n = regularVolumeNumber(v);
    if (n !== null && n > 0 && n <= 300) {
      existing.add(n);
      if (n > maxFound) maxFound = n;
    }
  }
  const targetMax = Math.min(200, Math.max(maxFound, parseInt(totalVolumes, 10) || 0));
  if (targetMax <= 1 || existing.size === 0) return [];
  const gaps = [];
  for (let i = 1; i <= targetMax; i++) {
    if (!existing.has(i)) gaps.push({ label: i, type: 'volume' });
  }
  return gaps;
};

/**
 * Whether the active filters leave room for ghost entries: type "Bände", status "Fehlt" and "Bände, die ihr fehlen"
 * fit a gap; search, publisher, condition and a person's owned volumes do not.
 */
export const filtersAllowGaps = ({
  volumeTypeFilter = 'ALL', volumeFilter = 'ALL', volumeSearch = '', volumePublisherFilter = 'ALL',
  volumeConditionFilter = 'ALL', volumeOwnerFilter = 'ALL', volumeOwnerMissing = false
} = {}) =>
  (volumeTypeFilter === 'ALL' || volumeTypeFilter === 'volume')
  && (volumeFilter === 'ALL' || volumeFilter === 'Fehlt')
  && !String(volumeSearch ?? '').trim()
  && volumePublisherFilter === 'ALL'
  && volumeConditionFilter === 'ALL'
  && (volumeOwnerFilter === 'ALL' || Boolean(volumeOwnerMissing));

/**
 * Rows for the shelf / grid / list views: the filtered volumes (already sorted by useVolumeFilters) with ghost
 * entries for detected gaps, only when sorting by number and filtersAllowGaps(). The volumes keep their order; a
 * ghost takes the slot of its regular volume, so it goes in front of a special edition with the same number in
 * both directions.
 */
export const buildDisplayVolumeItems = ({
  filteredVolumes, detectedGapEntries, detectedGaps, mpGapMap, showGaps, volumeSort, ...filters
}) => {
  const isNumberSort = volumeSort === 'number_asc' || volumeSort === 'number_desc';
  if (!showGaps || detectedGaps.length === 0 || !isNumberSort || !filtersAllowGaps(filters)) {
    return filteredVolumes.map(v => ({ isGap: false, volume: v }));
  }
  const descending = volumeSort === 'number_desc';

  // titled gaps ("26 (Titel)") resolve to their volume number; only regular volumes get ghost entries
  const gapsSet = new Set(detectedGapEntries.filter(e => e.type === 'volume').map(e => gapVolumeNumber(e.label)).filter(n => n !== null));
  for (const v of filteredVolumes) {
    const n = regularVolumeNumber(v);
    if (n !== null) gapsSet.delete(n);
  }
  const gapList = Array.from(gapsSet).sort((x, y) => (descending ? y - x : x - y));

  // same parser as the sort: "Limited Edition 14" sits at 14; schuber, specials and unnumbered entries have no slot
  const positions = filteredVolumes.map(v => {
    const info = getVolumeSortInfo(v);
    return info.rank === 1 && info.num !== 999999 ? info.num : null;
  });
  const numbered = positions.map((p, i) => (p === null ? -1 : i)).filter(i => i >= 0);
  const afterLastNumbered = numbered.length ? numbered[numbered.length - 1] + 1 : 0;

  const ghostsBefore = new Map();
  for (const n of gapList) {
    const anchor = numbered.find(i => (descending ? positions[i] <= n : positions[i] >= n));
    const index = anchor === undefined ? afterLastNumbered : anchor;
    ghostsBefore.set(index, [...(ghostsBefore.get(index) || []), n]);
  }

  const items = [];
  const pushGhosts = (index) => {
    for (const n of ghostsBefore.get(index) || []) {
      items.push({ isGap: true, gapNumber: n, gapMeta: getRegularGapMeta(mpGapMap, n) });
    }
  };
  filteredVolumes.forEach((v, i) => {
    pushGhosts(i);
    items.push({ isGap: false, volume: v });
  });
  pushGhosts(filteredVolumes.length);
  return items;
};
