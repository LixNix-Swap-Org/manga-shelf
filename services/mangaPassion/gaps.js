const { db, runTransaction } = require('../../db.js');
const { inferVolumeType, volumeNumberOf } = require('../../utils/volumeType');
const log = require('../../utils/logger').child('manga-passion');
const { searchMangaPassionEditions, getEditionDetailsAndVolumes, linkRecommendedEdition } = require('./client');
const { classifyOfficialVolume, officialVolumeNumber, resolveOfficialGap } = require('./classify');

async function reconcileMangaGaps(mangaId, options = {}) {
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) throw new Error('Manga nicht gefunden');

  const userVolumes = db.prepare('SELECT * FROM volumes WHERE manga_id = ?').all(mangaId);

  let editionId = options.edition_id || manga.manga_passion_id;
  let candidateEditions = [];
  // false: the edition was only guessed (not unambiguous), it is used for this answer but not stored
  let linkConfirmed = true;

  if (!editionId) {
    const searchRes = await searchMangaPassionEditions(manga.title, manga.publisher, manga.total_volumes);
    candidateEditions = searchRes.candidates;
    const linked = linkRecommendedEdition(manga, searchRes);
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

  const details = await getEditionDetailsAndVolumes(editionId, options.force_refresh);
  if (!details || details.notFound || !details.volumes) {
    return {
      success: false,
      matched: false,
      message: 'Manga-Passion Edition nicht gefunden oder nicht verfügbar.',
      candidate_editions: candidateEditions
    };
  }
  if (details.incomplete && !details.volumes.length) {
    return {
      success: false,
      matched: false,
      message: 'Manga Passion ist gerade nicht erreichbar. Bitte später erneut versuchen.',
      candidate_editions: candidateEditions
    };
  }
  const { edition, volumes: officialVolumes } = details;

  // Index the user's volumes by type AND number: Collectors Edition 5 is not Band 5.
  const userByTypeNum = new Map();
  const userNotesMap = new Map();
  userVolumes.forEach(v => {
    const type = inferVolumeType(v);
    const num = String(v.volume_number || '').trim().toLowerCase();
    const k = `${type}:${num}`;
    if (!userByTypeNum.has(k) || v.status === 'Vorhanden') userByTypeNum.set(k, v);
    if (v.notes) {
      userNotesMap.set(String(v.notes).trim().toLowerCase(), v);
    }
  });

  const gaps = [];
  const ownedOfficial = [];

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
      existing = userNotesMap.get(titleKey);
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
      if (!existing && (titleKey.includes('schuber') || titleKey.includes('box'))) {
        const schuberMatch = titleKey.match(/(east blue|alabasta|skypia|water seven|water 7|thriller bark|marine ford|marineford|fischmenschen|dress rosa|whole cake|wa no kuni)/i);
        if (schuberMatch) {
          const saga = schuberMatch[1].toLowerCase();
          existing = userVolumes.find(uv => {
            const uvStr = `${uv.volume_number} ${uv.notes || ''}`.toLowerCase();
            return uvStr.includes(saga);
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
      // Check if this entry represents a volume range (e.g. "21-25", "26-30" or Sammelschuber)
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

      // Also skip schubers / box sets if constituent volumes are owned
      const isSchuber = enrichedOv.type === 'schuber';
      if (isSchuber && rangeMatch) {
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
    } else if (existing.status === 'Vorhanden') {
      ownedOfficial.push(enrichedOv);
    }
  });

  const releasedGaps = gaps.filter(g => g.is_released);
  const upcomingGaps = gaps.filter(g => !g.is_released);

  // Discrepancy analysis
  let discrepancy = null;
  const officialTotal = edition ? edition.total_volumes : officialVolumes.length;
  if (manga.total_volumes && officialTotal && manga.total_volumes !== officialTotal) {
    discrepancy = {
      has_discrepancy: true,
      db_total: manga.total_volumes,
      official_total: officialTotal,
      edition_title: edition ? edition.title : manga.title,
      publisher: edition ? edition.publisher : manga.publisher,
      message: `Deine Sammlung gibt ${manga.total_volumes} Bände an (oft AniList-Originalzählung). Die deutsche Edition umfasst ${officialTotal} Bände.`
    };
  }

  return {
    success: true,
    matched: true,
    edition,
    discrepancy,
    total_official_volumes: officialTotal,
    official_volumes: officialVolumes,
    gaps,
    released_gaps: releasedGaps,
    upcoming_gaps: upcomingGaps,
    owned_count: userVolumes.filter(v => v.status === 'Vorhanden').length,
    user_volumes_count: userVolumes.length,
    incomplete: Boolean(details.incomplete),
    link_confirmed: linkConfirmed,
    candidate_editions: candidateEditions
  };
}

async function batchImportGaps(mangaId, gapVolumeNumbers, targetStatus = 'Fehlt', editionId = null) {
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) throw new Error('Manga nicht gefunden');

  const effEditionId = editionId || manga.manga_passion_id;
  let officialVolumes = [];
  if (effEditionId) {
    try {
      const data = await getEditionDetailsAndVolumes(effEditionId);
      officialVolumes = data.volumes || [];
    } catch (e) { log.warn('Loading Manga Passion edition for gap import failed:', e.message); }
  }

  const existingVolumes = db.prepare('SELECT id, volume_number, status, type, notes, price, release_date, cover_image FROM volumes WHERE manga_id = ?').all(mangaId);
  const existingMap = new Map();
  existingVolumes.forEach(v => existingMap.set(`${inferVolumeType(v)}:${String(v.volume_number).trim().toLowerCase()}`, v));

  const importedIds = [];
  const updatedIds = [];
  const skippedOwned = [];

  const updateStmt = db.prepare(`
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

  const insertStmt = db.prepare(`
    INSERT INTO volumes (
      manga_id, volume_number, status, price, release_date, 
      publisher, cover_image, type, notes, manga_passion_volume_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  runTransaction(() => {
    const seen = new Set();
    for (const entry of gapVolumeNumbers) {
      const matchedOfficial = resolveOfficialGap(entry, officialVolumes);
      const cleanLabel = String(entry).trim();

      const targetType = matchedOfficial ? classifyOfficialVolume(matchedOfficial) : (() => {
        const k = cleanLabel.toLowerCase();
        if (k.includes('schuber')) return 'schuber';
        if (/special\s*edition|limited\s*edition|collectors\s*edition/i.test(k)) return 'special_edition';
        return k === 'special' ? 'special' : 'volume';
      })();
      // store the clean number ("26"), not the UI label ("26 (Titel)")
      const volNumber = String(matchedOfficial ? officialVolumeNumber(matchedOfficial) : cleanLabel.replace(/\s*\(.*\)\s*$/, '')).trim();
      const key = `${targetType}:${volNumber.toLowerCase()}`;
      if (seen.has(key)) continue; // the same entry twice in one request
      seen.add(key);

      const price = matchedOfficial && matchedOfficial.price !== null ? matchedOfficial.price : null;
      const releaseDate = matchedOfficial && matchedOfficial.release_date ? matchedOfficial.release_date : null;
      const coverImage = matchedOfficial && matchedOfficial.cover_image ? matchedOfficial.cover_image : null;
      const mpVolId = matchedOfficial ? matchedOfficial.id : null;
      const publisher = manga.publisher || null;
      const notes = targetType === 'volume' ? (matchedOfficial?.title || null) : (matchedOfficial?.title || cleanLabel);

      const existing = existingMap.get(key);
      if (existing) {
        // never touch something the user already owns / has read; only complete the data of listed entries
        if (existing.status === 'Vorhanden' || existing.status === 'Gelesen') {
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

    // Recalculate owned_volumes atomically
    const ownedCountRow = db.prepare("SELECT count(*) as count FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").get(mangaId);
    const ownedCount = ownedCountRow ? ownedCountRow.count : 0;
    db.prepare('UPDATE mangas SET owned_volumes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ownedCount, mangaId);
  });

  return {
    success: true,
    imported_count: importedIds.length,
    updated_count: updatedIds.length,
    skipped_owned_count: skippedOwned.length,
    total_processed: importedIds.length + updatedIds.length
  };
}

async function syncMangaWithEdition(mangaId, editionId, options = {}) {
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) throw new Error('Manga nicht gefunden');

  const { edition } = await getEditionDetailsAndVolumes(editionId);
  if (!edition) throw new Error('Edition auf Manga-Passion nicht gefunden');

  const updates = [];
  const params = [];

  updates.push('manga_passion_id = ?');
  params.push(editionId);

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

  if (options.update_publisher && edition.publisher && edition.publisher !== 'Unbekannt') {
    updates.push('publisher = ?');
    params.push(edition.publisher);
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(mangaId);

  const sql = `UPDATE mangas SET ${updates.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...params);

  const updatedManga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  return updatedManga;
}

module.exports = {
  reconcileMangaGaps,
  batchImportGaps,
  syncMangaWithEdition
};
