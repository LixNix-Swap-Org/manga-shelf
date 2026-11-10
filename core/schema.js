// Schema of the database: base tables, settings seed and the sequential migrations. Runs on any connection with
// prepare(sql).get/all/run and exec(sql) (node:sqlite on the server, an in-memory database in tests, a device database
// in the apps). Server-only steps (the safety snapshot before an update) are passed in as options.
const { normalizePublisher, resolvePublisher, publisherKey, loadPublisherAliases, PUBLISHER_ALIAS_SEED } = require('./lib/publishers');
const { normalizeIsbn } = require('./lib/isbn');
const { migrateLegacyReadStatus } = require('./lib/owners');
const { parseLanguage, DEFAULT_LANGUAGE } = require('./lib/language');
const { backfillCatalog, CATALOG_TRIGGERS_SQL, ANIME_LINK_TRIGGERS_SQL, CATALOG_TRIGGERS_V3_SQL, MARK_SERIES_LOCAL, MARK_VOLUMES_LOCAL, ADOPT_SERIES_SQL, ADOPT_VOLUME_SQL } = require('./lib/catalog');
const { MARK_VIEWS_SQL, MARK_VIEWS, MARK_FOLLOW_TRIGGERS_SQL, MARK_FOLLOW_TRIGGERS, marksOnCatalog, chaptersOnCatalog } = require('./lib/marks');
const { COPIES_TABLE_SQL, OWNERS_VIEW_SQL, OWNERS_VIEW_LENT_SQL, COPY_TRIGGERS, COPY_TRIGGERS_SQL, copiesInPlace } = require('./lib/copies');

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
// works (migration 38): the source ids a work key names, and the trigger body that keeps mangas.work_id on its key
const WORK_ANILIST_SQL = (col) => `CASE WHEN ${col} LIKE 'anilist:%' THEN CAST(substr(${col}, 9) AS INTEGER) END`;
const WORK_MAL_SQL = (col) => `CASE WHEN ${col} LIKE 'mal:%' THEN CAST(substr(${col}, 5) AS INTEGER) END`;
/**
 * Rebuilds `table` from its stored DDL as changed by `transform` (12-step procedure; the migration runs with foreign keys
 * off, see `foreignKeys: false`). Columns, rows, AUTOINCREMENT state, indexes and the table's own triggers stay;
 * `dropColumns` names columns the new definition leaves out (their values are not copied).
 */
function rebuildTable(d, table, transform, { dropColumns = [] } = {}) {
    const stored = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!stored) throw new Error(`${table}: table missing`);
    const ddl = transform(stored.sql);
    const head = new RegExp(`^CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?["\`]?${table}["\`]?`, 'i');
    if (!head.test(ddl)) throw new Error(`${table}: unexpected table definition`);
    if (ddl === stored.sql) return false;   // already in that shape (a replayed migration)
    const extras = d.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, rowid").all(table);
    const seq = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get()
        ? d.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)?.seq ?? null : null;
    const columns = d.prepare(`PRAGMA table_info(${table})`).all().filter(c => !dropColumns.includes(c.name)).map(c => `"${c.name}"`).join(', ');
    const tmp = `${table}_rebuild`;
    d.exec(ddl.replace(head, `CREATE TABLE ${tmp}`));
    d.exec(`INSERT INTO ${tmp} (${columns}) SELECT ${columns} FROM ${table};`);
    d.exec(`DROP TABLE ${table};`);
    // other tables' triggers name the dropped table: the legacy rename neither rewrites nor re-checks them
    d.exec('PRAGMA legacy_alter_table = ON;');
    try { d.exec(`ALTER TABLE ${tmp} RENAME TO ${table};`); } finally { d.exec('PRAGMA legacy_alter_table = OFF;'); }
    for (const { sql } of extras) d.exec(sql);
    if (seq !== null) {
        d.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table);
        d.prepare(`INSERT INTO sqlite_sequence (name, seq) SELECT ?, max(?, COALESCE((SELECT max(rowid) FROM ${table}), 0))`).run(table, seq);
    }
    return true;
}

/** Replaces `pattern` in a DDL text exactly once; throws when it is not there (an unexpected definition). */
function replaceOnce(sql, pattern, replacement, what) {
    const matches = sql.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));
    if (!matches || matches.length !== 1) throw new Error(`${what}: expected exactly one match of ${pattern}`);
    return sql.replace(pattern, replacement);
}

/**
 * Migration 13 with the SQL of its time (volume_reads by volume_id; owners.js writes catalog marks since migration 43):
 * every volume with the legacy status 'Gelesen' becomes 'Vorhanden'. Without an owner the oldest admin owns it; without a
 * read entry its owners become its readers. Returns the count. Frozen.
 */
function convertLegacyReadStatusV13(d) {
    const rows = d.prepare("SELECT id FROM volumes WHERE LOWER(TRIM(status)) = LOWER('Gelesen')").all();
    if (!rows.length) return 0;
    const fallback = d.prepare("SELECT id FROM users ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, id LIMIT 1").get()?.id ?? null;
    for (const { id } of rows) {
        const vol = d.prepare('SELECT price, purchase_date, condition FROM volumes WHERE id = ?').get(id);
        if (!d.prepare('SELECT 1 FROM volume_owners WHERE volume_id = ? LIMIT 1').get(id) && fallback) {
            d.prepare('INSERT OR IGNORE INTO volume_owners (volume_id, user_id, price, purchase_date, condition) VALUES (?, ?, ?, ?, ?)')
                .run(id, fallback, vol.price ?? null, vol.purchase_date ?? null, vol.condition ?? null);
        }
        if (!d.prepare('SELECT 1 FROM volume_reads WHERE volume_id = ? LIMIT 1').get(id)) {
            d.prepare('INSERT OR IGNORE INTO volume_reads (volume_id, user_id) SELECT volume_id, user_id FROM volume_owners WHERE volume_id = ? ORDER BY created_at, rowid').run(id);
        }
        d.prepare("UPDATE volumes SET status = 'Vorhanden' WHERE id = ?").run(id);
    }
    return rows.length;
}

/** The data_versions triggers of `table` (migration 39) for `scope`. */
const dataVersionTriggersSql = (table, scope) => [['ins', 'INSERT'], ['upd', 'UPDATE'], ['del', 'DELETE']].map(([suffix, event]) => `
    CREATE TRIGGER IF NOT EXISTS trg_dv_${table}_${suffix} AFTER ${event} ON ${table} BEGIN
        UPDATE data_versions SET version = version + 1 WHERE scope = '${scope}';
    END;`).join('\n');

/**
 * trg_mangas_work_update since migration 45 (anime links on the work, no animes.manga_id): the last edition of a work moved to
 * another key (a merge of work groups) takes the anime links of the old work along; a shelf link naming the series follows it.
 */
