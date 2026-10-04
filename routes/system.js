// Admin system page (GET /api/system and its actions) and the calendar feed token of the release radar. Server-only:
// file sizes, free disk, backups, sessions and the sealed token copy need Node and the server secret.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../package.json');
const { db, dataDir, dbPath, uploadsDir, runTransaction, getInstanceId } = require('../db');
const { requireAuth, requireAdmin, signSessionToken, setAuthCookie, bumpSessionVersion } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const { freeBytes, fileSize } = require('../utils/disk');
const { HttpError } = require('../utils/httpError');
const { sealForServer, openForServer } = require('../utils/secretBox');
const scheduler = require('../services/scheduler');
const lifecycle = require('../services/lifecycle');
const { cleanOrphanUploads } = require('../services/uploadCleanup');
const { appliedSchemaVersion, LATEST_SCHEMA_VERSION } = require('../core/schema');
const { FEED_KEY_PREFIX } = require('../core/handlers/radar');
const backupsRoutes = require('./backups');
const log = require('../utils/logger').child('system');

const ORPHAN_CACHE_MS = 10 * 60 * 1000;
const UPDATE_URL = 'https://api.github.com/repos/LixNix-Swap-Org/manga-shelf/releases/latest';
const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_RETRY_MS = 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 5000;

const router = express.Router();

function diskTotal(dir) {
    try {
        const s = fs.statfsSync(dir);
        return Number(s.blocks) * Number(s.bsize);
    } catch (e) {
        return null;
    }
}

function uploadStats() {
    let count = 0;
    let bytes = 0;
    let entries = [];
    try { entries = fs.readdirSync(uploadsDir, { withFileTypes: true }); } catch (e) { /* none yet */ }
    for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        count++;
        bytes += fileSize(path.join(uploadsDir, entry.name));
    }
    return { count, bytes };
}

let orphanCache = null;

// series and volumes in the trash keep their images until the purge: their rows (and references) live in trash.payload
function trashPayloads() {
    try {
        return db.prepare('SELECT payload FROM trash').all().map(r => String(r.payload || '')).join('\n');
    } catch (e) {
        return '';
    }
}

/** Upload names the cleanup would delete (dry run), minus those a trashed entry still references. */
function orphanCandidates() {
    const dry = cleanOrphanUploads({ dryRun: true });
    const trashed = trashPayloads();
    const files = trashed ? dry.files.filter(name => !trashed.includes(name)) : dry.files;
    const bytes = files.reduce((sum, name) => sum + fileSize(path.join(uploadsDir, name)), 0);
    return { files, bytes, skipped: dry.skipped };
}

/** Dry run of the orphan cleanup, cached: it reads every upload name and every referencing column. */
function orphanStats({ refresh = false } = {}) {
    const now = Date.now();
    if (refresh || !orphanCache || now - orphanCache.at > ORPHAN_CACHE_MS) {
        try {
            const dry = orphanCandidates();
            orphanCache = { at: now, value: { count: dry.files.length, bytes: dry.bytes, skipped: dry.skipped, checked_at: new Date(now).toISOString() } };
        } catch (err) {
            log.warn('Verwaiste Uploads konnten nicht gezählt werden:', err);
            orphanCache = { at: now, value: { count: null, bytes: null, skipped: true, checked_at: new Date(now).toISOString() } };
        }
    }
    return orphanCache.value;
}

const snapshotSummary = (s) => (s ? { filename: s.filename, size: s.size, created_at: new Date(s.time).toISOString(), category: s.category, verify_error: s.verify_error || null } : null);

function backupStats() {
    const list = scheduler.listSnapshots();
    const schedule = scheduler.backupSchedule();
    return {
        count: list.length,
        bytes: list.reduce((sum, s) => sum + (s.size || 0), 0),
        latest: snapshotSummary(list[0]),
        last_verified: snapshotSummary(list.find(s => s.verified === true)),
        last_failed: snapshotSummary(list.find(s => s.verified === false)),
        daily_due: scheduler.needsDailyBackup(list),
        schedule: { hour: schedule.hour, time_zone: schedule.timeZone }
    };
}

