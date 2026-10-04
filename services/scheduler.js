const fs = require('fs');
const path = require('path');
const { db, dataDir, dbPath, tempDir, uploadsDir, openRawDb } = require('../db');
const log = require('../utils/logger').child('scheduler');
const { config, ENTRIES, KEEP_ALL } = require('../utils/config');
const lifecycle = require('./lifecycle');
const { cleanOrphanUploads, referencedUploadNames } = require('./uploadCleanup');
const zipTools = require('./backupArchive');
const disk = require('../utils/disk');

const backupsDir = path.join(dataDir, 'backups');
if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
}

const DAILY_PREFIX = 'daily-auto';
const PRE_RESTORE_PREFIX = 'vor-wiederherstellung';
const PRE_UPDATE_PREFIX = 'vor-update';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

const CATEGORIES = [
    { category: 'daily', matches: (p) => p === DAILY_PREFIX, keep: 'backupKeepDaily' },
    { category: 'manual', matches: (p) => p === 'manual', keep: 'backupKeepManual' },
    { category: 'pre-restore', matches: (p) => p === PRE_RESTORE_PREFIX, keep: 'backupKeepPreRestore' },
    // db.js names them vor-update-v<from>-auf-v<to>
    { category: 'pre-update', matches: (p) => p === PRE_UPDATE_PREFIX || p.startsWith(PRE_UPDATE_PREFIX + '-'), keep: 'backupKeepPreUpdate' }
];

const SNAPSHOT_NAME = /^(.+)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.zip$/;

/** { prefix, time } of a name written by createBackupSnapshot (`<prefix>-<ISO timestamp>.zip`), else null. */
function parseSnapshotName(filename) {
    const m = SNAPSHOT_NAME.exec(filename);
    if (!m) return null;
    const time = Date.parse(`${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z`);
    return Number.isNaN(time) ? null : { prefix: m[1], time };
}

const categoryForPrefix = (prefix) => CATEGORIES.find(c => c.matches(prefix)) || null;

/** daily | manual | pre-restore | pre-update | other (copied in by hand, legacy names: never pruned). */
function categoryOf(filename) {
    const parsed = parseSnapshotName(filename);
    const cat = parsed && categoryForPrefix(parsed.prefix);
    return cat ? cat.category : 'other';
}

/** Snapshots kept for the category of `prefix` (BACKUP_KEEP_*, KEEP_ALL when invalid); null for names that are never pruned. */
function retentionFor(prefix) {
    const cat = categoryForPrefix(prefix);
    return cat ? config[cat.keep] : null;
}

const heldSnapshots = new Map();

/** Protects a snapshot from pruning while it is read (restore). Returns the release function. */
function holdSnapshot(filename) {
    heldSnapshots.set(filename, (heldSnapshots.get(filename) || 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const n = heldSnapshots.get(filename) - 1;
        if (n > 0) heldSnapshots.set(filename, n);
        else heldSnapshots.delete(filename);
    };
}

const isSnapshotHeld = (filename) => heldSnapshots.has(filename);

const sidecarPath = (filename) => path.join(backupsDir, filename.replace(/\.zip$/, '.json'));

/** { verified, error, verified_at, manifest } written next to a snapshot, or null (older snapshots have none). */
function readSidecar(filename) {
    try {
        const data = JSON.parse(fs.readFileSync(sidecarPath(filename), 'utf8'));
        return data && typeof data === 'object' ? data : null;
    } catch (e) {
        return null;
    }
}

function writeSidecar(filename, data) {
    const target = sidecarPath(filename);
    const tmp = target + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, target);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (e) { /* never written */ }
        throw err;
    }
}

/** Deletes a snapshot and its sidecar. Throws only when the ZIP itself cannot be deleted. */
function deleteSnapshot(filename) {
    fs.unlinkSync(path.join(backupsDir, filename));
    try { fs.unlinkSync(sidecarPath(filename)); } catch (e) { /* none */ }
}

