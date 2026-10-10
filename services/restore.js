const path = require('path');
const fs = require('fs');
const { db, dataDir, uploadsDir, tempDir, closeDb, initDb, validateDbFile, migrateDbFile, openRawDb } = require('../db');
const { ALLOWED_IMAGE_EXTS, stripImageFileSync } = require('../middleware/upload');
const { createBackupSnapshot, PRE_RESTORE_PREFIX } = require('./scheduler');
const { invalidBackup, notAZip, readDbFacts, latestSchemaVersion, openZip, extractEntry, findDbEntry } = require('./backupArchive');
const disk = require('../utils/disk');
const { config } = require('../utils/config');
const { trackJob } = require('./lifecycle');
const { msg } = require('../core/errors');
const schema = require('../core/schema');
const updateLock = require('./update/lock');
const log = require('../utils/logger').child('backup');

/** Read per restore so operators (and tests) can change them without a restart. */
function restoreLimits() {
    return {
        maxDbBytes: config.restoreMaxDbBytes,
        maxUploadsBytes: config.restoreMaxUploadsBytes,
        maxEntries: config.restoreMaxEntries
    };
}

const SPACE_MARGIN_BYTES = 16 * 1024 * 1024;

async function openArchive(source, maxEntries) {
    return openZip(source, maxEntries).catch((err) => {
        if (err.status) throw err;
        log.warn('[Backup Restore] Could not read the archive:', err.message);
        throw notAZip(msg('Datei kann nicht gelesen werden'));
    });
}

function restorableUploadName(entryName, prefix) {
    const base = prefix + 'uploads/';
    if (!entryName.startsWith(base)) return null;
    const name = entryName.slice(base.length);
    if (!name || name.startsWith('.') || /[/\\:]/.test(name) || [...name].some(c => c.charCodeAt(0) < 32)) return null;
    if (!ALLOWED_IMAGE_EXTS.has(path.extname(name).toLowerCase())) return null;
    return name;
}

const dbFilePath = path.join(dataDir, 'manga.db');
const stagedDbPath = path.join(dataDir, 'manga.db.restore-tmp');
const bakPath = path.join(dataDir, 'manga.db.bak');

/** `file` resolved inside `root`, or null when it points anywhere else (traversal, another absolute path). */
function resolveInside(root, file) {
    if (typeof file !== 'string' || !file) return null;
    const resolved = path.resolve(root, file);
    if (!resolved.startsWith(root + path.sep)) return null;
    return resolved;
}

function unlinkQuietly(file) {
    const target = resolveInside(dataDir, file);
    if (!target) return;
    try { fs.unlinkSync(target); } catch (e) { /* not there */ }
}

function removeJournalFiles(file) {
    unlinkQuietly(file + '-wal');
    unlinkQuietly(file + '-shm');
}

function removeStagedDb() {
    unlinkQuietly(stagedDbPath);
    removeJournalFiles(stagedDbPath);
}

function rollbackSwap(bakWritten) {
    try {
        closeDb();
        removeJournalFiles(dbFilePath);
        if (bakWritten) fs.copyFileSync(bakPath, dbFilePath);
        else unlinkQuietly(dbFilePath);
        removeJournalFiles(dbFilePath);
        initDb({ allowNewerSchema: true });
        db.prepare('SELECT count(*) AS count FROM mangas').get();
        if (bakWritten) unlinkQuietly(bakPath);
    } catch (rollbackErr) {
        log.error(`[Backup Restore] Rollback failed; the previous database is kept at ${bakPath}:`, rollbackErr);
    }
}

function swapInStagedDb() {
    const bakTmpPath = bakPath + '.tmp';
    let bakWritten = false;
    let swapped = false;
    try {
        closeDb();
        if (fs.existsSync(dbFilePath)) {
            fs.copyFileSync(dbFilePath, bakTmpPath);
            fs.renameSync(bakTmpPath, bakPath);
            bakWritten = true;
        }
        removeJournalFiles(dbFilePath);
        fs.renameSync(stagedDbPath, dbFilePath);
        swapped = true;

        initDb();
        require('../middleware/auth').persistJwtSecret();
        const row = db.prepare('SELECT count(*) AS count FROM mangas').get();
        if (bakWritten) unlinkQuietly(bakPath);
        return row ? row.count : 0;
    } catch (err) {
        unlinkQuietly(bakTmpPath);
        if (swapped) {
            rollbackSwap(bakWritten);
        } else {
            if (bakWritten) unlinkQuietly(bakPath);
            try { initDb({ allowNewerSchema: true }); } catch (e) { log.error('[Backup Restore] Reopening the live database failed:', e); }
        }
        throw err;
    }
}