function databaseStats() {
    const pragma = (name) => {
        try { return Number(Object.values(db.prepare(`PRAGMA ${name}`).get() || {})[0]) || 0; } catch (e) { return null; }
    };
    const count = (table) => {
        try { return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; } catch (e) { return null; }
    };
    const pageSize = pragma('page_size');
    const freelist = pragma('freelist_count');
    return {
        bytes: fileSize(dbPath),
        wal_bytes: fileSize(`${dbPath}-wal`),
        freelist_bytes: pageSize === null || freelist === null ? null : freelist * pageSize,
        schema_version: appliedSchemaVersion(db),
        latest_schema_version: LATEST_SCHEMA_VERSION,
        counts: { mangas: count('mangas'), volumes: count('volumes'), users: count('users'), animes: count('animes') }
    };
}

// ----- update check (GitHub releases, once a day, only while an admin looks at the page; never awaited) -----

const updateCheckEnabled = () => !/^(0|false|off|no|nein)$/i.test(String(process.env.UPDATE_CHECK || '').trim());
const update = { result: null, nextAt: 0, running: null };

function versionParts(value) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || '').trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** >0 when `a` is newer than `b`, 0 when equal or unreadable. */
function compareVersions(a, b) {
    const pa = versionParts(a);
    const pb = versionParts(b);
    if (!pa || !pb) return 0;
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
}

async function checkForUpdate(now = Date.now()) {
    try {
        const res = await globalThis.fetch(UPDATE_URL, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': `manga-shelf/${pkg.version}` },
            signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const latest = String(data?.tag_name || '').replace(/^v/, '');
        if (!versionParts(latest)) throw new Error('keine Versionsnummer in der Antwort');
        const url = typeof data.html_url === 'string' && data.html_url.startsWith('https://github.com/') ? data.html_url : null;
        update.result = { latest, available: compareVersions(latest, pkg.version) > 0, url, checked_at: new Date(now).toISOString() };
        update.nextAt = now + UPDATE_TTL_MS;
    } catch (err) {
        log.debug('Update-Prüfung nicht möglich:', err && err.message);
        update.nextAt = now + UPDATE_RETRY_MS;
    }
}

/** The last known result; starts a check in the background when the last one is a day old. */
function updateState(now = Date.now()) {
    const enabled = updateCheckEnabled();
    if (enabled && !update.running && now >= update.nextAt) {
        update.running = checkForUpdate(now).finally(() => { update.running = null; });
    }
    return { enabled, current: pkg.version, ...(update.result || { latest: null, available: false, url: null, checked_at: null }) };
}

function usersWithKeys() {
    try {
        return db.prepare('SELECT count(DISTINCT user_id) AS n FROM user_api_credentials WHERE user_id IS NOT NULL').get().n;
    } catch (e) {
        return null;
    }
}

router.get('/system', requireAdmin, (req, res) => {
    const free = freeBytes(dataDir);
    const uptime = process.uptime();
    res.json({
        version: pkg.version,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        instance_id: getInstanceId(),
        uptime: Math.round(uptime),
        started_at: new Date(Date.now() - uptime * 1000).toISOString(),
        memory_rss: process.memoryUsage().rss,
        data_dir: dataDir,
        health: lifecycle.healthReport({
            db, dataDir, freeBytes, lastVerifiedSnapshot: scheduler.lastVerifiedSnapshot,
            isRestoreRunning: backupsRoutes.isRestoreRunning, uptimeMs: uptime * 1000
        }),
        database: databaseStats(),
        storage: { free_bytes: free, total_bytes: diskTotal(dataDir), uploads: uploadStats() },
        orphans: orphanStats({ refresh: req.query.refresh === '1' }),
        backups: backupStats(),
        jobs: { running: lifecycle.runningJobs(), restore_running: Boolean(backupsRoutes.isRestoreRunning()) },
        sources: { users_with_keys: usersWithKeys() },
        update: updateState()
    });
});

router.post('/system/orphans/clean', requireAdmin, (req, res) => {
    if (backupsRoutes.isRestoreRunning()) throw new HttpError(409, 'Während einer Wiederherstellung nicht möglich', 'RESTORE_RUNNING');
    // a snapshot reads the upload folder while it runs
    if (lifecycle.runningJobs().length) throw new HttpError(409, 'Gerade läuft ein Snapshot – bitte gleich noch einmal versuchen', 'JOB_RUNNING');
    const candidates = orphanCandidates();
    const result = { removed: 0, bytes: 0, skipped: candidates.skipped };
    if (!candidates.skipped) {
        for (const name of candidates.files) {
            const file = path.join(uploadsDir, name);
            const size = fileSize(file);
            try {
                fs.unlinkSync(file);
            } catch (err) {
                if (err.code !== 'ENOENT') log.warn('Verwaister Upload konnte nicht gelöscht werden', name, err);
                continue;
            }
            result.removed++;
            result.bytes += size;
        }
    }
    orphanCache = null;
    log.info(`Verwaiste Uploads entfernt durch ${req.user.username}: ${result.removed} (${result.bytes} Bytes)${result.skipped ? ', übersprungen' : ''}`);
    res.json({ success: true, removed: result.removed, bytes: result.bytes, skipped: result.skipped });
});

const wantsTokenInBody = (req) => String(req.get('X-Client') || '').trim().toLowerCase() === 'app' || req.authScheme === 'bearer';

// every session of every user ends; the caller gets a fresh one so the admin page stays usable
router.post('/system/sessions/end-all', requireAdmin, (req, res) => {
    const me = runTransaction(() => {
        const ids = db.prepare('SELECT id FROM users').all().map(r => r.id);
        for (const id of ids) bumpSessionVersion(id);
        return { users: ids.length, row: db.prepare('SELECT id, username, role, password_changed_at FROM users WHERE id = ?').get(req.user.id) };
    });
    if (!me.row) throw new HttpError(401, 'Sitzung abgelaufen oder ungültig – bitte neu anmelden', 'SESSION_INVALID');
    const token = signSessionToken(me.row);
    setAuthCookie(req, res, token);
    log.info(`Alle Sitzungen beendet durch ${req.user.username} (${me.users} Benutzer)`);
    res.json({ success: true, users: me.users, ...(wantsTokenInBody(req) ? { token } : {}) });
});

// ----- calendar feed token (GET /api/radar/feed.ics is a core handler; it only compares the hash) -----

const FEED_PATH = '/api/radar/feed.ics';
const feedLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 120, message: 'Zu viele Kalender-Abrufe. Bitte später erneut versuchen.' });

