// Schema of the database: base tables, settings seed and the sequential migrations. Runs on any connection with
// prepare(sql).get/all/run and exec(sql) (node:sqlite on the server, an in-memory database in tests, a device database
// in the apps). Server-only steps (the safety snapshot before an update) are passed in as options.
const { normalizePublisher, resolvePublisher, publisherKey, loadPublisherAliases, PUBLISHER_ALIAS_SEED } = require('./lib/publishers');
const { normalizeIsbn } = require('./lib/isbn');
const { migrateLegacyReadStatus } = require('./lib/owners');
const { parseLanguage, DEFAULT_LANGUAGE } = require('./lib/language');

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

const USERNAME_INDEX_MIGRATION = 14;
const SEEDED_START_DATE = '2021-04-09';

/**
 * Enforces case-insensitive usernames with an index. Existing case duplicates are reported, never renamed:
 * the index is skipped and retried on every start until an admin has resolved them.
 */
function ensureUsernameNocaseIndex(d, log = silentLog) {
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
function retryUsernameNocaseIndex(d, log) {
    const tracked = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (tracked && d.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(USERNAME_INDEX_MIGRATION)) ensureUsernameNocaseIndex(d, log);
}

// Numeric value of a volume number as the routes used to compute it at query time ("Band 12" = 12, "12.5" = 12.5,
// labels NULL). Frozen: migration 15 backfills with it and its triggers keep it; never change shipped SQL.
const numberSortExpr = (col) => {
    const n = `TRIM(REPLACE(REPLACE(COALESCE(${col}, ''), 'Band ', ''), 'band ', ''))`;
    return `CASE WHEN ${n} GLOB '[0-9]*' AND ${n} NOT GLOB '*[^0-9.]*' THEN CAST(${n} AS REAL) ELSE NULL END`;
};

/** All schema migrations in order. New ones are appended; shipped ones never change. */
function migrationList(log = silentLog) {
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
                // Wishlist: priority (0 none, 1 low, 2 medium, 3 high) and target price for in-store purchases
                const cols = new Set(d.prepare('PRAGMA table_info(volumes)').all().map(c => c.name));
                if (!cols.has('priority')) d.exec('ALTER TABLE volumes ADD COLUMN priority INTEGER DEFAULT 0;');
                if (!cols.has('target_price')) d.exec('ALTER TABLE volumes ADD COLUMN target_price REAL DEFAULT NULL;');
            }
        },
        {
            version: 11,
            name: 'add_volume_owners',
            up: (d) => {
                // Ownership per user: several people can own the same volume. volumes.status = 'Vorhanden' stays
                // "at least one owner"; existing volumes are assigned to the oldest admin.
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
                const converted = migrateLegacyReadStatus(d);
                if (converted) log.info(`[Database Migration] Converted ${converted} volumes with legacy status 'Gelesen' to 'Vorhanden' plus a read entry`);
            }
        },
        {
            version: USERNAME_INDEX_MIGRATION,
            name: 'users_username_nocase_unique',
            up: (d) => { ensureUsernameNocaseIndex(d, log); }
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
        },
        {
            version: 17,
            name: 'add_mangas_wish_priority',
            up: (d) => {
                // Wished series: NULL = not wished, otherwise 0 to 3 like volumes.priority; counts only without an owned volume
                const cols = new Set(d.prepare('PRAGMA table_info(mangas)').all().map(c => c.name));
                if (!cols.has('wish_priority')) d.exec('ALTER TABLE mangas ADD COLUMN wish_priority INTEGER DEFAULT NULL;');
            }
        },
        {
            version: 18,
            name: 'add_animes',
            up: (d) => {
                // Anime tab: one entry per AniList/MAL medium for everyone, progress per user; api_cache for search responses
                d.exec(`
                    CREATE TABLE IF NOT EXISTS animes (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        anilist_id INTEGER UNIQUE,
                        mal_id INTEGER UNIQUE,
                        title TEXT NOT NULL,
                        title_romaji TEXT, title_english TEXT, title_native TEXT, title_de TEXT,
                        format TEXT, episodes INTEGER, duration INTEGER,
                        status TEXT,
                        season TEXT, season_year INTEGER, start_date TEXT, end_date TEXT,
                        studios TEXT, genres TEXT, score INTEGER, description TEXT,
                        cover_image TEXT, banner_image TEXT, cover_source TEXT, banner_source TEXT,
                        next_airing_episode INTEGER, next_airing_at INTEGER, next_airing_estimated INTEGER NOT NULL DEFAULT 0,
                        manga_id INTEGER REFERENCES mangas(id) ON DELETE SET NULL,
                        relations TEXT,
                        urls TEXT,
                        notes TEXT,
                        meta_source TEXT, meta_fetched_at INTEGER, next_check_at INTEGER,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME,
                        updated_by INTEGER REFERENCES users(id)
                    );
                    CREATE TABLE IF NOT EXISTS anime_progress (
                        anime_id INTEGER NOT NULL REFERENCES animes(id) ON DELETE CASCADE,
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        status TEXT NOT NULL DEFAULT 'Geplant' CHECK (status IN ('Geplant','Schaue','Gesehen','Pausiert','Abgebrochen')),
                        episodes_watched INTEGER NOT NULL DEFAULT 0,
                        score INTEGER,
                        notes TEXT,
                        started_at TEXT,
                        finished_at TEXT,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (anime_id, user_id)
                    );
                    CREATE TABLE IF NOT EXISTS api_cache (
                        cache_key TEXT PRIMARY KEY,
                        json_data TEXT NOT NULL,
                        created_at INTEGER NOT NULL,
                        expires_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_anime_progress_user ON anime_progress (user_id);
                    CREATE INDEX IF NOT EXISTS idx_animes_manga ON animes (manga_id);
                    CREATE INDEX IF NOT EXISTS idx_animes_next_check ON animes (next_check_at);
                `);
            }
        },
        {
            version: 19,
            name: 'add_user_api_credentials',
            up: (d) => {
                // Own API keys (AES-256-GCM, utils/secretBox.js); user_id NULL = instance key (admins only)
                d.exec(`
                    CREATE TABLE IF NOT EXISTS user_api_credentials (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                        provider TEXT NOT NULL CHECK (provider IN ('anilist','mal','google_books')),
                        secret_enc TEXT NOT NULL,
                        label TEXT,
                        last4 TEXT,
                        allow_background INTEGER NOT NULL DEFAULT 0,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        last_used_at INTEGER, last_ok_at INTEGER, last_error TEXT
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_api_credentials_owner ON user_api_credentials (COALESCE(user_id, 0), provider);
                `);
            }
        },
        {
            version: 20,
            name: 'add_mangas_collecting',
            up: (d) => {
                // Collecting status of the household, separate from the release status: aktiv | pausiert | abgebrochen
                const cols = new Set(d.prepare('PRAGMA table_info(mangas)').all().map(c => c.name));
                if (!cols.has('collecting')) d.exec("ALTER TABLE mangas ADD COLUMN collecting TEXT NOT NULL DEFAULT 'aktiv';");
            }
        },
        {
            version: 21,
            name: 'add_trash',
            up: (d) => {
                // Trash: deleted series and volumes (with owners and reading state as JSON) restorable for 30 days.
                // The rows leave their tables so that no list, statistic or export ever sees them.
                d.exec(`
                    CREATE TABLE IF NOT EXISTS trash (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        kind TEXT NOT NULL CHECK (kind IN ('manga', 'volume')),
                        ref_id INTEGER NOT NULL,
                        manga_id INTEGER,
                        title TEXT NOT NULL,
                        payload TEXT NOT NULL,
                        deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                        deleted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE INDEX IF NOT EXISTS idx_trash_deleted_at ON trash (deleted_at);
                    CREATE INDEX IF NOT EXISTS idx_trash_ref ON trash (kind, ref_id);
                `);
            }
        },
        {
            version: 22,
            name: 'add_publisher_aliases',
            up: (d) => {
                // Publisher spellings -> canonical name, in addition to the built-in list (core/lib/publishers.js)
                d.exec(`
                    CREATE TABLE IF NOT EXISTS publisher_aliases (
                        alias TEXT PRIMARY KEY,
                        canonical TEXT NOT NULL,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    );
                `);
                const insert = d.prepare('INSERT OR IGNORE INTO publisher_aliases (alias, canonical) VALUES (?, ?)');
                for (const [alias, canonical] of Object.entries(PUBLISHER_ALIAS_SEED)) insert.run(alias, canonical);
                const aliases = new Map(Object.entries(PUBLISHER_ALIAS_SEED));
                for (const table of ['mangas', 'volumes']) {
                    const rows = d.prepare(`SELECT DISTINCT publisher FROM ${table} WHERE publisher IS NOT NULL AND TRIM(publisher) != ''`).all();
                    const update = d.prepare(`UPDATE ${table} SET publisher = ? WHERE publisher = ?`);
                    for (const { publisher } of rows) {
                        const normalized = resolvePublisher(publisher, aliases);
                        if (normalized && normalized !== publisher) update.run(normalized, publisher);
                    }
                }
            }
        },
        {
            version: 23,
            name: 'add_publisher_identity_aliases',
            up: (d) => {
                // older merges into a spelling that the built-in list writes differently ("Tokyopop") keep that spelling
                const insert = d.prepare('INSERT OR IGNORE INTO publisher_aliases (alias, canonical) VALUES (?, ?)');
                const builtIn = new Map();
                for (const { canonical } of d.prepare('SELECT DISTINCT canonical FROM publisher_aliases ORDER BY canonical').all()) {
                    const key = publisherKey(canonical);
                    if (key && resolvePublisher(canonical, builtIn) !== canonical) insert.run(key, canonical);
                }
            }
        },
        {
            version: 24,
            name: 'clear_seeded_start_date',
            up: (d) => {
                // up to v2.19.1 every database got 2021-04-09 as start date; without an earlier purchase or entry the
                // date is that seed, and the stats derive the start from the data again
                const stored = d.prepare("SELECT value FROM app_settings WHERE key = 'collection_start_date'").get();
                if (!stored || stored.value !== SEEDED_START_DATE) return;
                const earlier = d.prepare(`
                    SELECT 1 FROM volumes
                    WHERE (TRIM(purchase_date) GLOB '[0-9][0-9][0-9][0-9]*' AND SUBSTR(TRIM(purchase_date), 1, 4) >= '1900'
                           AND SUBSTR(TRIM(purchase_date), 1, 10) < ?)
                       OR SUBSTR(created_at, 1, 10) < ?
                    LIMIT 1
                `).get(SEEDED_START_DATE, SEEDED_START_DATE);
                if (!earlier) d.prepare("DELETE FROM app_settings WHERE key = 'collection_start_date'").run();
            }
        },
        {
            version: 25,
            name: 'add_anime_watch',
            up: (d) => {
                // Watch progress from streaming links: resume link per user, AniList link lists, remembered service links
                // (a Crunchyroll series spans several AniList entries, so external_id is not unique) and the list-sync state
                const progressCols = new Set(d.prepare('PRAGMA table_info(anime_progress)').all().map(c => c.name));
                if (!progressCols.has('resume_url')) d.exec('ALTER TABLE anime_progress ADD COLUMN resume_url TEXT;');
                if (!progressCols.has('resume_episode')) d.exec('ALTER TABLE anime_progress ADD COLUMN resume_episode INTEGER;');
                const animeCols = new Set(d.prepare('PRAGMA table_info(animes)').all().map(c => c.name));
                if (!animeCols.has('external_links')) d.exec('ALTER TABLE animes ADD COLUMN external_links TEXT;');
                if (!animeCols.has('streaming_episodes')) d.exec('ALTER TABLE animes ADD COLUMN streaming_episodes TEXT;');
                d.exec(`
                    CREATE TABLE IF NOT EXISTS anime_links (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        anime_id INTEGER NOT NULL REFERENCES animes(id) ON DELETE CASCADE,
                        service TEXT NOT NULL,
                        external_id TEXT NOT NULL,
                        url TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_anime_links_anime_service ON anime_links (anime_id, service);
                    CREATE INDEX IF NOT EXISTS idx_anime_links_lookup ON anime_links (service, external_id);
                    CREATE TABLE IF NOT EXISTS anime_sync (
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        service TEXT NOT NULL,
                        enabled INTEGER NOT NULL DEFAULT 0,
                        external_user_id TEXT,
                        last_synced_at INTEGER,
                        last_error TEXT,
                        last_report TEXT,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (user_id, service)
                    );
                `);
            }
        },
        {
            version: 26,
            name: 'add_users_locale',
            up: (d) => {
                // UI language per user (NULL = follow the device) and the default edition language of the collection
                const cols = new Set(d.prepare('PRAGMA table_info(users)').all().map(c => c.name));
                if (!cols.has('locale')) d.exec('ALTER TABLE users ADD COLUMN locale TEXT;');
                if (!cols.has('default_language')) d.exec("ALTER TABLE users ADD COLUMN default_language TEXT NOT NULL DEFAULT 'de';");
            }
        },
        {
            version: 27,
            name: 'add_editions',
            up: (d) => {
                // Editions of one work in different languages: language becomes an ISO 639-1 code, plus region, work key,
                // the currency of the prices and a per-volume language (NULL = the series language)
                const mangaCols = new Set(d.prepare('PRAGMA table_info(mangas)').all().map(c => c.name));
                if (!mangaCols.has('region')) d.exec('ALTER TABLE mangas ADD COLUMN region TEXT;');
                if (!mangaCols.has('work_key')) d.exec('ALTER TABLE mangas ADD COLUMN work_key TEXT;');
                if (!mangaCols.has('currency')) d.exec("ALTER TABLE mangas ADD COLUMN currency TEXT NOT NULL DEFAULT 'EUR';");
                const volumeCols = new Set(d.prepare('PRAGMA table_info(volumes)').all().map(c => c.name));
                if (!volumeCols.has('language')) d.exec('ALTER TABLE volumes ADD COLUMN language TEXT;');
                d.exec('CREATE INDEX IF NOT EXISTS idx_mangas_work_key ON mangas (work_key);');
                // one UPDATE per distinct stored text; unknown text becomes 'de' (the pre-update backup keeps the original)
                const update = d.prepare('UPDATE mangas SET language = ?, region = COALESCE(region, ?) WHERE language IS ?');
                const unknown = [];
                for (const { language, n } of d.prepare('SELECT language, count(*) AS n FROM mangas GROUP BY language').all()) {
                    const parsed = parseLanguage(language);
                    if (!parsed) unknown.push(`"${language}" (${n})`);
                    const code = (parsed && parsed.language) || DEFAULT_LANGUAGE;
                    const region = (parsed && parsed.region) || null;
                    if (code !== language || region) update.run(code, region, language);
                }
                if (unknown.length) log.warn(`[Database Migration] v27: unknown series languages set to '${DEFAULT_LANGUAGE}': ${unknown.join(', ')}`);
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
function pendingMigrations(database, log) {
    const tracked = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    const applied = new Set(tracked ? database.prepare('SELECT version FROM schema_migrations').all().map(r => r.version) : []);
    return migrationList(log).filter(m => !applied.has(m.version));
}

function appliedSchemaVersion(database) {
    const tracked = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    return tracked ? (database.prepare('SELECT max(version) AS v FROM schema_migrations').get()?.v || 0) : 0;
}

const SCHEMA_NEWER_ACCEPTED_KEY = 'schema_newer_accepted';

/** { version, known, accepted } for a schema newer than this code (accepted: a restore confirmed exactly that version), else null. */
function newerSchema(database) {
    const version = appliedSchemaVersion(database);
    if (version <= LATEST_SCHEMA_VERSION) return null;
    const settings = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get();
    const row = settings ? database.prepare('SELECT value FROM app_settings WHERE key = ?').get(SCHEMA_NEWER_ACCEPTED_KEY) : null;
    return { version, known: LATEST_SCHEMA_VERSION, accepted: Boolean(row) && String(row.value) === String(version) };
}

/** Records that this code may open the database's newer schema (a restore with allow_newer_schema); returns that version. */
function acceptNewerSchema(database) {
    const version = appliedSchemaVersion(database);
    database.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(SCHEMA_NEWER_ACCEPTED_KEY, String(version));
    return version;
}

/**
 * Applies pending migrations, each in its own transaction, and returns what ran: [{ version, name, changes, ms }].
 * options.beforeMigrations(database, pending) runs once before the first one (the server snapshots there).
 */
function runSequentialMigrations(database, options = {}) {
    const log = options.log || silentLog;
    const pending = pendingMigrations(database, log);
    ensureMigrationsTable(database);
    if (!pending.length) return [];

    if (options.beforeMigrations) options.beforeMigrations(database, pending);

    const totalChanges = () => database.prepare('SELECT total_changes() AS n').get().n;
    const report = [];
    for (const mig of pending) {
        const started = Date.now();
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
        const entry = { version: mig.version, name: mig.name, changes: totalChanges() - changesBefore - 1, ms: Date.now() - started };
        report.push(entry);
        log.info(`[Database Migration] v${entry.version} ${entry.name}: ${entry.changes.toLocaleString('de-DE')} Zeilen geändert, ${entry.ms} ms`);
    }
    return report;
}

/**
 * Base tables, default settings and all pending migrations on an open connection (live DB or a staged restore).
 * loadAliases: also make its publisher_aliases the process-wide map of normalizePublisher (only for the live connection).
 */
function applySchema(conn, options = {}) {
    const log = options.log || silentLog;
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
            wish_priority INTEGER DEFAULT NULL,
            collecting TEXT NOT NULL DEFAULT 'aktiv',
            region TEXT,
            work_key TEXT,
            currency TEXT NOT NULL DEFAULT 'EUR',
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
            language TEXT,
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

    // before the migrations, so a first run that skips the index does not warn twice
    retryUsernameNocaseIndex(conn, log);
    const report = runSequentialMigrations(conn, options);
    if (options.loadAliases) loadPublisherAliases(conn);
    return report;
}

module.exports = {
    applySchema,
    runSequentialMigrations,
    pendingMigrations,
    appliedSchemaVersion,
    newerSchema,
    acceptNewerSchema,
    SCHEMA_NEWER_ACCEPTED_KEY,
    ensureMigrationsTable,
    migrationList,
    numberSortExpr,
    LATEST_SCHEMA_VERSION,
    USERNAME_INDEX_MIGRATION
};
