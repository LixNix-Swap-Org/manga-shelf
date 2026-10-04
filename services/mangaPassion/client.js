const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, uploadsDir } = require('../../db.js');
const { fetchRemoteImage } = require('../../utils/safeFetch');
const { normalizePublisher } = require('../../utils/publishers');
const { scoreEdition, titleRelation, cleanOfficialDate, isOfficialReleased, isConfidentMatch, buildSearchQueries } = require('./classify');

const pkg = require('../../package.json');
const log = require('../../utils/logger').child('manga-passion');
const API_BASE = 'https://api.manga-passion.de';
const API_ORIGIN = new URL(API_BASE).origin;
const USER_AGENT = `MangaShelf/${pkg.version || '2.11.0'}`;
const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/ld+json'
};

const UNKNOWN = 'Unbekannt';
const REQUEST_TIMEOUT_MS = 8000;
const SEARCH_DEADLINE_MS = 20000;
const EDITION_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const EMPTY_SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;
const EDITION_INFO_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_VOLUME_PAGES = 20;
// The lookup chooser loads edition details (author, description) only for candidates at least this similar
const LOOKUP_DETAIL_MIN_SCORE = 15;

/** Fetch with a per-request timeout; a caller signal (overall deadline, client disconnect) is combined with it. */
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  return await fetch(url, { ...options, signal });
}

/** Strict Manga Passion edition id: a positive safe integer (or a string of digits), otherwise null. */
function toEditionId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function mapEditionStatus(code) {
  if (code === 2) return 'Abgeschlossen';
  if (code === 1) return 'Laufend';
  return UNKNOWN;
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

    const urlHash = crypto.createHash('md5').update(url.trim()).digest('hex').slice(0, 16);
    const filename = `mp-cov-${urlHash}${cleanExt}`;
    const targetPath = path.join(uploadsDir, filename);

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 500) {
      // the orphan cleanup keeps young files only: a reused cover must look new until the form is saved
      try {
        const now = new Date();
        fs.utimesSync(targetPath, now, now);
        return `/uploads/${filename}`;
      } catch (e) {
        log.debug('Refreshing a reused Manga Passion cover failed, downloading it again:', e);
      }
    }

    const { buffer } = await fetchRemoteImage(url);
    if (buffer.length < 500) return url; // Invalid image or empty

    fs.writeFileSync(targetPath, buffer);
    return `/uploads/${filename}`;
  } catch (err) {
    log.warn('Failed to download image locally:', err);
    return url;
  }
}

// Round 2 (other spellings) only runs while no candidate reaches this total scoreEdition() score
const GOOD_MATCH_SCORE = 100;
// Below this the best candidate is not even a similar title: better "no match" than a wrong suggestion
const MIN_RECOMMEND_SCORE = 50;

function writeCache(cacheKey, value) {
  try {
    db.prepare(`
      INSERT INTO manga_passion_cache (cache_key, json_data, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET json_data = excluded.json_data, created_at = excluded.created_at
    `).run(cacheKey, JSON.stringify(value), Date.now());
  } catch (e) { log.warn('Manga Passion cache write failed:', e); }
}

function readCacheEntry(cacheKey) {
  try {
    const row = db.prepare('SELECT json_data, created_at FROM manga_passion_cache WHERE cache_key = ?').get(cacheKey);
    if (row && row.json_data) return { value: JSON.parse(row.json_data), ageMs: Date.now() - row.created_at };
  } catch (e) { log.warn('Manga Passion cache read failed:', e); }
  return null;
}

/** Cached JSON for a key if it is younger than `ttlMs` (Infinity = any age), else null. */
function readCache(cacheKey, ttlMs) {
  const entry = readCacheEntry(cacheKey);
  return entry && (ttlMs === Infinity || entry.ageMs < ttlMs) ? entry.value : null;
}