function feedRows(userId) {
    return db.prepare('SELECT key, value FROM app_settings WHERE key LIKE ?').all(`${FEED_KEY_PREFIX}%`)
        .map(row => {
            try { return { key: row.key, entry: JSON.parse(row.value) }; } catch (e) { return null; }
        })
        .filter(r => r && r.entry && r.entry.user_id === userId);
}

const feedPath = (token) => `${FEED_PATH}?token=${encodeURIComponent(token)}`;
const absolute = (req, p) => `${req.protocol}://${req.get('host')}${p}`;

function feedState(req) {
    const row = feedRows(req.user.id)[0];
    if (!row) return { active: false, path: null, url: null, created_at: null, last_used_at: null, unreadable: false };
    let token = null;
    try { token = openForServer(row.entry.sealed); } catch (e) { token = null; }
    return {
        active: true,
        path: token ? feedPath(token) : null,
        url: token ? absolute(req, feedPath(token)) : null,
        created_at: row.entry.created_at || null,
        last_used_at: row.entry.last_used_at ? new Date(row.entry.last_used_at).toISOString() : null,
        unreadable: !token
    };
}

function removeFeeds(userId) {
    let removed = 0;
    for (const row of feedRows(userId)) removed += db.prepare('DELETE FROM app_settings WHERE key = ?').run(row.key).changes;
    return removed;
}

router.get('/radar/feed.ics', feedLimiter, (req, res, next) => next());

router.get('/radar/feed-token', requireAuth, (req, res) => {
    res.json(feedState(req));
});

// a new token replaces the old one: calendars subscribed with the old address stop updating
router.post('/radar/feed-token', requireAuth, (req, res) => {
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
    const entry = { user_id: req.user.id, created_at: new Date().toISOString(), last_used_at: null, sealed: sealForServer(token) };
    runTransaction(() => {
        removeFeeds(req.user.id);
        db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(FEED_KEY_PREFIX + hash, JSON.stringify(entry));
    });
    res.json(feedState(req));
});

router.delete('/radar/feed-token', requireAuth, (req, res) => {
    res.json({ success: true, removed: runTransaction(() => removeFeeds(req.user.id)) });
});

module.exports = router;
module.exports.checkForUpdate = checkForUpdate;
module.exports.compareVersions = compareVersions;
module.exports.resetSystemState = () => {
    orphanCache = null;
    update.result = null;
    update.nextAt = 0;
    update.running = null;
};
module.exports.updateRun = () => update.running;
