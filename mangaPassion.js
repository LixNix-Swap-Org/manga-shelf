const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, uploadsDir, runTransaction, withTransaction } = require('./db.js');
const { fetchRemoteImage } = require('./utils/safeFetch');
const { normalizePublisher } = require('./utils/publishers');

const pkg = require('./package.json');
const log = require('./utils/logger').child('manga-passion');
const USER_AGENT = `MangaShelf/${pkg.version || '2.11.0'}`;
const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/ld+json'
};

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Resilient fetch wrapper with controlled timeout using AbortSignal.timeout(8000)
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const signal = options.signal || AbortSignal.timeout(timeoutMs);
  return await fetch(url, { ...options, signal });
}

/**
 * Downloads a remote image (e.g. from Manga Passion) and saves it permanently to data/uploads/.
 * Uses a deterministic hash based on the remote URL to prevent duplicate downloads and identical files.
 * Returns the local URL (/uploads/{filename}) or the original URL on failure.
 */
async function downloadRemoteImageToUploads(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return url;
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname).toLowerCase() || '.jpg';
    const cleanExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
    
    // Deterministic filename based on MD5 hash of the URL to prevent duplicates
    const urlHash = crypto.createHash('md5').update(url.trim()).digest('hex').slice(0, 16);
    const filename = `mp-cov-${urlHash}${cleanExt}`;
    const targetPath = path.join(uploadsDir, filename);

    // If already downloaded and valid, return existing local URL immediately
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath);
      if (stats.size > 500) {
        return `/uploads/${filename}`;
      }
    }

    const { buffer } = await fetchRemoteImage(url);
    if (buffer.length < 500) return url; // Invalid image or empty

    fs.writeFileSync(targetPath, buffer);
    return `/uploads/${filename}`;
  } catch (err) {
    log.warn('Failed to download image locally:', err.message);
    return url;
  }
}

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

async function searchMangaPassionEditions(title, publisher = '', totalVolumes = null) {
  if (!title || !title.trim()) return { candidates: [], recommended: null };

  const queries = [
    title,
    title.replace(/[–—]/g, '-').trim(),
    title.replace(/[-–—:]/g, ' ').replace(/\s+/g, ' ').trim(),
    title.replace(/\./g, '. ').replace(/\s+/g, ' ').trim(),
    title.split(/[:–—-]/)[0].trim()
  ];
  const uniqueQueries = [...new Set(queries.map(q => q.replace(/\s+/g, ' ').trim()).filter(q => q.length >= 2))];

  const seenIds = new Set();
  const candidates = [];

  for (const q of uniqueQueries) {
    try {
      const url = `https://api.manga-passion.de/editions?title=${encodeURIComponent(q)}&itemsPerPage=50`;
      const res = await fetchWithTimeout(url, { headers: HEADERS }, 8000);
      if (res.ok) {
        const data = await res.json();
        const list = (data['hydra:member'] || []).filter(e => !e.digital && !e.title.toLowerCase().includes('(ebook)'));
        for (const item of list) {
          if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            candidates.push(item);
          }
        }
        if (candidates.length >= 10) break;
      }
    } catch (err) {
      log.warn('Manga Passion edition search query failed:', q, err.message);
    }
  }

  const scored = candidates.map(c => {
    const score = scoreEdition(c, title, publisher, totalVolumes);
    const pubName = normalizePublisher(c.publishers?.[0]?.name) || 'Unbekannt';
    return {
      id: c.id,
      title: c.title,
      total_volumes: c.numVolumes || null,
      status: c.status === 2 ? 'Abgeschlossen' : (c.status === 1 ? 'Laufend' : 'Unbekannt'),
      publisher: pubName,
      cover_image: c.cover || null,
      score
    };
  }).sort((a, b) => b.score - a.score);

  const recommended = scored.length > 0 ? { ...scored[0], recommended: true } : null;

  return {
    candidates: scored,
    recommended
  };
}