let lastPrune = 0;
function pruneSearchCache() {
  const now = Date.now();
  if (now - lastPrune < CACHE_PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  try {
    db.prepare("DELETE FROM manga_passion_cache WHERE cache_key LIKE 'mp\\_search\\_q\\_%' ESCAPE '\\' AND created_at < ?")
      .run(now - SEARCH_CACHE_TTL_MS);
    db.prepare("DELETE FROM manga_passion_cache WHERE cache_key LIKE 'mp\\_edition\\_info\\_%' ESCAPE '\\' AND created_at < ?")
      .run(now - EDITION_INFO_MAX_AGE_MS);
  } catch (e) { log.warn('Pruning the Manga Passion search cache failed:', e); }
}

const searchCacheKey = (q) => `mp_search_q_${q.trim().toLowerCase()}`;

// Only the fields the scoring and the candidate list use
const slimSearchItem = (e) => ({
  id: e.id,
  title: e.title,
  numVolumes: e.numVolumes ?? null,
  status: e.status ?? null,
  publishers: (e.publishers || []).slice(0, 1).map(p => ({ name: p?.name ?? null })),
  cover: e.cover || null
});

const isNetworkError = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError' || err instanceof TypeError;

/**
 * Searches the German editions for a title in up to three query rounds. Every query answer is cached on its own
 * (scoring stays local, so publisher or volume count changes never hit a stale score); failed queries are never cached.
 * `unavailable: true` means the API could not be asked: no candidates and every query failed, or the search was cut
 * short by a network error or the overall deadline.
 * opts: { signal, forceRefresh, deadlineMs, requestTimeoutMs }
 */
async function searchMangaPassionEditions(title, publisher = '', totalVolumes = null, opts = {}) {
  if (!title || !title.trim()) return { candidates: [], recommended: null };

  const requestTimeoutMs = opts.requestTimeoutMs || REQUEST_TIMEOUT_MS;
  const deadline = AbortSignal.any([AbortSignal.timeout(opts.deadlineMs || SEARCH_DEADLINE_MS), opts.signal].filter(Boolean));
  const { primary, variants, words } = buildSearchQueries(title);
  const seenIds = new Set();
  const candidates = [];
  let attempted = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let cutShort = false;

  const runQuery = async (q) => {
    const cacheKey = searchCacheKey(q);
    if (!opts.forceRefresh) {
      const hit = readCacheEntry(cacheKey);
      const items = hit?.value?.items;
      if (Array.isArray(items) && hit.ageMs < (items.length ? SEARCH_CACHE_TTL_MS : EMPTY_SEARCH_CACHE_TTL_MS)) return items;
    }
    attempted++;
    const url = `${API_BASE}/editions?title=${encodeURIComponent(q)}&itemsPerPage=50`;
    let res;
    try {
      res = await fetchWithTimeout(url, { headers: HEADERS, signal: deadline }, requestTimeoutMs);
    } catch (err) {
      failed++;
      cutShort = true;
      log.warn(`Manga Passion edition search for "${q}" failed, skipping the remaining queries:`, err);
      return null;
    }
    if (!res.ok) {
      // a 4xx belongs to this query string only; 5xx and 429 mean the API itself is struggling
      if (res.status >= 500 || res.status === 429) {
        failed++;
        if (++consecutiveFailures >= 2) cutShort = true;
      }
      log.warn(`Manga Passion edition search for "${q}" answered ${res.status}`);
      return null;
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      failed++;
      if (isNetworkError(err)) cutShort = true;
      log.warn(`Manga Passion edition search for "${q}" returned an unreadable answer:`, err);
      return null;
    }
    consecutiveFailures = 0;
    const items = (data?.['hydra:member'] || [])
      .filter(e => e && e.id != null && typeof e.title === 'string' && !e.digital && !e.title.toLowerCase().includes('(ebook)'))
      .map(slimSearchItem);
    writeCache(cacheKey, { items });
    pruneSearchCache();
    return items;
  };

  const runQueries = async (queries, stopAt = 10) => {
    for (const q of queries) {
      if (cutShort || deadline.aborted) { cutShort = true; break; }
      const items = await runQuery(q);
      for (const item of items || []) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          candidates.push(item);
        }
      }
      if (candidates.length >= stopAt) break;
    }
  };
  const score = (c) => scoreEdition(c, title, publisher, totalVolumes);
  const hasGoodMatch = () => candidates.some(c => score(c) >= GOOD_MATCH_SCORE);

  await runQueries(primary);
  if (!hasGoodMatch()) await runQueries(variants, Infinity);   // other spellings of the same title
  if (candidates.length === 0) await runQueries(words, Infinity); // last resort: a single rare word, ranked locally

  const scored = candidates.map(c => ({
    id: c.id,
    title: c.title,
    total_volumes: c.numVolumes || null,
    status: mapEditionStatus(c.status),
    publisher: normalizePublisher(c.publishers?.[0]?.name) || UNKNOWN,
    cover_image: c.cover || null,
    title_relation: titleRelation(c.title, title),
    score: score(c)
  })).sort((a, b) => b.score - a.score);

  const recommended = scored.length > 0 && scored[0].score >= MIN_RECOMMEND_SCORE ? { ...scored[0], recommended: true } : null;
  const result = { candidates: scored, recommended };
  if (scored.length === 0 && (cutShort || (attempted > 0 && failed === attempted))) result.unavailable = true;
  return result;
}

