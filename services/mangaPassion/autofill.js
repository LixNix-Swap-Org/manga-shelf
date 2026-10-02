const { db, withTransaction } = require('../../db.js');
const { normalizePublisher } = require('../../utils/publishers');
const { normalizeIsbn } = require('../../utils/isbn');
const log = require('../../utils/logger').child('manga-passion');
const {
  API_BASE, HEADERS, fetchWithTimeout, downloadRemoteImageToUploads,
  searchMangaPassionEditions, getEditionDetailsAndVolumes, saveEditionLink
} = require('./client');
const { cleanOfficialDate, matchSchuberVolume, findRegularVolume } = require('./classify');

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
        const relDate = cleanOfficialDate(fullVol.date);
        const relYear = fullVol.year || (relDate ? parseInt(relDate.slice(0, 4), 10) : null);
        const publisher = normalizePublisher(fullVol.edition?.publishers?.[0]?.name) || manga?.publisher || null;

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
      const searchRes = await searchMangaPassionEditions(manga.title, manga.publisher, manga.total_volumes);
      if (searchRes.recommended) {
        editionId = searchRes.recommended.id;
        saveEditionLink(manga, editionId);
      }
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

        const isSchuber = options.type === 'schuber' ||
          String(volumeNumber || '').toLowerCase().includes('schuber') ||
          String(options.notes || '').toLowerCase().includes('schuber');

        if (isSchuber) {
          matchedVolume = matchSchuberVolume(details.volumes, volumeNumber, options.price, options.notes);
        } else if (options.type === 'special_edition' || String(volumeNumber || '').toLowerCase().includes('special edition') || String(volumeNumber || '').toLowerCase().includes('limited edition')) {
          matchedVolume = details.volumes.find(v => v.specialType === 2 || /special\s*edition|limited\s*edition/i.test(v.title || ''));
        } else {
          matchedVolume = findRegularVolume(details.volumes, volumeNumber);
        }
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

    const relDate = fullVol?.date ? cleanOfficialDate(fullVol.date) : matchedVolume.release_date;
    const relYear = fullVol?.year || (relDate ? parseInt(relDate.slice(0, 4), 10) : null);
    const pages = fullVol?.pages || matchedVolume.pages || null;
    const isbn = normalizeIsbn(fullVol?.isbn13 || fullVol?.isbn10 || options.isbn);
    const price = fullVol?.price ? Math.round(fullVol.price) / 100 : matchedVolume.price;
    const rawCover = fullVol?.cover || matchedVolume.cover_image || null;
    const localCover = await downloadRemoteImageToUploads(rawCover);
    const title = fullVol?.title || matchedVolume.title || null;
    const publisher = editionInfo?.publisher || manga?.publisher || null;

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
    if (searchRes.recommended) {
      editionId = searchRes.recommended.id;
      saveEditionLink(manga, editionId);
    }
  }

  if (!editionId) {
    return {
      success: false,
      message: 'Keine passende deutsche Edition auf Manga-Passion gefunden.',
      updated_count: 0
    };
  }

  const details = await getEditionDetailsAndVolumes(editionId, false);
  if (!details || !details.volumes || details.volumes.length === 0) {
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

  // Phase 1 (async): pre-download needed Schuber covers and collect updates without holding a DB lock
  const schuberCovers = new Map();
  for (const uv of userVolumes) {
    const isSchuber = uv.type === 'schuber' || String(uv.volume_number || '').toLowerCase().includes('schuber');
    if (isSchuber) {
      const matched = matchSchuberVolume(officialVolumes, uv.volume_number, uv.price, uv.notes);
      if (matched?.cover_image && (overwrite || !uv.cover_image || options.update_covers)) {
        try {
          const localCover = await downloadRemoteImageToUploads(matched.cover_image);
          if (localCover) schuberCovers.set(uv.id, localCover);
        } catch (e) { log.warn('Schuber cover download failed:', e.message); }
      }
    }
  }

  const pendingUpdates = [];
    for (const uv of userVolumes) {
      const isSchuber = uv.type === 'schuber' || String(uv.volume_number || '').toLowerCase().includes('schuber');
      let matched = null;

      if (isSchuber) {
        matched = matchSchuberVolume(officialVolumes, uv.volume_number, uv.price, uv.notes);
      } else {
        matched = findRegularVolume(officialVolumes, uv.volume_number);
      }

      if (!matched) continue;

      let changed = false;
      let newDate = uv.release_date;
      let newYear = uv.release_year;
      let newPages = uv.pages;
      let newPrice = uv.price;
      let newPub = uv.publisher;
      let newCover = uv.cover_image;
      let newNotes = uv.notes;

      if ((overwrite || !newDate) && matched.release_date) {
        newDate = matched.release_date;
        changed = true;
      }
      const inferredYear = matched.release_date ? parseInt(matched.release_date.slice(0, 4), 10) : null;
      if ((overwrite || !newYear) && inferredYear) {
        newYear = inferredYear;
        changed = true;
      }
      if ((overwrite || !newPages) && matched.pages) {
        newPages = matched.pages;
        changed = true;
      }
      if ((overwrite || !newPrice || newPrice === 0) && matched.price) {
        newPrice = matched.price;
        changed = true;
      }
      if ((overwrite || !newPub) && (details.edition?.publisher || manga.publisher)) {
        newPub = details.edition?.publisher || manga.publisher;
        changed = true;
      }

      // For Schuber: apply pre-downloaded cover and title
      if (isSchuber) {
        if (schuberCovers.has(uv.id)) {
          newCover = schuberCovers.get(uv.id);
          changed = true;
        }
        if ((overwrite || !newNotes || newNotes === 'Das Abenteuer beginnt') && matched.title) {
          newNotes = matched.title;
          changed = true;
        }
      }

      if (changed) {
        pendingUpdates.push({
          uv,
          next: { release_date: newDate, release_year: newYear, pages: newPages, price: newPrice, publisher: newPub, cover_image: newCover, notes: newNotes }
        });
      }
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