/** Every .zip in backupsDir with its sidecar data, newest first (time from the name, else mtime). */
function listSnapshots() {
    let names;
    try { names = fs.readdirSync(backupsDir); } catch (e) { return []; }
    const list = [];
    for (const filename of names) {
        if (!filename.endsWith('.zip')) continue;
        let stat;
        try { stat = fs.statSync(path.join(backupsDir, filename)); } catch (e) { continue; }
        if (!stat.isFile()) continue;
        const parsed = parseSnapshotName(filename);
        const sidecar = readSidecar(filename);
        list.push({
            filename,
            size: stat.size,
            time: parsed ? parsed.time : stat.mtimeMs,
            category: categoryOf(filename),
            // a sidecar holding only the upload list (pre-update snapshots) says nothing about the restore test
            verified: sidecar && typeof sidecar.verified === 'boolean' ? sidecar.verified : null,
            verify_error: sidecar && sidecar.verified === false ? (sidecar.error || null) : null,
            manifest: sidecar && sidecar.manifest ? sidecar.manifest : null
        });
    }
    return list.sort((a, b) => b.time - a.time || (a.filename < b.filename ? 1 : -1));
}

/** Newest snapshot that passed its restore test, or null. */
function lastVerifiedSnapshot() {
    return listSnapshots().find(s => s.verified === true) || null;
}

/**
 * Which snapshots of one category to delete: the newest `keep` good ones stay (verified or from before
 * verification existed). A failed one is only kept while it is the newest snapshot, so hourly retries of a
 * failing daily run cannot pile up or push out good snapshots.
 */
function selectForPruning(entries, keep) {
    const sorted = [...entries].sort((a, b) => b.time - a.time || (a.filename < b.filename ? 1 : -1));
    const remove = [];
    let good = 0;
    let keptFailed = false;
    for (const s of sorted) {
        if (s.verified === false) {
            if (good === 0 && !keptFailed) keptFailed = true;
            else remove.push(s.filename);
        } else if (good < keep) {
            good++;
        } else {
            remove.push(s.filename);
        }
    }
    return remove;
}

/**
 * Applies the retention of the category `prefix` belongs to (all vor-update-* names share one). Names that are
 * not `<prefix>-<timestamp>.zip` of a known category are never touched; snapshots being restored are skipped.
 */
function pruneBackups(prefix, maxSnapshots = retentionFor(prefix)) {
    const cat = prefix && categoryForPrefix(prefix);
    if (!cat || !maxSnapshots) return;
    if (maxSnapshots === KEEP_ALL) {
        const variable = ENTRIES.find(e => e.key === cat.keep)?.name;
        log.warn(`[Backup] ${variable} ist ungültig: Snapshots der Art "${cat.category}" werden nicht gelöscht, bis der Wert korrigiert ist`);
        return;
    }
    try {
        const entries = listSnapshots().filter(s => s.category === cat.category);
        for (const name of selectForPruning(entries, maxSnapshots)) {
            if (isSnapshotHeld(name)) {
                log.info('Keeping old snapshot while it is being restored:', name);
                continue;
            }
            try {
                deleteSnapshot(name);
            } catch (e) {
                log.warn('Could not delete old snapshot', name, e);
            }
        }
    } catch (e) {
        log.warn('Pruning old backups failed:', e);
    }
}

