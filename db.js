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

const dbPath = path.join(dataDir, 'manga.db');

let currentDb = null;

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
    } catch (e) {
        const Database = require('better-sqlite3');
        currentDb = new Database(dbPath);
        currentDb.pragma('journal_mode = WAL');
    }

    // Migrations / Table Creation
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
            release_year INTEGER,
            condition TEXT,
            pages INTEGER,
            publisher TEXT,
            purchase_date TEXT,
            status TEXT,
            notes TEXT,
            cover_image TEXT,
            images TEXT,
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
    `);

    try {
        currentDb.exec("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('collection_start_date', '2021-04-09');");
    } catch (e) {}

    // Migrations for existing databases to ensure all volume fields exist
    try {
        const volCols = currentDb.prepare("PRAGMA table_info(volumes)").all();
        const volColNames = new Set(volCols.map(c => c.name));
        if (!volColNames.has('price')) currentDb.exec('ALTER TABLE volumes ADD COLUMN price REAL DEFAULT NULL;');
        if (!volColNames.has('release_year')) currentDb.exec('ALTER TABLE volumes ADD COLUMN release_year INTEGER DEFAULT NULL;');
        if (!volColNames.has('condition')) currentDb.exec('ALTER TABLE volumes ADD COLUMN condition TEXT DEFAULT NULL;');
        if (!volColNames.has('pages')) currentDb.exec('ALTER TABLE volumes ADD COLUMN pages INTEGER DEFAULT NULL;');
        if (!volColNames.has('publisher')) currentDb.exec('ALTER TABLE volumes ADD COLUMN publisher TEXT DEFAULT NULL;');
        if (!volColNames.has('cover_image')) currentDb.exec('ALTER TABLE volumes ADD COLUMN cover_image TEXT DEFAULT NULL;');
        if (!volColNames.has('images')) currentDb.exec('ALTER TABLE volumes ADD COLUMN images TEXT DEFAULT NULL;');
    } catch (e) {
        console.error('Migration error on volumes table:', e);
    }

    return currentDb;
}

// Initial connection
initDb();

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

module.exports = { db, initDb, closeDb, hasAdmin, uploadsDir, dataDir, dbPath };
