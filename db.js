const fs = require('fs');
const path = require('path');
const log = require('./utils/logger').child('db');

// DATA_DIR allows isolated data directories (tests, custom volume layouts); default: ./data
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
const uploadsDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
const tempDir = path.join(dataDir, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'manga.db');

let currentDb = null;

/**
 * Sequential Schema Migrations Runner
 * Applies migrations idempotently and atomically within SQLite transactions.
 */
function runSequentialMigrations(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    const migrations = [
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
        }
    ];

    for (const mig of migrations) {
        const row = database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(mig.version);
        if (!row) {
            database.exec('BEGIN TRANSACTION;');
            try {
                mig.up(database);
                database.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(mig.version, mig.name);
                database.exec('COMMIT;');
                log.info(`[Database Migration] Applied migration v${mig.version}: ${mig.name}`);
            } catch (err) {
                database.exec('ROLLBACK;');
                log.error(`[Database Migration] Failed migration v${mig.version} (${mig.name}):`, err);
                throw err;
            }
        }
    }
}

/** Opens a SQLite file with node:sqlite (Node >= 22.5) or better-sqlite3 as fallback. */
function openRawDb(file, options = {}) {
    try {
        const { DatabaseSync } = require('node:sqlite');
        return new DatabaseSync(file, options.readOnly ? { readOnly: true } : {});
    } catch (e) {
        if (e && e.code !== 'MODULE_NOT_FOUND' && e.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw e;
        const Database = require('better-sqlite3');
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

function initDb() {
    if (currentDb) {
        try {
            currentDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
            currentDb.close();
        } catch (e) {
            log.error('Error closing current db:', e);
        }
    }

    currentDb = openRawDb(dbPath);
    currentDb.exec('PRAGMA journal_mode = WAL;');
    currentDb.exec('PRAGMA foreign_keys = ON;');

    // Base Schema Creation
    currentDb.exec(`
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
        currentDb.exec("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('collection_start_date', '2021-04-09');");
    } catch (e) { log.warn('Seeding collection_start_date failed:', e.message); }

    // Run Sequential Migrations Registry
    try {
        runSequentialMigrations(currentDb);
    } catch (migErr) {
        log.error('[Database Migration] Fatal error running migrations:', migErr);
    }

    return currentDb;
}

// Initial connection
initDb();

// Database restore/maintenance state
let isRestoring = false;

function setRestoringState(active) {
    isRestoring = Boolean(active);
}

/**
 * Universal Atomic Transaction Runner.
 * Supports both better-sqlite3 native transactions and node:sqlite BEGIN IMMEDIATE transactions.
 */
function runTransaction(fn) {
    if (isRestoring) {
        throw new Error('DATABASE_MAINTENANCE_RESTORE_IN_PROGRESS: Datenbank-Wiederherstellung läuft. Bitte kurz warten.');
    }
    if (!currentDb) {
        initDb();
    }
    if (typeof currentDb.transaction === 'function') {
        const tx = currentDb.transaction(fn);
        return tx();
    }
    currentDb.exec('BEGIN IMMEDIATE;');
    try {
        const res = fn(currentDb);
        currentDb.exec('COMMIT;');
        return res;
    } catch (err) {
        try {
            currentDb.exec('ROLLBACK;');
        } catch (e) { log.warn('ROLLBACK failed:', e.message); }
        throw err;
    }
}

function closeDb() {
    if (currentDb) {
        try {
            currentDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        } catch (e) { log.warn('WAL checkpoint before close failed:', e.message); }
        try {
            currentDb.close();
        } catch (e) {}
        currentDb = null;
    }
}

const db = new Proxy({}, {
    get(target, prop) {
        if (isRestoring) {
            throw new Error('DATABASE_MAINTENANCE_RESTORE_IN_PROGRESS: Datenbank-Wiederherstellung läuft. Bitte kurz warten.');
        }
        if (!currentDb) {
            initDb();
        }
        if (prop === 'transaction') {
            return (fn) => (...args) => runTransaction(() => fn(...args));
        }
        const val = currentDb[prop];
        if (typeof val === 'function') {
            return val.bind(currentDb);
        }
        return val;
    }
});

/**
 * Runs fn inside a single SQLite transaction (commit on success, rollback on error).
 * fn MUST be synchronous: there is only one connection, so awaiting inside a transaction would
 * let unrelated requests run inside it. Do network I/O before calling this helper.
 */
function withTransaction(fn) {
    const database = db;
    database.exec('BEGIN TRANSACTION;');
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            throw new Error('withTransaction: asynchrone Callbacks sind nicht erlaubt');
        }
        database.exec('COMMIT;');
        return result;
    } catch (err) {
        try { database.exec('ROLLBACK;'); } catch (rbErr) { /* ignore */ }
        throw err;
    }
}

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
    withTransaction,
    validateDbFile,
    setRestoringState,
    isRestoring: () => isRestoring
};

