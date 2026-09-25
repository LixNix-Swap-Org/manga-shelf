const Database = require('better-sqlite3');
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
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// Migrations / Table Creation
db.exec(`
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
        purchase_date TEXT,
        status TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (manga_id) REFERENCES mangas (id) ON DELETE CASCADE
    );
`);

function hasAdmin() {
    const row = db.prepare('SELECT count(*) as count FROM users WHERE role = ?').get('admin');
    return row.count > 0;
}

module.exports = { db, hasAdmin, uploadsDir, dataDir };
