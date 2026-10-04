const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const log = require('./utils/logger').child('db');
const { config } = require('./utils/config');

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

const USERNAME_INDEX_MIGRATION = 14;

/**
 * Login and user management compare usernames case-insensitively; this index enforces it in the schema.
 * Existing case duplicates (old or restored databases) are reported, never renamed: the index is skipped and
 * retried on every start until an admin has resolved them.
 */
function ensureUsernameNocaseIndex(d) {
    if (d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_username_nocase'").get()) return true;
    const duplicates = d.prepare("SELECT group_concat(username, ', ') AS names FROM users GROUP BY lower(username) HAVING count(*) > 1").all();
    if (duplicates.length) {
        log.warn(`[Database] Usernames differ only in case (${duplicates.map(r => r.names).join('; ')}); the case-insensitive unique index is skipped until they are renamed or deleted.`);
        return false;
    }
    try {
        d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users (username COLLATE NOCASE);');
        return true;
    } catch (e) {
        log.warn('[Database] Creating the case-insensitive username index failed:', e);
        return false;
    }
}

/** Retries the username index of an earlier start that found duplicates (the migration itself only runs once). */
function retryUsernameNocaseIndex(d) {
    const tracked = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (tracked && d.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(USERNAME_INDEX_MIGRATION)) ensureUsernameNocaseIndex(d);
}

// Numeric value of a volume number as the routes used to compute it at query time ("Band 12" = 12, "12.5" = 12.5,
// labels NULL). Frozen: migration 15 backfills with it and its triggers keep it; never change shipped SQL.
const numberSortExpr = (col) => {
    const n = `TRIM(REPLACE(REPLACE(COALESCE(${col}, ''), 'Band ', ''), 'band ', ''))`;
    return `CASE WHEN ${n} GLOB '[0-9]*' AND ${n} NOT GLOB '*[^0-9.]*' THEN CAST(${n} AS REAL) ELSE NULL END`;
};

/** All schema migrations in order. New ones are appended; shipped ones never change. */
function migrationList() {
    return [
        {
            version: 1,
            name: 'add_manga_and_volume_columns',
            up: (d) => {
                const mangaCols = d.prepare("PRAGMA table_info(mangas)").all();
                const mangaColNames = new Set(mangaCols.map(c => c.name));
                if (!mangaColNames.has('manga_passion_id')) d.exec('ALTER TABLE mangas ADD COLUMN manga_passion_id INTEGER DEFAULT NULL;');
                if (!mangaColNames.has('manga_passion_edition_data')) d.exec('ALTER TABLE mangas ADD COLUMN manga_passion_edition_data TEXT DEFAULT NULL;');

                const volCols = d.prepare("PRAGMA table_info(volumes)").all();
                const volColNames = new Set(volCols.map(c => c.name));
                if (!volColNames.has('price')) d.exec('ALTER TABLE volumes ADD COLUMN price REAL DEFAULT NULL;');
                if (!volColNames.has('release_date')) d.exec('ALTER TABLE volumes ADD COLUMN release_date TEXT DEFAULT NULL;');
                if (!volColNames.has('release_year')) d.exec('ALTER TABLE volumes ADD COLUMN release_year INTEGER DEFAULT NULL;');
                if (!volColNames.has('condition')) d.exec('ALTER TABLE volumes ADD COLUMN condition TEXT DEFAULT NULL;');
                if (!volColNames.has('pages')) d.exec('ALTER TABLE volumes ADD COLUMN pages INTEGER DEFAULT NULL;');
                if (!volColNames.has('publisher')) d.exec('ALTER TABLE volumes ADD COLUMN publisher TEXT DEFAULT NULL;');
                if (!volColNames.has('cover_image')) d.exec('ALTER TABLE volumes ADD COLUMN cover_image TEXT DEFAULT NULL;');
                if (!volColNames.has('images')) d.exec('ALTER TABLE volumes ADD COLUMN images TEXT DEFAULT NULL;');
                if (!volColNames.has('type')) d.exec("ALTER TABLE volumes ADD COLUMN type TEXT DEFAULT 'volume';");
                if (!volColNames.has('manga_passion_volume_id')) d.exec('ALTER TABLE volumes ADD COLUMN manga_passion_volume_id INTEGER DEFAULT NULL;');
            }
        },
        {
            version: 2,
            name: 'normalize_volume_types_and_publishers',
            up: (d) => {
                // One Piece Schuber migration
                d.exec(`
                    UPDATE volumes 
                    SET type = 'schuber', 
                        volume_number = REPLACE(volume_number, 'Special', 'Schuber') 
                    WHERE manga_id IN (SELECT id FROM mangas WHERE title LIKE '%One Piece%') 
                      AND (volume_number LIKE 'Special%' OR (notes IS NOT NULL AND notes LIKE '%Schuber%'));
                `);

                // Schuber in volume_number
                d.exec(`
                    UPDATE volumes 
                    SET type = 'schuber' 
                    WHERE volume_number LIKE 'Schuber%' AND (type IS NULL OR type = 'volume');
                `);

                // Specials / Extras
                d.exec(`
                    UPDATE volumes 
                    SET type = 'special' 
                    WHERE (volume_number LIKE 'Special%' OR volume_number LIKE 'Extra%' OR volume_number LIKE 'Sonderband%') 
                      AND (type IS NULL OR type = 'volume');
                `);

                // Special / Limited Editions
                d.exec(`
                    UPDATE volumes 
                    SET type = 'special_edition' 
                    WHERE (volume_number LIKE '%special edition%' OR volume_number LIKE '%limited edition%' OR (notes IS NOT NULL AND (notes LIKE '%special edition%' OR notes LIKE '%limited edition%'))) 
                      AND (type IS NULL OR type = 'volume' OR type = 'special');
                `);

                // Normalize publisher casings
                d.exec(`
                    UPDATE mangas SET publisher = 'Kazé Manga' WHERE publisher = 'kazé Manga';
                    UPDATE mangas SET publisher = 'Manga Cult' WHERE publisher = 'manga Cult';
                    UPDATE mangas SET publisher = 'Panini Verlags GmbH' WHERE publisher = 'Panini Verlag GmbH';
                    UPDATE mangas SET publisher = 'Papertoons' WHERE publisher = 'papertoons';

                    UPDATE volumes SET publisher = 'Kazé Manga' WHERE publisher = 'kazé Manga';
                    UPDATE volumes SET publisher = 'Manga Cult' WHERE publisher = 'manga Cult';
                    UPDATE volumes SET publisher = 'Panini Verlags GmbH' WHERE publisher = 'Panini Verlag GmbH';
                    UPDATE volumes SET publisher = 'Papertoons' WHERE publisher = 'papertoons';
                `);
            }
        },
        {
            version: 3,
            name: 'add_explicit_performance_indices',
            up: (d) => {
                d.exec(`
                    CREATE INDEX IF NOT EXISTS idx_volumes_manga_id ON volumes (manga_id);
                    CREATE INDEX IF NOT EXISTS idx_volumes_status ON volumes (status);
                    CREATE INDEX IF NOT EXISTS idx_volume_reads_user ON volume_reads (user_id);
                    CREATE INDEX IF NOT EXISTS idx_volume_reads_vol ON volume_reads (volume_id);
                    CREATE INDEX IF NOT EXISTS idx_mangas_passion_id ON mangas (manga_passion_id);
                `);
            }
        },
        {
            version: 4,
            name: 'normalize_manga_passion_publisher_names',
            up: (d) => {
                // Series/volumes created from Manga Passion carry names like "Carlsen Manga!" / "Panini Manga"
                const { normalizePublisher } = require('./utils/publishers');
                for (const table of ['mangas', 'volumes']) {
                    const rows = d.prepare(`SELECT DISTINCT publisher FROM ${table} WHERE publisher IS NOT NULL AND TRIM(publisher) != ''`).all();
                    const update = d.prepare(`UPDATE ${table} SET publisher = ? WHERE publisher = ?`);
                    for (const { publisher } of rows) {
                        const normalized = normalizePublisher(publisher);
                        if (normalized && normalized !== publisher) update.run(normalized, publisher);
                    }
                }
            }
        },
        {
            version: 5,
            name: 'normalize_isbn_format',
            up: (d) => {
                // hyphenated / ISBN-10 values -> canonical digits-only ISBN-13 (same form barcode scans produce)
                const { normalizeIsbn } = require('./utils/isbn');
                const rows = d.prepare("SELECT id, isbn FROM volumes WHERE isbn IS NOT NULL AND TRIM(isbn) != ''").all();
                const update = d.prepare('UPDATE volumes SET isbn = ? WHERE id = ?');
                for (const { id, isbn } of rows) {
                    const normalized = normalizeIsbn(isbn);
                    if (normalized && normalized !== isbn) update.run(normalized, id);
                }
            }
        },
        {
            version: 6,
            name: 'clean_labelled_volume_numbers',
            up: (d) => {
                // Older versions imported gaps under their UI label ("4 (Wolf im Schafspelz)") instead of the number "4".
                const rows = d.prepare("SELECT id, manga_id, volume_number, notes FROM volumes WHERE COALESCE(type, 'volume') = 'volume' AND volume_number GLOB '[0-9]* (*)'").all();
                const taken = d.prepare("SELECT 1 FROM volumes WHERE manga_id = ? AND volume_number = ? AND COALESCE(type, 'volume') = 'volume'");
                const update = d.prepare('UPDATE volumes SET volume_number = ?, notes = COALESCE(notes, ?) WHERE id = ?');
                for (const row of rows) {
                    const match = String(row.volume_number).match(/^(\d+)\s*\((.+)\)\s*$/);
                    if (!match) continue;
                    if (taken.get(row.manga_id, match[1])) continue; // a clean volume with that number exists: leave both alone
                    update.run(match[1], match[2].trim(), row.id);
                }
            }
        },
        {
            version: 7,
            name: 'drop_placeholder_release_dates',
            up: (d) => {
                // Manga Passion's "date not announced" placeholder (2999-12-31) was stored as a real date and ended up in the radar
                d.exec("UPDATE volumes SET release_date = NULL WHERE release_date IS NOT NULL AND CAST(SUBSTR(release_date, 1, 4) AS INTEGER) >= 2100;");
            }
        },
        {
            version: 8,
            name: 'strip_band_prefix_from_volume_numbers',
            up: (d) => {
                // Some collections store regular volumes as "Band 14" while the official lists (and gap detection) use "14"
                const rows = d.prepare("SELECT id, manga_id, volume_number FROM volumes WHERE COALESCE(type, 'volume') = 'volume' AND LOWER(volume_number) LIKE 'band %'").all();
                const taken = d.prepare("SELECT 1 FROM volumes WHERE manga_id = ? AND volume_number = ? AND COALESCE(type, 'volume') = 'volume'");
                const update = d.prepare('UPDATE volumes SET volume_number = ? WHERE id = ?');
                for (const row of rows) {
                    const match = String(row.volume_number).trim().match(/^band\s+(\d+)$/i);
                    if (!match || taken.get(row.manga_id, match[1])) continue;
                    update.run(match[1], row.id);
                }
            }
        },
        {
            version: 9,
            name: 'add_users_password_changed_at',
            up: (d) => {
                // A password change ends older sessions: tokens issued before this moment are rejected (middleware/auth.js)
                const cols = new Set(d.prepare('PRAGMA table_info(users)').all().map(c => c.name));
                if (!cols.has('password_changed_at')) d.exec('ALTER TABLE users ADD COLUMN password_changed_at INTEGER DEFAULT NULL;');
            }
        },
        {
            version: 10,
            name: 'add_volumes_priority_target_price',
            up: (d) => {
                // Wunschliste: Priorität (0 keine, 1 niedrig, 2 mittel, 3 hoch) und Zielpreis für Käufe im Laden
                const cols = new Set(d.prepare('PRAGMA table_info(volumes)').all().map(c => c.name));
                if (!cols.has('priority')) d.exec('ALTER TABLE volumes ADD COLUMN priority INTEGER DEFAULT 0;');
                if (!cols.has('target_price')) d.exec('ALTER TABLE volumes ADD COLUMN target_price REAL DEFAULT NULL;');
            }
        },
        {
            version: 11,
            name: 'add_volume_owners',
            up: (d) => {
                // Besitz pro Benutzer: mehrere Personen können denselben Band besitzen. volumes.status = 'Vorhanden' bleibt
                // "mindestens ein Besitzer"; bestehende Bände werden dem ältesten Admin zugeordnet.
                d.exec(`
                    CREATE TABLE IF NOT EXISTS volume_owners (
                        volume_id INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        price REAL,
                        purchase_date TEXT,
                        condition TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (volume_id, user_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_volume_owners_user ON volume_owners (user_id);
                `);
                const owner = d.prepare("SELECT id FROM users ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, id LIMIT 1").get();
                if (owner) {
                    d.prepare(`
                        INSERT OR IGNORE INTO volume_owners (volume_id, user_id, price, purchase_date, condition)
                        SELECT id, ?, price, purchase_date, condition FROM volumes WHERE status = 'Vorhanden'
                    `).run(owner.id);
                }
            }
        },
        {
            version: 12,
            name: 'index_volumes_isbn_drop_redundant_reads_index',
            up: (d) => {
                // the volume_reads primary key (volume_id, user_id) already serves volume_id lookups
                d.exec(`
                    CREATE INDEX IF NOT EXISTS idx_volumes_isbn ON volumes (isbn);
                    DROP INDEX IF EXISTS idx_volume_reads_vol;
                `);
            }
        },
        {
            version: 13,
            name: 'convert_legacy_gelesen_status',
            up: (d) => {
                const converted = require('./utils/owners').migrateLegacyReadStatus(d);
                if (converted) log.info(`[Database Migration] Converted ${converted} volumes with legacy status 'Gelesen' to 'Vorhanden' plus a read entry`);
            }
        },
        {
            version: USERNAME_INDEX_MIGRATION,
            name: 'users_username_nocase_unique',
            up: (d) => { ensureUsernameNocaseIndex(d); }
        },
        {
            version: 15,
            name: 'add_volumes_number_sort',
            up: (d) => {
                const cols = new Set(d.prepare('PRAGMA table_info(volumes)').all().map(c => c.name));
                if (!cols.has('number_sort')) d.exec('ALTER TABLE volumes ADD COLUMN number_sort REAL;');
                d.exec(`
                    CREATE TRIGGER IF NOT EXISTS trg_volumes_number_sort_ins AFTER INSERT ON volumes BEGIN
                        UPDATE volumes SET number_sort = ${numberSortExpr('NEW.volume_number')} WHERE id = NEW.id;
                    END;
                    CREATE TRIGGER IF NOT EXISTS trg_volumes_number_sort_upd AFTER UPDATE OF volume_number ON volumes BEGIN
                        UPDATE volumes SET number_sort = ${numberSortExpr('NEW.volume_number')} WHERE id = NEW.id;
                    END;
                    UPDATE volumes SET number_sort = ${numberSortExpr('volume_number')};
                    CREATE INDEX IF NOT EXISTS idx_volumes_manga_number ON volumes (manga_id, type, number_sort);
                `);
            }
        },
        {
            version: 16,
            name: 'maintain_mangas_owned_volumes_by_triggers',
            up: (d) => {
                d.exec(`
                    CREATE TRIGGER IF NOT EXISTS trg_volumes_owned_ins AFTER INSERT ON volumes WHEN NEW.status = 'Vorhanden' BEGIN
                        UPDATE mangas SET owned_volumes = COALESCE(owned_volumes, 0) + 1 WHERE id = NEW.manga_id;
                    END;
                    CREATE TRIGGER IF NOT EXISTS trg_volumes_owned_del AFTER DELETE ON volumes WHEN OLD.status = 'Vorhanden' BEGIN
                        UPDATE mangas SET owned_volumes = COALESCE(owned_volumes, 0) - 1 WHERE id = OLD.manga_id;
                    END;
                    CREATE TRIGGER IF NOT EXISTS trg_volumes_owned_upd AFTER UPDATE OF status, manga_id ON volumes
                    WHEN (OLD.status IS 'Vorhanden') != (NEW.status IS 'Vorhanden') OR OLD.manga_id != NEW.manga_id BEGIN
                        UPDATE mangas SET owned_volumes = COALESCE(owned_volumes, 0) - (OLD.status IS 'Vorhanden') WHERE id = OLD.manga_id;
                        UPDATE mangas SET owned_volumes = COALESCE(owned_volumes, 0) + (NEW.status IS 'Vorhanden') WHERE id = NEW.manga_id;
                    END;
                    UPDATE mangas SET owned_volumes = (SELECT count(*) FROM volumes v WHERE v.manga_id = mangas.id AND v.status = 'Vorhanden');
                `);
            }
        }
    ];
}

const LATEST_SCHEMA_VERSION = Math.max(...migrationList().map(m => m.version));

function ensureMigrationsTable(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

/** Migrations not yet recorded in schema_migrations (all of them for a database without that table). */
function pendingMigrations(database) {
    const tracked = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    const applied = new Set(tracked ? database.prepare('SELECT version FROM schema_migrations').all().map(r => r.version) : []);
    return migrationList().filter(m => !applied.has(m.version));
}

function appliedSchemaVersion(database) {
    const tracked = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    return tracked ? (database.prepare('SELECT max(version) AS v FROM schema_migrations').get()?.v || 0) : 0;
}

const SAFETY_SNAPSHOT_PREFIX = 'vor-update';
// same variable as the pre-update category of services/scheduler.js
const safetySnapshotKeep = () => config.backupKeepPreUpdate;
const SAFETY_SNAPSHOT_TIME = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.zip$/;

/**
 * DB-only ZIP of the database as it is before pending migrations run (backups/vor-update-v<from>-auf-v<to>-<ts>.zip),
 * restorable like any snapshot. Synchronous: it runs during initDb, before anything else uses the connection.
 * The generated JWT secret is removed from the copy, as in services/scheduler.js copyDatabaseToTemp().
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
    const older = fs.readdirSync(backupsDir)
        .filter(f => f.startsWith(SAFETY_SNAPSHOT_PREFIX + '-') && SAFETY_SNAPSHOT_TIME.test(f))
        .sort((a, b) => SAFETY_SNAPSHOT_TIME.exec(b)[1].localeCompare(SAFETY_SNAPSHOT_TIME.exec(a)[1]))
        .slice(safetySnapshotKeep());
    for (const name of older) {
        try { fs.unlinkSync(path.join(backupsDir, name)); } catch (e) { log.warn(`[Database] Could not delete old safety snapshot ${name}:`, e.message); }
    }
    return filename;
}

/**
 * Applies pending migrations, each in its own transaction, and returns what ran: [{ version, name, changes, ms }].
 * options.safetySnapshot: write a DB-only snapshot first when something is pending and the database has users.
 */
function runSequentialMigrations(database, options = {}) {
    const pending = pendingMigrations(database);
    ensureMigrationsTable(database);
    if (!pending.length) return [];

    if (options.safetySnapshot && database.prepare('SELECT count(*) AS n FROM users').get().n > 0) {
        const from = appliedSchemaVersion(database);
        const to = pending[pending.length - 1].version;
        try {
            const started = process.hrtime.bigint();
            const name = writePreMigrationSnapshot(database, from, to);
            log.info(`[Database Migration] Sicherung vor dem Update: backups/${name} (${Math.round(Number(process.hrtime.bigint() - started) / 1e6)} ms)`);
        } catch (err) {
            log.error('[Database Migration] Sicherung vor dem Update fehlgeschlagen, die Migrationen laufen trotzdem (letzter täglicher Snapshot in backups/):', err);
        }
    }

    const totalChanges = () => database.prepare('SELECT total_changes() AS n').get().n;
    const report = [];
    for (const mig of pending) {
        const started = process.hrtime.bigint();
        const changesBefore = totalChanges();
        database.exec('BEGIN TRANSACTION;');
        try {
            mig.up(database);
            database.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(mig.version, mig.name);
            database.exec('COMMIT;');
        } catch (err) {
            try { database.exec('ROLLBACK;'); } catch (rbErr) { log.warn('[Database Migration] ROLLBACK failed:', rbErr.message); }
            log.error(`[Database Migration] Failed migration v${mig.version} (${mig.name}):`, err);
            throw err;
        }
        // minus the schema_migrations row itself
        const entry = { version: mig.version, name: mig.name, changes: totalChanges() - changesBefore - 1, ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6) };
        report.push(entry);
        log.info(`[Database Migration] v${entry.version} ${entry.name}: ${entry.changes.toLocaleString('de-DE')} Zeilen geändert, ${entry.ms} ms`);
    }
    return report;
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

/**
 * Verifies that a SQLite file is intact and looks like a Manga Shelf database
 * (integrity_check, required tables, at least one admin). Throws a descriptive Error otherwise.
 */
function validateDbFile(file) {
    let probe;
    try {
        probe = openRawDb(file, { readOnly: true });
        const check = probe.prepare('PRAGMA integrity_check').get();
        const result = check && Object.values(check)[0];
        if (result !== 'ok') throw new Error('Integritätsprüfung fehlgeschlagen: ' + result);
        const tables = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
        for (const t of ['users', 'mangas', 'volumes']) {
            if (!tables.has(t)) throw new Error(`Tabelle "${t}" fehlt in der Datenbank`);
        }
        const admins = probe.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin'").get();
        if (!admins || admins.count < 1) throw new Error('Die Datenbank enthält keinen Administrator');
    } catch (err) {
        const invalid = new Error('Ungültige Backup-Datenbank: ' + err.message);
        invalid.status = 400; // the uploaded file is at fault, not the server
        throw invalid;
    } finally {
        try { probe && probe.close(); } catch (e) { /* ignore */ }
    }
}

/** Base tables, default settings and all pending migrations on an open connection (live DB or a staged restore). */
function applySchema(conn, options = {}) {
    conn.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'editor',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS mangas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            alt_title TEXT,
            author TEXT,
            publisher TEXT,
            language TEXT,
            status TEXT,
            tags TEXT,
            total_volumes INTEGER,
            owned_volumes INTEGER DEFAULT 0,
            description TEXT,
            cover_image TEXT,
            banner_image TEXT,
            manga_passion_id INTEGER DEFAULT NULL,
            manga_passion_edition_data TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_by INTEGER,
            FOREIGN KEY (updated_by) REFERENCES users (id)
        );

        CREATE TABLE IF NOT EXISTS volumes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            manga_id INTEGER NOT NULL,
            volume_number TEXT NOT NULL,
            isbn TEXT,
            price REAL,
            release_date TEXT,
            release_year INTEGER,
            condition TEXT,
            pages INTEGER,
            publisher TEXT,
            purchase_date TEXT,
            status TEXT,
            notes TEXT,
            cover_image TEXT,
            images TEXT,
            type TEXT DEFAULT 'volume',
            priority INTEGER DEFAULT 0,
            target_price REAL,
            manga_passion_volume_id INTEGER DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (manga_id) REFERENCES mangas (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS volume_reads (
            volume_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (volume_id, user_id),
            FOREIGN KEY (volume_id) REFERENCES volumes (id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS manga_passion_cache (
            cache_key TEXT PRIMARY KEY,
            json_data TEXT,
            created_at INTEGER
        );
    `);

    try {
        conn.exec("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('collection_start_date', '2021-04-09');");
    } catch (e) { log.warn('Seeding collection_start_date failed:', e.message); }

    // before the migrations, so a first run that skips the index does not warn twice
    retryUsernameNocaseIndex(conn);
    return runSequentialMigrations(conn, options);
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
        const invalid = new Error('Ungültige Backup-Datenbank: Migration fehlgeschlagen: ' + err.message);
        invalid.status = 400;
        throw invalid;
    } finally {
        try { conn && conn.close(); } catch (e) { /* ignore */ }
        for (const suffix of ['-wal', '-shm']) {
            try { fs.unlinkSync(file + suffix); } catch (e) { /* not there */ }
        }
    }
}

/**
 * (Re)opens the live database. currentDb is only assigned once schema and migrations succeeded, so a failed
 * init never leaves a half-migrated or closed handle behind: the proxy simply tries again on the next access.
 */
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

function initDb() {
    closeDb();
    assertNoPendingRollbackCopy();

    const conn = openRawDb(dbPath);
    try {
        conn.exec('PRAGMA journal_mode = WAL;');
        // recommended with WAL: a crash of the app loses nothing, a power cut at most the last commits; no corruption
        conn.exec('PRAGMA synchronous = NORMAL;');
        conn.exec('PRAGMA foreign_keys = ON;');
        lastMigrationReport = applySchema(conn, { safetySnapshot: true });
    } catch (err) {
        // Running on with a half-migrated schema only fails later with unclear SQL errors: stop here with the real cause
        log.error('[Database] Opening the database failed:', err);
        try { conn.close(); } catch (e) { /* ignore */ }
        throw err;
    }
    ensureInstanceId(conn);
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

initDb();

/**
 * Runs fn inside one SQLite transaction (BEGIN IMMEDIATE; commit on success, rollback on error).
 * fn MUST be synchronous: there is only one connection, so awaiting inside a transaction would let unrelated
 * requests run inside it. Do network I/O before calling this helper.
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

function hasAdmin() {
    const row = db.prepare('SELECT count(*) as count FROM users WHERE role = ?').get('admin');
    return row && row.count > 0;
}

module.exports = {
    db,
    initDb,
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
    pendingMigrations,
    LATEST_SCHEMA_VERSION,
    getConnectionGeneration: () => connectionGeneration,
    getInstanceId: () => instanceId,
    getLastMigrationReport: () => lastMigrationReport
};