const STRIP_MAX_BYTES = 32 * 1024 * 1024;

function stripRestoredUpload(file, name) {
    try {
        if (fs.statSync(file).size <= STRIP_MAX_BYTES) stripImageFileSync(file);
    } catch (e) {
        log.warn(`[Backup Restore] Could not strip metadata from ${name}:`, e.message);
    }
}

function moveRestoredUploads(stagingDir, names) {
    let moved = 0;
    for (const name of names) {
        const from = path.join(stagingDir, name);
        const to = path.join(uploadsDir, name);
        try {
            stripRestoredUpload(from, name);
            try {
                fs.renameSync(from, to);
            } catch (e) {
                if (e.code !== 'EXDEV') throw e;
                fs.copyFileSync(from, to);
            }
            moved++;
        } catch (e) {
            log.warn(`[Backup Restore] Could not restore upload ${name}:`, e.message);
        }
    }
    return moved;
}

let restoreRunning = false;

/** A leftover manga.db.bak (failed rollback or crash mid-swap) may be the only good copy, so no restore runs until an operator dealt with it. */
function assertNoRollbackCopy() {
    if (!fs.existsSync(bakPath)) return;
    const text = msg('Eine frühere Wiederherstellung wurde nicht sauber abgeschlossen. Die vorherige Datenbank liegt als {path}. Von Hand: Server stoppen, manga.db.bak nach manga.db kopieren (oder löschen, wenn die aktuelle Datenbank stimmt) und neu starten. Oder auf dem Server "node scripts/admin.js rollback-aufraeumen" ausführen (Docker: "docker exec -it -u node manga-shelf node scripts/admin.js rollback-aufraeumen", in der Server-Konsole "rollback-aufraeumen"): es prüft die aktuelle Datenbank und löscht die Kopie erst nach Bestätigung.', { path: bakPath });
    const blocked = new Error(text.text);
    blocked.extra = { msg: text.template, params: text.params };
    blocked.status = 503;
    blocked.code = 'ROLLBACK_COPY_PENDING';
    throw blocked;
}

function assertSchemaSupported(version, allowNewer) {
    const current = latestSchemaVersion();
    if (version <= current || allowNewer) return;
    const err = invalidBackup(msg('Backup stammt aus einer neueren Version (Schema v{version} > v{current}) – erst Manga Shelf aktualisieren.', { version, current }));
    err.code = 'SCHEMA_NEWER';
    throw err;
}

function acceptNewerSchema(file) {
    const conn = openRawDb(file);
    try {
        conn.exec('PRAGMA journal_mode = DELETE;');
        const version = schema.acceptNewerSchema(conn);
        log.warn(`[Backup Restore] Backup mit neuerem Schema v${version} wird bestätigt eingespielt (schema_newer_accepted)`);
    } finally {
        conn.close();
    }
    removeJournalFiles(file);
}

const isDiskFull = (err) => err && (err.code === 'ENOSPC' || (err.errcode & 0xff) === 13 /* SQLITE_FULL from VACUUM INTO */);

/** Restorable covers next to the archive's manga.db and their (claimed) uncompressed size. */
function restorableUploads(entries, prefix) {
    const list = [];
    for (const entry of entries) {
        if (entry.name.endsWith('/')) continue;
        const name = restorableUploadName(entry.name, prefix);
        if (name) list.push({ entry, name });
    }
    return { list, bytes: list.reduce((sum, u) => sum + u.entry.uncompressedSize, 0) };
}