function mapEdition(edData) {
  const s0 = edData.sources?.[0];
  let author = null;
  if (s0?.contributors) {
    const names = [...new Set(s0.contributors.map(c => c.contributor?.name).filter(Boolean))];
    if (names.length > 0) author = names.join(', ');
  }
  return {
    id: edData.id,
    title: edData.title,
    alt_title: s0?.romaji || s0?.title || null,
    author,
    tags: s0?.tags ? s0.tags.map(t => t.name).join(', ') : null,
    total_volumes: edData.numVolumes || null,
    status: mapEditionStatus(edData.status),
    publisher: normalizePublisher(edData.publishers?.[0]?.name) || UNKNOWN,
    cover_image: edData.cover || null,
    description: edData.description || null
  };
}

// Entries cached before publisher names were normalized still say "Carlsen Manga!"
const normalizeEdition = (edition) => edition
  ? { ...edition, publisher: normalizePublisher(edition.publisher) || UNKNOWN }
  : edition;

/** Cached data keeps is_released from fetch time: derive it again from the date (an undated entry keeps its flag). */
function prepareEditionResult(result) {
  const now = new Date();
  return {
    ...result,
    edition: normalizeEdition(result.edition),
    volumes: (result.volumes || []).map(v => (v.release_date ? { ...v, is_released: isOfficialReleased(v.release_date, now) } : v))
  };
}

/** Last usable edition data regardless of age, flagged stale (used when Manga Passion is unreachable). */
function readStaleEditionCache(cacheKey) {
  const parsed = readCache(cacheKey, Infinity);
  return parsed && !parsed.notFound && parsed.volumes?.length ? { ...prepareEditionResult(parsed), stale: true } : null;
}

function resolveApiUrl(link) {
  try {
    const url = new URL(String(link), API_BASE);
    return url.origin === API_ORIGIN ? url.href : null;
  } catch {
    return null;
  }
}

