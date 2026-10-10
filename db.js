// SQLite connection of the server: opens the database, runs migrations (with a safety snapshot first) and exposes a
// reopenable proxy so a restore can swap the file under running code.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const log = require('./utils/logger').child('db');
const { config } = require('./utils/config');
const schema = require('./core/schema');
const { loadPublisherAliases } = require('./core/lib/publishers');
const { msg } = require('./core/errors');
const updateState = require('./services/update/state');

// DATA_DIR allows isolated data directories (tests, custom volume layouts); default: ./data
const dataDir = config.dataDir;
const uploadsDir = path.join(dataDir, 'uploads');
const tempDir = path.join(dataDir, 'temp');
for (const dir of [dataDir, uploadsDir, tempDir]) {
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
        if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
        log.error(`Datenordner ${dataDir} ist für uid ${process.getuid?.()} nicht beschreibbar (z. B. chown 1000:1000 ./data)`);
        process.exit(1);
    }
}

const dbPath = path.join(dataDir, 'manga.db');
const rollbackCopyPath = dbPath + '.bak';

let currentDb = null;
// bumped on every (re)open: a restore reopens the file and total_changes() starts again at 0 (utils/dataVersion.js)
let connectionGeneration = 0;
let lastMigrationReport = [];

const SAFETY_SNAPSHOT_PREFIX = 'vor-update';
// same variable as the pre-update category of services/scheduler.js
const safetySnapshotKeep = () => config.backupKeepPreUpdate;
const SAFETY_SNAPSHOT_TIME = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.zip$/;

/**
 * DB-only ZIP of the database before pending migrations run (backups/vor-update-v<from>-auf-v<to>-<ts>.zip).
 * Synchronous: it runs during initDb, before anything else uses the connection. The JWT secret is removed from the copy.
 */
