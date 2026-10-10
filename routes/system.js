// Admin system page (GET /api/system and its actions) and the calendar feed token of the release radar. Server-only:
// file sizes, free disk, backups, sessions and the sealed token copy need Node and the server secret.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../package.json');
const { db, dataDir, dbPath, uploadsDir, runTransaction, getInstanceId } = require('../db');
const { requireAuth, requireAdmin, signSessionToken, setAuthCookie, bumpSessionVersion, confirmCurrentPassword } = require('../middleware/auth');
const { createRateLimiter, clientIp } = require('../middleware/rateLimit');
const { freeBytes, fileSize } = require('../utils/disk');
const { HttpError, msg } = require('../utils/httpError');
const { sealForServer, openForServer } = require('../utils/secretBox');
const scheduler = require('../services/scheduler');
const lifecycle = require('../services/lifecycle');
const { cleanOrphanUploads } = require('../services/uploadCleanup');
const { appliedSchemaVersion, LATEST_SCHEMA_VERSION } = require('../core/schema');
const { FEED_KEY_PREFIX, revokeFeedTokens } = require('../core/handlers/radar');
const backupsRoutes = require('./backups');
const updater = require('../services/update');
const { REPOSITORY_URL } = require('../services/update/constants');
const { config } = require('../utils/config');
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

const updateCheckEnabled = () => config.updateCheck;
const update = { result: null, nextAt: 0, running: null, releases: null };
const NO_RESULT = { latest: null, available: false, url: null, checked_at: null };

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
    if (updater.cachedLatest()) {
        update.nextAt = now + UPDATE_TTL_MS;
        return;
    }
    try {
        const res = await globalThis.fetch(UPDATE_URL, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': `manga-shelf/${pkg.version}` },
            signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS)
        });
        if (res.status === 404) {
            // no release yet, or a private repository: that is an answer, not an outage
            update.result = { latest: null, available: false, url: null, checked_at: new Date(now).toISOString() };
            update.nextAt = now + UPDATE_TTL_MS;
            return;
        }
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

function refreshInBackground(now) {
    if (update.running) return;
    update.running = (async () => {
        update.releases = await updater.listReleases();
        if (!update.releases.error && now >= update.nextAt) await checkForUpdate(now);
    })()
        .catch((err) => log.debug('Versionsliste nicht abrufbar:', err && err.message))
        .finally(() => { update.running = null; });
}

function latestState() {
    const cached = updater.cachedLatest();
    if (!cached) return update.result || NO_RESULT;
    return { latest: cached.version, available: compareVersions(cached.version, pkg.version) > 0, url: cached.html_url, checked_at: cached.fetched_at };
}

const releaseSummary = (r) => ({
    version: r.version, tag: r.tag, published_at: r.published_at, url: r.html_url,
    signed: r.signed, installable: r.installable, reason: r.reason, has_admin_notes: r.has_admin_notes
});

const releasesState = (view) => ({
    releases: view ? view.releases.map(releaseSummary) : null,
    releases_error: view ? view.error : null,
    next_try_at: view ? view.next_try_at : null
});

const README_UPDATING = `${REPOSITORY_URL}#updating`;
const RELEASES_PAGE = `${REPOSITORY_URL}/releases`;
const DOCKER_IMAGE = 'ghcr.io/lixnix-swap-org/manga-shelf';
const START_VALUES = ['--port', '--host', '--data-dir'];
const START_FLAGS = ['--log-file', '--no-console'];
const DEB_FAMILY = ['debian', 'ubuntu'];
const RPM_FAMILY = ['fedora', 'rhel', 'centos', 'suse', 'opensuse'];

/** Start options of the binary's command line (`forService`: only those install-service takes); --data-dir absolute. */
function startOptions(argv, { forService = false } = {}) {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
        const raw = String(argv[i]);
        const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
        const flag = eq === -1 ? raw : raw.slice(0, eq);
        if (START_VALUES.includes(flag)) {
            let value = raw.slice(eq + 1);
            if (eq === -1) {
                value = argv[i + 1];
                if (typeof value !== 'string' || value.startsWith('--')) continue;
                i++;
            }
            if (!value.trim()) continue;
            out.push(flag, flag === '--data-dir' ? path.resolve(value) : value.trim());
        } else if (!forService && eq === -1 && START_FLAGS.includes(flag)) {
            out.push(flag);
        }
    }
    return out;
}

