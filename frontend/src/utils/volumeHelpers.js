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
 * Accepts the /api/mangas row (regular_owned, max_regular_number) or just the counts.
 */
export const getSeriesProgress = ({ regular_owned, max_regular_number, total_volumes, owned_volumes }) => {
  const all = owned_volumes || 0;
  const regular = regular_owned ?? all;
  const total = Math.max(total_volumes || 0, max_regular_number || 0);
  return {
    owned: regular,
    total,
    extras: Math.max(0, all - regular),
    pct: total > 0 ? Math.min(100, Math.round((regular / total) * 100)) : null
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

/** The number part of a special edition's volume_number ("Band 5 Limited Edition" -> "5"), or the cleaned text. */
export const getSpecialEditionNumber = (vol) => {
  const raw = String(vol.volume_number || '');
  const cleaned = raw.replace(/collector'?s?\s*edition|limited\s*edition|special\s*edition|spezial\s*edition|premium\s*edition|deluxe\s*edition|variant|band/gi, '').trim();
  const match = cleaned.match(/\d+(\.\d+)?/);
  return match ? match[0] : cleaned;
};

export const getVolumeDisplayTitle = (vol) => {
  const type = inferVolumeType(vol);
  const numStr = String(vol.volume_number || '').trim();
  if (type === 'schuber') {
    // "Vollschuber 1-5" / "Leerschuber 6-10" already say what they are; plain numbers become "Schuber 8",
    // or "Sammelschuber 15" when the notes name the kind of slipcase
    if (numStr.toLowerCase().includes('schuber')) return numStr;
    const kind = String(vol.notes || '').match(/\b(\w*schuber)\b/i);
    return `${kind ? kind[1].charAt(0).toUpperCase() + kind[1].slice(1) : 'Schuber'} ${numStr}`;
  }
  if (type === 'special_edition') {
    const { label } = getEditionLabel(vol);
    const num = getSpecialEditionNumber(vol);
    return num ? `Band ${num} (${label})` : label;
  }
  if (type === 'special') {
    return (numStr.toLowerCase().startsWith('special') || numStr.toLowerCase().startsWith('extra') || numStr.toLowerCase().startsWith('sonderband')) 
      ? numStr 
      : `Special ${numStr}`;
  }
  return numStr.toLowerCase().startsWith('band') ? numStr : `Band ${numStr}`;
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
      accentBadge: 'bg-orange-500 text-white font-bold',
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
      accentBadge: 'bg-purple-600 text-white font-bold',
      accentName: 'Papertoons'
    };
  }
  if (pub.includes('hayabusa')) {
    return {
      bg: 'from-pink-800 via-rose-950 to-slate-950',
      border: 'border-pink-400/40',
      text: 'text-pink-100',
      accentBadge: 'bg-pink-600 text-white font-bold',
      accentName: 'Hayabusa'
    };
  }
  if (pub.includes('panini')) {
    return {
      bg: 'from-emerald-800 via-teal-950 to-slate-950',
      border: 'border-emerald-400/40',
      text: 'text-emerald-100',
      accentBadge: 'bg-emerald-600 text-white font-bold',
      accentName: 'Panini'
    };
  }
  return {
    bg: 'from-slate-700 via-slate-850 to-slate-950',
    border: 'border-slate-600/40',
    text: 'text-slate-100',
    accentBadge: 'bg-brand-600 text-white font-bold',
    accentName: publisherName || 'Manga'
  };
};

/** Whether `userId` has read the volume; falls back to the caller's own flag when the API sent no reader list. */
export const hasUserRead = (vol, userId, currentUserId) =>
  vol.read_users
    ? vol.read_users.some(u => String(u.user_id ?? u.id) === String(userId))
    : (Boolean(vol.is_read) && String(userId) === String(currentUserId));

/**
 * Rows for the shelf / grid / list views: the filtered volumes with ghost entries for detected gaps interleaved
 * (only when sorting by number without conflicting filters).
 */
export const buildDisplayVolumeItems = ({ filteredVolumes, detectedGapEntries, detectedGaps, mpGapMap, showGaps, volumeTypeFilter, volumeFilter, volumeSearch, volumeSort }) => {
  const isNumberSort = volumeSort === 'number_asc' || volumeSort === 'number_desc';
  const allowTypeFilter = volumeTypeFilter === 'ALL' || volumeTypeFilter === 'volume';
  const allowStatusFilter = volumeFilter === 'ALL' || volumeFilter === 'Fehlt';

  if (!showGaps || detectedGaps.length === 0 || !allowTypeFilter || !allowStatusFilter || volumeSearch.trim() || !isNumberSort) {
    return filteredVolumes.map(v => ({ isGap: false, volume: v }));
  }

  const items = [];
  // titled gaps ("26 (Titel)") must resolve to their volume number, otherwise no ghost entry is drawn for them
  // only regular volumes get ghost entries; a Collectors Edition gap ("5 (Collectors Edition)") must not mask Band 5
  const gapsSet = new Set(detectedGapEntries.filter(e => e.type === 'volume').map(e => gapVolumeNumber(e.label)).filter(n => n !== null));
  const sorted = [...filteredVolumes];

  // Ensure no volume that actually exists in sorted is treated as a gap:
  sorted.forEach(v => {
    const match = String(v.volume_number).trim().match(/^(\d+)$/);
    if (match) gapsSet.delete(parseInt(match[1], 10));
  });

  const maxTarget = Math.max(
    ...Array.from(gapsSet).map(g => typeof g === 'number' ? g : 0),
    ...sorted.map(v => {
      const match = String(v.volume_number).trim().match(/^(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    })
  );

  let volIndex = 0;
  for (let i = 1; i <= maxTarget; i++) {
    if (gapsSet.has(i)) {
      const gapMeta = mpGapMap.get(String(i).toLowerCase());
      items.push({ isGap: true, gapNumber: i, gapMeta });
    }
    while (volIndex < sorted.length) {
      const v = sorted[volIndex];
      const match = String(v.volume_number).trim().match(/^(\d+)$/);
      const parsed = match ? parseInt(match[1], 10) : null;
      if (parsed !== null && parsed === i) {
        items.push({ isGap: false, volume: v });
        volIndex++;
      } else if (parsed !== null && parsed < i) {
        items.push({ isGap: false, volume: v });
        volIndex++;
      } else {
        break;
      }
    }
  }
  while (volIndex < sorted.length) {
    items.push({ isGap: false, volume: sorted[volIndex] });
    volIndex++;
  }

  if (volumeSort === 'number_desc') {
    items.reverse();
  }

  return items;
};