async function takePreRestoreSnapshot() {
    let snapshot;
    try {
        snapshot = await createBackupSnapshot(PRE_RESTORE_PREFIX, { includeUploads: false });
    } catch (err) {
        log.error('[Backup Restore] Pre-restore snapshot failed, restore aborted:', err);
        if (err.status === 507) throw err;
        const failed = new Error(isDiskFull(err)
            ? 'Nicht genug Speicherplatz für die Sicherung vor der Wiederherstellung. Bitte Platz freigeben und erneut versuchen.'
            : 'Sicherung vor der Wiederherstellung fehlgeschlagen');
        failed.status = isDiskFull(err) ? 507 : 500;
        throw failed;
    }
    if (!snapshot.verified) {
        log.error(`[Backup Restore] Pre-restore snapshot ${snapshot.filename} failed its test (${snapshot.verify_error}), restore aborted`);
        const failed = new Error('Sicherung vor der Wiederherstellung hat die Prüfung nicht bestanden');
        failed.status = 500;
        throw failed;
    }
    return snapshot;
}

/** Restores a backup ZIP: slow work runs before the live database is touched, then a safety snapshot and swapInStagedDb(); options: allowNewerSchema, preRestoreSnapshot. */
function restoreFromZip(source, options) {
    return trackJob('Wiederherstellung', runRestore(source, options));
}

async function runRestore(source, { allowNewerSchema = false, preRestoreSnapshot = true } = {}) {
    updateLock.assertNoUpdate();
    if (restoreRunning) {
        const busy = new Error('Es läuft bereits eine Wiederherstellung. Bitte warte, bis sie fertig ist.');
        busy.status = 409;
        throw busy;
    }
    assertNoRollbackCopy();
    restoreRunning = true;
    let stagingDir = null;
    try {
        const limits = restoreLimits();
        const zip = await openArchive(source, limits.maxEntries);
        const images = new Set();
        try {
            const dbEntry = findDbEntry(zip.entries);
            if (!dbEntry) {
                throw invalidBackup(msg('Ungültiges Backup-Archiv: Keine manga.db Datenbank im ZIP gefunden.'));
            }
            const prefix = dbEntry.name.slice(0, -'manga.db'.length);
            const uploads = restorableUploads(zip.entries, prefix);
            disk.ensureFreeSpace(dataDir, Math.min(dbEntry.uncompressedSize, limits.maxDbBytes)
                + Math.min(uploads.bytes, limits.maxUploadsBytes) + disk.fileSize(dbFilePath) + SPACE_MARGIN_BYTES, 'restore');

            removeStagedDb();
            await extractEntry(zip, dbEntry, stagedDbPath, limits.maxDbBytes);
            validateDbFile(stagedDbPath);
            removeJournalFiles(stagedDbPath);
            const stagedVersion = readDbFacts(stagedDbPath).schema_version;
            assertSchemaSupported(stagedVersion, allowNewerSchema);
            removeJournalFiles(stagedDbPath);
            migrateDbFile(stagedDbPath);
            if (stagedVersion > latestSchemaVersion()) acceptNewerSchema(stagedDbPath);

            stagingDir = fs.mkdtempSync(path.join(tempDir, 'restore-uploads-'));
            let budget = limits.maxUploadsBytes;
            for (const { entry, name } of uploads.list) {
                budget -= await extractEntry(zip, entry, path.join(stagingDir, name), budget);
                images.add(name);
            }
            const skipped = zip.entries.filter(e => !e.name.endsWith('/') && e !== dbEntry && /(^|\/)uploads\//.test(e.name)).length - uploads.list.length;
            if (skipped > 0) log.warn(`[Backup Restore] Skipped ${skipped} entries under uploads/ that are not flat image files`);
        } finally {
            await zip.fh.close().catch(() => {});
        }

        const safety = preRestoreSnapshot ? await takePreRestoreSnapshot() : null;
        const mangaCount = swapInStagedDb();
        const restoredImagesCount = moveRestoredUploads(stagingDir, images);
        return { mangaCount, restoredImagesCount, preRestoreSnapshot: safety ? safety.filename : null };
    } catch (err) {
        removeStagedDb();
        throw err;
    } finally {
        if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
        restoreRunning = false;
    }
}

const isRestoreRunning = () => restoreRunning;

module.exports = {
    restoreFromZip,
    isRestoreRunning,
    assertNoRollbackCopy,
    restoreLimits,
    openArchive,
    restorableUploads,
    resolveInside,
    unlinkQuietly,
    removeJournalFiles,
    isDiskFull,
    dbFilePath,
    SPACE_MARGIN_BYTES
};