async function getEditionDetailsAndVolumes(editionId, forceRefresh = false) {
  const cacheKey = `mp_edition_vols_${editionId}`;
  const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

  if (!forceRefresh) {
    try {
      const cached = db.prepare('SELECT json_data, created_at FROM manga_passion_cache WHERE cache_key = ?').get(cacheKey);
      if (cached && cached.json_data && (Date.now() - cached.created_at < CACHE_TTL_MS)) {
        const parsed = JSON.parse(cached.json_data);
        if (parsed?.notFound) {
          return parsed;
        }
        if (parsed?.edition && parsed.edition.author !== undefined) {
          // cached before publisher names were normalized ("Carlsen Manga!")
          parsed.edition.publisher = normalizePublisher(parsed.edition.publisher) || 'Unbekannt';
          return parsed;
        }
      }
    } catch (e) { log.warn('Manga Passion edition cache read failed:', e.message); }
  }

  // Fetch edition info
  let edition = null;
  try {
    const edRes = await fetchWithTimeout(`https://api.manga-passion.de/editions/${editionId}`, { headers: HEADERS }, 8000);
    if (edRes.status === 404) {
      const notFoundResult = { notFound: true, edition: null, volumes: [] };
      try {
        db.prepare(`
          INSERT INTO manga_passion_cache (cache_key, json_data, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET json_data = excluded.json_data, created_at = excluded.created_at
        `).run(cacheKey, JSON.stringify(notFoundResult), Date.now());
      } catch (e) { log.warn('Manga Passion cache write failed:', e.message); }
      return notFoundResult;
    }
    if (edRes.ok) {
      const edData = await edRes.json();
      const s0 = edData.sources?.[0];
      let author = null;
      if (s0?.contributors) {
        const names = [...new Set(s0.contributors.map(c => c.contributor?.name).filter(Boolean))];
        if (names.length > 0) author = names.join(', ');
      }
      const alt_title = s0?.romaji || s0?.title || null;
      const tags = s0?.tags ? s0.tags.map(t => t.name).join(', ') : null;

      edition = {
        id: edData.id,
        title: edData.title,
        alt_title,
        author,
        tags,
        total_volumes: edData.numVolumes || null,
        status: edData.status === 2 ? 'Abgeschlossen' : (edData.status === 1 ? 'Laufend' : 'Unbekannt'),
        publisher: normalizePublisher(edData.publishers?.[0]?.name) || 'Unbekannt',
        cover_image: edData.cover || null,
        description: edData.description || null
      };
    }
  } catch (err) {
    log.warn(`Error fetching edition ${editionId}:`, err.message);
  }

  // Fetch volumes with pagination support
  let rawList = [];
  let nextUrl = `https://api.manga-passion.de/editions/${editionId}/volumes?itemsPerPage=100`;

  while (nextUrl) {
    try {
      const volRes = await fetchWithTimeout(nextUrl, { headers: HEADERS }, 8000);
      if (volRes.status === 404) {
        if (rawList.length === 0) {
          const notFoundResult = { notFound: true, edition, volumes: [] };
          try {
            db.prepare(`
              INSERT INTO manga_passion_cache (cache_key, json_data, created_at)
              VALUES (?, ?, ?)
              ON CONFLICT(cache_key) DO UPDATE SET json_data = excluded.json_data, created_at = excluded.created_at
            `).run(cacheKey, JSON.stringify(notFoundResult), Date.now());
          } catch (e) { log.warn('Manga Passion cache write failed:', e.message); }
          return notFoundResult;
        }
        break;
      }
      if (!volRes.ok) {
        log.warn(`[Manga Passion] Upstream error fetching volumes: status ${volRes.status}`);
        break;
      }

      const volData = await volRes.json();
      const items = Array.isArray(volData) ? volData : (volData['hydra:member'] || []);
      rawList.push(...items);

      const nextPath = volData['hydra:view']?.['hydra:next'];
      if (nextPath && items.length > 0) {
        nextUrl = nextPath.startsWith('http') ? nextPath : `https://api.manga-passion.de${nextPath}`;
      } else {
        nextUrl = null;
      }
    } catch (volErr) {
      log.warn(`[Manga Passion] Network or timeout error fetching volumes:`, volErr.message);
      break;
    }
  }

  const volumes = rawList.map(v => {
    const nrStr = v.numberDisplay || (v.number !== null && v.number !== undefined ? String(v.number) : 'Special');
    const numMatch = nrStr.match(/(\d+(\.\d+)?)/);
    const num = numMatch ? parseFloat(numMatch[1]) : (typeof v.number === 'number' ? v.number : 999999);
    const dateStr = v.date ? v.date.slice(0, 10) : null;
    const isReleased = dateStr ? (new Date(dateStr) <= new Date()) : true;

    return {
      id: v.id,
      volume_number: nrStr,
      num,
      title: v.title || null,
      price: v.price ? Math.round(v.price) / 100 : null,
      release_date: dateStr,
      cover_image: v.cover || null,
      pages: v.pages || null,
      is_released: isReleased,
      format: v.format ?? 0,
      type: v.type ?? 0,
      specialType: v.specialType ?? null,
      customArrangement: v.customArrangement ?? null,
      number: v.number ?? null,
      lastNumber: v.lastNumber ?? null
    };
  }).sort((a, b) => a.num - b.num);

  const result = { edition, volumes };

  try {
    db.prepare(`
      INSERT INTO manga_passion_cache (cache_key, json_data, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET json_data = excluded.json_data, created_at = excluded.created_at
    `).run(cacheKey, JSON.stringify(result), Date.now());
  } catch (e) {
    log.warn('Cache write failed:', e);
  }

  return result;
}