async function getEditionDetailsAndVolumes(editionId, forceRefresh = false) {
  const id = toEditionId(editionId);
  if (!id) {
    log.warn('Ignoring invalid Manga Passion edition id:', String(editionId).slice(0, 40));
    return { notFound: true, edition: null, volumes: [] };
  }
  const cacheKey = `mp_edition_vols_${id}`;

  if (!forceRefresh) {
    const cached = readCache(cacheKey, EDITION_CACHE_TTL_MS);
    if (cached?.notFound) return cached;
    if (cached?.edition && cached.edition.author !== undefined) return prepareEditionResult(cached);
  }

  // Anything but a clean answer (timeout, 5xx, aborted pagination) must never be cached as if it were complete
  let complete = true;

  let edition = null;
  try {
    const edRes = await fetchWithTimeout(`${API_BASE}/editions/${id}`, { headers: HEADERS });
    if (edRes.status === 404) {
      const notFoundResult = { notFound: true, edition: null, volumes: [] };
      writeCache(cacheKey, notFoundResult);
      return notFoundResult;
    }
    if (edRes.ok) {
      edition = mapEdition(await edRes.json());
    } else {
      complete = false;
    }
  } catch (err) {
    complete = false;
    log.warn(`Error fetching edition ${id}:`, err);
  }

  let rawList = [];
  let nextUrl = `${API_BASE}/editions/${id}/volumes?itemsPerPage=100`;
  const visited = new Set();

  while (nextUrl) {
    if (visited.size >= MAX_VOLUME_PAGES || visited.has(nextUrl)) {
      log.warn(`[Manga Passion] Stopping the volume pagination of edition ${id} after ${visited.size} pages`);
      complete = false;
      break;
    }
    visited.add(nextUrl);
    try {
      const volRes = await fetchWithTimeout(nextUrl, { headers: HEADERS });
      if (volRes.status === 404) {
        if (visited.size === 1) {
          const notFoundResult = { notFound: true, edition, volumes: [] };
          if (complete) writeCache(cacheKey, notFoundResult);
          return notFoundResult;
        }
        log.warn(`[Manga Passion] Volume page ${visited.size} of edition ${id} answered 404`);
        complete = false;
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
      nextUrl = null;
      if (nextPath && items.length > 0) {
        nextUrl = resolveApiUrl(nextPath);
        if (!nextUrl) {
          log.warn(`[Manga Passion] Ignoring a next-page link outside the API for edition ${id}`);
          complete = false;
        }
      }
    } catch (volErr) {
      log.warn('[Manga Passion] Network or timeout error fetching volumes:', volErr);
      complete = false;
      break;
    }
  }

  const volumes = rawList.map(v => {
    const nrStr = v.numberDisplay || (v.number !== null && v.number !== undefined ? String(v.number) : 'Special');
    const numMatch = nrStr.match(/(\d+(\.\d+)?)/);
    const num = numMatch ? parseFloat(numMatch[1]) : (typeof v.number === 'number' ? v.number : 999999);
    // the whole volume: a month-only entry ("day": null) stays "YYYY-MM" instead of Manga Passion's last-of-month date
    const dateStr = cleanOfficialDate(v);
    // no date although the API sent one = announced without a date: not released yet
    const isReleased = dateStr ? isOfficialReleased(dateStr) : !v.date;

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
      number: v.number ?? null,
      lastNumber: v.lastNumber ?? null
    };
  }).sort((a, b) => a.num - b.num);

  if (!complete) {
    // keep serving the last good data (even if older than the TTL) instead of an empty or truncated list;
    // volumes without their edition are unusable (no volume count, Schuber and announcements would be counted)
    return readStaleEditionCache(cacheKey)
      || (edition ? { edition, volumes, incomplete: true } : { edition: null, volumes: [], incomplete: true });
  }

  const result = { edition, volumes };
  writeCache(cacheKey, result);
  return result;
}

/** Edition metadata only (no volume pages). Reuses a fresh full edition entry; failures are not cached. */
async function getEditionInfo(editionId) {
  const id = toEditionId(editionId);
  if (!id) return null;
  const full = readCache(`mp_edition_vols_${id}`, EDITION_CACHE_TTL_MS);
  if (full?.edition && full.edition.author !== undefined) return normalizeEdition(full.edition);

  const cacheKey = `mp_edition_info_${id}`;
  const cached = readCache(cacheKey, EDITION_CACHE_TTL_MS);
  if (cached) return cached.notFound ? null : normalizeEdition(cached.edition);

  try {
    const res = await fetchWithTimeout(`${API_BASE}/editions/${id}`, { headers: HEADERS });
    if (res.status === 404) {
      writeCache(cacheKey, { notFound: true });
      return null;
    }
    if (!res.ok) return null;
    const edition = mapEdition(await res.json());
    writeCache(cacheKey, { edition });
    return edition;
  } catch (err) {
    log.warn(`Failed to fetch details for edition ${id}:`, err);
    return null;
  }
}