function writePreMigrationSnapshot(conn, fromVersion, toVersion) {
    const AdmZip = require('adm-zip');
    const backupsDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const copy = path.join(tempDir, `vor-update-db-${Date.now()}-${Math.round(Math.random() * 1e9)}.db`);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${SAFETY_SNAPSHOT_PREFIX}-v${fromVersion}-auf-v${toVersion}-${timestamp}.zip`;
    const target = path.join(backupsDir, filename);
    try {
        conn.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
        const c = openRawDb(copy);
        try {
            c.exec('PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON;');
            if (c.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get()) {
                c.exec("DELETE FROM app_settings WHERE key = 'jwt_secret'");
            }
        } finally {
            c.close();
        }
        const zip = new AdmZip();
        zip.addLocalFile(copy, '', 'manga.db');
        fs.writeFileSync(target + '.part', zip.toBuffer());
        fs.renameSync(target + '.part', target);
    } catch (err) {
        try { fs.unlinkSync(target + '.part'); } catch (e) { /* never written */ }
        throw err;
    } finally {
        for (const suffix of ['', '-journal']) {
            try { fs.unlinkSync(copy + suffix); } catch (e) { /* not there */ }
        }
    }
    const held = updateState.heldBackup(dataDir);
    const older = fs.readdirSync(backupsDir)
        .filter(f => f.startsWith(SAFETY_SNAPSHOT_PREFIX + '-') && SAFETY_SNAPSHOT_TIME.test(f))
        .sort((a, b) => SAFETY_SNAPSHOT_TIME.exec(b)[1].localeCompare(SAFETY_SNAPSHOT_TIME.exec(a)[1]))
        .slice(safetySnapshotKeep())
        .filter(f => f !== held);
    for (const name of older) {
        try { fs.unlinkSync(path.join(backupsDir, name)); } catch (e) { log.warn(`[Database] Could not delete old safety snapshot ${name}:`, e.message); }
    }
    return filename;
}
/**
 * The safety snapshot before pending migrations run, only for a database that already has users. Without it the
 * start stops before the first migration (the database stays as it is) unless MIGRATE_WITHOUT_SNAPSHOT is set.
 */
function safetySnapshotBeforeMigrations(database, pending) {
    if (database.prepare('SELECT count(*) AS n FROM users').get().n === 0) return;
    const from = schema.appliedSchemaVersion(database);
    const to = pending[pending.length - 1].version;
    try {
        const started = process.hrtime.bigint();
        const name = writePreMigrationSnapshot(database, from, to);
        log.info(`[Database Migration] Sicherung vor dem Update: backups/${name} (${Math.round(Number(process.hrtime.bigint() - started) / 1e6)} ms)`);
    } catch (err) {
        if (config.migrateWithoutSnapshot) {
            log.error('[Database Migration] Sicherung vor dem Update fehlgeschlagen; MIGRATE_WITHOUT_SNAPSHOT ist gesetzt, die Migrationen laufen ohne diese Sicherung:', err);
            return;
        }
        const abort = new Error(`Die Sicherung vor dem Update (backups/${SAFETY_SNAPSHOT_PREFIX}-v${from}-auf-v${to}-….zip) ließ sich nicht schreiben (${err.message}). `
            + 'Die Datenbank wurde nicht verändert. Freien Speicher und Schreibrechte des Ordners backups/ prüfen und neu starten; '
            + 'wer bewusst ohne diese Sicherung aktualisieren will, startet einmal mit MIGRATE_WITHOUT_SNAPSHOT=1.');
        abort.code = 'PRE_UPDATE_SNAPSHOT_FAILED';
        abort.cause = err;
        throw abort;
    }
}

/** Base tables, default settings and all pending migrations (core/schema.js); safetySnapshot: write one first. */
function applySchema(conn, options = {}) {
    return schema.applySchema(conn, { log, beforeMigrations: options.safetySnapshot ? safetySnapshotBeforeMigrations : undefined });
}

/** Opens a SQLite file with node:sqlite (Node >= 22.13 without flag) or better-sqlite3 as fallback. */
function openRawDb(file, options = {}) {
    try {
        const { DatabaseSync } = require('node:sqlite');
        return new DatabaseSync(file, options.readOnly ? { readOnly: true } : {});
    } catch (e) {
        if (e && e.code !== 'MODULE_NOT_FOUND' && e.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw e;
        let Database;
        try {
            Database = require('better-sqlite3');
        } catch (fallbackErr) {
            if (fallbackErr && fallbackErr.code !== 'MODULE_NOT_FOUND') throw fallbackErr;
            // e.g. a Pterodactyl egg still on Node 20: say what to change instead of "Cannot find module"
            throw new Error(`Node.js ${process.versions.node} hat kein eingebautes node:sqlite. Manga Shelf braucht Node.js 22.13 oder neuer (im Pterodactyl-Panel unter Startup das Docker-Image "Node.js 22" wählen).`);
        }
        return new Database(file, options.readOnly ? { readonly: true } : {});
    }
}

/** 400 for an uploaded database; `reason` is a msg() or SQLite's own text (both reach the client nested). */
function invalidDbFile(reason) {
    const text = msg('Ungültige Backup-Datenbank: {reason}', { reason });
    const invalid = new Error(text.text);
    invalid.status = 400; // the uploaded file is at fault, not the server
    invalid.extra = { msg: text.template, params: text.params };
    return invalid;
}

/** What makes an open SQLite file unusable as a Manga Shelf database (a msg()), or null. */
function dbFileProblem(probe) {
    const check = probe.prepare('PRAGMA integrity_check').get();
    const result = check && Object.values(check)[0];
    if (result !== 'ok') return msg('Integritätsprüfung fehlgeschlagen: {result}', { result });
    const tables = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
    for (const t of ['users', 'mangas', 'volumes']) {
        if (!tables.has(t)) return msg('Tabelle "{table}" fehlt in der Datenbank', { table: t });
    }
    const admins = probe.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin'").get();
    if (!admins || admins.count < 1) return msg('Die Datenbank enthält keinen Administrator');
    return null;
}

/**
 * Verifies that a SQLite file is intact and looks like a Manga Shelf database
 * (integrity_check, required tables, at least one admin). Throws a descriptive Error otherwise.
 */
function validateDbFile(file) {
    let probe;
    let problem = null;
    try {
        probe = openRawDb(file, { readOnly: true });
        problem = dbFileProblem(probe);
    } catch (err) {
        problem = err.message;
    } finally {
        try { probe && probe.close(); } catch (e) { /* ignore */ }
    }
    if (problem !== null) throw invalidDbFile(problem);
}


/**
 * Brings a staged restore file to the current schema on its own connection, so a backup that cannot be
 * migrated is rejected before it replaces the live database. Leaves no -wal/-shm next to the file.
 */
function migrateDbFile(file) {
    let conn;
    try {
        conn = openRawDb(file);
        conn.exec('PRAGMA journal_mode = DELETE;');
        applySchema(conn);
    } catch (err) {
        throw invalidDbFile(msg('Migration fehlgeschlagen: {cause}', { cause: err.message }));
    } finally {
        try { conn && conn.close(); } catch (e) { /* ignore */ }
        for (const suffix of ['-wal', '-shm']) {
            try { fs.unlinkSync(file + suffix); } catch (e) { /* not there */ }
        }
    }
}

/**
 * A failed restore rollback leaves the previous database as manga.db.bak. If manga.db is then missing or empty,
 * opening it would create an empty database and offer the setup again instead of pointing at the copy.
 */
function assertNoPendingRollbackCopy() {
    if (!fs.existsSync(rollbackCopyPath)) return;
    let size = 0;
    try { size = fs.statSync(dbPath).size; } catch (e) { /* missing */ }
    if (size > 0) return;
    const err = new Error(`Die Datenbank ${dbPath} fehlt oder ist leer, aber ${rollbackCopyPath} existiert (Sicherung einer fehlgeschlagenen Wiederherstellung). Es wird keine neue, leere Datenbank angelegt: Server stoppen, manga.db.bak nach manga.db kopieren und neu starten (oder manga.db.bak löschen, um wirklich neu zu beginnen).`);
    err.code = 'DB_ROLLBACK_COPY_PENDING';
    throw err;
}

// Lets the apps recognise this server when its address changes (GET /api/health); not secret. It travels with the
// database, and a restored backup that has none keeps the id that was live before.
let instanceId = null;
function ensureInstanceId(conn) {
    try {
        const row = conn.prepare("SELECT value FROM app_settings WHERE key = 'instance_id'").get();
        if (row && row.value) {
            instanceId = row.value;
            return;
        }
        instanceId = instanceId || crypto.randomUUID();
        conn.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('instance_id', ?)").run(instanceId);
    } catch (err) {
        log.warn('[Database] instance_id could not be stored:', err.message);
    }
}

const EXIT_SCHEMA_NEWER = 78;
const allowNewerFromEnv = () => /^(true|1|yes|on|ja)$/i.test(String(process.env.ALLOW_NEWER_SCHEMA || '').trim());

function schemaNewerWayBack() {
    const backups = path.join(dataDir, 'backups');
    if (process.env.P_SERVER_UUID) {
        return 'Zurück zu dieser Version im Panel (ein gestoppter Server hat keine Shell): im Dateimanager in die Datei '
            + `${path.join(process.cwd(), '.env')} die Zeile ALLOW_NEWER_SCHEMA=1 eintragen, den Server starten, sofort im Dialog `
            + `"Backups" das Backup von vor dem Update (vor-update-…zip aus ${backups}) wiederherstellen, vorher nichts ändern, `
            + 'und die Zeile danach wieder entfernen.';
    }
    return 'Zurück zu dieser Version: bei gestopptem Server das Backup von vor dem Update einspielen, mit '
        + '"manga-shelf-server restore <backup.zip>" (Binärdatei) bzw. "node scripts/admin.js wiederherstellen <backup.zip>" '
        + `(die Backups liegen in ${backups}). Nur wenn sicher ist, dass diese Version mit der neueren Datenbank arbeiten kann: `
        + 'einmal mit ALLOW_NEWER_SCHEMA=1 starten.';
}

function schemaNewerError({ version, known }) {
    const err = new Error(`Die Datenbank ${dbPath} hat Schema v${version} und stammt aus einer neueren Version von Manga Shelf `
        + `(diese Version kennt Schema bis v${known}); sie wird nicht geöffnet. Zurück zur neueren Version: diese wieder installieren und starten. `
        + schemaNewerWayBack());
    err.code = 'SCHEMA_NEWER';
    err.exitCode = EXIT_SCHEMA_NEWER;
    return err;
}

function checkNewerSchema(conn, allowNewerSchema) {
    const newer = schema.newerSchema(conn);
    if (!newer || allowNewerSchema) return;
    if (newer.accepted) {
        log.warn(`[Database] Schema v${newer.version} ist neuer als diese Version (v${newer.known}); bei der Wiederherstellung bestätigt, die Datenbank wird geöffnet.`);
        return;
    }
    if (allowNewerFromEnv()) {
        log.warn(`[Database] Schema v${newer.version} ist neuer als diese Version (v${newer.known}); ALLOW_NEWER_SCHEMA ist gesetzt, die Datenbank wird trotzdem geöffnet. Die Variable danach wieder entfernen.`);
        return;
    }
    throw schemaNewerError(newer);
}

// (Re)opens the live database; currentDb is only assigned once schema and migrations succeeded, so a failed init is retried on next access.
function initDb({ allowNewerSchema = false } = {}) {
    closeDb();
    assertNoPendingRollbackCopy();

    const conn = openRawDb(dbPath);
    try {
        conn.exec('PRAGMA journal_mode = WAL;');
        // recommended with WAL: a crash of the app loses nothing, a power cut at most the last commits; no corruption
        conn.exec('PRAGMA synchronous = NORMAL;');
        conn.exec('PRAGMA foreign_keys = ON;');
        checkNewerSchema(conn, allowNewerSchema);
        lastMigrationReport = applySchema(conn, { safetySnapshot: true });
    } catch (err) {
        // Running on with a half-migrated schema only fails later with unclear SQL errors: stop here with the real cause
        if (err.code !== 'SCHEMA_NEWER') log.error('[Database] Opening the database failed:', err);
        try { conn.close(); } catch (e) { /* ignore */ }
        throw err;
    }
    ensureInstanceId(conn);
    loadPublisherAliases(conn);
    currentDb = conn;
    connectionGeneration++;
    return currentDb;
}

function closeDb() {
    if (!currentDb) return;
    const conn = currentDb;
    currentDb = null;
    try {
        conn.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (e) { log.warn('WAL checkpoint before close failed:', e.message); }
    try {
        conn.close();
    } catch (e) { log.warn('Closing the database failed:', e.message); }
}

try {
    initDb();
} catch (err) {
    if (err.code !== 'SCHEMA_NEWER') throw err;
}

/** The live connection, opened when it is not open yet (throws SCHEMA_NEWER for a refused database). */
function ensureDbOpen() {
    if (!currentDb) initDb();
    return currentDb;
}

/**
 * Runs fn inside one SQLite transaction (BEGIN IMMEDIATE; rollback on error). fn MUST be synchronous:
 * with a single connection, awaiting inside would let unrelated requests run in the transaction.
 */
function runTransaction(fn) {
    if (!currentDb) initDb();
    const conn = currentDb;
    conn.exec('BEGIN IMMEDIATE;');
    try {
        const result = fn(conn);
        if (result && typeof result.then === 'function') {
            result.then(null, () => {});
            // the callback's synchronous part is rolled back; whatever it does after its first await runs outside any transaction
            throw new Error('runTransaction: asynchrone Callbacks sind nicht erlaubt');
        }
        conn.exec('COMMIT;');
        return result;
    } catch (err) {
        try { conn.exec('ROLLBACK;'); } catch (rbErr) { log.warn('ROLLBACK failed:', rbErr.message); }
        throw err;
    }
}

const db = new Proxy({}, {
    get(target, prop) {
        if (!currentDb) {
            initDb();
        }
        const val = currentDb[prop];
        if (typeof val === 'function') {
            return val.bind(currentDb);
        }
        return val;
    }
});

// --- ctx for core/ (core/ctx.js): this connection, data/uploads, outbound HTTP with the server's safety rules ---

const serverDb = {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    transaction: runTransaction,
    generation: () => connectionGeneration
};

function uploadPath(name) {
    const text = String(name);
    if (!text || text === '.' || text === '..' || /[/\\\0]/.test(text)) throw new Error('Ungültiger Dateiname');
    return path.join(uploadsDir, text);
}

const serverFiles = {
    async write(name, bytes, options = {}) {
        const data = options.image ? require('./utils/imageMeta').stripImageMetadata(bytes, options.image) : bytes;
        await fs.promises.writeFile(uploadPath(name), data);
    },
    read: (name) => fs.promises.readFile(uploadPath(name)),
    async stat(name) {
        try {
            const st = await fs.promises.stat(uploadPath(name));
            return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
        } catch (e) {
            return null;
        }
    },
    async touch(name) {
        const now = new Date();
        await fs.promises.utimes(uploadPath(name), now, now);
    },
    remove: (name) => fs.promises.rm(uploadPath(name), { force: true }),
    list: () => fs.promises.readdir(uploadsDir)
};

// looked up at call time: tests replace global.fetch
const serverHttp = {
    fetch: (url, init) => globalThis.fetch(url, init),
    fetchText: (url, timeoutMs) => require('./services/isbnLookup').fetchTextHttps(url, timeoutMs),
    fetchImage: (url) => require('./utils/safeFetch').fetchRemoteImage(url)
};

/** ctx of core/ on the server; `extra` adds the caller (user) and request parts (signal, limit). */
function createCtx(extra = {}) {
    return require('./core/ctx').createCtx({
        db: serverDb,
        files: serverFiles,
        http: serverHttp,
        log: require('./utils/logger'),
        // read on access: the variables may change at run time (console, tests)
        config: { get appTimeZone() { return config.appTimeZone; }, appVersion: require('./package.json').version },
        randomId: () => crypto.randomUUID(),
        yield: () => new Promise(resolve => setImmediate(resolve)),
        ...extra
    });
}

function hasAdmin() {
    const row = db.prepare('SELECT count(*) as count FROM users WHERE role = ?').get('admin');
    return row && row.count > 0;
}

module.exports = {
    db,
    initDb,
    ensureDbOpen,
    closeDb,
    hasAdmin,
    uploadsDir,
    dataDir,
    dbPath,
    tempDir,
    runTransaction,
    withTransaction: runTransaction,
    validateDbFile,
    migrateDbFile,
    openRawDb,
    pendingMigrations: (database) => schema.pendingMigrations(database, log),
    LATEST_SCHEMA_VERSION: schema.LATEST_SCHEMA_VERSION,
    getConnectionGeneration: () => connectionGeneration,
    getInstanceId: () => instanceId,
    getLastMigrationReport: () => lastMigrationReport,
    createCtx
};
