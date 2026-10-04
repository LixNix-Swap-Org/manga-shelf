// ZIP reading and writing for backups: a streaming reader (only the central directory is held in memory), manifests
// and the restore test of a fresh archive. Server-only: needs fs, zlib and the database.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable, Transform, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const archiver = require('archiver');
const { db, uploadsDir, tempDir } = require('../db');
const pkg = require('../package.json');
const log = require('../utils/logger').child('backup');
const { msg, isMsg } = require('../core/errors');

/** A backup file that cannot be restored because its content is invalid (client error, HTTP 400). */
function invalidBackup(message) {
    const err = new Error(String(message));
    err.status = 400;
    // a msg(): the restore answer nests it as { msg, params } (routes/backups.js restoreErrorText)
    if (isMsg(message)) err.extra = { msg: message.template, params: message.params };
    return err;
}

/** `detail` is a msg() so the client can translate the nested text. */
const notAZip = (detail) => invalidBackup(msg('Ungültiges ZIP-Archiv: {detail}', { detail }));
const formatMb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

const MANIFEST_NAME = 'manifest.json';
const MANIFEST_FORMAT = 1;
const MAX_MANIFEST_BYTES = 1024 * 1024;

// Images do not shrink under deflate; storing them is several times faster at practically the same size
const STORED_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

function createArchive() {
    return archiver('zip', { zlib: { level: 6 } });
}

/** Flat, non-hidden files in uploads/ (the only ones a restore brings back). */
function listUploads() {
    let entries;
    try { entries = fs.readdirSync(uploadsDir, { withFileTypes: true }); } catch (e) { return []; }
    const files = [];
    for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        const file = path.join(uploadsDir, entry.name);
        try {
            files.push({ name: entry.name, file, size: fs.statSync(file).size });
        } catch (e) { /* deleted in between */ }
    }
    return files;
}

function appendUploads(archive, uploads = listUploads()) {
    for (const u of uploads) archive.file(u.file, { name: 'uploads/' + u.name, store: STORED_EXT.test(u.name) });
    return { count: uploads.length, bytes: uploads.reduce((sum, u) => sum + u.size, 0) };
}

function openReadOnly(file) {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(file, { readOnly: true });
}

/**
 * quick_check, schema version and row counts of a database file. With `username` it also reports whether that
 * user exists in the file (case-insensitive, like the login) and with which role.
 */
function readDbFacts(file, { username } = {}) {
    const probe = openReadOnly(file);
    try {
        const check = probe.prepare('PRAGMA quick_check').get();
        const tables = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
        const count = (table, where = '') => (tables.has(table) ? probe.prepare(`SELECT count(*) AS c FROM ${table} ${where}`).get().c : null);
        const facts = {
            quick_check: check ? String(Object.values(check)[0]) : 'unbekannt',
            schema_version: tables.has('schema_migrations') ? (probe.prepare('SELECT max(version) AS v FROM schema_migrations').get().v || 0) : 0,
            counts: { mangas: count('mangas'), volumes: count('volumes'), users: count('users'), admins: count('users', "WHERE role = 'admin'") }
        };
        if (username !== undefined && tables.has('users')) {
            const user = probe.prepare('SELECT role FROM users WHERE username = ? COLLATE NOCASE').get(String(username));
            facts.user = user ? { exists: true, role: user.role } : { exists: false, role: null };
        }
        return facts;
    } finally {
        probe.close();
    }
}

let appSchemaVersion = null;

