/**
 * Pure helpers for Manga Passion data: scoring editions, classifying official volumes and matching Schubers.
 * No database or network access, so everything here can be unit-tested directly.
 */

/**
 * Comparison key of a title: lowercase, apostrophes / dots / ! / ? dropped, dashes, colons and the like turned into
 * spaces ("Hell's Paradise" = "Hells Paradise", "ONE-PUNCH MAN" = "One Punch Man", "Akame ga Kill!" = "Akame ga Kill").
 */
function titleKey(t) {
  return String(t || '').toLowerCase()
    .replace(/[’'`´.!?]/g, '')
    .replace(/[:–—\-_/&,;]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const compactKey = (t) => titleKey(t).replace(/\s+/g, '');

/** Share of identical words between two titles (0 - 1). */
function wordOverlap(a, b) {
  const wa = new Set(titleKey(a).split(' ').filter(Boolean));
  const wb = new Set(titleKey(b).split(' ').filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/**
 * How the title of an edition relates to the series title: 'exact' (same words, also "Eyeshield21" = "Eyeshield 21"),
 * 'candidate-longer' (an official subtitle was added), 'target-longer' (the series title has extra words such as
 * "max", "Extream" or "Anthology": probably a different edition than the plain series), or 'fuzzy'.
 */
function titleRelation(editionTitle, targetTitle) {
  const e = titleKey(editionTitle);
  const t = titleKey(targetTitle);
  if (!e || !t) return 'fuzzy';
  if (e === t || compactKey(editionTitle) === compactKey(targetTitle)) return 'exact';
  if (e.includes(t)) return 'candidate-longer';
  if (t.includes(e)) return 'target-longer';
  return 'fuzzy';
}

// in titleKey form ("Spin-off" -> "spin off"); matched as whole words so "Romance" is no "Roman"
const COMPANION_WORDS = ['guide', 'guidebook', 'artbook', 'artworks', 'spin off', 'spinoff', 'roman', 'romane', 'novel', 'novels',
  'präludium', 'fanbuch', 'kochbuch', 'wimmelbuch'];
const hasWord = (key, word) => ` ${key} `.includes(` ${word} `);

function scoreEdition(e, targetTitle, targetPub, targetTotal) {
  let score = 0;
  const tNorm = titleKey(targetTitle);
  const eNorm = titleKey(e.title);

  if (eNorm === tNorm) score += 100;
  else if (compactKey(e.title) === compactKey(targetTitle) && tNorm) score += 90; // "Eyeshield21" = "Eyeshield 21"
  else if (eNorm.includes(tNorm) || tNorm.includes(eNorm)) score += 50;
  else score += Math.round(40 * wordOverlap(e.title, targetTitle)); // "JoJo Bizarre Adventure Part 1" ~ "JoJo's Bizarre Adventure - Part 1: Phantom Blood"

  // Publisher and volume count only count for a title that is at least somewhat similar (otherwise any edition of the
  // same publisher with a matching volume count would look like a hit)
  if (score < 15) return score;

  const tBase = titleKey(String(targetTitle || '').split(/[:–—-]/)[0]);
  const eBase = titleKey(String(e.title || '').split(/[:–—-]/)[0]);
  if (tBase && eBase && tBase === eBase) score += 35;

  if (targetPub && e.publishers?.[0]?.name) {
    const p1 = targetPub.toLowerCase();
    const p2 = e.publishers[0].name.toLowerCase();
    if (p1.includes(p2) || p2.includes(p1) || 
       (p1.includes('panini') && p2.includes('panini')) || 
       (p1.includes('carlsen') && p2.includes('carlsen')) ||
       (p1.includes('altraverse') && p2.includes('altraverse')) ||
       (p1.includes('manga cult') && p2.includes('manga cult')) ||
       (p1.includes('tokyopop') && p2.includes('tokyopop')) ||
       (p1.includes('egmont') && p2.includes('egmont')) ||
       (p1.includes('crunchyroll') && p2.includes('crunchyroll')) ||
       (p1.includes('kazé') && p2.includes('kazé'))
    ) {
      score += 45;
    }
  }

  if (targetTotal && e.numVolumes) {
    if (e.numVolumes === targetTotal) score += 30;
    else if (Math.abs(e.numVolumes - targetTotal) <= 2) score += 15;
  }

  // Demote companion books (guides, artbooks, novels, spin-offs ...) unless the target asks for that same kind
  const isSpinOff = COMPANION_WORDS.some(w => hasWord(eNorm, w) && !hasWord(tNorm, w));
  if (isSpinOff) {
    score -= 40;
  }

  // Multi-volume series are preferred over single extras when searching general titles
  if (e.numVolumes && e.numVolumes > 1) {
    score += 20;
  }

  // Bonus for closer title length to the searched title
  if (eBase === tBase) {
    score += Math.max(0, 30 - Math.min(30, Math.abs(e.title.length - targetTitle.length)));
  }

  return score;
}

const MIN_YEAR = 1900;
const PLACEHOLDER_YEAR = 2100;
const pad2 = (n) => String(n).padStart(2, '0');

function validYearMonth(year, month) {
  return Number.isInteger(year) && year >= MIN_YEAR && year < PLACEHOLDER_YEAR && Number.isInteger(month) && month >= 1 && month <= 12;
}

/**
 * Release date of an official entry: "YYYY-MM-DD", or "YYYY-MM" when Manga Passion only knows the month (it then sends
 * day: null and the last day of the month as date). Accepts the raw date string or the whole API volume.
 * Manga Passion marks "not announced yet" with 2999-12-31: that, invalid and malformed input give null.
 */
function cleanOfficialDate(raw) {
  if (raw && typeof raw === 'object') {
    const full = cleanOfficialDate(raw.date);
    if (raw.day === null && raw.month != null) {
      const year = Number(raw.year ?? (full ? full.slice(0, 4) : NaN));
      const month = Number(raw.month);
      return validYearMonth(year, month) ? `${year}-${pad2(month)}` : null;
    }
    return full;
  }
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?(?=$|[T\s])/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (!validYearMonth(year, month)) return null;
  if (!m[3]) return `${m[1]}-${m[2]}`;
  const day = parseInt(m[3], 10);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Whether an official release date has passed. A month-only date ("YYYY-MM") counts as released once that month is
 * over, the same moment as the last-of-month date Manga Passion sends for it.
 */
function isOfficialReleased(date, now = new Date()) {
  const m = String(date || '').match(/^(\d{4})-(\d{2})$/);
  if (m) return now.getTime() >= Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10), 1);
  return date ? new Date(date) <= now : false;
}

/** A publisher name that is not the 'Unbekannt' placeholder the edition mapping uses for "none". */
function knownPublisher(name) {
  const p = typeof name === 'string' ? name.trim() : '';
  return p && p !== 'Unbekannt' ? p : null;
}

const MP_UNREACHABLE_MESSAGE = 'Manga Passion ist gerade nicht erreichbar. Bitte später erneut versuchen.';
const MP_EDITION_NOT_FOUND_MESSAGE = 'Manga-Passion Edition nicht gefunden oder nicht verfügbar.';

// Title heuristics, used only where the structured API fields (type / specialType) do not decide. "schuber" stays a
// substring for German compounds (Leerschuber, Sammelschuber); "box" is a whole word so "Der Boxer" is a volume.
const SCHUBER_TITLE = /schuber|slipcase|sammelbox|\bbox(?:\s?set)?\b/i;
const SPECIAL_EDITION_TITLE = /\b(?:collector['’]?s?|limited|variant|deluxe)\b|\bedition\b/i;
const SPECIAL_TITLE = /\b(?:special|extras?|guide|guidebook|sonderband|fanbook|fanbuch)\b/i;

const hasStructure = (v) => typeof v.type === 'number';
const hasDigit = (v) => /\d/.test(String(v.volume_number || ''));

/**
 * A Schuber / box set entry of the official edition. Manga Passion marks them with specialType 1 (type 3); a type 3
 * entry with another specialType is a Collectors/Limited Edition, a numbered type 0 entry a regular volume.
 */
function isSchuberEntry(v) {
  if (v.specialType === 1) return true;
  if (/schuber/i.test(String(v.volume_number || ''))) return true;
  if (hasStructure(v)) {
    if (v.type === 3 && v.specialType != null) return false;
    if (v.type !== 3 && hasDigit(v)) return false;
  }
  return SCHUBER_TITLE.test(v.title || '');
}

/**
 * Entry type of an official Manga Passion volume: 'volume' | 'special_edition' | 'schuber' | 'special'.
 * A Collectors/Limited Edition has the same number as the regular volume, so the type is part of its identity.
 * Live data: type 3 + specialType 1 = Schuber, type 3 otherwise = Collectors/Limited/Variant edition,
 * type 0 = regular volume whatever its title says. Titles are only read when those fields do not decide.
 */
function classifyOfficialVolume(ov) {
  if (isSchuberEntry(ov)) return 'schuber';
  const key = String(ov.volume_number || '').trim().toLowerCase();
  const title = String(ov.title || '').trim().toLowerCase();
  if (ov.type === 3 || ov.specialType === 2) return 'special_edition';
  if (hasStructure(ov)) {
    if (key === 'special' || /\b(?:special|extra|sonderband)\b/.test(key)) return 'special';
    if (hasDigit(ov)) return 'volume';
  }
  if (SPECIAL_EDITION_TITLE.test(title)) return 'special_edition';
  if (key === 'special' || SPECIAL_TITLE.test(title)) return 'special';
  return 'volume';
}

/** Volume number as stored for an official entry ("Special" entries use their title). */
function officialVolumeNumber(ov) {
  const key = String(ov.volume_number || '').trim().toLowerCase();
  return key === 'special' && ov.title ? ov.title.trim() : ov.volume_number;
}

/**
 * Resolves one gap entry sent by the client to an official Manga Passion volume. Accepts what the UI shows:
 * a plain number ("14" -> the regular volume), a labelled entry ("26 (Abenteuer auf der Insel des Gottes)",
 * "5 (Collectors Edition)") or a title ("East Blue Leerschuber").
 */
function resolveOfficialGap(entry, officialVolumes) {
  const raw = String(entry).trim();
  const key = raw.toLowerCase();
  const labelled = raw.match(/^(\d+)\s*\((.+)\)\s*$/);

  const byTitleKey = officialVolumes.find(ov => String(ov.title || '').trim().toLowerCase() === key);
  if (byTitleKey) return byTitleKey;

  if (labelled) {
    const num = labelled[1];
    const label = labelled[2].trim().toLowerCase();
    const sameNumber = officialVolumes.filter(ov => String(ov.volume_number || '').trim() === num);
    return sameNumber.find(ov => String(ov.title || '').trim().toLowerCase() === label)
      || sameNumber.find(ov => classifyOfficialVolume(ov) === 'volume')
      || sameNumber[0] || null;
  }

  const sameNumber = officialVolumes.filter(ov => String(ov.volume_number || '').trim().toLowerCase() === key);
  // a bare number means the regular volume, never its Collectors Edition / Schuber
  return sameNumber.find(ov => classifyOfficialVolume(ov) === 'volume') || sameNumber[0] || null;
}

// An edition is only linked to a series automatically when it clearly stands out: a high score and a lead over the
// runner-up. Calibrated on a real collection: exact matches score 150+, spin-offs / second editions of the same title
// land within a few points of the real series (e.g. "Magi" vs "Magilumiere Inc.", "Arifureta" vs its spin-off).
const MIN_CONFIDENT_SCORE = 120;
const MIN_CONFIDENT_LEAD = 20;

/** Whether the best-scored candidate (candidates sorted by score, best first) is unambiguous enough to link without asking. */
function isConfidentMatch(candidates) {
  const [best, second] = candidates || [];
  if (!best || best.score < MIN_CONFIDENT_SCORE) return false;
  // a series title with extra words ("Dragon Ball max") must not be linked to the plain series ("Dragon Ball") unasked
  if (best.title_relation === 'target-longer' || best.title_relation === 'fuzzy') return false;
  return !second || best.score - second.score >= MIN_CONFIDENT_LEAD;
}

const SEARCH_STOP_WORDS = new Set(['edition', 'deluxe', 'ultimate', 'ultimative', 'collectors', 'manga', 'premium', 'special', 'limited', 'master', 'perfect', 'complete', 'anthology', 'magazin']);

/**
 * Queries for the Manga Passion title search, which only finds a title when the spelling matches closely
 * ("One Punch Man" finds nothing, "One-Punch Man" does). `primary` are the cheap spellings, `variants` guess
 * hyphens, apostrophes and glued numbers, `words` are single rare words used as a last resort.
 */
function buildSearchQueries(title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  const unique = (list) => [...new Set(list.map(q => q.replace(/\s+/g, ' ').trim()).filter(q => q.length >= 2))];

  const primary = unique([
    clean,
    clean.replace(/[–—]/g, '-'),
    clean.replace(/[-–—:]/g, ' '),
    clean.replace(/\./g, '. '),
    clean.split(/[:–—-]/)[0]
  ]);

  const words = clean.split(' ');
  const variants = [clean.replace(/([A-Za-zÄÖÜäöüß])(\d)/g, '$1 $2')]; // Eyeshield21 -> Eyeshield 21
  if (words.length >= 2 && words.length <= 5 && !/[-–—:]/.test(clean)) {
    for (let i = 0; i < words.length - 1; i++) { // One Punch Man -> One-Punch Man, One Punch-Man
      variants.push([...words.slice(0, i), words[i] + '-' + words[i + 1], ...words.slice(i + 2)].join(' '));
    }
    variants.push(words.join('-'));
  }
  words.forEach((w, i) => { // Hells Paradise -> Hell's Paradise
    if (/^[A-Za-zÄÖÜäöüß]{4,}s$/.test(w)) variants.push([...words.slice(0, i), w.slice(0, -1) + "'s", ...words.slice(i + 1)].join(' '));
  });

  const rare = titleKey(clean).split(' ')
    .filter(w => w.length >= 5 && !SEARCH_STOP_WORDS.has(w))
    .sort((a, b) => b.length - a.length);

  const seen = new Set(primary);
  return {
    primary,
    variants: unique(variants).filter(q => !seen.has(q)).slice(0, 8),
    words: [...new Set(rare)].slice(0, 2)
  };
}

const numberIn = (text) => {
  const m = String(text ?? '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
};
const officialNum = (v) => (Number.isFinite(v.num) && v.num < 99999 ? v.num : numberIn(v.volume_number));
const lower = (t) => String(t ?? '').trim().toLowerCase();

const EDITION_KINDS = [['collectors', /collector/], ['limited', /limited/], ['variant', /variant/], ['deluxe', /deluxe/], ['special', /special|spezial/]];
function editionKind(text) {
  const t = lower(text);
  const hit = EDITION_KINDS.find(([, re]) => re.test(t));
  return hit ? hit[0] : null;
}

/** Several special editions with one number (Limited and Collectors of volume 7): the user's label, then the price decide. */
function pickSpecialEdition(candidates, volumeNumber, hint) {
  if (candidates.length <= 1) return candidates[0] || null;
  const notes = lower(hint.notes);
  const byTitle = notes && candidates.find(c => lower(c.title) === notes);
  if (byTitle) return byTitle;
  const kind = editionKind(`${volumeNumber ?? ''} ${hint.notes ?? ''}`);
  const byKind = kind && candidates.find(c => editionKind(c.title) === kind);
  if (byKind) return byKind;
  const price = Number(hint.price);
  if (price > 0) {
    const priced = candidates.filter(c => c.price);
    if (priced.length) return priced.reduce((a, b) => (Math.abs(b.price - price) < Math.abs(a.price - price) ? b : a));
  }
  return candidates[0];
}

/**
 * The official entry for a user volume of a given type ('volume' | 'special_edition' | 'special'; Schubers go through
 * matchSchuberVolume). Never crosses types: a regular volume never gets Collectors Edition data and the other way round,
 * and a number without an entry of that type gives null instead of another entry. `hint` = { notes, price } of the
 * user volume, used to tell several special editions with the same number apart.
 */
function findOfficialVolume(officialVolumes, volumeNumber, type = 'volume', hint = {}) {
  const vols = officialVolumes || [];
  const key = lower(volumeNumber);

  if (type === 'special_edition') {
    const editions = vols.filter(v => classifyOfficialVolume(v) === 'special_edition');
    const wanted = numberIn(volumeNumber);
    if (wanted === null) return pickSpecialEdition(editions, volumeNumber, hint);
    return pickSpecialEdition(editions.filter(v => officialNum(v) === wanted), volumeNumber, hint);
  }

  if (type === 'special') {
    const names = [key, lower(hint.notes)].filter(Boolean);
    return vols.find(v => classifyOfficialVolume(v) === 'special'
      && [lower(v.volume_number), lower(officialVolumeNumber(v)), lower(v.title)].some(n => n && names.includes(n))) || null;
  }

  // a regular volume; an entry classified 'special' only by its title is still accepted, a Schuber or special edition never
  const regular = vols.filter(v => !['schuber', 'special_edition'].includes(classifyOfficialVolume(v)));
  let matches = regular.filter(v => lower(v.volume_number) === key);
  if (!matches.length) {
    const wanted = numberIn(key);
    if (wanted === null) return null;
    matches = regular.filter(v => v.num === wanted && v.num < 99999);
  }
  return matches.find(v => classifyOfficialVolume(v) === 'volume') || matches[0] || null;
}

/**
 * Finds the regular official volume for a number as the user wrote it ("5", "05", "Band 5").
 * Exact label first, then the first number in it. Schubers and special editions are never returned.
 */
function findRegularVolume(officialVolumes, volumeNumber) {
  return findOfficialVolume(officialVolumes, volumeNumber, 'volume');
}

function matchSchuberIn(pool, targetNum) {
  // 1. By customArrangement
  let matched = pool.find(v => v.customArrangement === targetNum);

  // 2. By title number (e.g. "Schuber 1" or "#1")
  if (!matched) {
    matched = pool.find(v => {
      const tm = (v.title || '').match(/(\d+)/);
      return tm && parseInt(tm[1], 10) === targetNum;
    });
  }

  // 3. By index in chronological order
  if (!matched && targetNum >= 1 && targetNum <= pool.length) {
    const sorted = [...pool].sort((a, b) => (a.release_date || '').localeCompare(b.release_date || '') || a.id - b.id);
    matched = sorted[targetNum - 1];
  }
  return matched || null;
}

/**
 * Matches a Schuber (Sammelschuber or Leerschuber) by customArrangement, title number or chronological index. The kind
 * suggested by price / notes is tried first, then the other kind. A number without a Schuber gives null.
 */
function matchSchuberVolume(volumes, volumeNumber, userPrice, userNotes) {
  if (!volumes || volumes.length === 0) return null;
  const numMatch = String(volumeNumber || '').match(/(\d+(\.\d+)?)/);
  const targetNum = numMatch ? parseInt(numMatch[1], 10) : 1;
  if (targetNum <= 0) return null;

  const schuberVols = volumes.filter(isSchuberEntry);
  if (schuberVols.length === 0) return null;

  const emptyBoxes = schuberVols.filter(v => /leer/i.test(v.title || '') || (v.price && v.price <= 25));
  const fullBoxes = schuberVols.filter(v => /sammel|komplett/i.test(v.title || '') || (v.price && v.price > 25));

  const preferEmpty = (userPrice && userPrice <= 25) || /leer/i.test(userNotes || '') || (!userPrice && emptyBoxes.length > 0);
  const pools = preferEmpty ? [emptyBoxes, fullBoxes, schuberVols] : [fullBoxes, emptyBoxes, schuberVols];

  for (const pool of pools) {
    if (!pool.length) continue;
    const matched = matchSchuberIn(pool, targetNum);
    if (matched) return matched;
  }
  return null;
}

module.exports = {
  scoreEdition,
  titleKey,
  titleRelation,
  buildSearchQueries,
  isConfidentMatch,
  cleanOfficialDate,
  isOfficialReleased,
  knownPublisher,
  MP_UNREACHABLE_MESSAGE,
  MP_EDITION_NOT_FOUND_MESSAGE,
  classifyOfficialVolume,
  officialVolumeNumber,
  resolveOfficialGap,
  matchSchuberVolume,
  isSchuberEntry,
  findRegularVolume,
  findOfficialVolume
};
