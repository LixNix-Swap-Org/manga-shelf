const { db } = require('./db.js');

const USER_AGENT = 'MangaShelf/2.6.0';
const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/ld+json'
};

function scoreEdition(e, targetTitle, targetPub, targetTotal) {
  let score = 0;
  const tNorm = (targetTitle || '').toLowerCase().replace(/[:–—\-]/g, ' ').replace(/\s+/g, ' ').trim();
  const eNorm = (e.title || '').toLowerCase().replace(/[:–—\-]/g, ' ').replace(/\s+/g, ' ').trim();
  
  if (eNorm === tNorm) score += 100;
  else if (eNorm.includes(tNorm) || tNorm.includes(eNorm)) score += 50;

  const tBase = (targetTitle || '').toLowerCase().split(/[:–—\-]/)[0].trim();
  const eBase = (e.title || '').toLowerCase().split(/[:–—\-]/)[0].trim();
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

  // Demote single volume spin-offs if target title isn't a spin-off
  const isSpinOff = e.title.toLowerCase().includes('guide') || 
                    e.title.toLowerCase().includes('artbook') || 
                    e.title.toLowerCase().includes('spin-off') || 
                    e.title.toLowerCase().includes('roman') || 
                    e.title.toLowerCase().includes('novel') || 
                    e.title.toLowerCase().includes('wimmelbuch');
  if (isSpinOff && !tNorm.includes('guide') && !tNorm.includes('spin-off') && !tNorm.includes('novel') && !tNorm.includes('roman')) {
    score -= 35;
  }

  return score;
}

async function searchMangaPassionEditions(title, publisher = '', totalVolumes = null) {
  if (!title || !title.trim()) return { candidates: [], recommended: null };

  const queries = [
    title,
    title.replace(/[–—]/g, '-').trim(),
    title.replace(/[-–—:]/g, ' ').replace(/\s+/g, ' ').trim(),
    title.split(/[:–—\-]/)[0].trim()
  ];
  const uniqueQueries = [...new Set(queries.map(q => q.replace(/\s+/g, ' ').trim()).filter(q => q.length >= 2))];

  const seenIds = new Set();
  const candidates = [];

  for (const q of uniqueQueries) {
    try {
      const url = `https://api.manga-passion.de/editions?title=${encodeURIComponent(q)}&itemsPerPage=50`;
      const res = await fetch(url, { headers: HEADERS });
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
      console.warn('Manga Passion edition search query failed:', q, err.message);
    }
  }

  const scored = candidates.map(c => {
    const score = scoreEdition(c, title, publisher, totalVolumes);
    const pubName = c.publishers?.[0]?.name || 'Unbekannt';
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
        return JSON.parse(cached.json_data);
      }
    } catch (_) {}
  }

  // Fetch edition info
  let edition = null;
  try {
    const edRes = await fetch(`https://api.manga-passion.de/editions/${editionId}`, { headers: HEADERS });
    if (edRes.ok) {
      const edData = await edRes.json();
      edition = {
        id: edData.id,
        title: edData.title,
        total_volumes: edData.numVolumes || null,
        status: edData.status === 2 ? 'Abgeschlossen' : (edData.status === 1 ? 'Laufend' : 'Unbekannt'),
        publisher: edData.publishers?.[0]?.name || 'Unbekannt',
        cover_image: edData.cover || null,
        description: edData.description || null
      };
    }
  } catch (err) {
    console.warn(`Error fetching edition ${editionId}:`, err.message);
  }

  // Fetch volumes
  const volUrl = `https://api.manga-passion.de/editions/${editionId}/volumes`;
  const volRes = await fetch(volUrl, { headers: HEADERS });
  if (!volRes.ok) {
    throw new Error(`Manga Passion API Fehler beim Abrufen der Bände (Status ${volRes.status})`);
  }

  const volData = await volRes.json();
  const rawList = Array.isArray(volData) ? volData : (volData['hydra:member'] || []);

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
      format: v.format ?? 0
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
    console.warn('Cache write failed:', e);
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
      } catch (_) {}
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

  const { edition, volumes: officialVolumes } = await getEditionDetailsAndVolumes(editionId, options.force_refresh);

  // Map user's volumes by cleaned volume_number
  const userVolMap = new Map();
  userVolumes.forEach(v => {
    const key = String(v.volume_number || '').trim().toLowerCase();
    userVolMap.set(key, v);
  });

  const gaps = [];
  const ownedOfficial = [];

  officialVolumes.forEach(ov => {
    const key = String(ov.volume_number || '').trim().toLowerCase();
    const existing = userVolMap.get(key);

    if (!existing) {
      gaps.push({
        ...ov,
        in_collection: false,
        user_status: null,
        user_volume_id: null
      });
    } else if (existing.status === 'Fehlt') {
      gaps.push({
        ...ov,
        in_collection: true,
        user_status: 'Fehlt',
        user_volume_id: existing.id
      });
    } else if (existing.status === 'Vorhanden') {
      ownedOfficial.push(ov);
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
    } catch (_) {}
  }

  const existingVolumes = db.prepare('SELECT id, volume_number, status, price, release_date, cover_image FROM volumes WHERE manga_id = ?').all(mangaId);
  const existingMap = new Map();
  existingVolumes.forEach(v => existingMap.set(String(v.volume_number).trim().toLowerCase(), v));

  const importedIds = [];
  const updatedIds = [];

  for (const volNumStr of gapVolumeNumbers) {
    const cleanNum = String(volNumStr).trim();
    const key = cleanNum.toLowerCase();
    
    // Find matching official volume data if available
    const matchedOfficial = officialVolumes.find(ov => String(ov.volume_number).trim().toLowerCase() === key);
    
    const price = matchedOfficial && matchedOfficial.price !== null ? matchedOfficial.price : null;
    const releaseDate = matchedOfficial && matchedOfficial.release_date ? matchedOfficial.release_date : null;
    const coverImage = matchedOfficial && matchedOfficial.cover_image ? matchedOfficial.cover_image : null;
    const mpVolId = matchedOfficial ? matchedOfficial.id : null;
    const publisher = manga.publisher || null;

    const existing = existingMap.get(key);
    if (existing) {
      db.prepare(`
        UPDATE volumes 
        SET status = ?,
            price = COALESCE(price, ?),
            release_date = COALESCE(release_date, ?),
            cover_image = COALESCE(cover_image, ?),
            manga_passion_volume_id = COALESCE(manga_passion_volume_id, ?)
        WHERE id = ?
      `).run(targetStatus, price, releaseDate, coverImage, mpVolId, existing.id);
      updatedIds.push(existing.id);
    } else {
      const ins = db.prepare(`
        INSERT INTO volumes (
          manga_id, volume_number, status, price, release_date, 
          publisher, cover_image, type, manga_passion_volume_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'volume', ?, CURRENT_TIMESTAMP)
      `).run(mangaId, cleanNum, targetStatus, price, releaseDate, publisher, coverImage, mpVolId);
      importedIds.push(Number(ins.lastInsertRowid));
    }
  }

  // Recalculate owned_volumes
  const ownedCountRow = db.prepare("SELECT count(*) as count FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").get(mangaId);
  const ownedCount = ownedCountRow ? ownedCountRow.count : 0;
  db.prepare('UPDATE mangas SET owned_volumes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ownedCount, mangaId);

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

module.exports = {
  searchMangaPassionEditions,
  getEditionDetailsAndVolumes,
  reconcileMangaGaps,
  batchImportGaps,
  syncMangaWithEdition
};