/** Highest migration this app knows. The live database is migrated at startup, so its newest row is that number. */
function latestSchemaVersion() {
    const exported = require('../db').LATEST_SCHEMA_VERSION;
    if (Number.isInteger(exported)) return exported;
    if (appSchemaVersion === null) {
        appSchemaVersion = db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v || 0;
    }
    return appSchemaVersion;
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file)
            .on('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

function buildManifest({ category, createdAt, facts, dbBytes, dbSha256, uploads }) {
    return {
        format: MANIFEST_FORMAT,
        app: 'manga-shelf',
        app_version: pkg.version,
        schema_version: facts.schema_version,
        created_at: createdAt,
        category,
        counts: { mangas: facts.counts.mangas, volumes: facts.counts.volumes, users: facts.counts.users },
        uploads: uploads ? { count: uploads.count, bytes: uploads.bytes } : null,
        db: { bytes: dbBytes, sha256: dbSha256 }
    };
}

/** Manifest for a database copy about to be zipped; `uploads` is the list going into the archive (or null). */
async function manifestForCopy(dbCopy, { category, createdAt = new Date().toISOString(), uploads = null } = {}) {
    const facts = readDbFacts(dbCopy);
    const dbSha256 = await sha256File(dbCopy);
    const summary = uploads ? { count: uploads.length, bytes: uploads.reduce((sum, u) => sum + u.size, 0) } : null;
    return buildManifest({ category, createdAt, facts, dbBytes: fs.statSync(dbCopy).size, dbSha256, uploads: summary });
}

// Minimal streaming ZIP reader: only the central directory is held in memory, entries are inflated straight to disk.
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;

async function readAt(fh, length, position) {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    if (bytesRead !== length) throw notAZip(msg('Datei ist unvollständig'));
    return buf;
}

async function openZip(file, maxEntries = Infinity) {
    const fh = await fs.promises.open(file, 'r');
    try {
        const { size } = await fh.stat();
        if (size < 22) throw notAZip(msg('Datei ist zu klein'));
        const tailLength = Math.min(size, 22 + 0xffff);
        const tail = await readAt(fh, tailLength, size - tailLength);
        let eocd = -1;
        for (let i = tailLength - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
        }
        if (eocd < 0) throw notAZip(msg('kein Inhaltsverzeichnis gefunden'));

        let count = tail.readUInt16LE(eocd + 10);
        let cdSize = tail.readUInt32LE(eocd + 12);
        let cdOffset = tail.readUInt32LE(eocd + 16);
        // 0xffff entries is also a plain value: archiver writes ZIP64 only above 65535 entries, so only the locator decides
        const locatorPosition = size - tailLength + eocd - 20;
        const locator = locatorPosition >= 0 && (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
            ? await readAt(fh, 20, locatorPosition)
            : null;
        if (locator && locator.readUInt32LE(0) === SIG_ZIP64_LOCATOR) {
            const zip64 = await readAt(fh, 56, Number(locator.readBigUInt64LE(8)));
            if (zip64.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw notAZip(msg('ZIP64-Verzeichnis ist beschädigt'));
            count = Number(zip64.readBigUInt64LE(32));
            cdSize = Number(zip64.readBigUInt64LE(40));
            cdOffset = Number(zip64.readBigUInt64LE(48));
        }
        if (count > maxEntries) throw invalidBackup(msg('Das Backup enthält zu viele Dateien ({count}, erlaubt sind {max}).', { count, max: maxEntries }));
        if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES) throw notAZip(msg('Inhaltsverzeichnis ist zu groß'));
        if (cdOffset + cdSize > size) throw notAZip(msg('Inhaltsverzeichnis liegt außerhalb der Datei'));

        const cd = await readAt(fh, cdSize, cdOffset);
        const entries = [];
        let p = 0;
        for (let i = 0; i < count; i++) {
            if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw notAZip(msg('Inhaltsverzeichnis ist beschädigt'));
            const flags = cd.readUInt16LE(p + 8);
            const nameLength = cd.readUInt16LE(p + 28);
            const extraLength = cd.readUInt16LE(p + 30);
            const commentLength = cd.readUInt16LE(p + 32);
            if (p + 46 + nameLength + extraLength > cd.length) throw notAZip(msg('Inhaltsverzeichnis ist beschädigt'));
            const entry = {
                name: cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLength),
                flags,
                method: cd.readUInt16LE(p + 10),
                crc32: cd.readUInt32LE(p + 16),
                compressedSize: cd.readUInt32LE(p + 20),
                uncompressedSize: cd.readUInt32LE(p + 24),
                localOffset: cd.readUInt32LE(p + 42)
            };
            let e = p + 46 + nameLength;
            const extraEnd = e + extraLength;
            while (e + 4 <= extraEnd) {
                const id = cd.readUInt16LE(e);
                const len = cd.readUInt16LE(e + 2);
                if (id === 0x0001) {
                    let q = e + 4;
                    for (const key of ['uncompressedSize', 'compressedSize', 'localOffset']) {
                        if (entry[key] === 0xffffffff && q + 8 <= e + 4 + len) {
                            entry[key] = Number(cd.readBigUInt64LE(q));
                            q += 8;
                        }
                    }
                }
                e += 4 + len;
            }
            entries.push(entry);
            p = extraEnd + commentLength;
        }
        return { file, fh, size, entries };
    } catch (err) {
        await fh.close().catch(() => {});
        throw err;
    }
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Reads `length` bytes from `start` through the archive's open handle, so the file can be deleted (snapshot
 * retention) while it is extracted. The handle stays open for the next entry.
 */
function readRange(fh, start, length) {
    let position = start;
    let remaining = length;
    return new Readable({
        highWaterMark: READ_CHUNK_BYTES,
        read() {
            if (remaining <= 0) {
                this.push(null);
                return;
            }
            const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
            fh.read(chunk, 0, chunk.length, position).then(({ bytesRead }) => {
                if (bytesRead === 0) return this.destroy(notAZip(msg('Datei ist unvollständig')));
                position += bytesRead;
                remaining -= bytesRead;
                this.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
            }, (err) => this.destroy(err));
        }
    });
}

/** Inflates one entry into `sink`, counting the bytes actually produced (the sizes in the archive can lie). */
async function inflateEntry(zip, entry, makeSink, maxBytes, hash) {
    const tooLarge = () => invalidBackup(msg('"{name}" im Backup ist zu groß (erlaubt sind {max}).', { name: entry.name, max: formatMb(maxBytes) }));
    if (entry.flags & 0x1) throw invalidBackup(msg('"{name}" im Backup ist verschlüsselt.', { name: entry.name }));
    if (entry.method !== 0 && entry.method !== 8) throw invalidBackup(msg('"{name}" im Backup nutzt ein nicht unterstütztes Kompressionsverfahren.', { name: entry.name }));
    if (entry.uncompressedSize > maxBytes) throw tooLarge();

    const local = await readAt(zip.fh, 30, entry.localOffset);
    if (local.readUInt32LE(0) !== SIG_LOCAL) throw notAZip(msg('Eintrag "{name}" ist beschädigt', { name: entry.name }));
    const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (start + entry.compressedSize > zip.size) throw notAZip(msg('Eintrag "{name}" ist unvollständig', { name: entry.name }));

    let written = 0;
    let crc = 0;
    const counter = new Transform({
        transform(chunk, encoding, callback) {
            written += chunk.length;
            if (written > maxBytes) return callback(tooLarge());
            if (written > entry.uncompressedSize) return callback(notAZip(msg('"{name}" ist größer als im Archiv angegeben', { name: entry.name })));
            crc = zlib.crc32(chunk, crc);
            if (hash) hash.update(chunk);
            callback(null, chunk);
        }
    });
    const stages = [readRange(zip.fh, start, entry.compressedSize)];
    if (entry.method === 8) stages.push(zlib.createInflateRaw());
    stages.push(counter, makeSink());

    try {
        await pipeline(stages);
        if (written !== entry.uncompressedSize) throw notAZip(msg('"{name}" ist kleiner als im Archiv angegeben', { name: entry.name }));
        if (crc !== entry.crc32) throw notAZip(msg('Prüfsumme von "{name}" stimmt nicht', { name: entry.name }));
    } catch (err) {
        if (err.status) throw err;
        if (typeof err.code === 'string' && err.code.startsWith('Z_')) throw notAZip(msg('"{name}" ist beschädigt', { name: entry.name }));
        throw err;
    }
    return written;
}

/** Inflates one entry to `target`; returns the bytes written and removes the partial file on any failure. */
async function extractEntry(zip, entry, target, maxBytes, hash) {
    try {
        return await inflateEntry(zip, entry, () => fs.createWriteStream(target), maxBytes, hash);
    } catch (err) {
        try { fs.unlinkSync(target); } catch (e) { /* not written */ }
        throw err;
    }
}

async function readEntryBuffer(zip, entry, maxBytes) {
    const chunks = [];
    const sink = new Writable({
        write(chunk, encoding, callback) {
            chunks.push(chunk);
            callback();
        }
    });
    await inflateEntry(zip, entry, () => sink, maxBytes);
    return Buffer.concat(chunks);
}

const isJunkPath = (name) => name.split('/').some(segment => segment === '__MACOSX' || segment.startsWith('.'));

/** The shallowest manga.db outside macOS metadata folders. */
function findDbEntry(entries) {
    return entries
        .filter(e => (e.name === 'manga.db' || e.name.endsWith('/manga.db')) && !isJunkPath(e.name))
        .sort((a, b) => a.name.length - b.name.length)[0];
}

/** manifest.json next to the archive's manga.db, or null when missing or unreadable. */
async function readArchiveManifest(zip, dbEntry) {
    const prefix = dbEntry ? dbEntry.name.slice(0, -'manga.db'.length) : '';
    const entry = zip.entries.find(e => e.name === prefix + MANIFEST_NAME);
    if (!entry) return null;
    try {
        const manifest = JSON.parse((await readEntryBuffer(zip, entry, MAX_MANIFEST_BYTES)).toString('utf8'));
        return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : null;
    } catch (e) {
        log.warn('Unreadable manifest.json in backup:', e.message);
        return null;
    }
}

function removeDbFile(file) {
    for (const f of [file, file + '-wal', file + '-shm', file + '-journal']) {
        try { fs.unlinkSync(f); } catch (e) { /* not there */ }
    }
}

/**
 * Restore test of a freshly written archive: extracts manga.db to data/temp, compares its sha256 with the
 * manifest, opens it read-only, runs quick_check and compares the row counts. Never throws.
 */
async function verifyArchive(file, expected) {
    const target = path.join(tempDir, `verify-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
    let zip = null;
    try {
        zip = await openZip(file);
        const dbEntry = zip.entries.find(e => e.name === 'manga.db');
        if (!dbEntry) throw new Error('manga.db fehlt im Archiv');
        const stored = await readArchiveManifest(zip, dbEntry);
        if (!stored) throw new Error('manifest.json fehlt oder ist unlesbar');
        if (stored.db?.sha256 !== expected.db.sha256) throw new Error('manifest.json passt nicht zur Datenbank');

        const hash = crypto.createHash('sha256');
        await extractEntry(zip, dbEntry, target, Number.MAX_SAFE_INTEGER, hash);
        if (hash.digest('hex') !== expected.db.sha256) throw new Error('Prüfsumme der Datenbank stimmt nicht');
        const facts = readDbFacts(target);
        if (facts.quick_check !== 'ok') throw new Error('quick_check: ' + facts.quick_check);
        for (const key of ['mangas', 'volumes', 'users']) {
            if (facts.counts[key] !== expected.counts[key]) {
                throw new Error(`Anzahl ${key} stimmt nicht (${facts.counts[key]} statt ${expected.counts[key]})`);
            }
        }
        return { verified: true, error: null, verified_at: new Date().toISOString() };
    } catch (err) {
        return { verified: false, error: err.message, verified_at: new Date().toISOString() };
    } finally {
        if (zip) await zip.fh.close().catch(() => {});
        removeDbFile(target);
    }
}

module.exports = {
    MANIFEST_NAME,
    STORED_EXT,
    invalidBackup,
    notAZip,
    formatMb,
    createArchive,
    listUploads,
    appendUploads,
    readDbFacts,
    latestSchemaVersion,
    sha256File,
    buildManifest,
    manifestForCopy,
    openZip,
    extractEntry,
    readEntryBuffer,
    isJunkPath,
    findDbEntry,
    readArchiveManifest,
    removeDbFile,
    verifyArchive
};
