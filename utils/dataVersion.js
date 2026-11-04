// Data version and ETag helpers: a cheap change marker for read endpoints so unchanged data answers 304.
const crypto = require('crypto');
const { db, getConnectionGeneration } = require('../db');
const { zonedToday } = require('../services/radar');

// The counters in data_versions survive a restart; the boot id still changes the tags after one, so a database replaced
// while the server was stopped (offline restore) never answers 304 to a tag from before.
const BOOT_ID = crypto.randomBytes(4).toString('hex');
const DEFAULT_SCOPES = ['collection'];

/**
 * State of the data behind the read endpoints, cheap to check before any query: the counters of data_versions (raised
 * by triggers on every row of their area, also by other connections, migration 39) and the reopen generation (restore).
 * Writes outside these areas (caches, sessions, feeds) leave it alone.
 */
function readDataVersion() {
    const versions = {};
    for (const row of db.prepare('SELECT scope, version FROM data_versions').all()) versions[row.scope] = row.version;
    return { boot: BOOT_ID, generation: getConnectionGeneration(), versions };
}

/** The version of `scopes` as one string, e.g. "3f9a0c1e.1.c4711"; equal strings mean unchanged data. */
function dataVersionKey(scopes = DEFAULT_SCOPES) {
    const v = readDataVersion();
    return [v.boot, v.generation, ...scopes.map(scope => `${scope[0]}${v.versions[scope] ?? '-'}`)].join('.');
}

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

/**
 * Weak ETag of a read endpoint: data version, caller (id and role), today's date in the app, server and UTC time
 * zones (radar countdowns, stats months, collection_days), and the path with its query.
 */
function dataEtag(req, now = new Date(), scopes = DEFAULT_SCOPES) {
    const url = crypto.createHash('sha1').update(req.originalUrl || req.url || '').digest('hex').slice(0, 10);
    const utc = now.toISOString().slice(0, 10).replace(/-/g, '');
    const day = [...new Set([dayKey(zonedToday(now)), dayKey(now), utc])].join('-');
    return `W/"${dataVersionKey(scopes)}.u${req.user?.id ?? 0}.${req.user?.role || '-'}.${day}.${url}"`;
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
 * The offline snapshot passes 'private, no-store' so the 30 MB copy stays out of the HTTP cache; `scopes` names the data
 * areas the answer depends on (default: the collection).
 */
function conditional({ cacheControl = 'private, no-cache', scopes = DEFAULT_SCOPES } = {}) {
    return function conditionalGet(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const etag = dataEtag(req, new Date(), scopes);
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', cacheControl);
        if (etagMatches(req.headers['if-none-match'], etag)) return res.status(304).end();
        next();
    };
}

module.exports = { BOOT_ID, DEFAULT_SCOPES, readDataVersion, dataVersionKey, dataEtag, etagMatches, conditional };