const WORK_UPDATE_TRIGGER_SQL = () => `
    CREATE TRIGGER trg_mangas_work_update AFTER UPDATE OF work_key ON mangas BEGIN
        ${WORK_TRIGGER_BODY}
        UPDATE animes SET work_id = (SELECT work_id FROM mangas WHERE id = NEW.id)
            WHERE OLD.work_id IS NOT NULL AND work_id = OLD.work_id AND NEW.work_key IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM mangas WHERE work_id = OLD.work_id);
        UPDATE OR IGNORE anime_work_links SET work_id = (SELECT work_id FROM mangas WHERE id = NEW.id)
            WHERE origin = 'manual' AND OLD.work_id IS NOT NULL AND work_id = OLD.work_id AND NEW.work_key IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM mangas WHERE work_id = OLD.work_id);
        UPDATE OR IGNORE anime_work_links SET work_id = (SELECT work_id FROM mangas WHERE id = NEW.id)
            WHERE origin = 'manual' AND manga_id = NEW.id AND NEW.work_key IS NOT NULL;
    END;`;
/** A shelf pin (migration 45) moves with the series it names: the shelf that holds the edition now shows its link. */
const ANIME_PIN_SHELF_TRIGGER_SQL = `
    CREATE TRIGGER IF NOT EXISTS trg_mangas_anime_pins_shelf AFTER UPDATE OF shelf_id ON mangas WHEN NEW.shelf_id IS NOT OLD.shelf_id BEGIN
        UPDATE OR IGNORE anime_work_links SET scope_shelf_id = NEW.shelf_id
         WHERE origin = 'manual' AND hidden = 0 AND manga_id = NEW.id AND scope_shelf_id = OLD.shelf_id;
        -- the target shelf already pins that work: its own choice stays
        DELETE FROM anime_work_links WHERE origin = 'manual' AND hidden = 0 AND manga_id = NEW.id AND scope_shelf_id = OLD.shelf_id;
    END;`;
