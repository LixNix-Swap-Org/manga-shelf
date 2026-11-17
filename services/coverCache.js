// Cover cache: foreign cover URLs (Manga Passion, AniList, TMDB …) are fetched once by the server and served from
// <DATA_DIR>/cache/covers, so the people using the app (and the shared wishlist) never contact the cover host
// themselves. Only URLs a series, volume or anime of this database names are fetched; the files are no part of a backup
// (they come back on demand) and the daily run removes the ones no row names any more.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getConnectionGeneration } = require('../db');
const safeFetch = require('../utils/safeFetch');
const { stripImageMetadata } = require('../utils/imageMeta');
const log = require('../utils/logger').child('covers');

const MAX_URL_LENGTH = 2048;
// Max's collection needs well under 1 GB; a full cache serves the remaining covers from their host again
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PARALLEL_DOWNLOADS = 4;
// a cover host that failed is not asked again for every page view
const FAILURE_TTL_MS = 10 * 60 * 1000;
const MAX_REMEMBERED_FAILURES = 2000;
const UNUSED_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const EXTS = ['.jpg', '.png', '.webp', '.gif', '.avif'];
const CONTENT_TYPES = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };
const CACHE_FILE = /^([0-9a-f]{64})\.(jpg|png|webp|gif|avif)$/;

// Columns that may hold a foreign image URL (AGENTS.md: cover_image/banner_image are "/uploads/<name> or a foreign URL")
const URL_COLUMNS = {
    mangas: ['cover_image', 'banner_image'],
    volumes: ['cover_image'],
    catalog_series: ['cover_image', 'banner_image'],
    catalog_volumes: ['cover_image'],
    animes: ['cover_image', 'banner_image']
};

const cacheDir = () => path.join(dataDir, 'cache', 'covers');
const keyOf = (url) => crypto.createHash('sha256').update(url, 'utf8').digest('hex');

/** The URL as it is cached (trimmed), or null for anything that is no plain https address. */
function cacheableUrl(raw) {
    if (typeof raw !== 'string') return null;
    const url = raw.trim();
    if (!url || url.length > MAX_URL_LENGTH) return null;
    let parsed;
    try { parsed = new URL(url); } catch (_) { return null; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return url;
}

let columnsCache = null;
const hasVolumeImages = () => presentColumns().images;
function presentColumns() {
    if (columnsCache && columnsCache.generation === getConnectionGeneration()) return columnsCache.list;
    const list = [];
    for (const [table, wanted] of Object.entries(URL_COLUMNS)) {
        let present;
        try {
            present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
        } catch (_) {
            continue;
        }
        for (const column of wanted) if (present.has(column)) list.push([table, column]);
    }
    let images = false;
    try {
        images = db.prepare('PRAGMA table_info(volumes)').all().some(c => c.name === 'images');
    } catch (_) { /* no volumes table */ }
    list.images = images;
    columnsCache = { generation: getConnectionGeneration(), list };
    return list;
}

/** Whether a row of this database names `url` as its cover, banner or volume photo. */
function isReferenced(url) {
    const columns = presentColumns();
    if (!columns.length && !columns.images) return false;
    const parts = columns.map(([table, column]) => `SELECT 1 FROM ${table} WHERE ${column} = ?`);
    const params = columns.map(() => url);
    if (hasVolumeImages()) {
        // a photo added as an external link (volumes.images, a JSON array of URLs)
        parts.push('SELECT 1 FROM volumes WHERE instr(images, ?) > 0');
        params.push(JSON.stringify(url));
    }
    return Boolean(db.prepare(parts.join(' UNION ALL ') + ' LIMIT 1').get(...params));
}

/** sha256 keys of every URL the database names now. */
function referencedKeys() {
    const keys = new Set();
    for (const [table, column] of presentColumns()) {
        for (const row of db.prepare(`SELECT DISTINCT ${column} AS url FROM ${table} WHERE ${column} LIKE 'https://%'`).all()) {
            const url = cacheableUrl(row.url);
            if (url) keys.add(keyOf(url));
        }
    }
    if (hasVolumeImages()) {
        // json_each fails on damaged JSON, so such a value is read as an empty list
        const rows = db.prepare(`SELECT DISTINCT j.value AS url
            FROM volumes v, json_each(CASE WHEN json_valid(v.images) AND json_type(v.images) = 'array' THEN v.images ELSE '[]' END) j
            WHERE v.images LIKE '%https://%' AND j.type = 'text'`).all();
        for (const row of rows) {
            const url = cacheableUrl(row.url);
            if (url) keys.add(keyOf(url));
        }
    }
    return keys;
}

function findCached(key) {
    for (const ext of EXTS) {
        const file = path.join(cacheDir(), key + ext);
        try {
            const stat = fs.statSync(file);
            if (stat.isFile() && stat.size > 0) return { file, ext, size: stat.size };
        } catch (_) { /* not this one */ }
    }
    return null;
}

let cacheBytes = null;
function currentCacheBytes() {
    if (cacheBytes !== null) return cacheBytes;
    cacheBytes = 0;
    try {
        for (const name of fs.readdirSync(cacheDir())) {
            if (CACHE_FILE.test(name)) cacheBytes += fs.statSync(path.join(cacheDir(), name)).size;
        }
    } catch (_) { /* no cache yet */ }
    return cacheBytes;
}

const failures = new Map();
function failedRecently(key) {
    const at = failures.get(key);
    if (at === undefined) return false;
    if (Date.now() - at < FAILURE_TTL_MS) return true;
    failures.delete(key);
    return false;
}
function rememberFailure(key) {
    if (failures.size >= MAX_REMEMBERED_FAILURES) failures.clear();
    failures.set(key, Date.now());
}

const inFlight = new Map();
let running = 0;
const waiting = [];
async function withSlot(fn) {
    if (running >= MAX_PARALLEL_DOWNLOADS) await new Promise(resolve => waiting.push(resolve));
    running++;
    try {
        return await fn();
    } finally {
        running--;
        const next = waiting.shift();
        if (next) next();
    }
}

async function download(url, key) {
    const { buffer, ext } = await withSlot(() => safeFetch.fetchRemoteImage(url));
    const data = stripImageMetadata(buffer, ext);
    if (currentCacheBytes() + data.length > MAX_CACHE_BYTES) {
        log.warn('[Cover] Zwischenspeicher ist voll, das Cover wird nicht gespeichert');
        return null;
    }
    await fs.promises.mkdir(cacheDir(), { recursive: true });
    const target = path.join(cacheDir(), key + ext);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        await fs.promises.writeFile(tmp, data);
        await fs.promises.rename(tmp, target);
    } catch (err) {
        await fs.promises.unlink(tmp).catch(() => {});
        throw err;
    }
    cacheBytes = currentCacheBytes() + data.length;
    return { file: target, ext, size: data.length };
}

