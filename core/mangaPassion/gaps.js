// Gap check and gap import of a series against its linked Manga Passion edition.
const { inferVolumeType, volumeNumberOf } = require('../lib/volumeType');
const { canonicalVolumeNumber } = require('../lib/volumeNumber');
const { normalizeTags } = require('../lib/tags');

const log = (ctx) => ctx.log.child('manga-passion');
const {
  searchMangaPassionEditions, getEditionDetailsAndVolumes, linkRecommendedEdition, toEditionId, downloadRemoteImageToUploads
} = require('./client');
const {
  classifyOfficialVolume, officialVolumeNumber, resolveOfficialGap, knownPublisher, MP_UNREACHABLE_MESSAGE, MP_EDITION_NOT_FOUND_MESSAGE
} = require('./classify');

// Statuses a gap import may write. 'Vorhanden' is excluded on purpose: it needs an owner (core/lib/owners.js).
const GAP_IMPORT_STATUSES = ['Vorbestellt', 'Fehlt', 'Erscheint bald', 'Bestellt'];
const MAX_VOLUME_NUMBER_LENGTH = 80;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const SAGA_PATTERN = /(east blue|alabasta|skypia|water seven|water 7|thriller bark|marine ford|marineford|fischmenschen|dress rosa|whole cake|wa no kuni)/i;

// A Leerschuber (empty box) and a Sammelschuber (filled set) are different products; a neutral name covers either.
function schuberKindsConflict(officialText, userText) {
  return (/leer/.test(officialText) && /sammel/.test(userText)) || (/sammel/.test(officialText) && /leer/.test(userText));
}

const userVolumeKey = (type, volumeNumber) => `${type}:${canonicalVolumeNumber(volumeNumber, type).toLowerCase()}`;

/**
 * options: { edition_id, force_refresh, signal, persist }. persist: false (read-only roles) never stores an
 * automatically found edition link.
 */
