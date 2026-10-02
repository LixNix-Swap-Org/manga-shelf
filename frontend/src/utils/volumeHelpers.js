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
export const getVolumeDisplayTitle = (vol) => {
  const type = inferVolumeType(vol);
  const numStr = String(vol.volume_number || '').trim();
  if (type === 'schuber') {
    return numStr.toLowerCase().startsWith('schuber') ? numStr : `Schuber ${numStr}`;
  }
  if (type === 'special_edition') {
    return (numStr.toLowerCase().includes('special edition') || numStr.toLowerCase().includes('limited edition') || numStr.toLowerCase().includes('spezial edition'))
      ? numStr
      : `Band ${numStr} (Special Edition)`;
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