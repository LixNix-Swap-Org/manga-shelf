const crypto = require('crypto');
const { db, getConnectionGeneration } = require('../db');
const { zonedToday } = require('../services/radar');

// A restart resets total_changes() too, so the process gets its own id.
const BOOT_ID = crypto.randomBytes(4).toString('hex');

/**
 * State of the data behind every read endpoint, cheap enough (one tiny statement) to check before any real query.
 * changes: rows written through this connection (cascades and trigger writes included); dataVersion: bumped by
 * commits of other connections to the same file; generation: bumped when db.js reopens the file (restore).
 * Any write changes the key; it may also change without a visible difference (e.g. a cache row), never the reverse.
 */
function readDataVersion() {
    const row = db.prepare('SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS dv').get();
    return { boot: BOOT_ID, generation: getConnectionGeneration(), changes: row.changes, dataVersion: row.dv };
}

/** The version as one string, e.g. "3f9a0c1e.1.4711.2"; equal strings mean unchanged data. */
function dataVersionKey() {
    const v = readDataVersion();
    return `${v.boot}.${v.generation}.${v.changes}.${v.dataVersion}`;
}

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

/**
 * Weak ETag of a read endpoint: data version, the caller (id and role decide what the body contains), today's date
 * in the app time zone (radar countdowns), in the server's (stats months) and in UTC (stats collection_days counts
 * from UTC midnight), and the path with its query.
 */
function dataEtag(req, now = new Date()) {
    const url = crypto.createHash('sha1').update(req.originalUrl || req.url || '').digest('hex').slice(0, 10);
    const utc = now.toISOString().slice(0, 10).replace(/-/g, '');
    const day = [...new Set([dayKey(zonedToday(now)), dayKey(now), utc])].join('-');
    return `W/"${dataVersionKey()}.u${req.user?.id ?? 0}.${req.user?.role || '-'}.${day}.${url}"`;
}

const opaque = (tag) => tag.trim().replace(/^W\//, '');

/** If-None-Match (weak comparison, list or *) against `etag`. */
function etagMatches(header, etag) {
    if (!header) return false;
    if (header.trim() === '*') return true;
    const wanted = opaque(etag);
    return header.split(',').some(t => opaque(t) === wanted);
}

/**
 * Mounted after requireAuth on GET endpoints: sets the ETag and answers 304 before the handler builds the body.
 * `cacheControl`: 'private, no-cache' (revalidate every time), the offline snapshot uses 'private, no-store' so the
 * 30 MB copy never lands in the HTTP cache; the client sends If-None-Match by hand there.
 */
function conditional({ cacheControl = 'private, no-cache' } = {}) {
    return function conditionalGet(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const etag = dataEtag(req);
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', cacheControl);
        if (etagMatches(req.headers['if-none-match'], etag)) return res.status(304).end();
        next();
    };
}

module.exports = { BOOT_ID, readDataVersion, dataVersionKey, dataEtag, etagMatches, conditional };