async function reconcileMangaGaps(ctx, mangaId, options = {}) {
  const manga = ctx.db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) throw httpError(404, 'Manga nicht gefunden');

  const userVolumes = ctx.db.prepare('SELECT * FROM volumes WHERE manga_id = ?').all(mangaId);

  let editionId = options.edition_id || manga.manga_passion_id;
  let candidateEditions = [];
  // false: the edition was only guessed or previewed, it is used for this answer but not stored
  let linkConfirmed = true;
  if (options.edition_id) {
    linkConfirmed = manga.manga_passion_id != null && Number(options.edition_id) === Number(manga.manga_passion_id);
  }

  if (!editionId) {
    const searchRes = await searchMangaPassionEditions(ctx, manga.title, manga.publisher, manga.total_volumes, {
      signal: options.signal,
      forceRefresh: Boolean(options.force_refresh)
    });
    if (searchRes.unavailable) {
      return { success: false, matched: false, unavailable: true, message: MP_UNREACHABLE_MESSAGE, candidate_editions: [] };
    }
    candidateEditions = searchRes.candidates;
    const linked = linkRecommendedEdition(ctx, manga, searchRes, { persist: options.persist !== false });
    editionId = linked.editionId;
    linkConfirmed = linked.confident;
  }

  if (!editionId) {
    return {
      success: false,
      matched: false,
      message: 'Keine passende deutsche Edition auf Manga-Passion gefunden.',
      candidate_editions: candidateEditions
    };
  }

  const details = await getEditionDetailsAndVolumes(ctx, editionId, options.force_refresh);
  if (!details || details.notFound || !details.volumes) {
    return {
      success: false,
      matched: false,
      message: MP_EDITION_NOT_FOUND_MESSAGE,
      candidate_editions: candidateEditions
    };
  }
  if (details.incomplete && !details.volumes.length) {
    return {
      success: false,
      matched: false,
      unavailable: true,
      message: MP_UNREACHABLE_MESSAGE,
      candidate_editions: candidateEditions
    };
  }
  const { edition, volumes: officialVolumes } = details;

  // Index the user's volumes by type AND number: Collectors Edition 5 is not Band 5.
  const userByTypeNum = new Map();
  const userNotesMap = new Map();
  userVolumes.forEach(v => {
    const type = inferVolumeType(v);
    const k = userVolumeKey(type, v.volume_number);
    if (!userByTypeNum.has(k) || v.status === 'Vorhanden') userByTypeNum.set(k, v);
    if (v.notes) {
      const nk = `${type}:${String(v.notes).trim().toLowerCase()}`;
      if (!userNotesMap.has(nk) || v.status === 'Vorhanden') userNotesMap.set(nk, v);
    }
  });

  const gaps = [];

  officialVolumes.forEach(ov => {
    const key = String(ov.volume_number || '').trim().toLowerCase();
    const titleKey = String(ov.title || '').trim().toLowerCase();
    const inferredType = classifyOfficialVolume(ov);
    let existing = userByTypeNum.get(`${inferredType}:${key}`);

    // Numbered entries: "Band 14" / "Schuber 8" in the collection are the official "14" / "8 (Schuber)"
    if (!existing && /^\d+$/.test(key)) {
      const wanted = parseInt(key, 10);
      existing = userVolumes.find(uv => inferVolumeType(uv) === inferredType && volumeNumberOf(uv) === wanted);
    }

    // Named entries (e.g. "East Blue Leerschuber") and titled volumes: check notes/titles and Schuber saga names.
    // A Special/Collectors/Limited Edition title is generic and shared by many entries, so it is never matched by name.
    if (!existing && titleKey && inferredType !== 'special_edition' && !(inferredType !== 'volume' && /^\d+$/.test(key))) {
      existing = userNotesMap.get(`${inferredType}:${titleKey}`);
      if (!existing) {
        existing = userVolumes.find(uv => {
          // a Leerschuber is not covered by a regular volume or a Collectors Edition: compare like with like
          if (inferVolumeType(uv) !== inferredType) return false;
          const uvNotes = String(uv.notes || '').trim().toLowerCase();
          const uvNum = String(uv.volume_number || '').trim().toLowerCase();
          if (uvNotes && (uvNotes.includes(titleKey) || titleKey.includes(uvNotes))) return true;
          // a bare number ("1") is a substring of many titles ("... Bände 1-5") and must not count as a name match
          if (uvNum && !/^\d+$/.test(uvNum) && (uvNum.includes(titleKey) || titleKey.includes(uvNum))) return true;
          return false;
        });
      }
      // Also match saga names in Schubers (e.g. East Blue, Alabasta, Skypia, Water 7, etc.)
      if (!existing && inferredType === 'schuber') {
        const schuberMatch = titleKey.match(SAGA_PATTERN);
        if (schuberMatch) {
          const saga = schuberMatch[1].toLowerCase();
          existing = userVolumes.find(uv => {
            if (inferVolumeType(uv) !== inferredType) return false;
            const uvStr = `${uv.volume_number} ${uv.notes || ''}`.toLowerCase();
            return uvStr.includes(saga) && !schuberKindsConflict(titleKey, uvStr);
          });
        }
      }
    }

    const finalVolNumber = officialVolumeNumber(ov);

    const enrichedOv = {
      ...ov,
      volume_number: finalVolNumber,
      display_title: (ov.title && ov.title.trim() !== finalVolNumber) ? `${finalVolNumber} (${ov.title.trim()})` : finalVolNumber,
      type: inferredType
    };

    if (!existing) {
      // A range entry ("21-25") is no gap when every regular volume in it is owned
      const rangeMatch = key.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        if (start < end && (end - start) <= 30) {
          let allOwned = true;
          for (let k = start; k <= end; k++) {
            const constituent = userByTypeNum.get(`volume:${k}`);
            if (!constituent || constituent.status !== 'Vorhanden') {
              allOwned = false;
              break;
            }
          }
          if (allOwned) {
            // The user already owns every individual volume in this range!
            return;
          }
        }
      }

      // Range-numbered Schuber (box sets for "1-5") are optional extras and never reported as gaps
      if (enrichedOv.type === 'schuber' && rangeMatch) {
        return;
      }

      gaps.push({
        ...enrichedOv,
        in_collection: false,
        user_status: null,
        user_volume_id: null
      });
    } else if (existing.status === 'Fehlt') {
      gaps.push({
        ...enrichedOv,
        in_collection: true,
        user_status: 'Fehlt',
        user_volume_id: existing.id
      });
    }
  });

  // Only a total announced by Manga Passion may suggest changing the stored total; a count of the listed
  // regular volumes trails running series (and partial lists), so it is used for display only.
  const announcedTotal = edition?.total_volumes || null;
  const listedTotal = officialVolumes.filter(v => classifyOfficialVolume(v) === 'volume').length;
  const officialTotal = announcedTotal || listedTotal || null;
  let discrepancy = null;
  if (manga.total_volumes && announcedTotal && manga.total_volumes !== announcedTotal) {
    discrepancy = {
      has_discrepancy: true,
      db_total: manga.total_volumes,
      official_total: announcedTotal,
      edition_title: edition ? edition.title : manga.title,
      publisher: edition ? edition.publisher : manga.publisher,
      message: `Deine Sammlung gibt ${manga.total_volumes} Bände an (oft AniList-Originalzählung). Die deutsche Edition umfasst ${announcedTotal} Bände.`
    };
  }

  return {
    success: true,
    matched: true,
    edition,
    discrepancy,
    total_official_volumes: officialTotal,
    gaps,
    incomplete: Boolean(details.incomplete),
    stale: Boolean(details.stale),
    link_confirmed: linkConfirmed,
    candidate_editions: candidateEditions
  };
}

