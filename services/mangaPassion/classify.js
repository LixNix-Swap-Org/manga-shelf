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

  // Demote single volume spin-offs, artbooks, novels, etc. if target title isn't explicitly looking for them
  const isSpinOff = e.title.toLowerCase().includes('guide') || 
                    e.title.toLowerCase().includes('artbook') || 
                    e.title.toLowerCase().includes('artworks') ||
                    e.title.toLowerCase().includes('spin-off') || 
                    e.title.toLowerCase().includes('roman') || 
                    e.title.toLowerCase().includes('novel') || 
                    e.title.toLowerCase().includes('präludium') ||
                    e.title.toLowerCase().includes('fanbuch') ||
                    e.title.toLowerCase().includes('kochbuch') ||
                    e.title.toLowerCase().includes('wimmelbuch');
  if (isSpinOff && !tNorm.includes('guide') && !tNorm.includes('spin-off') && !tNorm.includes('novel') && !tNorm.includes('roman') && !tNorm.includes('artbook') && !tNorm.includes('fanbuch')) {
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

/**
 * Manga Passion marks "release date not announced yet" with a placeholder far in the future (2999-12-31).
 * That is no date: returns null for it (and for empty input), otherwise the YYYY-MM-DD part.
 */
function cleanOfficialDate(raw) {
  if (!raw) return null;
  const day = String(raw).slice(0, 10);
  const year = parseInt(day.slice(0, 4), 10);
  return Number.isNaN(year) || year >= 2100 ? null : day;
}

/**
 * Entry type of an official Manga Passion volume: 'volume' | 'special_edition' | 'schuber' | 'special'.
 * A Collectors/Limited Edition has the same number as the regular volume, so the type is part of its identity.
 */
function classifyOfficialVolume(ov) {
  const key = String(ov.volume_number || '').trim().toLowerCase();
  const titleKey = String(ov.title || '').trim().toLowerCase();
  if (ov.specialType === 1 || titleKey.includes('schuber') || titleKey.includes('box')) return 'schuber';
  if (ov.specialType === 2 || /edition|limited|collectors|variant/i.test(titleKey)) return 'special_edition';
  if (key === 'special' || /special|extra|guide/i.test(titleKey)) return 'special';
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

/** A Schuber / box set entry of the official edition (never a regular volume). */
function isSchuberEntry(v) {
  return v.specialType === 1 || /schuber|box|slipcase/i.test(v.title || '');
}

/**
 * Finds the regular (non-Schuber) official volume for a number as the user wrote it ("5", "05", "Band 5").
 * Exact label first, then the first number in it. Schubers are excluded so Band 1 never matches a Schuber.
 */
function findRegularVolume(officialVolumes, volumeNumber) {
  const regular = officialVolumes.filter(v => !isSchuberEntry(v));
  const key = String(volumeNumber || '').trim().toLowerCase();
  const exact = regular.find(v => String(v.volume_number || '').trim().toLowerCase() === key);
  if (exact) return exact;
  const m = key.match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  const wanted = parseFloat(m[1]);
  return regular.find(v => v.num === wanted && v.num < 99999) || null;
}

/**
 * Intelligently matches a Schuber (Sammelschuber or Leerschuber) by customArrangement, title, or index.
 */
function matchSchuberVolume(volumes, volumeNumber, userPrice, userNotes) {
  if (!volumes || volumes.length === 0) return null;
  const numMatch = String(volumeNumber || '').match(/(\d+(\.\d+)?)/);
  const targetNum = numMatch ? parseInt(numMatch[1], 10) : 1;

  const schuberVols = volumes.filter(v => 
    v.specialType === 1 || v.type === 3 || 
    /schuber|box|slipcase/i.test(v.title || '') || 
    /schuber/i.test(v.volume_number || '')
  );
  if (schuberVols.length === 0) return null;

  const emptyBoxes = schuberVols.filter(v => /leer/i.test(v.title || '') || (v.price && v.price <= 25));
  const fullBoxes = schuberVols.filter(v => /sammel|komplett/i.test(v.title || '') || (v.price && v.price > 25));

  const preferEmpty = (userPrice && userPrice <= 25) || /leer/i.test(userNotes || '') || (!userPrice && emptyBoxes.length > 0);
  const pool = (preferEmpty && emptyBoxes.length > 0) ? emptyBoxes : (fullBoxes.length > 0 ? fullBoxes : schuberVols);

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

  return matched || pool[0];
}

module.exports = {
  scoreEdition,
  titleKey,
  titleRelation,
  buildSearchQueries,
  isConfidentMatch,
  cleanOfficialDate,
  classifyOfficialVolume,
  officialVolumeNumber,
  resolveOfficialGap,
  matchSchuberVolume,
  isSchuberEntry,
  findRegularVolume
};