const known = (v) => (v && v !== UNKNOWN ? v : null);

async function searchMangaPassionForLookup(queryTerm, opts = {}) {
  if (!queryTerm || !queryTerm.trim()) return [];
  const searchRes = await searchMangaPassionEditions(queryTerm.trim(), '', null, opts);
  if (!searchRes.candidates || searchRes.candidates.length === 0) return [];

  const top = searchRes.candidates.filter(c => c.score >= 0).slice(0, 5);
  const editions = await Promise.all(top.map(c => (c.score >= LOOKUP_DETAIL_MIN_SCORE ? getEditionInfo(c.id) : null)));

  return top.map((cand, i) => {
    const ed = editions[i] || {};
    return {
      id: `mp_${cand.id}`,
      manga_passion_id: cand.id,
      source: 'manga_passion',
      source_label: '🇩🇪 Manga Passion',
      title: ed.title || cand.title,
      alt_title: ed.alt_title || null,
      author: ed.author || null,
      publisher: known(ed.publisher) || known(cand.publisher) || null,
      status: known(ed.status) || known(cand.status) || 'Laufend',
      total_volumes: ed.total_volumes || cand.total_volumes || null,
      description: ed.description || null,
      cover_image: ed.cover_image || cand.cover_image || null,
      tags: ed.tags || null
    };
  });
}

const storedEditionLink = (mangaId) => {
  const v = db.prepare('SELECT manga_passion_id FROM mangas WHERE id = ?').get(mangaId)?.manga_passion_id;
  return v === null || v === undefined || v === '' ? null : v;
};

/**
 * Stores an automatically found edition, but only while the manga has none: an edition the user picked meanwhile wins.
 * Returns true when the link was written.
 */
function saveEditionLink(manga, editionId) {
  try {
    const info = db.prepare('UPDATE mangas SET manga_passion_id = ? WHERE id = ? AND manga_passion_id IS NULL').run(editionId, manga.id);
    if (info.changes === 1) {
      manga.manga_passion_id = editionId;
      return true;
    }
  } catch (e) { log.warn('Auto-saving Manga Passion edition id failed:', e); }
  return false;
}

/**
 * Picks the recommended edition of a search result and links it to the manga only when the match is unambiguous.
 * An uncertain pick is still returned (so a single request can use it) but not stored: the user has to confirm it.
 * An edition stored while the search ran (the user picked one) replaces the guess: { superseded: true }.
 * options.persist = false never writes (read-only roles).
 */
function linkRecommendedEdition(manga, searchRes, options = {}) {
  const persist = options.persist !== false;
  const superseded = () => {
    const stored = manga?.id != null ? storedEditionLink(manga.id) : null;
    if (stored === null) return null;
    manga.manga_passion_id = stored;
    return { editionId: stored, confident: true, superseded: true };
  };

  const already = superseded();
  if (already) return already;

  const recommended = searchRes?.recommended;
  if (!recommended) return { editionId: null, confident: false, unavailable: Boolean(searchRes?.unavailable) };
  const confident = isConfidentMatch(searchRes.candidates);
  if (confident && persist && !saveEditionLink(manga, recommended.id)) {
    const now = superseded();
    if (now) return now;
  }
  return { editionId: recommended.id, confident };
}

module.exports = {
  API_BASE,
  HEADERS,
  UNKNOWN,
  MAX_VOLUME_PAGES,
  fetchWithTimeout,
  toEditionId,
  mapEditionStatus,
  downloadRemoteImageToUploads,
  searchMangaPassionEditions,
  getEditionDetailsAndVolumes,
  getEditionInfo,
  searchMangaPassionForLookup,
  saveEditionLink,
  linkRecommendedEdition,
  readCache,
  writeCache
};