/** Type of a gap label when no official entry matches it (Manga Passion unreachable): same rules as for official entries. */
function classifyGapLabel(label) {
  const labelled = label.match(/^(\d+)\s*\((.+)\)\s*$/);
  return classifyOfficialVolume(labelled
    ? { volume_number: labelled[1], title: labelled[2].trim() }
    : { volume_number: label, title: label });
}

const COVER_DOWNLOAD_CONCURRENCY = 4;

/** Downloads the given remote covers into uploads/; returns Map remote URL -> local /uploads path (failures are left out). */
async function downloadCovers(ctx, urls) {
  const result = new Map();
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const local = await downloadRemoteImageToUploads(ctx, url);
        if (typeof local === 'string' && local.startsWith('/uploads/')) result.set(url, local);
      } catch (e) {
        log(ctx).warn('Gap cover download failed:', e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVER_DOWNLOAD_CONCURRENCY, urls.length) }, worker));
  return result;
}

/** One requested gap label resolved to the entry it creates: { key, volNumber, targetType, matchedOfficial, cleanLabel } or null. */
function planGapEntry(entry, officialVolumes) {
  if (typeof entry !== 'string' && !(typeof entry === 'number' && Number.isFinite(entry))) return null;
  const cleanLabel = String(entry).trim();
  const matchedOfficial = cleanLabel ? resolveOfficialGap(cleanLabel, officialVolumes) : null;
  const targetType = matchedOfficial ? classifyOfficialVolume(matchedOfficial) : classifyGapLabel(cleanLabel);
  // store the clean number ("26"), not the UI label ("26 (Titel)")
  const volNumber = String(matchedOfficial ? officialVolumeNumber(matchedOfficial) : cleanLabel.replace(/\s*\(.*\)\s*$/, '')).trim();
  if (!volNumber || volNumber.length > MAX_VOLUME_NUMBER_LENGTH) return null;
  return { key: userVolumeKey(targetType, volNumber), volNumber, targetType, matchedOfficial, cleanLabel };
}