let linuxPackage = null;
function linuxPackageKind() {
    if (linuxPackage) return linuxPackage;
    let text = '';
    try { text = fs.readFileSync('/etc/os-release', 'utf8'); } catch (e) { /* unknown distribution */ }
    const ids = [...text.matchAll(/^ID(?:_LIKE)?=["']?([^"'\n]*)/gm)].flatMap((m) => m[1].toLowerCase().split(/\s+/));
    linuxPackage = ids.some((id) => DEB_FAMILY.includes(id)) ? 'deb' : ids.some((id) => RPM_FAMILY.includes(id)) ? 'rpm' : 'package';
    return linuxPackage;
}

function instructionKind(inst) {
    if (inst.mode !== 'sea-system') return inst.mode;
    const asset = String(inst.assetName || '');
    if (asset.includes('-windows-')) return 'windows';
    if (!asset.includes('-linux-')) return 'binary';
    return String(inst.execPath || '').startsWith('/usr/bin/') ? linuxPackageKind() : 'service';
}

function instructions(inst) {
    const kind = instructionKind(inst);
    const sea = inst.mode === 'sea-user' || inst.mode === 'sea-system';
    const argv = sea ? [inst.execPath, ...startOptions(process.argv.slice(2), { forService: kind === 'service' || kind === 'windows' })] : null;
    return { kind, command: null, url: kind === 'desktop' ? RELEASES_PAGE : README_UPDATING, argv };
}

function installInfo() {
    const inst = updater.installMode();
    let reason = inst.reason;
    if (!reason && !config.updateInstall) reason = 'install_off';
    if (!reason && !updater.hasRestartHandler()) reason = 'no_restart';
    return {
        mode: inst.mode,
        can_install: Boolean(inst.canInstall) && !reason,
        reason: reason || null,
        supervisor: inst.supervisor || null,
        restart: inst.restart || null,
        asset: inst.assetName || null,
        instructions: instructions(inst),
        image: inst.mode === 'docker' ? DOCKER_IMAGE : null
    };
}

const STAGED_PHASES = new Set(['downloading', 'verifying', 'preflight', 'ready', 'applying']);

function stagingInfo(status) {
    if (!status.staging_id || !STAGED_PHASES.has(status.phase)) return null;
    return {
        staging_id: status.staging_id,
        version: status.version,
        asset: updater.installMode().assetName || null,
        size: status.total || null,
        expires_at: status.expires_at,
        verified: Boolean(status.verified)
    };
}

function updateState(now = Date.now()) {
    const enabled = updateCheckEnabled();
    if (!enabled) return { enabled, current: pkg.version, ...(update.result || NO_RESULT) };
    refreshInBackground(now);
    const status = updater.getStatus();
    return {
        enabled,
        current: pkg.version,
        ...latestState(),
        install: installInfo(),
        ...releasesState(update.releases),
        staging: stagingInfo(status),
        status,
        last: updater.lastResult()
    };
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

// one text per job that blocks the cleanup (names of lifecycle.trackJob(); the job name is German, so no parameter)
const JOB_RUNNING_TEXTS = {
    Snapshot: 'Gerade läuft „Snapshot“ – bitte gleich noch einmal versuchen',
    'Täglicher Snapshot': 'Gerade läuft „Täglicher Snapshot“ – bitte gleich noch einmal versuchen',
    Wiederherstellung: 'Gerade läuft „Wiederherstellung“ – bitte gleich noch einmal versuchen'
};

router.post('/system/orphans/clean', requireAdmin, (req, res) => {
    if (backupsRoutes.isRestoreRunning()) throw new HttpError(409, 'Während einer Wiederherstellung nicht möglich', 'RESTORE_RUNNING');
    updater.lock.assertNoUpdate();
    // snapshots and restores read or replace the upload folder while they run
    const blocking = lifecycle.runningJobs().find(name => /Snapshot|Wiederherstellung/.test(name));
    if (blocking) {
        const text = JOB_RUNNING_TEXTS[blocking] || msg('Gerade läuft „{job}“ – bitte gleich noch einmal versuchen', { job: msg(blocking) });
        throw new HttpError(409, text, 'JOB_RUNNING');
    }
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

// every session and every calendar feed address of every user ends; the caller gets a fresh session so the admin
// page stays usable
router.post('/system/sessions/end-all', requireAdmin, (req, res) => {
    const me = runTransaction(() => {
        const ids = db.prepare('SELECT id FROM users').all().map(r => r.id);
        for (const id of ids) bumpSessionVersion(id);
        revokeFeedTokens(db);
        return { users: ids.length, row: db.prepare('SELECT id, username, role, password_changed_at FROM users WHERE id = ?').get(req.user.id) };
    });
    if (!me.row) throw new HttpError(401, 'Sitzung abgelaufen oder ungültig – bitte neu anmelden', 'SESSION_INVALID');
    const token = signSessionToken(me.row);
    setAuthCookie(req, res, token);
    log.info(`Alle Sitzungen beendet durch ${req.user.username} (${me.users} Benutzer)`);
    res.json({ success: true, users: me.users, ...(wantsTokenInBody(req) ? { token } : {}) });
});


const TEN_MINUTES = 10 * 60 * 1000;
const LIMIT_TEXT = 'Zu viele Anfragen. Bitte in einigen Minuten erneut versuchen.';
const perUser = (req) => 'user:' + req.user.id;
const checkLimiter = createRateLimiter({ windowMs: TEN_MINUTES, max: 6, keyFn: perUser, message: LIMIT_TEXT });
const prepareLimiter = createRateLimiter({ windowMs: TEN_MINUTES, max: 6, keyFn: perUser, message: LIMIT_TEXT });
const applyLimiter = createRateLimiter({ windowMs: TEN_MINUTES, max: 3, keyFn: perUser, message: LIMIT_TEXT });

const audit = (req) => `${req.user.username} (${req.authScheme || '-'}, ${clientIp(req)})`;
const CHECK_VARIABLE = 'UPDATE_CHECK';

function updateAvailable(req, res, next) {
    if (!updateCheckEnabled()) throw new HttpError(404, msg('Updates über die Systemseite sind abgeschaltet ({variable}=false).', { variable: CHECK_VARIABLE }), 'NOT_AVAILABLE');
    next();
}

function installAllowed(req, res, next) {
    if (!config.updateInstall) throw updater.updateError('UPDATE_INSTALL_OFF');
    next();
}

async function confirmPassword(req, res, password) {
    try {
        await confirmCurrentPassword(req, res, password);
    } catch (err) {
        if (err.code === 'WRONG_PASSWORD') log.warn(`[Update] Falsches Passwort beim Installieren: ${audit(req)}`);
        throw err;
    }
}

router.get('/system/update/status', requireAdmin, updateAvailable, (req, res) => {
    res.json(updater.getStatus());
});

router.post('/system/update/check', requireAdmin, updateAvailable, checkLimiter, async (req, res) => {
    log.info(`[Update] Versionsliste neu abgefragt durch ${audit(req)}`);
    const view = await updater.refreshReleases();
    update.releases = view;
    res.json({ ...releasesState(view), fetched_at: view.fetched_at });
});

router.post('/system/update/prepare', requireAdmin, updateAvailable, installAllowed, prepareLimiter, async (req, res) => {
    const started = await updater.prepareUpdate({ version: req.body.version, userId: req.user.id });
    log.info(`[Update] v${req.body.version} wird geladen und geprüft, angefordert durch ${audit(req)}`);
    res.status(202).json(started);
});

router.post('/system/update/apply/:stagingId', requireAdmin, updateAvailable, installAllowed, applyLimiter, async (req, res) => {
    await confirmPassword(req, res, req.body.current_password);
    const accepted = updater.applyUpdate({
        stagingId: req.params.stagingId,
        userId: req.user.id,
        audit: { username: req.user.username, authScheme: req.authScheme, ip: clientIp(req) }
    });
    applyLimiter.refund(req);
    res.status(202).json(accepted);
});

router.delete('/system/update/staging/:stagingId', requireAdmin, updateAvailable, (req, res) => {
    const result = updater.discardStaging(req.params.stagingId);
    log.info(`[Update] Vorbereitetes Update verworfen durch ${audit(req)}`);
    res.json({ success: true, ...result });
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

const removeFeeds = (userId) => revokeFeedTokens(db, userId);

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
module.exports.startOptions = startOptions;
module.exports.resetSystemState = () => {
    orphanCache = null;
    update.result = null;
    update.nextAt = 0;
    update.running = null;
    update.releases = null;
};
module.exports.updateRun = () => update.running;
