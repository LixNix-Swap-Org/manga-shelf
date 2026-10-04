const { db, withTransaction } = require('../../db.js');
const { normalizePublisher } = require('../../utils/publishers');
const { normalizeIsbn } = require('../../utils/isbn');
const { inferVolumeType } = require('../../utils/volumeType');
const log = require('../../utils/logger').child('manga-passion');
const {
  API_BASE, HEADERS, fetchWithTimeout, downloadRemoteImageToUploads,
  searchMangaPassionEditions, getEditionDetailsAndVolumes, linkRecommendedEdition
} = require('./client');
const {
  cleanOfficialDate, matchSchuberVolume, findOfficialVolume, classifyOfficialVolume, knownPublisher,
  MP_UNREACHABLE_MESSAGE, MP_EDITION_NOT_FOUND_MESSAGE
} = require('./classify');

const VOLUME_TYPES = ['volume', 'special_edition', 'schuber', 'special'];

/** Type of the volume a single lookup is for: the form's type, keywords in the number, "schuber" in the notes. */
function lookupVolumeType(volumeNumber, options) {
  const vn = String(volumeNumber || '').toLowerCase();
  const type = VOLUME_TYPES.includes(options.type) ? options.type : null;
  if (type === 'schuber' || vn.includes('schuber') || String(options.notes || '').toLowerCase().includes('schuber')) return 'schuber';
  if (type && type !== 'volume') return type;
  if (/(?:special|spezial|limited|collector['’]?s?)\s*edition/.test(vn)) return 'special_edition';
  if (type === 'volume') return 'volume';
  return inferVolumeType({ volume_number: volumeNumber });
}

function officialYear(date, year) {
  if (date) return parseInt(date.slice(0, 4), 10);
  return Number.isInteger(year) && year >= 1900 && year < 2100 ? year : null;
}

/** The official entry for a user volume, never one of another type. Schubers: matchSchuberVolume. */
function matchOfficialVolume(officialVolumes, volumeNumber, type, hint = {}) {
  if (type === 'schuber') return matchSchuberVolume(officialVolumes, volumeNumber, hint.price, hint.notes);
  return findOfficialVolume(officialVolumes, volumeNumber, type, hint);
}

/** A stored link (set by the gap import) wins over number matching while it still fits the volume's type and number. */
function linkedOfficialVolume(officialVolumes, uv, type) {
  if (!uv.manga_passion_volume_id) return null;
  const linked = officialVolumes.find(ov => ov.id === uv.manga_passion_volume_id);
  if (!linked || classifyOfficialVolume(linked) !== type) return null;
  if (type === 'volume' || type === 'special_edition') {
    const m = String(uv.volume_number || '').match(/(\d+(?:\.\d+)?)/);
    if (m && linked.num !== parseFloat(m[1])) return null;
  }
  return linked;
}

/**
 * Looks up detailed metadata for a single volume or schuber (release_date, release_year, pages, isbn, price, cover, title)
 * via Manga Passion (and optionally DNB).
 */
async function lookupVolumeMetadata(mangaId, volumeNumber, options = {}) {
  let manga = null;
  if (mangaId) {
    manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  }

  // 0. Direct Manga Passion Volume URL or ID lookup (e.g. https://www.manga-passion.de/volumes/9736/...)
  const rawInput = options.url || volumeNumber || '';
  const urlMatch = String(rawInput).match(/manga-passion\.de\/volumes\/(\d+)/i) || 
                   String(options.mp_volume_id || '').match(/^#?(\d{3,8})$/) ||
                   (String(volumeNumber || '').match(/^#?(\d{4,8})$/) ? String(volumeNumber).match(/^#?(\d{4,8})$/) : null);
  const directVolumeId = urlMatch ? parseInt(urlMatch[1], 10) : (options.mp_volume_id ? parseInt(options.mp_volume_id, 10) : null);

  if (directVolumeId) {
    try {
      const fullRes = await fetchWithTimeout(`${API_BASE}/volumes/${directVolumeId}`, { headers: HEADERS }, 8000);
      if (fullRes.ok) {
        const fullVol = await fullRes.json();
        const localCover = await downloadRemoteImageToUploads(fullVol.cover);
        const relDate = cleanOfficialDate(fullVol);
        const relYear = officialYear(relDate, fullVol.year);
        const publisher = normalizePublisher(fullVol.edition?.publishers?.[0]?.name) || knownPublisher(manga?.publisher);

        return {
          success: true,
          matched: true,
          data: {
            volume_number: fullVol.numberDisplay || (fullVol.number !== null ? String(fullVol.number) : String(volumeNumber || 'Schuber')),
            release_date: relDate,
            release_year: relYear,
            pages: fullVol.pages || null,
            isbn: normalizeIsbn(fullVol.isbn13 || fullVol.isbn10),
            price: fullVol.price ? Math.round(fullVol.price) / 100 : null,
            publisher,
            cover_image: localCover || fullVol.cover || null,
            remote_cover_url: fullVol.cover || null,
            notes: fullVol.title || null,
            mp_volume_id: fullVol.id,
            source: 'Manga Passion'
          }
        };
      }
    } catch (e) {
      log.warn('Error fetching direct volume id from Manga Passion:', e.message);
    }
  }

  let editionId = options.edition_id || manga?.manga_passion_id;

  if (!editionId && manga) {
    try {
      // a single volume lookup may use an unconfirmed edition: the user sees and checks the filled values
      const searchRes = await searchMangaPassionEditions(manga.title, manga.publisher, manga.total_volumes);
      editionId = linkRecommendedEdition(manga, searchRes).editionId;
    } catch (e) {
      log.warn('Error finding edition for volume lookup:', e.message);
    }
  }

  let matchedVolume = null;
  let editionInfo = null;

  if (editionId) {
    try {
      const details = await getEditionDetailsAndVolumes(editionId, options.force_refresh);
      if (details && details.volumes && details.volumes.length > 0) {
        editionInfo = details.edition;

        const type = lookupVolumeType(volumeNumber, options);
        matchedVolume = matchOfficialVolume(details.volumes, volumeNumber, type, { notes: options.notes, price: options.price });
      }
    } catch (e) {
      log.warn('Error fetching edition volumes:', e.message);
    }
  }

  let resultData = null;

  if (matchedVolume) {
    let fullVol = null;
    if (matchedVolume.id) {
      try {
        const fullRes = await fetchWithTimeout(`${API_BASE}/volumes/${matchedVolume.id}`, { headers: HEADERS }, 8000);
        if (fullRes.ok) {
          fullVol = await fullRes.json();
        }
      } catch (e) {
        log.warn('Error fetching full volume details from Manga Passion:', e.message);
      }
    }

    const relDate = fullVol?.date ? cleanOfficialDate(fullVol) : matchedVolume.release_date;
    const relYear = officialYear(relDate, fullVol?.year);
    const pages = fullVol?.pages || matchedVolume.pages || null;
    const isbn = normalizeIsbn(fullVol?.isbn13 || fullVol?.isbn10 || options.isbn);
    const price = fullVol?.price ? Math.round(fullVol.price) / 100 : matchedVolume.price;
    const rawCover = fullVol?.cover || matchedVolume.cover_image || null;
    const localCover = await downloadRemoteImageToUploads(rawCover);
    const title = fullVol?.title || matchedVolume.title || null;
    const publisher = knownPublisher(editionInfo?.publisher) || knownPublisher(manga?.publisher);

    let finalVolNumber = matchedVolume.volume_number || String(volumeNumber);
    const isSchuber = options.type === 'schuber' || String(volumeNumber || '').toLowerCase().includes('schuber');
    if (isSchuber) {
      if (String(volumeNumber || '').toLowerCase().includes('schuber')) {
        finalVolNumber = String(volumeNumber);
      } else {
        finalVolNumber = `Schuber ${volumeNumber}`;
      }
    }

    resultData = {
      volume_number: finalVolNumber,
      release_date: relDate || null,
      release_year: relYear || null,
      pages: pages || null,
      isbn: isbn || null,
      price: price || null,
      publisher: publisher || null,
      cover_image: localCover || rawCover || null,
      remote_cover_url: rawCover || null,
      notes: title || null,
      mp_volume_id: matchedVolume.id,
      source: 'Manga Passion'
    };
  }

  if (resultData) {
    return {
      success: true,
      matched: true,
      data: resultData
    };
  }

  return {
    success: false,
    matched: false,
    message: `Keine Daten für "${volumeNumber}" auf Manga Passion gefunden.`
  };
}

const AUTOFILL_COLUMNS = ['release_date', 'release_year', 'pages', 'price', 'publisher', 'cover_image', 'notes'];

/**
 * Writes autofill results in one transaction. `pendingUpdates` is [{ uv, next }]: the volume row as it was read and the
 * new values computed from it. Those were computed before the (async) cover downloads, so a field somebody edited in
 * the meantime keeps its current value instead of being overwritten with the stale snapshot.
 * Returns the number of rows written.
 */
function applyAutofillUpdates(pendingUpdates) {
  const updateStmt = db.prepare(`UPDATE volumes SET ${AUTOFILL_COLUMNS.map(c => `${c} = ?`).join(', ')} WHERE id = ?`);
  let written = 0;
  withTransaction(() => {
    for (const { uv, next } of pendingUpdates) {
      const current = db.prepare('SELECT * FROM volumes WHERE id = ?').get(uv.id);
      if (!current) continue; // deleted meanwhile
      const merged = AUTOFILL_COLUMNS.map(c => (current[c] !== uv[c] ? current[c] : next[c]));
      updateStmt.run(...merged, uv.id);
      written++;
    }
  });
  return written;
}

/**
 * Batch-autofills missing release dates, years, pages, and prices for all volumes in a manga.
 */
async function autofillMangaVolumes(mangaId, options = {}) {
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) throw new Error('Manga nicht gefunden');

  let editionId = options.edition_id || manga.manga_passion_id;
  if (!editionId) {
    const searchRes = await searchMangaPassionEditions(manga.title, manga.publisher, manga.total_volumes);
    if (searchRes.unavailable) {
      return { success: false, unavailable: true, message: MP_UNREACHABLE_MESSAGE, updated_count: 0 };
    }
    const linked = linkRecommendedEdition(manga, searchRes);
    if (linked.editionId && !linked.confident) {
      // writing data into every volume from a guessed edition could corrupt them: ask first
      return {
        success: false,
        needs_confirmation: true,
        message: 'Die passende Manga-Passion-Edition ist nicht eindeutig (Vorschlag: "' + searchRes.recommended.title + '"). Bitte zuerst mit „Edition bestätigen“ (Lücken-Hinweis oder Manga-Passion-Dialog) bestätigen oder eine andere Edition wählen.',
        updated_count: 0
      };
    }
    editionId = linked.editionId;
  }

  if (!editionId) {
    return {
      success: false,
      message: 'Keine passende deutsche Edition auf Manga-Passion gefunden.',
      updated_count: 0
    };
  }

  const details = await getEditionDetailsAndVolumes(editionId, false);
  if (!details || details.notFound) {
    return { success: false, message: MP_EDITION_NOT_FOUND_MESSAGE, updated_count: 0 };
  }
  if (details.incomplete && !details.volumes?.length) {
    return { success: false, unavailable: true, message: MP_UNREACHABLE_MESSAGE, updated_count: 0 };
  }
  if (!details.volumes || details.volumes.length === 0) {
    return {
      success: false,
      message: 'Keine Bände für diese Edition gefunden.',
      updated_count: 0
    };
  }

  const officialVolumes = details.volumes;
  const userVolumes = db.prepare('SELECT * FROM volumes WHERE manga_id = ?').all(mangaId);

  let updatedCount = 0;
  const overwrite = Boolean(options.overwrite);
  const editionPublisher = knownPublisher(details.edition?.publisher);
  const mangaPublisher = knownPublisher(manga.publisher);

  const matches = [];
  for (const uv of userVolumes) {
    const type = inferVolumeType(uv);
    const matched = linkedOfficialVolume(officialVolumes, uv, type)
      || matchOfficialVolume(officialVolumes, uv.volume_number, type, { notes: uv.notes, price: uv.price });
    if (matched) matches.push({ uv, type, matched });
  }

  // Phase 1 (async): pre-download needed Schuber covers without holding a DB lock
  const schuberCovers = new Map();
  for (const { uv, type, matched } of matches) {
    if (type === 'schuber' && matched.cover_image && (overwrite || !uv.cover_image || options.update_covers)) {
      try {
        const localCover = await downloadRemoteImageToUploads(matched.cover_image);
        if (localCover) schuberCovers.set(uv.id, localCover);
      } catch (e) { log.warn('Schuber cover download failed:', e.message); }
    }
  }

  const pendingUpdates = [];
  for (const { uv, type, matched } of matches) {
    const next = {
      release_date: uv.release_date, release_year: uv.release_year, pages: uv.pages, price: uv.price,
      publisher: uv.publisher, cover_image: uv.cover_image, notes: uv.notes
    };
    let changed = false;
    const set = (field, value, when) => {
      if (when && value && value !== next[field]) { next[field] = value; changed = true; }
    };

    set('release_date', matched.release_date, overwrite || !next.release_date);
    const inferredYear = matched.release_date ? parseInt(matched.release_date.slice(0, 4), 10) : null;
    set('release_year', inferredYear, overwrite || !next.release_year);
    set('pages', matched.pages, overwrite || !next.pages);
    set('price', matched.price, overwrite || !next.price);
    // the edition's publisher may replace a volume's own one; the series publisher only fills a missing one
    const volumePublisher = knownPublisher(next.publisher);
    if (editionPublisher) set('publisher', editionPublisher, overwrite || !volumePublisher);
    else set('publisher', mangaPublisher, !volumePublisher);

    if (type === 'schuber') {
      if (schuberCovers.has(uv.id)) set('cover_image', schuberCovers.get(uv.id), true);
      set('notes', matched.title, overwrite || !next.notes || next.notes === 'Das Abenteuer beginnt');
    }

    if (changed) pendingUpdates.push({ uv, next });
  }

  // Phase 2 (sync): apply all updates atomically
  updatedCount = applyAutofillUpdates(pendingUpdates);

  return {
    success: true,
    edition_title: details.edition?.title,
    updated_count: updatedCount,
    total_user_volumes: userVolumes.length
  };
}

module.exports = {
  lookupVolumeMetadata,
  autofillMangaVolumes,
  applyAutofillUpdates
};