async function batchImportGaps(ctx, mangaId, gapVolumeNumbers, targetStatus = 'Fehlt', editionId = null) {
  if (!GAP_IMPORT_STATUSES.includes(targetStatus)) {
    throw httpError(400, 'Ungültiger Zielstatus (erlaubt: ' + GAP_IMPORT_STATUSES.join(', ') + ')');
  }
  const manga = ctx.db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) throw httpError(404, 'Manga nicht gefunden');

  const effEditionId = editionId || manga.manga_passion_id;
  let officialVolumes = [];
  if (effEditionId) {
    try {
      const data = await getEditionDetailsAndVolumes(ctx, effEditionId);
      officialVolumes = data.volumes || [];
    } catch (e) { log(ctx).warn('Loading Manga Passion edition for gap import failed:', e); }
  }

  const readExisting = () => {
    const map = new Map();
    ctx.db.prepare('SELECT id, volume_number, status, type, notes, cover_image FROM volumes WHERE manga_id = ?').all(mangaId).forEach(v => {
      const k = userVolumeKey(inferVolumeType(v), v.volume_number);
      // an owned entry wins over a listed duplicate ("Band 2" owned next to a missing "2")
      if (!map.has(k) || v.status === 'Vorhanden') map.set(k, v);
    });
    return map;
  };
  const isOwnedEntry = (v) => v.status === 'Vorhanden' || v.status === 'Gelesen';

  const plans = gapVolumeNumbers.map(entry => planGapEntry(entry, officialVolumes));

  // covers are downloaded before the transaction (no network inside it); a failed download keeps the remote URL
  const before = readExisting();
  const coverUrls = new Set();
  for (const plan of plans) {
    const url = plan?.matchedOfficial?.cover_image;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    const existing = before.get(plan.key);
    if (existing && (isOwnedEntry(existing) || existing.cover_image)) continue;
    coverUrls.add(url);
  }
  const localCovers = await downloadCovers(ctx, [...coverUrls]);

  const importedIds = [];
  const updatedIds = [];
  const skippedOwned = [];
  let skippedInvalid = 0;

  const updateStmt = ctx.db.prepare(`
    UPDATE volumes 
    SET status = ?,
        price = COALESCE(price, ?),
        release_date = COALESCE(release_date, ?),
        cover_image = COALESCE(cover_image, ?),
        type = COALESCE(type, ?),
        notes = COALESCE(notes, ?),
        manga_passion_volume_id = COALESCE(manga_passion_volume_id, ?)
    WHERE id = ?
  `);

  const insertStmt = ctx.db.prepare(`
    INSERT INTO volumes (
      manga_id, volume_number, status, price, release_date, 
      publisher, cover_image, type, notes, manga_passion_volume_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  ctx.db.transaction(() => {
    // the downloads took a while: the series may have been deleted meanwhile
    if (!ctx.db.prepare('SELECT 1 FROM mangas WHERE id = ?').get(mangaId)) throw httpError(404, 'Manga nicht gefunden');
    const existingMap = readExisting();
    const seen = new Set();
    for (const plan of plans) {
      if (!plan) {
        skippedInvalid++;
        continue;
      }
      const { key, volNumber, targetType, matchedOfficial, cleanLabel } = plan;
      if (seen.has(key)) continue; // the same entry twice in one request
      seen.add(key);

      const price = matchedOfficial && matchedOfficial.price !== null ? matchedOfficial.price : null;
      const releaseDate = matchedOfficial && matchedOfficial.release_date ? matchedOfficial.release_date : null;
      const remoteCover = matchedOfficial && matchedOfficial.cover_image ? matchedOfficial.cover_image : null;
      const coverImage = remoteCover ? (localCovers.get(remoteCover) || remoteCover) : null;
      const mpVolId = matchedOfficial ? matchedOfficial.id : null;
      const publisher = manga.publisher || null;
      const notes = targetType === 'volume' ? (matchedOfficial?.title || null) : (matchedOfficial?.title || cleanLabel);

      const existing = existingMap.get(key);
      if (existing) {
        // never touch something the user already owns / has read; only complete the data of listed entries
        if (isOwnedEntry(existing)) {
          skippedOwned.push(existing.id);
          continue;
        }
        updateStmt.run(targetStatus, price, releaseDate, coverImage, targetType, notes, mpVolId, existing.id);
        updatedIds.push(existing.id);
      } else {
        const ins = insertStmt.run(mangaId, volNumber, targetStatus, price, releaseDate, publisher, coverImage, targetType, notes, mpVolId);
        importedIds.push(Number(ins.lastInsertRowid));
      }
    }

    ctx.db.prepare('UPDATE mangas SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(mangaId);
  });

  return {
    success: true,
    imported_count: importedIds.length,
    imported_ids: importedIds,
    updated_count: updatedIds.length,
    skipped_owned_count: skippedOwned.length,
    skipped_invalid_count: skippedInvalid,
    total_processed: importedIds.length + updatedIds.length
  };
}

async function syncMangaWithEdition(ctx, mangaId, editionId, options = {}) {
  const manga = ctx.db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) throw httpError(404, 'Manga nicht gefunden');

  // an edition whose volume list 404s still has edition data and can be synced
  const details = await getEditionDetailsAndVolumes(ctx, editionId);
  const edition = details?.edition;
  if (!edition) {
    if (details?.notFound) throw httpError(404, 'Edition auf Manga-Passion nicht gefunden');
    throw httpError(503, 'Manga Passion ist gerade nicht erreichbar. Bitte später erneut versuchen.');
  }

  const updates = [];
  const params = [];

  updates.push('manga_passion_id = ?');
  params.push(toEditionId(editionId));

  updates.push('manga_passion_edition_data = ?');
  params.push(JSON.stringify(edition));

  if (options.update_total_volumes && edition.total_volumes) {
    updates.push('total_volumes = ?');
    params.push(edition.total_volumes);
  }

  if (options.update_status && edition.status && edition.status !== 'Unbekannt') {
    updates.push('status = ?');
    params.push(edition.status);
  }

  // an empty genre list takes the edition's (never replaces tags the user set)
  const editionTags = normalizeTags(edition.tags);
  if (editionTags && !(typeof manga.tags === 'string' && manga.tags.trim())) {
    updates.push('tags = ?');
    params.push(editionTags);
  }

  if (options.update_publisher && knownPublisher(edition.publisher)) {
    updates.push('publisher = ?');
    params.push(knownPublisher(edition.publisher));
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(mangaId);

  const sql = `UPDATE mangas SET ${updates.join(', ')} WHERE id = ?`;
  ctx.db.prepare(sql).run(...params);

  const updatedManga = ctx.db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  return updatedManga;
}

module.exports = {
  GAP_IMPORT_STATUSES,
  reconcileMangaGaps,
  batchImportGaps,
  syncMangaWithEdition
};