function sqlString(value) {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Writes a consistent copy of the live database to a temp file (VACUUM INTO) and returns its path.
 * Zipping manga.db directly could read it while a write is in progress. The caller deletes the file afterwards.
 * A jwt_secret row that older versions kept in app_settings is removed from the copy (secure_delete overwrites the
 * freed bytes): whoever holds a backup must not be able to sign tokens. The live secret is a file outside the database.
 */
function copyDatabaseToTemp() {
    fs.mkdirSync(tempDir, { recursive: true });
    const target = path.join(tempDir, `backup-db-${Date.now()}-${Math.round(Math.random() * 1e9)}.db`);
    try {
        // a VACUUM INTO that fails halfway (disk full) leaves a partial copy and its journal behind
        db.exec(`VACUUM INTO ${sqlString(target)}`);
        db.exec(`ATTACH DATABASE ${sqlString(target)} AS backup_copy`);
        try {
            db.exec('PRAGMA backup_copy.journal_mode = DELETE');
            db.exec('PRAGMA backup_copy.secure_delete = ON');
            const hasSettings = db.prepare("SELECT 1 AS ok FROM backup_copy.sqlite_master WHERE type = 'table' AND name = 'app_settings'").get();
            if (hasSettings) db.exec("DELETE FROM backup_copy.app_settings WHERE key = 'jwt_secret'");
        } finally {
            db.exec('DETACH DATABASE backup_copy');
        }
    } catch (err) {
        for (const file of [target, target + '-journal', target + '-wal', target + '-shm']) {
            try { fs.unlinkSync(file); } catch (e) { /* not there */ }
        }
        throw err;
    }
    return target;
}

/** Zips the database copy, the uploads (if any) and manifest.json into `file`. Settles only after the file is closed. */
function writeSnapshotArchive(file, dbCopy, manifest, uploads) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(file);
        const archive = zipTools.createArchive();
        let failure = null;
        const fail = (err) => {
            if (failure) return;
            failure = err;
            archive.abort();
            output.destroy();
        };

        output.on('error', fail);
        archive.on('error', fail);
        archive.on('warning', (err) => {
            // an upload deleted while the archive is written is not worth failing the snapshot for
            if (err && err.code === 'ENOENT') log.warn('Snapshot skipped a file that disappeared:', err.message);
            else fail(err);
        });
        output.on('close', () => (failure ? reject(failure) : resolve()));
        archive.pipe(output);

        archive.file(dbCopy, { name: 'manga.db' });
        if (uploads) zipTools.appendUploads(archive, uploads);
        archive.append(JSON.stringify(manifest, null, 2), { name: zipTools.MANIFEST_NAME });
        archive.finalize().catch(fail);
    });
}

const SNAPSHOT_SPACE_FACTOR = 1.2;

/** Uploads the database copy references; undefined when it cannot be read (the cleanup then reads the ZIP itself). */
function uploadNamesOf(dbFile) {
    try {
        const conn = openRawDb(dbFile, { readOnly: true });
        try { return referencedUploadNames(conn); } finally { conn.close(); }
    } catch (err) {
        log.warn('Could not list the uploads of the snapshot database:', err);
        return undefined;
    }
}

/**
 * Creates a ZIP snapshot of manga.db (and uploads/ unless `includeUploads` is false) with a manifest.json.
 * The archive is written as `<name>.zip.part`, restore-tested (verifyArchive) and only then renamed, after the
 * sidecar `<name>.json` with the result; a running or failed write is never listed, restored or counted.
 * A snapshot that fails its test is kept but marked (verified: false) and never counts as today's daily one.
 * Resolves to { filename, size, created_at, category, verified, verify_error, manifest }.
 */
async function createBackupSnapshot(prefix = 'manga-shelf-backup', { includeUploads = true } = {}) {
    fs.mkdirSync(backupsDir, { recursive: true });
    const uploads = includeUploads ? zipTools.listUploads() : null;
    const uploadBytes = uploads ? uploads.reduce((sum, u) => sum + u.size, 0) : 0;
    const dbBytes = disk.fileSize(dbPath) + disk.fileSize(dbPath + '-wal');
    disk.ensureFreeSpace(backupsDir, Math.ceil(SNAPSHOT_SPACE_FACTOR * (dbBytes + uploadBytes)), 'den Snapshot');

    const dbCopy = copyDatabaseToTemp();
    const created = new Date();
    const filename = `${prefix}-${created.toISOString().replace(/[:.]/g, '-')}.zip`;
    const category = categoryOf(filename);
    const targetFile = path.join(backupsDir, filename);
    const partFile = targetFile + '.part';

    let manifest;
    let check;
    try {
        manifest = await zipTools.manifestForCopy(dbCopy, { category, createdAt: created.toISOString(), uploads });
        await writeSnapshotArchive(partFile, dbCopy, manifest, uploads);
        check = await zipTools.verifyArchive(partFile, manifest);
        const sidecar = { verified: check.verified, error: check.error, verified_at: check.verified_at, manifest };
        // a DB-only snapshot is undone with the files still in uploads/: the orphan cleanup must keep them
        if (!uploads) sidecar.referenced_uploads = uploadNamesOf(dbCopy);
        writeSidecar(filename, sidecar);
        fs.renameSync(partFile, targetFile);
    } catch (err) {
        try { fs.unlinkSync(partFile); } catch (e) { /* never created */ }
        try { fs.unlinkSync(sidecarPath(filename)); } catch (e) { /* never written */ }
        throw err;
    } finally {
        try { fs.unlinkSync(dbCopy); } catch (e) { /* temp file already gone */ }
    }
    if (!check.verified) log.error(`Snapshot ${filename} failed its restore test: ${check.error}`);

    pruneBackups(prefix);

    // Only the automatic daily run tidies up: the fresh snapshot just taken still holds every file
    if (prefix === DAILY_PREFIX && check.verified) {
        try { cleanOrphanUploads(); } catch (e) { log.warn('Cleaning orphaned uploads failed:', e); }
    }

    return {
        filename,
        size: fs.statSync(targetFile).size,
        created_at: created.toISOString(),
        category,
        verified: check.verified,
        verify_error: check.error,
        manifest
    };
}

