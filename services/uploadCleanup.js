const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, uploadsDir, tempDir, openRawDb } = require('../db');
const log = require('../utils/logger').child('uploads');

const MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const backupsDir = path.join(dataDir, 'backups');
// DB-only undo snapshots (services/scheduler.js PRE_RESTORE_PREFIX, db.js vor-update-v<from>-auf-v<to>)
const UNDO_SNAPSHOT = /^(vor-wiederherstellung|vor-update)-.+\.zip$/;

const REFERENCE_COLUMNS = {
    mangas: ['cover_image', 'banner_image', 'description', 'manga_passion_edition_data'],
    volumes: ['cover_image', 'images', 'notes'],
    animes: ['cover_image', 'banner_image'],
    trash: ['payload']
};

/** Every column value that can name an upload (cover/banner URLs, JSON image lists, markdown/HTML in texts). */
function referenceValues(conn = db) {
    const values = [];
    for (const [table, wanted] of Object.entries(REFERENCE_COLUMNS)) {
        // older databases (snapshots taken before an update) may lack some columns
        const present = new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
        const columns = wanted.filter(c => present.has(c));
        if (!columns.length) continue;
        for (const row of conn.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all()) {
            for (const c of columns) values.push(row[c]);
        }
    }
    return values.filter(Boolean).map(String);
}

const TOKEN_SPLIT = /[^A-Za-z0-9._-]+/;
const TOKEN_NAME = /^[A-Za-z0-9._-]+$/;
const IMAGE_EXT_END = /\.(jpe?g|png|webp|gif|avif)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)/gi;

const reverse = (str) => str.split('').reverse().join('');

/** First index in the sorted array whose element is >= value. */
function lowerBound(sorted, value) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * A file counts as used when its name appears anywhere in those values (plain substring semantics). A name made of
 * [A-Za-z0-9._-] can only occur inside one such token, ending where the token has the same image extension, so it is
 * answered from the token set or a sorted list of reversed token prefixes that end in an image extension (binary
 * search for the reversed name as a prefix). Other names fall back to the substring search over all values.
 */
function buildReferenceIndex(conn = db) {
    const values = referenceValues(conn);
    const tokens = new Set();
    for (const value of values) {
        for (const token of value.split(TOKEN_SPLIT)) {
            if (token) tokens.add(token);
        }
    }
    const endings = [];
    for (const token of tokens) {
        for (const m of token.matchAll(IMAGE_EXT)) endings.push(reverse(token.slice(0, m.index + m[0].length)));
    }
    endings.sort();
    let text = null;
    return {
        isReferenced(name) {
            if (tokens.has(name)) return true;
            if (TOKEN_NAME.test(name) && IMAGE_EXT_END.test(name)) {
                const key = reverse(name);
                const i = lowerBound(endings, key);
                return i < endings.length && endings[i].startsWith(key);
            }
            if (text === null) text = values.join('\n');
            return text.includes(name);
        }
    };
}

function uploadFileNames() {
    let entries;
    try { entries = fs.readdirSync(uploadsDir, { withFileTypes: true }); } catch (e) { return []; }
    return entries.filter(e => e.isFile() && !e.name.startsWith('.')).map(e => e.name);
}

/** Names of the files in uploads/ that the database behind `conn` references, sorted. */
function referencedUploadNames(conn = db) {
    const index = buildReferenceIndex(conn);
    return uploadFileNames().filter(name => index.isReferenced(name)).sort();
}

const sidecarFile = (zipName) => path.join(backupsDir, zipName.replace(/\.zip$/, '.json'));

function readSidecar(zipName) {
    try {
        const data = JSON.parse(fs.readFileSync(sidecarFile(zipName), 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (e) {
        return null;
    }
}

/** Reads manga.db out of a DB-only snapshot and lists the uploads it references. */
function listFromSnapshot(zipName) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(path.join(backupsDir, zipName));
    const entry = zip.getEntries()
        .filter(e => e.entryName === 'manga.db' || e.entryName.endsWith('/manga.db'))
        .sort((a, b) => a.entryName.length - b.entryName.length)[0];
    if (!entry) throw new Error('manga.db fehlt im Archiv');
    fs.mkdirSync(tempDir, { recursive: true });
    const copy = path.join(tempDir, `inspect-refs-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
    try {
        fs.writeFileSync(copy, entry.getData());
        const conn = openRawDb(copy, { readOnly: true });
        try { return referencedUploadNames(conn); } finally { conn.close(); }
    } finally {
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
            try { fs.unlinkSync(copy + suffix); } catch (e) { /* not there */ }
        }
    }
}

/**
 * Upload names that retained undo snapshots (pre-restore, pre-update) still reference: restoring one must find its
 * covers. Snapshots written before the list existed get it computed once and stored in their sidecar.
 * `missing` names snapshots whose list could not be determined.
 */
function undoSnapshotReferences() {
    const names = new Set();
    const missing = [];
    let files;
    try { files = fs.readdirSync(backupsDir); } catch (e) { return { names, missing }; }
    for (const zipName of files.filter(f => UNDO_SNAPSHOT.test(f))) {
        const sidecar = readSidecar(zipName);
        let list = sidecar && Array.isArray(sidecar.referenced_uploads) ? sidecar.referenced_uploads : null;
        if (!list) {
            try {
                list = listFromSnapshot(zipName);
                const target = sidecarFile(zipName);
                fs.writeFileSync(target + '.tmp', JSON.stringify({ ...(sidecar || {}), referenced_uploads: list }, null, 2));
                fs.renameSync(target + '.tmp', target);
            } catch (e) {
                if (!list) {
                    log.warn(`Could not read the uploads referenced by ${zipName}:`, e.message);
                    missing.push(zipName);
                    continue;
                }
                log.warn(`Could not store the upload list of ${zipName}:`, e.message);
            }
        }
        for (const name of list) names.add(String(name));
    }
    return { names, missing };
}

/**
 * Deletes files in uploads/ that no series or volume references any more (left behind by deleted entries and
 * replaced covers). Files younger than 7 days stay: an upload happens before the form is saved. Files a retained
 * undo snapshot references stay too; when such a snapshot's list cannot be read, nothing is deleted.
 * With dryRun the files are only counted. Returns { removed, bytes, files, skipped }.
 */
function cleanOrphanUploads({ dryRun = false, minAgeMs = MIN_AGE_MS } = {}) {
    const result = { removed: 0, bytes: 0, files: [], skipped: false };
    if (!fs.existsSync(uploadsDir)) return result;
    const undo = undoSnapshotReferences();
    if (undo.missing.length) {
        log.warn(`Orphaned uploads are kept: the upload list of ${undo.missing.join(', ')} is unreadable`);
        return { ...result, skipped: true };
    }
    const references = buildReferenceIndex();
    const now = Date.now();
    for (const name of uploadFileNames()) {
        const full = path.join(uploadsDir, name);
        let stat;
        try { stat = fs.statSync(full); } catch (e) { continue; }
        if (now - stat.mtimeMs < minAgeMs) continue;
        if (undo.names.has(name) || references.isReferenced(name)) continue;
        if (!dryRun) {
            try { fs.unlinkSync(full); } catch (e) { log.warn('Could not delete orphaned upload', name, e); continue; }
        }
        result.removed++;
        result.bytes += stat.size;
        result.files.push(name);
    }
    if (result.removed && !dryRun) log.info(`Removed ${result.removed} orphaned uploads (${Math.round(result.bytes / 1024)} KB)`);
    return result;
}

module.exports = { cleanOrphanUploads, referencedUploadNames, undoSnapshotReferences };
