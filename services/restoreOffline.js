const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const defaultOut = (text) => process.stdout.write(text + '\n');

function quickCheck(conn) {
    const row = conn.prepare('PRAGMA quick_check').get();
    const result = row ? String(Object.values(row)[0]) : 'unbekannt';
    if (result !== 'ok') throw new Error(`quick_check: ${result}`);
}

function checkFolder(source, tmpRoot) {
    for (const base of tmpRoot ? [tmpRoot] : [path.dirname(source), os.tmpdir()]) {
        try {
            return fs.mkdtempSync(path.join(base, 'manga-shelf-db-check-'));
        } catch (e) { /* next */ }
    }
    throw new Error('kein Ordner für die Kopie beschreibbar');
}

/** Copies `file` into a temp folder next to it (else the system's) and migrates the copy; resolves 0 (passed) or 1. */
async function dbCheck(file, { out = defaultOut, tmpRoot = null } = {}) {
    const schema = require('../core/schema');
    const source = path.resolve(String(file || ''));
    let st = null;
    try { st = fs.statSync(source); } catch (e) { /* missing */ }
    if (!file || !st || !st.isFile()) {
        out(`Datenbank-Prüfung fehlgeschlagen: Datei nicht gefunden (${source})`);
        return 1;
    }
    let dir = null;
    let conn = null;
    try {
        dir = checkFolder(source, tmpRoot);
        const copy = path.join(dir, 'manga.db');
        fs.copyFileSync(source, copy);
        if (fs.existsSync(source + '-wal')) fs.copyFileSync(source + '-wal', copy + '-wal');
        const { DatabaseSync } = require('node:sqlite');
        conn = new DatabaseSync(copy);
        conn.exec('PRAGMA journal_mode = DELETE;');
        quickCheck(conn);
        const from = schema.appliedSchemaVersion(conn);
        const newer = schema.newerSchema(conn);
        if (newer && !newer.accepted) throw new Error(`Schema v${newer.version} ist neuer als diese Version (v${newer.known})`);
        const report = schema.applySchema(conn, { log: require('../utils/logger').child('db') });
        quickCheck(conn);
        out(`Datenbank-Prüfung bestanden: Schema v${from} → v${schema.appliedSchemaVersion(conn)}, ${report.length} Migrationen an einer Kopie.`);
        return 0;
    } catch (err) {
        out(`Datenbank-Prüfung fehlgeschlagen: ${err && err.message ? err.message : err}`);
        return 1;
    } finally {
        try { if (conn) conn.close(); } catch (e) { /* closed */ }
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** True while another connection (the running server) holds the database open. */
function databaseInUse(dbPath) {
    if (!fs.existsSync(dbPath)) return false;
    const { DatabaseSync } = require('node:sqlite');
    let conn = null;
    try {
        conn = new DatabaseSync(dbPath);
        conn.exec('PRAGMA locking_mode = EXCLUSIVE;');
        conn.exec('BEGIN EXCLUSIVE;');
        conn.exec('COMMIT;');
        return false;
    } catch (err) {
        if (err && (err.errcode === 5 || err.errcode === 6)) return true;
        throw err;
    } finally {
        try { if (conn) conn.close(); } catch (e) { /* closed */ }
    }
}

function backupSource(file, backupsDir) {
    if (typeof file !== 'string' || !file.trim()) return null;
    const candidates = [path.resolve(file)];
    if (path.basename(file) === file) candidates.push(path.join(backupsDir, file));
    return candidates.find((candidate) => {
        try { return fs.statSync(candidate).isFile(); } catch (e) { return false; }
    }) || null;
}

/** Restores a backup ZIP into the data folder of a stopped server (pre-restore snapshot first); resolves 0 or 1. */
async function restoreOffline(file, { allowNewerSchema = false, out = defaultOut } = {}) {
    const dbm = require('../db');
    const scheduler = require('./scheduler');
    const source = backupSource(file, scheduler.backupsDir);
    if (!source) {
        out(`Backup nicht gefunden: ${file} (Pfad zur ZIP-Datei oder ein Name aus ${scheduler.backupsDir})`);
        return 1;
    }
    let copy = null;
    let release = null;
    try {
        dbm.closeDb();
        if (databaseInUse(dbm.dbPath)) {
            out('Die Datenbank ist geöffnet, der Server läuft also noch. Erst den Server stoppen, dann wiederherstellen.');
            return 1;
        }
        dbm.initDb({ allowNewerSchema: true });
        let zipPath = source;
        if (!source.startsWith(dbm.dataDir + path.sep)) {
            copy = path.join(dbm.tempDir, `restore-offline-${crypto.randomBytes(6).toString('hex')}.zip`);
            fs.copyFileSync(source, copy);
            zipPath = copy;
        } else if (path.dirname(source) === scheduler.backupsDir) {
            release = scheduler.holdSnapshot(path.basename(source));
        }
        const result = await require('./restore').restoreFromZip(zipPath, { allowNewerSchema });
        out(`Backup eingespielt: ${path.basename(source)} (${result.mangaCount} Manga-Reihen, ${result.restoredImagesCount} Bilddateien).`);
        if (result.preRestoreSnapshot) out(`Die Datenbank davor liegt als Sicherung in backups/${result.preRestoreSnapshot}.`);
        out('Alle Sitzungen sind beendet. Jetzt den Server starten.');
        return 0;
    } catch (err) {
        out(`Wiederherstellung fehlgeschlagen: ${err && err.message ? err.message : err}`);
        return 1;
    } finally {
        if (release) release();
        if (copy) fs.rmSync(copy, { force: true });
        dbm.closeDb();
    }
}

module.exports = { dbCheck, restoreOffline, databaseInUse };