async function reconcileMangaGaps(mangaId, options = {}) {
  const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) throw new Error('Manga nicht gefunden');

  const userVolumes = db.prepare('SELECT * FROM volumes WHERE manga_id = ?').all(mangaId);

  let editionId = options.edition_id || manga.manga_passion_id;
  let candidateEditions = [];
  let recommended = null;

  if (!editionId) {
    const searchRes = await searchMangaPassionEditions(manga.title, manga.publisher, manga.total_volumes);
    candidateEditions = searchRes.candidates;
    recommended = searchRes.recommended;
    if (recommended) {
      editionId = recommended.id;
      // Auto-save matched edition ID if found
      try {
        db.prepare('UPDATE mangas SET manga_passion_id = ? WHERE id = ?').run(editionId, mangaId);
        manga.manga_passion_id = editionId;
      } catch (e) { log.warn('Auto-saving Manga Passion edition id failed:', e.message); }
    }
  } else {
    // Also fetch alternatives in background so user can switch
    searchMangaPassionEditions(manga.title, manga.publisher, manga.total_volumes)
      .then(res => { candidateEditions = res.candidates; })
      .catch(() => {});
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
  const { edition, volumes: officialVolumes } = details;

  // Map user's volumes by cleaned volume_number and by notes
  const userVolMap = new Map();
  const userNotesMap = new Map();
  userVolumes.forEach(v => {
    const key = String(v.volume_number || '').trim().toLowerCase();
    userVolMap.set(key, v);
    if (v.notes) {
      userNotesMap.set(String(v.notes).trim().toLowerCase(), v);
    }
  });

  const gaps = [];
  const ownedOfficial = [];

  officialVolumes.forEach(ov => {
    const key = String(ov.volume_number || '').trim().toLowerCase();
    const titleKey = String(ov.title || '').trim().toLowerCase();
    let existing = userVolMap.get(key);

    // If no direct number match and this entry has a title, check notes/titles or Schuber names
    if (!existing && titleKey) {
      existing = userNotesMap.get(titleKey);
      if (!existing) {
        existing = userVolumes.find(uv => {
          const uvNotes = String(uv.notes || '').trim().toLowerCase();
          const uvNum = String(uv.volume_number || '').trim().toLowerCase();
          if (uvNotes && (uvNotes.includes(titleKey) || titleKey.includes(uvNotes))) return true;
          if (uvNum && (uvNum.includes(titleKey) || titleKey.includes(uvNum))) return true;
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

    // Determine entry type and display title
    let inferredType = 'volume';
    if (ov.specialType === 1 || titleKey.includes('schuber') || titleKey.includes('box')) {
      inferredType = 'schuber';
    } else if (ov.specialType === 2 || /edition|limited|collectors|variant/i.test(titleKey)) {
      inferredType = 'special_edition';
    } else if (key === 'special' || /special|extra|guide/i.test(titleKey)) {
      inferredType = 'special';
    }

    let finalVolNumber = ov.volume_number;
    if (key === 'special' && ov.title) {
      finalVolNumber = ov.title.trim();
    }

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
            const constituent = userVolMap.get(String(k));
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

  const existingVolumes = db.prepare('SELECT id, volume_number, status, price, release_date, cover_image FROM volumes WHERE manga_id = ?').all(mangaId);
  const existingMap = new Map();
  existingVolumes.forEach(v => existingMap.set(String(v.volume_number).trim().toLowerCase(), v));

  const importedIds = [];
  const updatedIds = [];

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
    for (const volNumStr of gapVolumeNumbers) {
      const cleanNum = String(volNumStr).trim();
      const key = cleanNum.toLowerCase();
      
      // Find matching official volume data if available
      const matchedOfficial = officialVolumes.find(ov => {
        const ovNum = String(ov.volume_number || '').trim().toLowerCase();
        const ovTitle = String(ov.title || '').trim().toLowerCase();
        return ovNum === key || (ovTitle && ovTitle === key);
      });
      
      const price = matchedOfficial && matchedOfficial.price !== null ? matchedOfficial.price : null;
      const releaseDate = matchedOfficial && matchedOfficial.release_date ? matchedOfficial.release_date : null;
      const coverImage = matchedOfficial && matchedOfficial.cover_image ? matchedOfficial.cover_image : null;
      const mpVolId = matchedOfficial ? matchedOfficial.id : null;
      const publisher = manga.publisher || null;

      const isSchuber = key.includes('schuber') || (matchedOfficial?.title && matchedOfficial.title.toLowerCase().includes('schuber')) || matchedOfficial?.specialType === 1;
      const isSpecialEdition = !isSchuber && (/special\s*edition|limited\s*edition|collectors\s*edition/i.test(key) || (matchedOfficial?.title && /special\s*edition|limited\s*edition|collectors\s*edition/i.test(matchedOfficial.title)) || matchedOfficial?.specialType === 2);
      const isSpecial = !isSchuber && !isSpecialEdition && (key === 'special' || (matchedOfficial?.title && /special|extra|guide/i.test(matchedOfficial.title)));
      const targetType = isSchuber ? 'schuber' : (isSpecialEdition ? 'special_edition' : (isSpecial ? 'special' : 'volume'));
      const notes = isSchuber ? (matchedOfficial?.title || cleanNum) : (matchedOfficial?.title || null);

      const existing = existingMap.get(key);
      if (existing) {
        updateStmt.run(targetStatus, price, releaseDate, coverImage, targetType, notes, mpVolId, existing.id);
        updatedIds.push(existing.id);
      } else {
        const ins = insertStmt.run(mangaId, cleanNum, targetStatus, price, releaseDate, publisher, coverImage, targetType, notes, mpVolId);
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

async function searchMangaPassionForLookup(queryTerm) {
  if (!queryTerm || !queryTerm.trim()) return [];
  const searchRes = await searchMangaPassionEditions(queryTerm.trim());
  if (!searchRes.candidates || searchRes.candidates.length === 0) return [];

  // Filter candidates with score >= 0 (up to 5)
  const top = searchRes.candidates.filter(c => c.score >= 0).slice(0, 5);
  const results = [];

  const detailPromises = top.map(c => 
    getEditionDetailsAndVolumes(c.id).catch(err => {
      log.warn(`Failed to fetch details for edition ${c.id}:`, err.message);
      return null;
    })
  );

  const resolved = await Promise.all(detailPromises);
  for (let i = 0; i < resolved.length; i++) {
    const item = resolved[i];
    const cand = top[i];
    if (item && item.edition) {
      const ed = item.edition;
      results.push({
        id: `mp_${ed.id}`,
        manga_passion_id: ed.id,
        source: 'manga_passion',
        source_label: '🇩🇪 Manga Passion',
        title: ed.title || cand.title,
        alt_title: ed.alt_title || null,
        author: ed.author || cand.author || null,
        publisher: ed.publisher || cand.publisher || null,
        status: ed.status || cand.status || 'Laufend',
        total_volumes: ed.total_volumes || cand.total_volumes || null,
        description: ed.description || null,
        cover_image: ed.cover_image || cand.cover_image || null,
        tags: ed.tags || null
      });
    } else if (cand) {
      results.push({
        id: `mp_${cand.id}`,
        manga_passion_id: cand.id,
        source: 'manga_passion',
        source_label: '🇩🇪 Manga Passion',
        title: cand.title,
        alt_title: null,
        author: null,
        publisher: cand.publisher || null,
        status: cand.status || 'Laufend',
        total_volumes: cand.total_volumes || null,
        description: null,
        cover_image: cand.cover_image || null,
        tags: null
      });
    }
  }

  return results;
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
      const fullRes = await fetchWithTimeout(`https://api.manga-passion.de/volumes/${directVolumeId}`, { headers: HEADERS }, 8000);
      if (fullRes.ok) {
        const fullVol = await fullRes.json();
        const localCover = await downloadRemoteImageToUploads(fullVol.cover);
        const relDate = fullVol.date ? fullVol.date.slice(0, 10) : null;
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
            isbn: fullVol.isbn13 || fullVol.isbn10 || null,
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
        try {
          db.prepare('UPDATE mangas SET manga_passion_id = ? WHERE id = ?').run(editionId, manga.id);
          manga.manga_passion_id = editionId;
        } catch (e) { log.warn('Auto-saving Manga Passion edition id failed:', e.message); }
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
          // Regular volume matching - EXCLUDE Schuber so regular Band 1 never accidentally matches a Schuber
          const regularVolumes = details.volumes.filter(v => v.specialType !== 1 && !/schuber|box|slipcase/i.test(v.title || ''));
          const targetClean = String(volumeNumber || '').trim().toLowerCase();
          const targetNumMatch = targetClean.match(/(\d+(\.\d+)?)/);
          const targetNum = targetNumMatch ? parseFloat(targetNumMatch[1]) : null;

          // 1. Exact volume_number string match
          matchedVolume = regularVolumes.find(v => String(v.volume_number || '').trim().toLowerCase() === targetClean);

          // 2. Numeric match (e.g. 1 === 1.0 or "01" === 1)
          if (!matchedVolume && targetNum !== null) {
            matchedVolume = regularVolumes.find(v => v.num === targetNum);
          }

          // 3. Substring match (e.g. "Band 1" or "Vol. 1")
          if (!matchedVolume && targetNum !== null) {
            matchedVolume = regularVolumes.find(v => {
              const m = String(v.volume_number || '').match(/(\d+(\.\d+)?)/);
              return m && parseFloat(m[1]) === targetNum;
            });
          }
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
        const fullRes = await fetchWithTimeout(`https://api.manga-passion.de/volumes/${matchedVolume.id}`, { headers: HEADERS }, 8000);
        if (fullRes.ok) {
          fullVol = await fullRes.json();
        }
      } catch (e) {
        log.warn('Error fetching full volume details from Manga Passion:', e.message);
      }
    }

    const relDate = fullVol?.date ? fullVol.date.slice(0, 10) : matchedVolume.release_date;
    const relYear = fullVol?.year || (relDate ? parseInt(relDate.slice(0, 4), 10) : null);
    const pages = fullVol?.pages || matchedVolume.pages || null;
    const isbn = fullVol?.isbn13 || fullVol?.isbn10 || options.isbn || null;
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
      try {
        db.prepare('UPDATE mangas SET manga_passion_id = ? WHERE id = ?').run(editionId, manga.id);
        manga.manga_passion_id = editionId;
      } catch (e) { log.warn('Auto-saving Manga Passion edition id failed:', e.message); }
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

  const offByNumStr = new Map();
  const offByNumFloat = new Map();

  officialVolumes.forEach(ov => {
    // Only index regular volumes by num so Schubers don't collide with Band 1
    if (ov.specialType !== 1 && !/schuber/i.test(ov.title || '')) {
      const cleanStr = String(ov.volume_number || '').trim().toLowerCase();
      offByNumStr.set(cleanStr, ov);
      if (ov.num !== null && ov.num !== undefined && ov.num < 99999) {
        offByNumFloat.set(ov.num, ov);
      }
    }
  });

  let updatedCount = 0;
  const overwrite = Boolean(options.overwrite);

  const updateStmt = db.prepare(`
    UPDATE volumes SET
      release_date = ?,
      release_year = ?,
      pages = ?,
      price = ?,
      publisher = ?,
      cover_image = ?,
      notes = ?
    WHERE id = ?
  `);

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
        const cleanKey = String(uv.volume_number || '').trim().toLowerCase();
        const numMatch = cleanKey.match(/(\d+(\.\d+)?)/);
        const floatKey = numMatch ? parseFloat(numMatch[1]) : null;
        matched = offByNumStr.get(cleanKey) || (floatKey !== null ? offByNumFloat.get(floatKey) : null);
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
        pendingUpdates.push([newDate, newYear, newPages, newPrice, newPub, newCover, newNotes, uv.id]);
      }
    }

  // Phase 2 (sync): apply all updates atomically
  withTransaction(() => {
    for (const params of pendingUpdates) updateStmt.run(...params);
  });
  updatedCount = pendingUpdates.length;

  return {
    success: true,
    edition_title: details.edition?.title,
    updated_count: updatedCount,
    total_user_volumes: userVolumes.length
  };
}

module.exports = {
  searchMangaPassionEditions,
  getEditionDetailsAndVolumes,
  reconcileMangaGaps,
  batchImportGaps,
  syncMangaWithEdition,
  searchMangaPassionForLookup,
  lookupVolumeMetadata,
  autofillMangaVolumes,
  scoreEdition,
  matchSchuberVolume
};
