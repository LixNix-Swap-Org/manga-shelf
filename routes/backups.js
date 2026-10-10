const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, tempDir, migrateDbFile, validateDbFile, openRawDb } = require('../db');
const auth = require('../middleware/auth');
const { requireAdmin, signSessionToken, setAuthCookie, clearAuthCookie } = auth;
const { uploadBackup } = require('../middleware/upload');
const scheduler = require('../services/scheduler');
const { backupsDir, copyDatabaseToTemp, createBackupSnapshot, holdSnapshot } = scheduler;
const {
    invalidBackup, createArchive, listUploads, appendUploads, manifestForCopy, readDbFacts, latestSchemaVersion,
    extractEntry, findDbEntry, readArchiveManifest, removeDbFile, MANIFEST_NAME
} = require('../services/backupArchive');
const {
    restoreFromZip, isRestoreRunning, assertNoRollbackCopy, restoreLimits, openArchive, restorableUploads, resolveInside,
    unlinkQuietly, removeJournalFiles, isDiskFull, dbFilePath, SPACE_MARGIN_BYTES
} = require('../services/restore');
const update = require('../services/update');
const disk = require('../utils/disk');
const { trackJob } = require('../services/lifecycle');
const { sendError } = require('../utils/httpError');
const { msg, msgData, payloadMsg, badRequest, HttpError } = require('../core/errors');
const { clientIp } = require('../middleware/rateLimit');
const log = require('../utils/logger').child('backup');

const refuseDuringUpdate = (req, res, next) => {
    update.lock.assertNoUpdate();
    next();
};


async function confirmRestorePassword(req, res) {
    try {
        await auth.confirmCurrentPassword(req, res, req.body && req.body.current_password);
    } catch (err) {
        if (err.code === 'WRONG_PASSWORD') log.warn(`[Backup Restore] Wrong password for a restore by ${req.user.username} (${req.authScheme || '-'}, ${clientIp(req)})`);
        throw err;
    }
}

const requireRestorePassword = async (req, res, next) => {
    try {
        await confirmRestorePassword(req, res);
    } catch (err) {
        const upload = uploadedBackupPath(req);
        if (upload) unlinkQuietly(upload);
        throw err;
    }
    next();
};

// *_TEXTS: the extractor collects the role names as catalog keys (they reach the client as nested messages)
const ROLE_TEXTS = { admin: 'Administrator', editor: 'Bearbeiter', visitor: 'Besucher', guest: 'Gast' };

const userWarning = (user, username) => {
    if (!user || !user.exists) return msg('Dein Benutzer „{username}“ ist im Backup nicht vorhanden: Du wirst danach abgemeldet.', { username });
    if (user.role !== 'admin') {
        const role = ROLE_TEXTS[user.role] ? msg(ROLE_TEXTS[user.role]) : user.role;
        return msg('Dein Benutzer „{username}“ ist im Backup kein Administrator (Rolle: {role}): Die Backup-Verwaltung ist danach nicht mehr erreichbar.', { username, role });
    }
    return null;
};

const NO_PASSWORD_HASH = '!local-profile';
const MAX_NAMED_ACCOUNTS = 10;

/** Accounts that cannot log in after a restore: the app marks other users of a pulled database with '!local-profile'. */
function accountsWithoutPassword(file) {
    const probe = openRawDb(file, { readOnly: true });
    try {
        if (!probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) return [];
        return probe.prepare(`
            SELECT username FROM users
            WHERE password_hash IS NULL OR TRIM(password_hash) = '' OR password_hash = ?
            ORDER BY username COLLATE NOCASE
        `).all(NO_PASSWORD_HASH).map(r => r.username);
    } finally {
        probe.close();
    }
}