const WORK_TRIGGER_BODY = `INSERT OR IGNORE INTO works (work_key, anilist_id, mal_id)
                            SELECT NEW.work_key, ${WORK_ANILIST_SQL('NEW.work_key')}, ${WORK_MAL_SQL('NEW.work_key')} WHERE NEW.work_key IS NOT NULL;
                        UPDATE mangas SET work_id = (SELECT id FROM works WHERE work_key = NEW.work_key) WHERE id = NEW.id;`;

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
                    CREATE INDEX IF NOT EXISTS idx_mangas_passion_id ON mangas (manga_passion_id);
                `);
                // migration 12 drops it again; a replay on marks keyed by the catalog (migration 43) has no volume_id
                if (!marksOnCatalog(d)) d.exec('CREATE INDEX IF NOT EXISTS idx_volume_reads_vol ON volume_reads (volume_id);');
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
                // replayed after migration 44: ownership lives in volume_copies, volume_owners is a view of it
                if (copiesInPlace(d)) return;
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
                // replayed on a database whose marks are on the catalog already (migration 43): the current rules of owners.js
                const converted = marksOnCatalog(d) ? migrateLegacyReadStatus(d) : convertLegacyReadStatusV13(d);
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
                    CREATE INDEX IF NOT EXISTS idx_animes_next_check ON animes (next_check_at);
                `);
                // the series link went to the work in migration 45: a replay on such a database has no column to index
                if (d.prepare('PRAGMA table_info(animes)').all().some(c => c.name === 'manga_id')) {
                    d.exec('CREATE INDEX IF NOT EXISTS idx_animes_manga ON animes (manga_id);');
                }
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
        },
        {
            version: 28,
            name: 'add_media_kinds_and_languages',
            up: (d) => {
                const animeCols = new Set(d.prepare('PRAGMA table_info(animes)').all().map(c => c.name));
                if (!animeCols.has('kind')) d.exec("ALTER TABLE animes ADD COLUMN kind TEXT NOT NULL DEFAULT 'anime';");
                for (const [name, type] of [['tmdb_id', 'INTEGER'], ['tmdb_kind', 'TEXT'], ['imdb_id', 'TEXT'], ['original_language', 'TEXT'],
                    ['spoken_languages', 'TEXT'], ['seasons', 'TEXT']]) {
                    if (!animeCols.has(name)) d.exec(`ALTER TABLE animes ADD COLUMN ${name} ${type};`);
                }
                d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_animes_tmdb ON animes (tmdb_kind, tmdb_id);');
                const progressCols = new Set(d.prepare('PRAGMA table_info(anime_progress)').all().map(c => c.name));
                if (!progressCols.has('audio_language')) d.exec('ALTER TABLE anime_progress ADD COLUMN audio_language TEXT;');
                if (!progressCols.has('subtitle_language')) d.exec('ALTER TABLE anime_progress ADD COLUMN subtitle_language TEXT;');
                const table = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_api_credentials'").get();
                if (!table || table.sql.includes("'tmdb'")) return;
                const check = /(CHECK\s*\(\s*provider\s+IN\s*\()([^)]*)(\))/i;
                const head = /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?user_api_credentials["`]?/i;
                if (!check.test(table.sql) || !head.test(table.sql)) throw new Error('user_api_credentials: unexpected table definition, provider check not found');
                const ddl = table.sql.replace(check, (_, open, list, close) => `${open}${list},'tmdb'${close}`).replace(head, 'CREATE TABLE user_api_credentials_new');
                const columns = d.prepare('PRAGMA table_info(user_api_credentials)').all().map(c => `"${c.name}"`).join(', ');
                d.exec(ddl);
                d.exec(`INSERT INTO user_api_credentials_new (${columns}) SELECT ${columns} FROM user_api_credentials;`);
                d.exec('DROP TABLE user_api_credentials;');
                d.exec('ALTER TABLE user_api_credentials_new RENAME TO user_api_credentials;');
                d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_api_credentials_owner ON user_api_credentials (COALESCE(user_id, 0), provider);');
            }
        },
        {
            version: 29,
            name: 'add_anime_watched_episodes',
            up: (d) => {
                // Single watched episodes per user (JSON array); NULL keeps the plain counter 1..episodes_watched
                const progressCols = new Set(d.prepare('PRAGMA table_info(anime_progress)').all().map(c => c.name));
                if (!progressCols.has('watched_episodes')) d.exec('ALTER TABLE anime_progress ADD COLUMN watched_episodes TEXT;');
            }
        },
        {
            version: 30,
            name: 'add_anime_episode_scores',
            up: (d) => {
                // Ratings of single episodes per user (JSON object episode -> 1..10); NULL = none
                const progressCols = new Set(d.prepare('PRAGMA table_info(anime_progress)').all().map(c => c.name));
                if (!progressCols.has('episode_scores')) d.exec('ALTER TABLE anime_progress ADD COLUMN episode_scores TEXT;');
            }
        },
        {
            version: 31,
            name: 'add_anime_custom_seasons',
            up: (d) => {
                // Seasons set by hand per entry (JSON [{ start, name }]); NULL = TMDb seasons or blocks of 100
                const animeCols = new Set(d.prepare('PRAGMA table_info(animes)').all().map(c => c.name));
                if (!animeCols.has('custom_seasons')) d.exec('ALTER TABLE animes ADD COLUMN custom_seasons TEXT;');
            }
        },
        {
            version: 32,
            name: 'add_shelves',
            up: (d) => {
                // Shelves = collections with members. Everything that exists moves into shelf 1; every account joins it.
                d.exec(`
                    CREATE TABLE IF NOT EXISTS shelves (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT NOT NULL,
                        description TEXT,
                        color TEXT NOT NULL DEFAULT '#6366f1',
                        owner_user_id INTEGER,
                        is_default INTEGER NOT NULL DEFAULT 0,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE TABLE IF NOT EXISTS shelf_members (
                        shelf_id INTEGER NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
                        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (shelf_id, user_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_shelf_members_user ON shelf_members (user_id);
                `);
                const cols = new Set(d.prepare('PRAGMA table_info(mangas)').all().map(c => c.name));
                if (!cols.has('shelf_id')) d.exec('ALTER TABLE mangas ADD COLUMN shelf_id INTEGER;');
                if (!d.prepare('SELECT 1 FROM shelves WHERE id = 1').get()) {
                    const owner = d.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()
                        || d.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
                    d.prepare("INSERT INTO shelves (id, name, owner_user_id, is_default) VALUES (1, 'Sammlung', ?, 1)").run(owner ? owner.id : null);
                }
                d.exec("UPDATE mangas SET shelf_id = 1 WHERE shelf_id IS NULL;");
                // the trash remembers the shelf of what it holds, so it is only listed to that shelf's members
                const trashCols = new Set(d.prepare('PRAGMA table_info(trash)').all().map(c => c.name));
                if (!trashCols.has('shelf_id')) d.exec('ALTER TABLE trash ADD COLUMN shelf_id INTEGER;');
                d.exec("UPDATE trash SET shelf_id = 1 WHERE shelf_id IS NULL;");
                // only accounts without any shelf, so a second run leaves memberships changed since then alone
                d.exec(`
                    INSERT OR IGNORE INTO shelf_members (shelf_id, user_id, role)
                    SELECT 1, id, CASE role WHEN 'admin' THEN 'owner' WHEN 'editor' THEN 'editor' ELSE 'viewer' END FROM users
                    WHERE id NOT IN (SELECT user_id FROM shelf_members);
                    CREATE INDEX IF NOT EXISTS idx_mangas_shelf ON mangas (shelf_id);
                `);
                // a series is always in a shelf; new rows without one land in shelf 1 until the handler names it. A trash
                // entry written without a shelf (older code on this database) takes the shelf of its series, else 1.
                d.exec(`
                    CREATE TRIGGER IF NOT EXISTS trg_mangas_shelf_default AFTER INSERT ON mangas
                    WHEN NEW.shelf_id IS NULL BEGIN UPDATE mangas SET shelf_id = 1 WHERE id = NEW.id; END;
                    CREATE TRIGGER IF NOT EXISTS trg_trash_shelf_default AFTER INSERT ON trash
                    WHEN NEW.shelf_id IS NULL BEGIN
                        UPDATE trash SET shelf_id = COALESCE((SELECT shelf_id FROM mangas WHERE id = NEW.manga_id), 1) WHERE id = NEW.id;
                    END;
                `);
            }
        },
        {
            version: 33,
            name: 'add_anime_rating_visibility',
            up: (d) => {
                // Who sees a user's rating of a shared anime entry: public (named), anonymous or private
                const progressCols = new Set(d.prepare('PRAGMA table_info(anime_progress)').all().map(c => c.name));
                if (!progressCols.has('rating_visibility')) d.exec("ALTER TABLE anime_progress ADD COLUMN rating_visibility TEXT NOT NULL DEFAULT 'public';");
                if (!progressCols.has('public_comment')) d.exec('ALTER TABLE anime_progress ADD COLUMN public_comment TEXT;');
                const userCols = new Set(d.prepare('PRAGMA table_info(users)').all().map(c => c.name));
                if (!userCols.has('default_anime_visibility')) d.exec("ALTER TABLE users ADD COLUMN default_anime_visibility TEXT NOT NULL DEFAULT 'public';");
            }
        },
        {
            version: 34,
            name: 'add_anime_tags',
            up: (d) => {
                // Tags / collections of the shared anime list (JSON list of short names)
                const animeCols = new Set(d.prepare('PRAGMA table_info(animes)').all().map(c => c.name));
                if (!animeCols.has('tags')) d.exec('ALTER TABLE animes ADD COLUMN tags TEXT;');
            }
        },
        {
            version: 35,
            name: 'add_anime_airings',
            up: (d) => {
                // Episodes that have aired (airing time in seconds), kept when the next one replaces them: the history of the anime calendar
                d.exec(`
                    CREATE TABLE IF NOT EXISTS anime_airings (
                        anime_id INTEGER NOT NULL REFERENCES animes(id) ON DELETE CASCADE,
                        episode INTEGER NOT NULL,
                        at INTEGER NOT NULL,
                        PRIMARY KEY (anime_id, episode)
                    );
                    CREATE INDEX IF NOT EXISTS idx_anime_airings_at ON anime_airings (at);
                `);
            }
        },
        {
            version: 36,
            name: 'add_webtoon_chapters',
            up: (d) => {
                // Webtoons and manhwa are read by chapter: the series format, its known chapter count and each user's chapter
                const cols = new Set(d.prepare('PRAGMA table_info(mangas)').all().map(c => c.name));
                if (!cols.has('format')) d.exec("ALTER TABLE mangas ADD COLUMN format TEXT NOT NULL DEFAULT 'print';");
                if (!cols.has('total_chapters')) d.exec('ALTER TABLE mangas ADD COLUMN total_chapters INTEGER;');
                d.exec(`
                    CREATE TABLE IF NOT EXISTS chapter_progress (
                        manga_id INTEGER NOT NULL REFERENCES mangas(id) ON DELETE CASCADE,
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        chapters_read INTEGER NOT NULL,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (manga_id, user_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_chapter_progress_user ON chapter_progress (user_id);
                `);
            }
        },
        {
            version: 37,
            name: 'add_volumes_sort_after',
            up: (d) => {
                // A special (guidebook, fanbook, anthology) can stand right after regular volume N instead of at the end
                const cols = new Set(d.prepare('PRAGMA table_info(volumes)').all().map(c => c.name));
                if (!cols.has('sort_after')) d.exec('ALTER TABLE volumes ADD COLUMN sort_after REAL;');
            }
        },
        {
            version: 38,
            name: 'add_works',
            up: (d) => {
                // One row per work (the work_key of its editions) with a numeric id. mangas.work_id follows mangas.work_key
                // through triggers on every write path; animes.work_id is the work of the linked series and outlives it
                d.exec(`
                    CREATE TABLE IF NOT EXISTS works (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        work_key TEXT NOT NULL UNIQUE,
                        anilist_id INTEGER,
                        mal_id INTEGER,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    );
                `);
                const mangaCols = new Set(d.prepare('PRAGMA table_info(mangas)').all().map(c => c.name));
                if (!mangaCols.has('work_id')) d.exec('ALTER TABLE mangas ADD COLUMN work_id INTEGER REFERENCES works(id);');
                const animeCols = new Set(d.prepare('PRAGMA table_info(animes)').all().map(c => c.name));
                if (!animeCols.has('work_id')) d.exec('ALTER TABLE animes ADD COLUMN work_id INTEGER REFERENCES works(id);');
                d.exec(`
                    CREATE INDEX IF NOT EXISTS idx_mangas_work_id ON mangas (work_id);
                    CREATE INDEX IF NOT EXISTS idx_animes_work_id ON animes (work_id);
                    INSERT OR IGNORE INTO works (work_key, anilist_id, mal_id)
                        SELECT DISTINCT work_key, ${WORK_ANILIST_SQL('work_key')}, ${WORK_MAL_SQL('work_key')} FROM mangas WHERE work_key IS NOT NULL;
                    UPDATE mangas SET work_id = (SELECT w.id FROM works w WHERE w.work_key = mangas.work_key);
                    DROP TRIGGER IF EXISTS trg_mangas_work_insert;
                    CREATE TRIGGER trg_mangas_work_insert AFTER INSERT ON mangas BEGIN
                        ${WORK_TRIGGER_BODY}
                    END;
                `);
                // replayed after migration 45 (no animes.manga_id): that migration's form of the update trigger
                if (!d.prepare('PRAGMA table_info(animes)').all().some(c => c.name === 'manga_id')) {
                    d.exec('DROP TRIGGER IF EXISTS trg_mangas_work_update;');
                    d.exec(WORK_UPDATE_TRIGGER_SQL());
                    return;
                }
                d.exec(`
                    UPDATE animes SET work_id = (SELECT m.work_id FROM mangas m WHERE m.id = animes.manga_id) WHERE manga_id IS NOT NULL;
                    DROP TRIGGER IF EXISTS trg_mangas_work_update;
                    CREATE TRIGGER trg_mangas_work_update AFTER UPDATE OF work_key ON mangas BEGIN
                        ${WORK_TRIGGER_BODY}
                        UPDATE animes SET work_id = (SELECT work_id FROM mangas WHERE id = NEW.id) WHERE manga_id = NEW.id;
                        -- the last edition of a work moved to another key (a merge of work groups): its unlinked anime follow
                        UPDATE animes SET work_id = (SELECT work_id FROM mangas WHERE id = NEW.id)
                            WHERE manga_id IS NULL AND OLD.work_id IS NOT NULL AND work_id = OLD.work_id AND NEW.work_key IS NOT NULL
                              AND NOT EXISTS (SELECT 1 FROM mangas WHERE work_id = OLD.work_id);
                    END;
                `);
            }
        },
        {
            version: 39,
            name: 'add_data_versions',
            up: (d) => {
                // One counter per area that triggers raise on every row written there (any connection): the ETags of the
                // collection endpoints follow it instead of every write of the database (caches, feeds, sessions)
                d.exec(`
                    CREATE TABLE IF NOT EXISTS data_versions (scope TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0);
                    INSERT OR IGNORE INTO data_versions (scope, version) VALUES ('collection', 0), ('anime', 0);
                `);
                const areas = {
                    collection: ['mangas', 'volumes', 'volume_owners', 'volume_reads', 'chapter_progress', 'shelves', 'shelf_members', 'users'],
                    anime: ['animes', 'anime_progress']
                };
                for (const [scope, tables] of Object.entries(areas)) {
                    for (const table of tables) {
                        // replayed after migration 44: volume_owners is a view (volume_copies carries the triggers)
                        if (d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?").get(table)) continue;
                        for (const [suffix, event] of [['ins', 'INSERT'], ['upd', 'UPDATE'], ['del', 'DELETE']]) {
                            d.exec(`CREATE TRIGGER IF NOT EXISTS trg_dv_${table}_${suffix} AFTER ${event} ON ${table} BEGIN
                                UPDATE data_versions SET version = version + 1 WHERE scope = '${scope}';
                            END;`);
                        }
                    }
                }
                // the collection start date is part of GET /stats
                for (const [suffix, event, row] of [['ins', 'INSERT', 'NEW'], ['upd', 'UPDATE', 'NEW'], ['del', 'DELETE', 'OLD']]) {
                    d.exec(`CREATE TRIGGER IF NOT EXISTS trg_dv_app_settings_${suffix} AFTER ${event} ON app_settings
                        WHEN ${row}.key = 'collection_start_date' BEGIN
                            UPDATE data_versions SET version = version + 1 WHERE scope = 'collection';
                        END;`);
                }
            }
        },
        {
            version: 40,
            name: 'harden_value_columns',
            up: (d) => {
                // A volume without a type is a regular volume: stored as such, so queries compare type directly
                // (and the index on manga_id, type, number_sort applies)
                d.exec("UPDATE volumes SET type = 'volume' WHERE type IS NULL OR TRIM(type) = '';");
                // One household shelf: older code could only ever create shelf 1 as the default, keep the lowest one
                const defaults = d.prepare('SELECT id FROM shelves WHERE is_default = 1 ORDER BY id').all();
                if (defaults.length > 1) {
                    log.warn(`[Database] ${defaults.length} household shelves found; shelf ${defaults[0].id} stays the household shelf.`);
                    d.prepare('UPDATE shelves SET is_default = 0 WHERE is_default = 1 AND id <> ?').run(defaults[0].id);
                }
                d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_shelves_one_default ON shelves (is_default) WHERE is_default = 1;');
                // The value lists of core/lib/validate.js as a safety net under every write path (handlers, CSV import,
                // raw SQL of the seeder and the takeover). Frozen here: a new value needs a migration that replaces
                // the triggers. An unchanged stored value passes an UPDATE, so older rows stay editable.
                const checks = [
                    // NULL passes (NOT IN is NULL); an empty type becomes 'volume' through the trigger below
                    // 'Gelesen' is the legacy status that migration 13, the quality check and convertLegacyRead still handle
                    ['volumes', 'status', "'Vorhanden', 'Fehlt', 'Vorbestellt', 'Erscheint bald', 'Bestellt', 'Gelesen'"],
                    ['volumes', 'type', "'volume', 'special_edition', 'schuber', 'special'", "TRIM(NEW.type) <> ''"],
                    ['mangas', 'collecting', "'aktiv', 'pausiert', 'abgebrochen'"],
                    ['mangas', 'format', "'print', 'webtoon'"]
                ];
                for (const [table, column, values, extra] of checks) {
                    const bad = `NEW.${column} NOT IN (${values})${extra ? ` AND ${extra}` : ''}`;
                    const stored = d.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${bad.replace(/NEW\./g, '')}`).get().n;
                    if (stored) log.warn(`[Database] ${stored} rows of ${table}.${column} hold a value outside the list; they stay as they are.`);
                    d.exec(`
                        CREATE TRIGGER IF NOT EXISTS trg_check_${table}_${column}_ins BEFORE INSERT ON ${table} WHEN ${bad} BEGIN
                            SELECT RAISE(ABORT, 'invalid ${table}.${column}');
                        END;
                        CREATE TRIGGER IF NOT EXISTS trg_check_${table}_${column}_upd BEFORE UPDATE OF ${column} ON ${table}
                            WHEN NEW.${column} IS NOT OLD.${column} AND ${bad} BEGIN
                            SELECT RAISE(ABORT, 'invalid ${table}.${column}');
                        END;
                    `);
                }
                // an explicit NULL type (raw SQL, an older offline snapshot in the takeover) becomes a regular volume
                d.exec(`
                    CREATE TRIGGER IF NOT EXISTS trg_volumes_type_default_ins AFTER INSERT ON volumes
                        WHEN NEW.type IS NULL OR TRIM(NEW.type) = '' BEGIN
                        UPDATE volumes SET type = 'volume' WHERE id = NEW.id;
                    END;
                    CREATE TRIGGER IF NOT EXISTS trg_volumes_type_default_upd AFTER UPDATE OF type ON volumes
                        WHEN NEW.type IS NULL OR TRIM(NEW.type) = '' BEGIN
                        UPDATE volumes SET type = 'volume' WHERE id = NEW.id;
                    END;
                `);
            }
        },
        {
            version: 41,
            name: 'add_catalog',
            up: (d) => {
                // Global catalog, stage 1 (core/lib/catalog.js): one row per edition and per volume of it for every shelf that
                // holds it; mangas/volumes point to it and triggers keep the link on every write path. anime_work_links: anime <-> work
                // n:m (the work of the linked series, AniList/MAL relations, later manual links of a shelf)
                d.exec(`
                    CREATE TABLE IF NOT EXISTS catalog_series (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        work_id INTEGER REFERENCES works(id),
                        title TEXT NOT NULL,
                        title_key TEXT NOT NULL,
                        publisher TEXT,
                        publisher_key TEXT NOT NULL DEFAULT '',
                        language TEXT NOT NULL DEFAULT 'de',
                        region TEXT,
                        format TEXT NOT NULL DEFAULT 'print',
                        alt_title TEXT, author TEXT, pub_status TEXT,
                        total_volumes INTEGER, total_chapters INTEGER,
                        list_currency TEXT NOT NULL DEFAULT 'EUR',
                        description TEXT, cover_image TEXT, banner_image TEXT,
                        mp_series_id INTEGER,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_series_mp ON catalog_series (mp_series_id) WHERE mp_series_id IS NOT NULL;
                    CREATE INDEX IF NOT EXISTS idx_catalog_series_match ON catalog_series (title_key, language, format, publisher_key);
                    CREATE INDEX IF NOT EXISTS idx_catalog_series_work ON catalog_series (work_id);
                    CREATE TABLE IF NOT EXISTS catalog_volumes (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        series_id INTEGER NOT NULL REFERENCES catalog_series(id),
                        volume_type TEXT NOT NULL DEFAULT 'volume',
                        volume_number TEXT NOT NULL,
                        number_sort REAL,
                        sort_after REAL,
                        isbn TEXT, language TEXT, publisher TEXT, release_date TEXT, pages INTEGER,
                        list_price REAL,
                        mp_volume_id INTEGER,
                        cover_image TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE (series_id, volume_type, volume_number)
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_volumes_isbn ON catalog_volumes (isbn) WHERE isbn IS NOT NULL;
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_volumes_mp ON catalog_volumes (mp_volume_id) WHERE mp_volume_id IS NOT NULL;
                    CREATE INDEX IF NOT EXISTS idx_catalog_volumes_order ON catalog_volumes (series_id, volume_type, number_sort);
                    CREATE INDEX IF NOT EXISTS idx_catalog_volumes_release ON catalog_volumes (release_date) WHERE release_date IS NOT NULL;
                    CREATE TRIGGER IF NOT EXISTS trg_catalog_volumes_number_sort_ins AFTER INSERT ON catalog_volumes BEGIN
                        UPDATE catalog_volumes SET number_sort = ${numberSortExpr('NEW.volume_number')} WHERE id = NEW.id;
                    END;
                    CREATE TRIGGER IF NOT EXISTS trg_catalog_volumes_number_sort_upd AFTER UPDATE OF volume_number ON catalog_volumes BEGIN
                        UPDATE catalog_volumes SET number_sort = ${numberSortExpr('NEW.volume_number')} WHERE id = NEW.id;
                    END;
                    CREATE TABLE IF NOT EXISTS catalog_merge_log (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        kind TEXT NOT NULL,
                        catalog_id INTEGER,
                        old_ids TEXT NOT NULL,
                        detail TEXT NOT NULL,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE TABLE IF NOT EXISTS anime_work_links (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        anime_id INTEGER NOT NULL REFERENCES animes(id) ON DELETE CASCADE,
                        work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
                        relation TEXT NOT NULL CHECK (relation IN ('SOURCE', 'ADAPTATION', 'SPIN_OFF', 'SIDE_STORY', 'ALTERNATIVE', 'OTHER')),
                        origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('collection', 'anilist', 'mal', 'manual')),
                        scope_shelf_id INTEGER REFERENCES shelves(id) ON DELETE CASCADE,
                        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1) AND (hidden = 0 OR scope_shelf_id IS NOT NULL)),
                        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_anime_work_links_unique ON anime_work_links (anime_id, work_id, relation, COALESCE(scope_shelf_id, 0));
                    CREATE INDEX IF NOT EXISTS idx_anime_work_links_work ON anime_work_links (work_id, anime_id);
                `);
                const mangaCols = new Set(d.prepare('PRAGMA table_info(mangas)').all().map(c => c.name));
                if (!mangaCols.has('catalog_series_id')) d.exec('ALTER TABLE mangas ADD COLUMN catalog_series_id INTEGER REFERENCES catalog_series(id);');
                const volumeCols = new Set(d.prepare('PRAGMA table_info(volumes)').all().map(c => c.name));
                if (!volumeCols.has('catalog_volume_id')) d.exec('ALTER TABLE volumes ADD COLUMN catalog_volume_id INTEGER REFERENCES catalog_volumes(id);');
                d.exec(`
                    CREATE INDEX IF NOT EXISTS idx_mangas_catalog ON mangas (catalog_series_id);
                    CREATE INDEX IF NOT EXISTS idx_volumes_catalog ON volumes (catalog_volume_id);
                `);
                backfillCatalog(d, log);
                d.exec(CATALOG_TRIGGERS_SQL);
                d.exec(ANIME_LINK_TRIGGERS_SQL);
            }
        },
        {
            version: 42,
            name: 'add_missing_foreign_keys',
            foreignKeys: false,
            up: (d) => {
                // Columns added by ALTER TABLE without REFERENCES (mangas.shelf_id, trash.shelf_id, shelves.owner_user_id) and
                // user references without an ON DELETE get their foreign keys through a rebuild. Rows pointing nowhere are
                // repaired first (logged): a series into shelf 1, a trash entry likewise, a missing user becomes NULL.
                const repairs = [
                    ['mangas without a shelf -> shelf 1', 'UPDATE mangas SET shelf_id = 1 WHERE shelf_id IS NULL OR shelf_id NOT IN (SELECT id FROM shelves)'],
                    ['trash entries without a shelf -> shelf 1', 'UPDATE trash SET shelf_id = 1 WHERE shelf_id IS NULL OR shelf_id NOT IN (SELECT id FROM shelves)'],
                    ['shelf owners without an account -> NULL', 'UPDATE shelves SET owner_user_id = NULL WHERE owner_user_id IS NOT NULL AND owner_user_id NOT IN (SELECT id FROM users)'],
                    ['series editors without an account -> NULL', 'UPDATE mangas SET updated_by = NULL WHERE updated_by IS NOT NULL AND updated_by NOT IN (SELECT id FROM users)'],
                    ['anime editors without an account -> NULL', 'UPDATE animes SET updated_by = NULL WHERE updated_by IS NOT NULL AND updated_by NOT IN (SELECT id FROM users)']
                ];
                if (!d.prepare('SELECT 1 FROM shelves WHERE id = 1').get()) d.exec("INSERT INTO shelves (id, name, is_default) VALUES (1, 'Sammlung', 1);");
                for (const [what, sql] of repairs) {
                    const changed = d.prepare(sql).run().changes;
                    if (changed) log.warn(`[Database Migration] v42: ${changed} ${what}`);
                }
                const withForeignKeys = (sql, keys) => {
                    let out = sql;
                    const clauses = [];
                    for (const [col, target] of Object.entries(keys)) {
                        // drop an existing column-level or table-level reference of the column, then name it once at the end
                        out = out.replace(new RegExp(`(\\b${col}\\s+INTEGER)\\s+REFERENCES\\s+\\w+\\s*\\(\\s*id\\s*\\)(\\s+ON\\s+DELETE\\s+(SET\\s+NULL|CASCADE|RESTRICT|NO\\s+ACTION))?`, 'i'), '$1');
                        out = out.replace(new RegExp(`,\\s*FOREIGN\\s+KEY\\s*\\(\\s*${col}\\s*\\)\\s*REFERENCES\\s+\\w+\\s*\\(\\s*id\\s*\\)(\\s+ON\\s+DELETE\\s+(SET\\s+NULL|CASCADE|RESTRICT|NO\\s+ACTION))?`, 'i'), '');
                        clauses.push(`FOREIGN KEY (${col}) REFERENCES ${target}`);
                    }
                    return replaceOnce(out, /\)\s*$/, `,\n            ${clauses.join(',\n            ')}\n        )`, 'table definition');
                };
                const targets = {
                    shelves: { owner_user_id: 'users(id) ON DELETE SET NULL' },
                    mangas: { shelf_id: 'shelves(id) ON DELETE RESTRICT', updated_by: 'users(id) ON DELETE SET NULL' },
                    trash: { shelf_id: 'shelves(id) ON DELETE CASCADE' },
                    animes: { updated_by: 'users(id) ON DELETE SET NULL' }
                };
                for (const [table, keys] of Object.entries(targets)) {
                    // a replayed migration finds the keys in place and leaves the table alone
                    const present = d.prepare(`PRAGMA foreign_key_list(${table})`).all();
                    const done = Object.entries(keys).every(([col, target]) => present.some(f => f.from === col
                        && `${f.table}(${f.to})`.toLowerCase() === target.split(' ')[0].toLowerCase()
                        && f.on_delete === target.split(' ON DELETE ')[1]));
                    if (!done) rebuildTable(d, table, sql => withForeignKeys(sql, keys));
                }
            }
        },
        {
            version: 43,
            name: 'marks_on_catalog',
            up: (d) => {
                // Reading marks and chapter progress move from the shelf rows to the catalog (core/lib/marks.js): volume_reads
                // by catalog_volume_id, chapter_progress by catalog_series_id. Rows of shelves holding the same edition merge
                // (earliest read, highest chapter). The views shelf_volume_reads/shelf_chapter_progress show them per row.
                for (const name of MARK_VIEWS) d.exec(`DROP VIEW IF EXISTS ${name};`);
                for (const name of MARK_FOLLOW_TRIGGERS) d.exec(`DROP TRIGGER IF EXISTS ${name};`);
                // each table once (a replayed migration finds it keyed by the catalog already)
                const move = (table, { keyed, ddl, unlinkedSql, copySql, hiddenSql }) => {
                    if (keyed(d)) return;
                    const unlinked = d.prepare(unlinkedSql).get().n;
                    if (unlinked) throw new Error(`${table}: ${unlinked} rows of series or volumes without a catalog entry`);
                    const before = d.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
                    const hidden = d.prepare(hiddenSql).get().n;
                    d.exec(`${ddl.replace('{name}', `${table}_catalog`)}; ${copySql}; DROP TABLE ${table};`);
                    // nothing else names the table; the legacy rename does not re-check the triggers of other tables
                    d.exec('PRAGMA legacy_alter_table = ON;');
                    try { d.exec(`ALTER TABLE ${table}_catalog RENAME TO ${table};`); } finally { d.exec('PRAGMA legacy_alter_table = OFF;'); }
                    const after = d.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
                    if (before) log.info(`[Database Migration] v43: ${table} ${before} -> ${after} rows on the catalog (${hidden} of users outside the shelf, kept hidden)`);
                };
                const outsideShelf = (alias, mangaAlias) => `NOT EXISTS (SELECT 1 FROM shelf_members sm WHERE sm.shelf_id = ${mangaAlias}.shelf_id AND sm.user_id = ${alias}.user_id)`;
                move('volume_reads', {
                    keyed: marksOnCatalog,
                    ddl: `CREATE TABLE {name} (
                            catalog_volume_id INTEGER NOT NULL REFERENCES catalog_volumes(id),
                            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            PRIMARY KEY (catalog_volume_id, user_id)
                        )`,
                    unlinkedSql: 'SELECT count(*) AS n FROM volume_reads r JOIN volumes v ON v.id = r.volume_id WHERE v.catalog_volume_id IS NULL',
                    hiddenSql: `SELECT count(*) AS n FROM volume_reads r JOIN volumes v ON v.id = r.volume_id JOIN mangas m ON m.id = v.manga_id WHERE ${outsideShelf('r', 'm')}`,
                    copySql: `INSERT INTO volume_reads_catalog (catalog_volume_id, user_id, read_at)
                        SELECT v.catalog_volume_id, r.user_id, MIN(r.read_at) FROM volume_reads r JOIN volumes v ON v.id = r.volume_id
                        GROUP BY v.catalog_volume_id, r.user_id`
                });
                move('chapter_progress', {
                    keyed: chaptersOnCatalog,
                    ddl: `CREATE TABLE {name} (
                            catalog_series_id INTEGER NOT NULL REFERENCES catalog_series(id),
                            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            chapters_read INTEGER NOT NULL,
                            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            PRIMARY KEY (catalog_series_id, user_id)
                        )`,
                    unlinkedSql: 'SELECT count(*) AS n FROM chapter_progress p JOIN mangas m ON m.id = p.manga_id WHERE m.catalog_series_id IS NULL',
                    hiddenSql: `SELECT count(*) AS n FROM chapter_progress p JOIN mangas m ON m.id = p.manga_id WHERE ${outsideShelf('p', 'm')}`,
                    copySql: `INSERT INTO chapter_progress_catalog (catalog_series_id, user_id, chapters_read, updated_at)
                        SELECT m.catalog_series_id, p.user_id, MAX(p.chapters_read), MAX(p.updated_at) FROM chapter_progress p JOIN mangas m ON m.id = p.manga_id
                        GROUP BY m.catalog_series_id, p.user_id`
                });
                d.exec(`
                    CREATE INDEX IF NOT EXISTS idx_volume_reads_user ON volume_reads (user_id);
                    CREATE INDEX IF NOT EXISTS idx_chapter_progress_user ON chapter_progress (user_id);
                    ${dataVersionTriggersSql('volume_reads', 'collection')}
                    ${dataVersionTriggersSql('chapter_progress', 'collection')}
                    ${MARK_VIEWS_SQL}
                    ${MARK_FOLLOW_TRIGGERS_SQL}
                `);
            }
        },
        {
            version: 44,
            name: 'add_volume_copies',
            up: (d) => {
                // Copies instead of an owner flag (core/lib/copies.js): every owner row becomes a personal copy, an owned
                // volume without owner a household copy; triggers keep volumes.status on the copies from now on and
                // volume_owners becomes a view of the personal copies (the shape every reader and the API know).
                for (const name of COPY_TRIGGERS) d.exec(`DROP TRIGGER IF EXISTS ${name};`);
                d.exec(COPIES_TABLE_SQL);
                const ownersTable = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'volume_owners'").get();
                let personal = 0;
                if (ownersTable) {
                    personal = d.prepare(`INSERT INTO volume_copies (volume_id, owner_user_id, purchase_price, purchase_date, condition, created_at)
                        SELECT o.volume_id, o.user_id, o.price, o.purchase_date, o.condition, COALESCE(o.created_at, CURRENT_TIMESTAMP)
                        FROM volume_owners o
                        WHERE NOT EXISTS (SELECT 1 FROM volume_copies c WHERE c.volume_id = o.volume_id AND c.owner_user_id = o.user_id)
                        ORDER BY o.created_at, o.rowid`).run().changes;
                    d.exec('DROP TABLE volume_owners;');
                }
                d.exec('DROP VIEW IF EXISTS volume_owners;');
                const household = d.prepare(`INSERT INTO volume_copies (volume_id, purchase_price, purchase_date, condition, created_at)
                    SELECT v.id, v.price, v.purchase_date, v.condition, COALESCE(v.created_at, CURRENT_TIMESTAMP) FROM volumes v
                    WHERE v.status = 'Vorhanden' AND NOT EXISTS (SELECT 1 FROM volume_copies c WHERE c.volume_id = v.id)
                    ORDER BY v.id`).run().changes;
                // owners on a volume with another status: the volume becomes owned (the cleanup fix status_from_owners did that)
                const owned = d.prepare(`UPDATE volumes SET status = 'Vorhanden'
                    WHERE status IS NOT 'Vorhanden' AND lower(trim(COALESCE(status, ''))) <> 'gelesen'
                      AND EXISTS (SELECT 1 FROM volume_copies c WHERE c.volume_id = volumes.id)`).run().changes;
                d.exec(`
                    ${OWNERS_VIEW_SQL}
                    ${dataVersionTriggersSql('volume_copies', 'collection')}
                    ${COPY_TRIGGERS_SQL}
                `);
                if (personal || household || owned) {
                    log.info(`[Database Migration] v44: ${personal} owner rows -> personal copies, ${household} owned volumes without owner -> household copies, ${owned} volumes with owners but another status -> 'Vorhanden'`);
                }
            }
        },
        {
            version: 45,
            name: 'anime_links_on_works',
            foreignKeys: false,
            up: (d) => {
                // The series link of an anime is a link to its work (core/lib/animeLinks.js): animes.work_id for everyone, shelf
                // rows in anime_work_links (origin 'manual', scope_shelf_id) that name the chosen edition (manga_id) or hide the
                // link for that shelf. animes.manga_id goes: a series linked without a work gets a manual key of its own first.
                const linkCols = new Set(d.prepare('PRAGMA table_info(anime_work_links)').all().map(c => c.name));
                if (!linkCols.has('manga_id')) d.exec('ALTER TABLE anime_work_links ADD COLUMN manga_id INTEGER REFERENCES mangas(id) ON DELETE SET NULL;');
                d.exec(`
                    CREATE INDEX IF NOT EXISTS idx_anime_work_links_shelf ON anime_work_links (scope_shelf_id, anime_id) WHERE scope_shelf_id IS NOT NULL;
                    CREATE INDEX IF NOT EXISTS idx_anime_work_links_manga ON anime_work_links (manga_id) WHERE manga_id IS NOT NULL;
                `);
                if (d.prepare('PRAGMA table_info(animes)').all().some(c => c.name === 'manga_id')) {
                    const keyed = d.prepare(`UPDATE mangas SET work_key = 'manual:' || lower(hex(randomblob(12)))
                        WHERE work_key IS NULL AND id IN (SELECT manga_id FROM animes WHERE manga_id IS NOT NULL)`).run().changes;
                    d.exec(`UPDATE animes SET work_id = (SELECT m.work_id FROM mangas m WHERE m.id = animes.manga_id)
                        WHERE manga_id IS NOT NULL AND EXISTS (SELECT 1 FROM mangas m WHERE m.id = animes.manga_id);`);
                    // the edition chosen so far stays the one its shelf sees
                    const pinned = d.prepare(`INSERT OR IGNORE INTO anime_work_links (anime_id, work_id, relation, origin, scope_shelf_id, hidden, manga_id)
                        SELECT a.id, m.work_id, 'SOURCE', 'manual', m.shelf_id, 0, m.id FROM animes a JOIN mangas m ON m.id = a.manga_id
                         WHERE m.work_id IS NOT NULL AND m.shelf_id IS NOT NULL`).run().changes;
                    if (keyed || pinned) log.info(`[Database Migration] v45: ${pinned} anime links -> links to the work, ${keyed} series got a work of their own`);
                    d.exec('DROP INDEX IF EXISTS idx_animes_manga;');
                    rebuildTable(d, 'animes', (sql) => replaceOnce(sql, /\s*\bmanga_id\s+INTEGER\s+REFERENCES\s+mangas\s*\(\s*id\s*\)\s+ON\s+DELETE\s+SET\s+NULL\s*,/i, '', 'animes.manga_id'),
                        { dropColumns: ['manga_id'] });
                }
                d.exec('DROP TRIGGER IF EXISTS trg_mangas_work_update;');
                d.exec(WORK_UPDATE_TRIGGER_SQL());
                d.exec(ANIME_PIN_SHELF_TRIGGER_SQL);
            }
        },
        {
            version: 46,
            name: 'catalog_owns_editions',
            up: (d) => {
                // Catalog stage 3 (core/lib/catalog.js, core/lib/catalogWrite.js): the catalog owns the edition data. The rows keep
                // their columns as a copy a shelf can override per field (local_fields); a catalog change flows into every row
                // where the field is not local, a row write reaches the catalog only through catalogWrite.js. Everything a row
                // has that differs from its entry is local from the start, so no shelf sees another value than before.
                const cols = (t) => new Set(d.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
                if (!cols('catalog_series').has('tags')) d.exec('ALTER TABLE catalog_series ADD COLUMN tags TEXT;');
                if (!cols('catalog_volumes').has('release_year')) d.exec('ALTER TABLE catalog_volumes ADD COLUMN release_year INTEGER;');
                if (!cols('mangas').has('local_fields')) d.exec('ALTER TABLE mangas ADD COLUMN local_fields TEXT;');
                if (!cols('volumes').has('local_fields')) d.exec('ALTER TABLE volumes ADD COLUMN local_fields TEXT;');
                // the overlay fields whose catalog value came from a source (Manga Passion): the only values a reset may show
                if (!cols('catalog_series').has('source_fields')) d.exec('ALTER TABLE catalog_series ADD COLUMN source_fields TEXT;');
                if (!cols('catalog_volumes').has('source_fields')) d.exec('ALTER TABLE catalog_volumes ADD COLUMN source_fields TEXT;');
                // the new catalog columns from the rows, the way the stage 1 backfill picked: the first row that has one
                d.exec(`
                    UPDATE catalog_series SET tags = (SELECT m.tags FROM mangas m WHERE m.catalog_series_id = catalog_series.id
                        AND m.tags IS NOT NULL AND trim(m.tags) <> '' ORDER BY m.id LIMIT 1) WHERE tags IS NULL
                        AND EXISTS (SELECT 1 FROM mangas m WHERE m.catalog_series_id = catalog_series.id AND m.tags IS NOT NULL AND trim(m.tags) <> '');
                    UPDATE catalog_volumes SET release_year = (SELECT v.release_year FROM volumes v WHERE v.catalog_volume_id = catalog_volumes.id
                        AND v.release_year IS NOT NULL ORDER BY v.id LIMIT 1) WHERE release_year IS NULL
                        AND EXISTS (SELECT 1 FROM volumes v WHERE v.catalog_volume_id = catalog_volumes.id AND v.release_year IS NOT NULL);
                `);
                for (const name of ['trg_mangas_catalog_insert', 'trg_mangas_catalog_identity', 'trg_mangas_catalog_shared', 'trg_mangas_catalog_relink',
                    'trg_volumes_catalog_insert', 'trg_volumes_catalog_identity', 'trg_volumes_catalog_shared',
                    'trg_catalog_series_overlay', 'trg_catalog_volumes_overlay']) d.exec(`DROP TRIGGER IF EXISTS ${name};`);
                // an entry only one row shows takes that row's values (stage 1 kept values of rows deleted since), then
                // whatever a row of a shared entry has of its own is local
                d.exec(`
                    ${ADOPT_SERIES_SQL('(SELECT m2.id FROM mangas m2 WHERE m2.catalog_series_id = catalog_series.id ORDER BY m2.id LIMIT 1)')}
                    ${ADOPT_VOLUME_SQL('(SELECT v2.id FROM volumes v2 WHERE v2.catalog_volume_id = catalog_volumes.id ORDER BY v2.id LIMIT 1)')}
                    ${MARK_SERIES_LOCAL('1 = 1')}
                    ${MARK_VOLUMES_LOCAL('1 = 1')}
                `);
                d.exec(CATALOG_TRIGGERS_V3_SQL);
                const series = d.prepare('SELECT count(*) AS n FROM mangas WHERE local_fields IS NOT NULL').get().n;
                const volumes = d.prepare('SELECT count(*) AS n FROM volumes WHERE local_fields IS NOT NULL').get().n;
                if (series || volumes) log.info(`[Database Migration] v46: ${series} series and ${volumes} volumes keep values of their own (local fields)`);
            }
        },
        {
            version: 47,
            name: 'add_copy_lending',
            up: (d) => {
                // who borrowed a copy: an account (lent_to_user_id; lent_to_name keeps its name should the account go) or a
                // person without one (lent_to_name only), since lent_at (YYYY-MM-DD). Nothing is lent after the migration.
                const cols = new Set(d.prepare('PRAGMA table_info(volume_copies)').all().map(c => c.name));
                if (!cols.has('lent_to_user_id')) d.exec('ALTER TABLE volume_copies ADD COLUMN lent_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;');
                if (!cols.has('lent_to_name')) d.exec('ALTER TABLE volume_copies ADD COLUMN lent_to_name TEXT;');
                if (!cols.has('lent_at')) d.exec('ALTER TABLE volume_copies ADD COLUMN lent_at TEXT;');
                d.exec(`
                    CREATE INDEX IF NOT EXISTS idx_volume_copies_lent_to ON volume_copies (lent_to_user_id) WHERE lent_to_user_id IS NOT NULL;
                    DROP VIEW IF EXISTS volume_owners;
                    ${OWNERS_VIEW_LENT_SQL}
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
function pendingMigrations(database, log, list = migrationList(log)) {
    const tracked = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    const applied = new Set(tracked ? database.prepare('SELECT version FROM schema_migrations').all().map(r => r.version) : []);
    return list.filter(m => !applied.has(m.version));
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
 * options.beforeMigrations(database, pending) runs once before the first one (the server snapshots there);
 * options.migrations replaces migrationList() (tests only).
 */
function runSequentialMigrations(database, options = {}) {
    const log = options.log || silentLog;
    const pending = pendingMigrations(database, log, options.migrations || migrationList(log));
    const fresh = isFreshDatabase(database);
    ensureMigrationsTable(database);
    if (!pending.length) return [];

    if (options.beforeMigrations) options.beforeMigrations(database, pending);

    const totalChanges = () => database.prepare('SELECT total_changes() AS n').get().n;
    // every row a migration writes in a versioned table also raises a data_versions counter (migration 39): not counted
    const versionBumps = () => (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_versions'").get()
        ? database.prepare('SELECT COALESCE(SUM(version), 0) AS n FROM data_versions').get().n : 0);
    const report = [];
    for (const mig of pending) {
        const started = Date.now();
        const changesBefore = totalChanges();
        const bumpsBefore = versionBumps();
        // a migration that rebuilds tables runs with foreign keys off (PRAGMA foreign_keys is a no-op inside a transaction, so
        // it is switched before BEGIN) and must leave no violation behind; the previous setting comes back either way
        const keysOff = mig.foreignKeys === false;
        const keysWereOn = keysOff && Boolean(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys);
        if (keysWereOn) database.exec('PRAGMA foreign_keys = OFF;');
        database.exec('BEGIN TRANSACTION;');
        try {
            mig.up(database);
            if (keysOff) {
                const violations = database.prepare('PRAGMA foreign_key_check').all();
                if (violations.length) {
                    const sample = violations.slice(0, 5).map(v => `${v.table}#${v.rowid} -> ${v.parent}`).join(', ');
                    throw new Error(`foreign key violations after the migration (${violations.length}): ${sample}`);
                }
            }
            database.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(mig.version, mig.name);
            database.exec('COMMIT;');
        } catch (err) {
            try { database.exec('ROLLBACK;'); } catch (rbErr) { log.warn('[Database Migration] ROLLBACK failed:', rbErr.message); }
            log.error(`[Database Migration] Failed migration v${mig.version} (${mig.name}):`, err);
            throw err;
        } finally {
            if (keysWereOn) database.exec('PRAGMA foreign_keys = ON;');
        }
        // minus the schema_migrations row itself and the counter updates of the data version triggers
        const entry = { version: mig.version, name: mig.name, changes: totalChanges() - changesBefore - 1 - (versionBumps() - bumpsBefore), ms: Date.now() - started };
        report.push(entry);
        if (fresh) continue;
        log.info(`[Database Migration] v${entry.version} ${entry.name}: ${entry.changes.toLocaleString('de-DE')} Zeilen geändert, ${entry.ms} ms`);
    }
    if (fresh) log.info(`[Database Migration] Neue Datenbank angelegt (Schema v${report[report.length - 1].version}, ${report.length} Migrationen, ${report.reduce((sum, r) => sum + r.ms, 0)} ms)`);
    return report;
}

/** True for a database nobody has used: no migration recorded yet and no account or series, so its migrations change nothing worth listing. */
function isFreshDatabase(database) {
    const has = name => database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (has('schema_migrations')) return false;
    return ['users', 'mangas'].every(name => !has(name) || !database.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get());
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
            format TEXT NOT NULL DEFAULT 'print',
            total_chapters INTEGER,
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
            sort_after REAL,
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
