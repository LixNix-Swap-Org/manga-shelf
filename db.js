const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
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
                console.log(`[Database Migration] Applied migration v${mig.version}: ${mig.name}`);
            } catch (err) {
                database.exec('ROLLBACK;');
                console.error(`[Database Migration] Failed migration v${mig.version} (${mig.name}):`, err);
                throw err;
            }
        }
    }
}

function initDb() {
    if (currentDb) {
        try {
            currentDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
            currentDb.close();
        } catch (e) {
            console.error('Error closing current db:', e);
        }
    }

    try {
        const { DatabaseSync } = require('node:sqlite');
        currentDb = new DatabaseSync(dbPath);
        currentDb.exec('PRAGMA journal_mode = WAL;');
        currentDb.exec('PRAGMA foreign_keys = ON;');
    } catch (e) {
        const Database = require('better-sqlite3');
        currentDb = new Database(dbPath);
        currentDb.pragma('journal_mode = WAL');
        currentDb.pragma('foreign_keys = ON');
    }

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
    } catch (e) {}

    // Run Sequential Migrations Registry
    try {
        runSequentialMigrations(currentDb);
    } catch (migErr) {
        console.error('[Database Migration] Fatal error running migrations:', migErr);
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
        } catch (_) {}
        throw err;
    }
}

function closeDb() {
    if (currentDb) {
        try {
            currentDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        } catch (e) {}
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
    setRestoringState,
    isRestoring: () => isRestoring
};