function noPasswordWarning(names) {
    const shown = names.slice(0, MAX_NAMED_ACCOUNTS).join(', ');
    if (names.length === 1) return msg('1 Konto braucht nach der Wiederherstellung einen Passwort-Reset (kein Passwort in der Sicherung): {names}.', { names: shown });
    if (names.length <= MAX_NAMED_ACCOUNTS) {
        return msg('{count} Konten brauchen nach der Wiederherstellung einen Passwort-Reset (kein Passwort in der Sicherung): {names}.', { count: names.length, names: shown });
    }
    return msg('{count} Konten brauchen nach der Wiederherstellung einen Passwort-Reset (kein Passwort in der Sicherung): {names} und {more} weitere.', {
        count: names.length, names: shown, more: names.length - MAX_NAMED_ACCOUNTS
    });
}

/**
 * Checks a backup without touching the live database: reads its manifest, extracts manga.db to data/temp,
 * validates and test-migrates it, and reports what a restore would bring in.
 */
async function inspectArchive(source, { username, snapshotTimeMs = null }) {
    const limits = restoreLimits();
    const zip = await openArchive(source, limits.maxEntries);
    const copy = path.join(tempDir, `inspect-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
    try {
        const dbEntry = findDbEntry(zip.entries);
        if (!dbEntry) throw invalidBackup(msg('Ungültiges Backup-Archiv: Keine manga.db Datenbank im ZIP gefunden.'));
        const prefix = dbEntry.name.slice(0, -'manga.db'.length);
        const uploads = restorableUploads(zip.entries, prefix);
        if (uploads.bytes > limits.maxUploadsBytes) {
            throw invalidBackup(msg('Die Bilder im Backup sind zusammen zu groß ({size}, erlaubt sind {max}).', { size: disk.formatMb(uploads.bytes), max: disk.formatMb(limits.maxUploadsBytes) }));
        }
        disk.ensureFreeSpace(tempDir, Math.min(dbEntry.uncompressedSize, limits.maxDbBytes) + SPACE_MARGIN_BYTES, 'inspect');
        const manifest = await readArchiveManifest(zip, dbEntry);

        await extractEntry(zip, dbEntry, copy, limits.maxDbBytes);
        validateDbFile(copy);
        removeJournalFiles(copy);
        const facts = readDbFacts(copy, { username });
        removeJournalFiles(copy);
        migrateDbFile(copy);
        const withoutPassword = accountsWithoutPassword(copy);

        const current = latestSchemaVersion();
        const live = readLiveCounts();
        const createdAt = (manifest && typeof manifest.created_at === 'string' && manifest.created_at)
            || (snapshotTimeMs !== null ? new Date(snapshotTimeMs).toISOString() : null);
        const warnings = [];
        const who = userWarning(facts.user, username);
        if (who) warnings.push(who);
        if (facts.schema_version > current) {
            warnings.push(msg('Backup stammt aus einer neueren Version (Schema v{version} > v{current}) – erst Manga Shelf aktualisieren.', { version: facts.schema_version, current }));
        } else if (facts.schema_version < current) {
            warnings.push(msg('Backup stammt aus einer älteren Version (Schema v{version}); es wird beim Einspielen auf v{current} aktualisiert.', { version: facts.schema_version, current }));
        }
        if (withoutPassword.length) warnings.push(noPasswordWarning(withoutPassword));
        warnings.push(msg('Alle anderen Sitzungen (andere Geräte und Benutzer) werden beendet.'));

        return {
            created_at: createdAt,
            created_at_source: manifest && manifest.created_at ? 'manifest' : (createdAt ? 'filename' : null),
            app_version: manifest && typeof manifest.app_version === 'string' ? manifest.app_version : null,
            current_app_version: require('../package.json').version,
            schema_version: facts.schema_version,
            current_schema_version: current,
            schema_newer: facts.schema_version > current,
            has_manifest: Boolean(manifest),
            counts: { ...facts.counts, uploads: uploads.list.length },
            uploads_bytes: uploads.bytes,
            current_counts: live,
            current_user: { username, exists: Boolean(facts.user && facts.user.exists), role: facts.user ? facts.user.role : null },
            relogin: !(facts.user && facts.user.exists && facts.user.role === 'admin'),
            accounts_without_password: withoutPassword,
            warnings: warnings.map(String),
            // parallel to warnings (plain strings for older clients), for the client's catalog
            warnings_msg: warnings.map(msgData)
        };
    } finally {
        await zip.fh.close().catch(() => {});
        removeDbFile(copy);
    }
}

function readLiveCounts() {
    const count = (table) => db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
    return { mangas: count('mangas'), volumes: count('volumes'), users: count('users') };
}

const STAGING_TTL_MS = 15 * 60 * 1000;
const MAX_STAGED = 3;
const staged = new Map();

function dropStaging(id) {
    const entry = staged.get(id);
    if (!entry) return;
    staged.delete(id);
    clearTimeout(entry.timer);
    if (entry.type === 'upload') unlinkQuietly(entry.path);
    if (entry.release) entry.release();
}

function addStaging(entry) {
    while (staged.size >= MAX_STAGED) dropStaging(staged.keys().next().value);
    const expiresAt = Date.now() + STAGING_TTL_MS;
    const timer = setTimeout(() => dropStaging(entry.id), STAGING_TTL_MS);
    timer.unref();
    staged.set(entry.id, { ...entry, expiresAt, timer });
    return new Date(expiresAt).toISOString();
}

/**
 * A restore swaps the users table. Keeps the admin signed in (new token) when the restored database has the same
 * username; otherwise ends the session so the client goes to the login instead of failing every request with 401.
 */
function sessionAfterRestore(req, res, previousUsername) {
    // read after persistJwtSecret() ended all sessions, so the token carries the new session version
    const user = db.prepare('SELECT id, username, role, password_changed_at FROM users WHERE username = ? COLLATE NOCASE').get(previousUsername);
    if (user) {
        setAuthCookie(req, res, signSessionToken(user));
        return { relogin: user.role !== 'admin' };
    }
    clearAuthCookie(res);
    return { relogin: true };
}

// per restore step: the hidden 500 text and the sentence around the reason ({reason} is the cause's own message)
const RESTORE_HIDDEN_TEXTS = {
    snapshot: 'Fehler beim Wiederherstellen (Details im Server-Log)',
    backup: 'Fehler beim Wiederherstellen des Backups (Details im Server-Log)',
    inspect: 'Backup kann nicht geprüft werden (Details im Server-Log)'
};
const RESTORE_REASON_TEXTS = {
    snapshot: 'Fehler beim Wiederherstellen: {reason}',
    backup: 'Fehler beim Wiederherstellen des Backups: {reason}',
    inspect: 'Backup kann nicht geprüft werden: {reason}'
};

/**
 * Client-facing restore error: own German texts for 4xx/503/507, never raw library or OS messages for a 500. The
 * reason is nested as a message of its own: a static text (the client looks it up) or the cause's msg/params.
 */
function restoreErrorText(step, err, status) {
    if (status >= 500 && status !== 503 && status !== 507) return RESTORE_HIDDEN_TEXTS[step];
    const reason = typeof err.extra?.msg === 'string' ? msg(err.extra.msg, err.extra.params) : msg(err.message);
    return msg(RESTORE_REASON_TEXTS[step], { reason });
}

const EXPOSED_RESTORE_CODES = new Set(['SCHEMA_NEWER', 'ROLLBACK_COPY_PENDING', 'INSUFFICIENT_SPACE', 'UPDATE_RUNNING']);

function sendRestoreError(res, step, err, status) {
    return sendError(res, status, restoreErrorText(step, err, status), EXPOSED_RESTORE_CODES.has(err.code) ? err.code : undefined);
}

/** Resolves a snapshot name from the URL to an existing .zip directly in backupsDir, or null. */
function findSnapshot(param) {
    const filename = path.basename(String(param));
    if (filename !== param || !filename.endsWith('.zip')) return null;
    const filePath = path.join(backupsDir, filename);
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? { filename, filePath, size: stat.size } : null;
    } catch (e) {
        return null;
    }
}

const snapshotNotFound = (res) => sendError(res, 404, 'Snapshot-Datei nicht gefunden', 'NOT_FOUND');

const truthy = (value) => value === true || value === 'true' || value === '1';

/** 507 before multer writes an upload that cannot fit (the archive plus its extracted content). */
function requireSpaceForUpload(req, res, next) {
    const length = Number(req.headers['content-length']);
    if (!Number.isFinite(length) || length <= 0) return next();
    try {
        disk.ensureFreeSpace(tempDir, 2 * length + disk.fileSize(dbFilePath), 'backup');
        next();
    } catch (err) {
        log.warn('[Backup Restore] Upload rejected for lack of space:', err.message);
        sendError(res, 507, err.message, err.code, err.extra);
    }
}

function snapshotJson(s) {
    return {
        filename: s.filename,
        size: s.size,
        created_at: new Date(s.time).toISOString(),
        category: s.category,
        verified: s.verified,
        verify_error: s.verify_error,
        manifest: s.manifest
    };
}

// 1. Direct stream download of current backup
router.get('/backup', requireAdmin, async (req, res) => {
    let dbCopy = null;
    const dropCopy = () => { if (dbCopy) { try { fs.unlinkSync(dbCopy); } catch (e) { /* already gone */ } } };
    try {
        // consistent copy of the live database (zipping manga.db directly could catch a write half done)
        dbCopy = copyDatabaseToTemp();
        res.on('close', dropCopy);
        const uploads = listUploads();
        const manifest = await manifestForCopy(dbCopy, { category: 'download', uploads });

        res.attachment('manga-shelf-backup.zip');
        const archive = createArchive();
        archive.on('error', (err) => {
            log.error('Backup stream failed:', err);
            if (!res.headersSent) sendError(res, 500, 'Backup konnte nicht erstellt werden');
            else res.destroy(err);
        });
        archive.pipe(res);
        archive.file(dbCopy, { name: 'manga.db' });
        appendUploads(archive, uploads);
        archive.append(JSON.stringify(manifest, null, 2), { name: MANIFEST_NAME });
        archive.finalize();
    } catch (err) {
        dropCopy();
        log.error('Error generating backup stream:', err);
        if (!res.headersSent) sendError(res, 500, 'Fehler beim Erstellen des Backups');
    }
});

// 2. List all automated and manual server snapshots, newest first
router.get('/backups', requireAdmin, (req, res) => {
    res.json({ backups: scheduler.listSnapshots().map(snapshotJson) });
});

// 3. Create a new server snapshot
router.post('/backups/create', requireAdmin, refuseDuringUpdate, async (req, res) => {
    try {
        const snapshot = await trackJob('Snapshot', createBackupSnapshot('manual'));
        const body = { success: true, snapshot };
        if (!snapshot.verified) {
            // the reason is the stored technical check result, shown verbatim
            Object.assign(body, payloadMsg('warning', msg('Der Snapshot wurde erstellt, hat aber die Prüfung nicht bestanden: {reason}', { reason: String(snapshot.verify_error) })));
        }
        res.json(body);
    } catch (err) {
        log.error('Error creating snapshot:', err);
        if (err.status === 507) return sendError(res, 507, err.message, err.code, err.extra);
        if (isDiskFull(err)) {
            return sendError(res, 507, 'Nicht genug Speicherplatz auf dem Server, um den Snapshot zu erstellen. Bitte Platz freigeben (z. B. alte Snapshots löschen) und erneut versuchen.', 'INSUFFICIENT_SPACE');
        }
        sendError(res, 500, 'Fehler beim Erstellen des Snapshots');
    }
});

// 4. Restore from an existing server snapshot (one step; the two-step flow is /backup/inspect + /backup/restore/:id)
router.post('/backups/:filename/restore', requireAdmin, refuseDuringUpdate, async (req, res) => {
    const snapshot = findSnapshot(req.params.filename);
    if (!snapshot) return snapshotNotFound(res);
    await confirmRestorePassword(req, res);
    try {
        const { filename } = snapshot;

        const release = holdSnapshot(filename);
        let result;
        try {
            result = await restoreFromZip(snapshot.filePath, { allowNewerSchema: truthy(req.body.allow_newer_schema) });
        } finally {
            release();
        }
        Object.assign(result, sessionAfterRestore(req, res, req.user.username));

        log.info(`[Backup Restore] Restored snapshot ${filename} (${result.mangaCount} Mangas)`);
        res.json({
            success: true,
            ...payloadMsg('message', msg('Snapshot "{filename}" erfolgreich wiederhergestellt! ({mangas} Mangas, {uploads} Uploads)', {
                filename, mangas: result.mangaCount, uploads: result.restoredImagesCount
            })),
            ...result
        });
    } catch (err) {
        // an invalid snapshot file is a client-side problem (400), like an invalid upload
        const status = err.status || 500;
        if (status >= 500) log.error('Error restoring snapshot:', err);
        else log.warn('Rejected snapshot restore:', err.message);
        sendRestoreError(res, 'snapshot', err, status);
    }
});

// 5. Download a specific server snapshot
router.get('/backups/:filename/download', requireAdmin, (req, res) => {
    const snapshot = findSnapshot(req.params.filename);
    if (!snapshot) return snapshotNotFound(res);
    res.download(snapshot.filePath, snapshot.filename);
});

// 6. Delete a specific server snapshot (and its sidecar)
router.delete('/backups/:filename', requireAdmin, refuseDuringUpdate, (req, res) => {
    const snapshot = findSnapshot(req.params.filename);
    if (!snapshot) return snapshotNotFound(res);
    if (snapshot.filename === update.heldBackup()) {
        return sendError(res, 409, 'Dieses Backup gehört zum laufenden Update und kann erst nach dessen Abschluss gelöscht werden.', 'BACKUP_HELD');
    }
    scheduler.deleteSnapshot(snapshot.filename);
    res.json({ success: true, ...payloadMsg('message', msg('Snapshot gelöscht')) });
});

const restoredMessage = (result) => payloadMsg('message', msg('Backup erfolgreich eingespielt! ({mangas} Manga-Reihen und {images} Bilddateien wiederhergestellt)', {
    mangas: result.mangaCount, images: result.restoredImagesCount
}));

const uploadedBackupPath = (req) => resolveInside(tempDir, req.file?.path);

// 7. Manual ZIP upload restore. multer stages the upload in data/temp (bounds only the compressed size);
// restoreFromZip streams the extraction and enforces its own uncompressed limits.
const handleUploadedBackupRestore = async (req, res) => {
    const uploadedPath = uploadedBackupPath(req);
    if (!uploadedPath || !fs.existsSync(uploadedPath)) {
        return sendError(res, 400, 'Keine Backup-Datei (.zip) ausgewählt', 'NO_BACKUP_FILE');
    }

    try {
        const result = await restoreFromZip(uploadedPath, { allowNewerSchema: truthy(req.body.allow_newer_schema) });
        Object.assign(result, sessionAfterRestore(req, res, req.user.username));
        res.json({
            success: true,
            ...restoredMessage(result),
            ...result
        });
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) log.error('[Backup Restore] Error:', err);
        else log.warn('[Backup Restore] Rejected uploaded backup:', err.message);
        sendRestoreError(res, 'backup', err, status);
    } finally {
        unlinkQuietly(uploadedPath);
    }
};

router.post('/backup/restore', requireAdmin, refuseDuringUpdate, requireSpaceForUpload, uploadBackup.single('backup'), requireRestorePassword, handleUploadedBackupRestore);
router.post('/restore', requireAdmin, refuseDuringUpdate, requireSpaceForUpload, uploadBackup.single('backup'), requireRestorePassword, handleUploadedBackupRestore);

// 8. Two-step restore, step 1: stage an uploaded ZIP (multipart field "backup") or a server snapshot
// ({ filename }), check it and report what it contains. The staging id is valid for 15 minutes.
router.post('/backup/inspect', requireAdmin, refuseDuringUpdate, requireSpaceForUpload, uploadBackup.single('backup'), async (req, res) => {
    const id = crypto.randomUUID();
    const uploadedPath = uploadedBackupPath(req);
    let stagedPath = null;
    let release = null;
    let kept = false;
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) clientGone = true; });
    try {
        assertNoRollbackCopy();
        let source;
        if (req.file) {
            if (!uploadedPath) return sendError(res, 400, 'Keine Backup-Datei (.zip) ausgewählt', 'NO_BACKUP_FILE');
            stagedPath = path.join(tempDir, `restore-staged-${id}.zip`);
            fs.renameSync(uploadedPath, stagedPath);
            source = { type: 'upload', path: stagedPath, filename: req.file.originalname || null, size: req.file.size };
        } else if (typeof req.body.filename === 'string' && req.body.filename) {
            const snapshot = findSnapshot(req.body.filename);
            if (!snapshot) return snapshotNotFound(res);
            release = holdSnapshot(snapshot.filename);
            source = { type: 'snapshot', path: snapshot.filePath, filename: snapshot.filename, size: snapshot.size };
        } else {
            return sendError(res, 400, 'Keine Backup-Datei (.zip) und kein Snapshot angegeben', 'NO_BACKUP_FILE');
        }

        const parsed = source.type === 'snapshot' ? scheduler.parseSnapshotName(source.filename) : null;
        const summary = await inspectArchive(source.path, { username: req.user.username, snapshotTimeMs: parsed ? parsed.time : null });
        // the dialog was closed meanwhile: nobody receives the staging id, so nothing is staged (finally cleans up)
        if (clientGone) return;
        const expiresAt = addStaging({ id, ...source, userId: req.user.id, release });
        kept = true;
        res.json({
            success: true,
            staging_id: id,
            expires_at: expiresAt,
            source: { type: source.type, filename: source.filename, size: source.size },
            ...summary
        });
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) log.error('[Backup Inspect] Error:', err);
        else log.warn('[Backup Inspect] Rejected backup:', err.message);
        sendRestoreError(res, 'inspect', err, status);
    } finally {
        if (!kept) {
            if (uploadedPath) unlinkQuietly(uploadedPath);
            if (stagedPath) unlinkQuietly(stagedPath);
            if (release) release();
        }
    }
});

const stagingNotFound = (res) => sendError(res, 404,
    'Die Prüfung ist abgelaufen oder unbekannt. Bitte das Backup erneut auswählen und prüfen.', 'STAGING_NOT_FOUND');

router.post('/backup/restore/:stagingId', requireAdmin, refuseDuringUpdate, async (req, res) => {
    const entry = staged.get(req.params.stagingId);
    if (!entry || entry.userId !== req.user.id) return stagingNotFound(res);
    await confirmRestorePassword(req, res);
    try {
        if (entry.type === 'snapshot') {
            const snapshot = findSnapshot(entry.filename);
            if (!snapshot || snapshot.size !== entry.size) {
                dropStaging(entry.id);
                return snapshotNotFound(res);
            }
        } else if (!fs.existsSync(entry.path)) {
            dropStaging(entry.id);
            return stagingNotFound(res);
        }
        const result = await restoreFromZip(entry.path, { allowNewerSchema: truthy(req.body.allow_newer_schema) });
        dropStaging(entry.id);
        Object.assign(result, sessionAfterRestore(req, res, req.user.username));
        log.info(`[Backup Restore] Restored staged ${entry.type} ${entry.filename || ''} (${result.mangaCount} Mangas)`);
        res.json({
            success: true,
            ...restoredMessage(result),
            ...result
        });
    } catch (err) {
        const status = err.status || 500;
        // an invalid archive does not become valid; anything else (busy, disk, newer schema) may be retried
        if (status === 400 && err.code !== 'SCHEMA_NEWER') dropStaging(entry.id);
        if (status >= 500) log.error('[Backup Restore] Error:', err);
        else log.warn('[Backup Restore] Rejected staged backup:', err.message);
        sendRestoreError(res, 'backup', err, status);
    }
});

// Discards a staged backup (dialog cancelled)
router.delete('/backup/restore/:stagingId', requireAdmin, (req, res) => {
    const entry = staged.get(req.params.stagingId);
    if (!entry || entry.userId !== req.user.id) return stagingNotFound(res);
    dropStaging(entry.id);
    res.json({ success: true });
});

// for /api/health ("restoring")
router.isRestoreRunning = isRestoreRunning;

module.exports = router;