/** Daily window: BACKUP_HOUR (0-23, default 3) in BACKUP_TIMEZONE (default Europe/Berlin, UTC when unknown). */
function backupSchedule() {
    return { hour: config.backupHour, timeZone: config.backupTimeZone };
}

/** Calendar date (YYYY-MM-DD) and hour of `date` in `timeZone`. */
function localParts(date, timeZone) {
    const parts = {};
    const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    for (const p of format.formatToParts(date)) parts[p.type] = p.value;
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/**
 * True when the local time has reached the daily hour and `snapshots` (listSnapshots() entries) hold no verified
 * daily snapshot taken on the current local day. Manual, unverified and unchecked snapshots do not count.
 */
function needsDailyBackup(snapshots, now = new Date(), schedule = backupSchedule()) {
    const today = localParts(now, schedule.timeZone);
    if (today.hour < schedule.hour) return false;
    return !snapshots.some((s) => {
        const parsed = parseSnapshotName(s.filename);
        return parsed && parsed.prefix === DAILY_PREFIX && s.verified === true
            && localParts(new Date(parsed.time), schedule.timeZone).date === today.date;
    });
}

let dailyRun = null;

/** Creates today's daily snapshot when due; concurrent calls share one run. Resolves to true if it made one. */
function runDailyBackupIfDue(now = new Date(), schedule = backupSchedule()) {
    if (dailyRun) return dailyRun;
    dailyRun = (async () => {
        if (!needsDailyBackup(listSnapshots(), now, schedule)) return false;
        log.info('[Auto-Backup] Creating daily automatic manga shelf backup snapshot...');
        // a shutdown waits for it (up to 8 s) instead of leaving a .zip.part behind
        const snapshot = await lifecycle.trackJob('Täglicher Snapshot', createBackupSnapshot(DAILY_PREFIX));
        if (snapshot.verified) log.info('[Auto-Backup] Daily automatic backup completed successfully.');
        return true;
    })().finally(() => { dailyRun = null; });
    return dailyRun;
}

/**
 * Removes what a crash or kill can leave behind: database copies, uploaded or staged restore ZIPs, restore and
 * inspection copies in data/temp, a staged restore database, a half-written safety copy (manga.db.bak.tmp),
 * half-written snapshots and sidecars, and sidecars whose snapshot is gone. Run it only at startup, before any
 * backup or restore can be in flight. manga.db.bak is kept on purpose: after a failed restore it can be the only
 * good copy.
 */
function sweepTempArtefacts() {
    const candidates = [];
    const collect = (dir, pattern) => {
        let names;
        try { names = fs.readdirSync(dir); } catch (e) { return; }
        for (const name of names) {
            if (pattern.test(name)) candidates.push(path.join(dir, name));
        }
    };
    collect(tempDir, /^((backup-db|verify|inspect|vor-update-db)-.*\.db(-wal|-shm|-journal)?|restore-.*\.zip|restore-uploads-.+)$/);
    collect(dataDir, /^manga\.db\.(restore-tmp(-wal|-shm|-journal)?|bak\.tmp)$/);
    collect(backupsDir, /\.(zip\.part|json\.tmp)$/);
    collect(uploadsDir, /^\.strip-.+\.tmp$/);
    try {
        for (const name of fs.readdirSync(backupsDir)) {
            if (name.endsWith('.json') && !fs.existsSync(path.join(backupsDir, name.slice(0, -5) + '.zip'))) {
                candidates.push(path.join(backupsDir, name));
            }
        }
    } catch (e) { /* no backups dir */ }

    let removed = 0;
    let bytes = 0;
    for (const file of candidates) {
        try {
            const stat = fs.lstatSync(file);
            if (stat.isDirectory() && path.basename(file).startsWith('restore-uploads-')) {
                fs.rmSync(file, { recursive: true, force: true });
            } else if (stat.isFile() || stat.isSymbolicLink()) {
                fs.unlinkSync(file);
                bytes += stat.size;
            } else {
                continue;
            }
            removed++;
        } catch (e) {
            log.warn('Could not remove leftover temp file', file, e);
        }
    }
    if (removed) log.info(`Removed ${removed} leftover temp files and folders (${Math.round(bytes / 1024)} KB in files)`);
    if (fs.existsSync(path.join(dataDir, 'manga.db.bak'))) {
        log.warn('data/manga.db.bak exists: rollback copy of an interrupted restore. Restores stay blocked until it is dealt with: run "node scripts/admin.js rollback-aufraeumen" (Docker: "docker exec -it -u node manga-shelf node scripts/admin.js rollback-aufraeumen") or the console command "rollback-aufraeumen".');
    }
    return { removed, bytes };
}

const STRIP_DONE_KEY = 'uploads_metadata_stripped';
const STRIP_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const STRIP_CHUNK = 20;

/**
 * One-time pass over uploads stored before metadata stripping existed: removes EXIF/GPS and similar in place and
 * records completion in app_settings, so it never runs again. Yields to the event loop between chunks; `shouldStop`
 * ends it early without recording completion. Resolves to { done, files, stripped }.
 */
async function stripExistingUploadsOnce({ shouldStop = () => false } = {}) {
    const { stripImageFile } = require('../middleware/upload');
    if (db.prepare('SELECT 1 AS ok FROM app_settings WHERE key = ?').get(STRIP_DONE_KEY)) return { done: true, files: 0, stripped: 0 };
    let names;
    try { names = fs.readdirSync(uploadsDir); } catch (e) { names = []; }
    const files = names.filter(n => !n.startsWith('.') && STRIP_EXTS.has(path.extname(n).toLowerCase()));
    let stripped = 0;
    for (let i = 0; i < files.length; i++) {
        if (i % STRIP_CHUNK === 0) {
            await new Promise(resolve => setImmediate(resolve));
            if (shouldStop()) return { done: false, files: i, stripped };
        }
        try {
            if (await stripImageFile(path.join(uploadsDir, files[i]))) stripped++;
        } catch (e) {
            if (e.code !== 'ENOENT') log.warn('Could not strip metadata from upload', files[i], e);
        }
    }
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(STRIP_DONE_KEY, new Date().toISOString());
    if (stripped) log.info(`Removed metadata from ${stripped} of ${files.length} existing uploads`);
    return { done: true, files: files.length, stripped };
}

/**
 * Starts the daily backup: a check 10 s after boot and then every hour creates a daily-auto snapshot once the
 * local time has reached BACKUP_HOUR and there is no verified one for the local day, so restarts cannot skip a
 * day and the time does not drift with the boot time. Returns a stop function that clears the timers.
 */
function initScheduler() {
    sweepTempArtefacts();
    let stopped = false;
    stripExistingUploadsOnce({ shouldStop: () => stopped })
        .catch(e => log.warn('Stripping metadata from existing uploads failed:', e));
    const check = async () => {
        try {
            await runDailyBackupIfDue();
        } catch (e) {
            log.error('[Auto-Backup] Daily backup failed:', e);
        }
    };
    const first = setTimeout(check, 10000);
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
        stopped = true;
        clearTimeout(first);
        clearInterval(interval);
    };
}

module.exports = {
    backupsDir,
    DAILY_PREFIX,
    PRE_RESTORE_PREFIX,
    PRE_UPDATE_PREFIX,
    parseSnapshotName,
    categoryOf,
    retentionFor,
    copyDatabaseToTemp,
    createBackupSnapshot,
    listSnapshots,
    lastVerifiedSnapshot,
    readSidecar,
    deleteSnapshot,
    selectForPruning,
    pruneBackups,
    holdSnapshot,
    isSnapshotHeld,
    backupSchedule,
    localParts,
    needsDailyBackup,
    runDailyBackupIfDue,
    sweepTempArtefacts,
    stripExistingUploadsOnce,
    initScheduler
};
