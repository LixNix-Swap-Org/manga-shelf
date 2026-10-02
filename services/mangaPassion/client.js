const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, uploadsDir } = require('../../db.js');
const { fetchRemoteImage } = require('../../utils/safeFetch');
const { normalizePublisher } = require('../../utils/publishers');
const { scoreEdition, cleanOfficialDate } = require('./classify');

const pkg = require('../../package.json');
const log = require('../../utils/logger').child('manga-passion');
const API_BASE = 'https://api.manga-passion.de';
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
      const url = `${API_BASE}/editions?title=${encodeURIComponent(q)}&itemsPerPage=50`;
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

function writeEditionCache(cacheKey, value) {
  try {
    db.prepare(`
      INSERT INTO manga_passion_cache (cache_key, json_data, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET json_data = excluded.json_data, created_at = excluded.created_at
    `).run(cacheKey, JSON.stringify(value), Date.now());
  } catch (e) { log.warn('Manga Passion cache write failed:', e.message); }
}

/** Last cached edition data regardless of age (used when Manga Passion is unreachable). */
function readStaleEditionCache(cacheKey) {
  try {
    const row = db.prepare('SELECT json_data FROM manga_passion_cache WHERE cache_key = ?').get(cacheKey);
    const parsed = row?.json_data ? JSON.parse(row.json_data) : null;
    return parsed && !parsed.notFound && parsed.volumes?.length ? parsed : null;
  } catch (e) { return null; }
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

  // Anything but a clean answer (timeout, 5xx, aborted pagination) must never be cached as if it were complete
  let complete = true;

  // Fetch edition info
  let edition = null;
  try {
    const edRes = await fetchWithTimeout(`${API_BASE}/editions/${editionId}`, { headers: HEADERS }, 8000);
    if (edRes.status === 404) {
      const notFoundResult = { notFound: true, edition: null, volumes: [] };
      writeEditionCache(cacheKey, notFoundResult);
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
    } else {
      complete = false;
    }
  } catch (err) {
    complete = false;
    log.warn(`Error fetching edition ${editionId}:`, err.message);
  }

  // Fetch volumes with pagination support
  let rawList = [];
  let nextUrl = `${API_BASE}/editions/${editionId}/volumes?itemsPerPage=100`;

  while (nextUrl) {
    try {
      const volRes = await fetchWithTimeout(nextUrl, { headers: HEADERS }, 8000);
      if (volRes.status === 404) {
        if (rawList.length === 0) {
          const notFoundResult = { notFound: true, edition, volumes: [] };
          writeEditionCache(cacheKey, notFoundResult);
          return notFoundResult;
        }
        break;
      }
      if (!volRes.ok) {
        log.warn(`[Manga Passion] Upstream error fetching volumes: status ${volRes.status}`);
        complete = false;
        break;
      }

      const volData = await volRes.json();
      const items = Array.isArray(volData) ? volData : (volData['hydra:member'] || []);
      rawList.push(...items);

      const nextPath = volData['hydra:view']?.['hydra:next'];
      if (nextPath && items.length > 0) {
        nextUrl = nextPath.startsWith('http') ? nextPath : `${API_BASE}${nextPath}`;
      } else {
        nextUrl = null;
      }
    } catch (volErr) {
      log.warn(`[Manga Passion] Network or timeout error fetching volumes:`, volErr.message);
      complete = false;
      break;
    }
  }

  const volumes = rawList.map(v => {
    const nrStr = v.numberDisplay || (v.number !== null && v.number !== undefined ? String(v.number) : 'Special');
    const numMatch = nrStr.match(/(\d+(\.\d+)?)/);
    const num = numMatch ? parseFloat(numMatch[1]) : (typeof v.number === 'number' ? v.number : 999999);
    const dateStr = cleanOfficialDate(v.date);
    // no date although the API sent one = announced without a date: not released yet
    const isReleased = dateStr ? (new Date(dateStr) <= new Date()) : !v.date;

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

  if (!complete) {
    // keep serving the last good data (even if older than the TTL) instead of an empty or truncated list
    return readStaleEditionCache(cacheKey) || { ...result, incomplete: true };
  }

  writeEditionCache(cacheKey, result);
  return result;
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

/** Remembers the Manga Passion edition a manga was matched with. */
function saveEditionLink(manga, editionId) {
  try {
    db.prepare('UPDATE mangas SET manga_passion_id = ? WHERE id = ?').run(editionId, manga.id);
    manga.manga_passion_id = editionId;
  } catch (e) { log.warn('Auto-saving Manga Passion edition id failed:', e.message); }
}

module.exports = {
  API_BASE,
  HEADERS,
  fetchWithTimeout,
  downloadRemoteImageToUploads,
  searchMangaPassionEditions,
  getEditionDetailsAndVolumes,
  searchMangaPassionForLookup,
  saveEditionLink
};