/**
 * The cached file of a foreign cover URL: { status: 'ok', file, contentType }, or { status: 'unknown' } (no row names
 * it, nothing is fetched), or { status: 'unavailable' } (download failed or cache full).
 */
async function coverFile(raw) {
    const url = cacheableUrl(raw);
    if (!url) return { status: 'unknown' };
    const key = keyOf(url);
    const cached = findCached(key);
    if (cached) return { status: 'ok', file: cached.file, contentType: CONTENT_TYPES[cached.ext] };
    let referenced = false;
    try {
        referenced = isReferenced(url);
    } catch (err) {
        // database closed for a restore or an update: the host serves it this once
        log.debug('[Cover] Datenbank gerade nicht lesbar:', err && err.message);
    }
    if (!referenced) return { status: 'unknown' };
    if (failedRecently(key)) return { status: 'unavailable' };
    let pending = inFlight.get(key);
    if (!pending) {
        pending = download(url, key).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
    }
    try {
        const stored = await pending;
        if (!stored) return { status: 'unavailable' };
        return { status: 'ok', file: stored.file, contentType: CONTENT_TYPES[stored.ext] };
    } catch (err) {
        rememberFailure(key);
        log.debug(`[Cover] ${new URL(url).host} nicht erreichbar:`, err && err.message);
        return { status: 'unavailable' };
    }
}

/** Removes cached covers no row names any more (older than a day, so a cover just saved stays); returns the count. */
function pruneUnused(now = Date.now()) {
    let names;
    try { names = fs.readdirSync(cacheDir()); } catch (_) { return 0; }
    const keep = referencedKeys();
    let removed = 0;
    for (const name of names) {
        const file = path.join(cacheDir(), name);
        const match = CACHE_FILE.exec(name);
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile()) continue;
            // leftovers of an interrupted write
            const stale = !match && name.endsWith('.tmp') && now - stat.mtimeMs > 60 * 60 * 1000;
            if (!stale && (!match || keep.has(match[1]) || now - stat.mtimeMs < UNUSED_MIN_AGE_MS)) continue;
            fs.unlinkSync(file);
            removed++;
        } catch (_) { /* gone meanwhile */ }
    }
    cacheBytes = null;
    if (removed) log.info(`[Cover] ${removed} nicht mehr benutzte Cover aus dem Zwischenspeicher entfernt`);
    return removed;
}

/** Forgets the in-memory state (tests, after a restore). */
function reset() {
    failures.clear();
    cacheBytes = null;
    columnsCache = null;
}

module.exports = { coverFile, pruneUnused, cacheableUrl, cacheDir, keyOf, reset, MAX_CACHE_BYTES };
