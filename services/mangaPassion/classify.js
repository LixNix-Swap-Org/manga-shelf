/**
 * Pure helpers for Manga Passion data: scoring editions, classifying official volumes and matching Schubers.
 * No database or network access, so everything here can be unit-tested directly.
 */

function scoreEdition(e, targetTitle, targetPub, targetTotal) {
  let score = 0;
  const tNorm = (targetTitle || '').toLowerCase().replace(/[:–—-]/g, ' ').replace(/\s+/g, ' ').trim();
  const eNorm = (e.title || '').toLowerCase().replace(/[:–—-]/g, ' ').replace(/\s+/g, ' ').trim();
  
  if (eNorm === tNorm) score += 100;
  else if (eNorm.includes(tNorm) || tNorm.includes(eNorm)) score += 50;

  const tBase = (targetTitle || '').toLowerCase().split(/[:–—-]/)[0].trim();
  const eBase = (e.title || '').toLowerCase().split(/[:–—-]/)[0].trim();
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
  cleanOfficialDate,
  classifyOfficialVolume,
  officialVolumeNumber,
  resolveOfficialGap,
  matchSchuberVolume,
  isSchuberEntry,
  findRegularVolume
};
