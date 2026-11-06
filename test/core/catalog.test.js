// Global catalog stage 1 (migrations 41 and 42, core/lib/catalog.js): backfill with deduplication, the triggers that keep
// mangas/volumes linked on every write path, anime <-> work links and the foreign keys added by the rebuild.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const schema = require('../../core/schema');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const CATALOG_MIGRATIONS = [41, 42];

/** A database at schema v40 with `seed` applied, then migrated to the latest version. */
function migratedFrom39(seed) {
    const conn = new DatabaseSync(':memory:');
    conn.exec('PRAGMA foreign_keys = ON;');
    schema.ensureMigrationsTable(conn);
    const hold = conn.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, 'held back')");
    for (const v of CATALOG_MIGRATIONS) hold.run(v);
    schema.applySchema(conn, { log: quiet });
    seed(conn);
    conn.prepare(`DELETE FROM schema_migrations WHERE version IN (${CATALOG_MIGRATIONS.join(', ')})`).run();
    const report = schema.runSequentialMigrations(conn, { log: quiet });
    assert.deepEqual(report.map(r => r.version), CATALOG_MIGRATIONS);
    return conn;
}

const fresh = () => {
    const conn = new DatabaseSync(':memory:');
    conn.exec('PRAGMA foreign_keys = ON;');
    schema.applySchema(conn, { log: quiet });
    conn.exec(`
        INSERT INTO users (id, username, password_hash, role) VALUES (1, 'alice', 'x', 'admin'), (2, 'bob', 'x', 'editor');
        INSERT INTO shelves (id, name, owner_user_id) VALUES (2, 'Bob', 2);
    `);
    return conn;
};

const seedDuplicates = (d) => d.exec(`
    INSERT INTO users (id, username, password_hash, role) VALUES (1, 'alice', 'x', 'admin'), (2, 'bob', 'x', 'editor');
    INSERT INTO shelves (id, name, owner_user_id) VALUES (2, 'Bob', 2);
    INSERT INTO mangas (id, title, publisher, language, total_volumes, manga_passion_id, work_key, shelf_id, updated_at) VALUES
        (1, 'One Piece', 'Carlsen', 'de', 110, 100, 'anilist:30013', 1, '2026-01-01'),
        (2, 'One Piece', 'Carlsen', 'de', 109, 100, 'anilist:30013', 2, '2025-01-01'),
        (3, 'ONE PIECE!', 'Carlsen', 'de', NULL, NULL, NULL, 1, '2024-01-01'),
        (4, 'Frieren', 'Egmont', 'de', NULL, NULL, NULL, 1, NULL),
        (5, 'frieren', 'Egmont Manga', 'de', NULL, NULL, NULL, 2, NULL),
        (6, 'One Piece', 'VIZ', 'en', NULL, NULL, 'anilist:30013', 2, NULL),
        (7, 'Solo Leveling', 'altraverse', 'de', NULL, NULL, NULL, 2, NULL);
    UPDATE mangas SET format = 'webtoon' WHERE id = 7;
    INSERT INTO volumes (id, manga_id, volume_number, isbn, price, release_date, status) VALUES
        (11, 1, '1', '9783551745712', 6.5, '2001-07', 'Vorhanden'), (12, 1, '2', '9783551745729', 6.5, NULL, 'Fehlt'),
        (21, 2, '1', '9783551745712', NULL, NULL, 'Vorhanden'), (22, 2, '2 ', '9783551740000', 7.0, '2001-09', 'Fehlt'),
        (31, 3, '1', NULL, NULL, NULL, 'Vorhanden'),
        (41, 4, '1', '9783770400001', 7.0, NULL, 'Vorhanden'),
        (51, 5, '1', '9783770400001', NULL, NULL, 'Fehlt'), (52, 5, '2', '9783770400002', 7.0, NULL, 'Fehlt'),
        (61, 6, '1', '9781569319017', 9.99, NULL, 'Vorhanden');
    INSERT INTO animes (id, anilist_id, title, manga_id, relations) VALUES
        (1, 21, 'One Piece', 1, '[{"relation":"SOURCE","kind":"MANGA","anilist_id":30013,"mal_id":13}]'),
        (2, 154587, 'Frieren', NULL, '[{"relation":"SOURCE","kind":"MANGA","anilist_id":118586,"mal_id":null},{"relation":"SEQUEL","kind":"ANIME","anilist_id":1}]');
    UPDATE animes SET work_id = (SELECT work_id FROM mangas WHERE id = 1) WHERE id = 1;
    INSERT INTO trash (kind, ref_id, manga_id, title, payload, shelf_id) VALUES ('volume', 99, 1, 'x', '{}', 1);
`);

const catalogOf = (d, mangaId) => d.prepare('SELECT catalog_series_id AS c FROM mangas WHERE id = ?').get(mangaId).c;
const catalogVolumeOf = (d, volumeId) => d.prepare('SELECT catalog_volume_id AS c FROM volumes WHERE id = ?').get(volumeId).c;

test('migration 41 folds duplicates into one catalog series per edition and one catalog volume per number', () => {
    const d = migratedFrom39(seedDuplicates);
    assert.equal(catalogOf(d, 1), catalogOf(d, 2), 'same Manga Passion edition in two shelves');
    assert.equal(catalogOf(d, 1), catalogOf(d, 3), 'title key ignores case and punctuation');
    assert.equal(catalogOf(d, 4), catalogOf(d, 5), 'a shared ISBN joins different publisher spellings');
    assert.notEqual(catalogOf(d, 6), catalogOf(d, 1), 'the English edition is its own catalog series');
    assert.equal(d.prepare('SELECT count(*) AS n FROM catalog_series').get().n, 4);
    const onePiece = d.prepare('SELECT * FROM catalog_series WHERE id = ?').get(catalogOf(d, 1));
    assert.deepEqual([onePiece.title, onePiece.mp_series_id, onePiece.total_volumes], ['One Piece', 100, 110], 'values of the newest Manga Passion row');
    assert.equal(onePiece.work_id, d.prepare('SELECT work_id FROM catalog_series WHERE id = ?').get(catalogOf(d, 6)).work_id, 'both editions share the work');
    assert.equal(d.prepare('SELECT title FROM catalog_series WHERE id = ?').get(catalogOf(d, 4)).title, 'Frieren');
    assert.equal(catalogVolumeOf(d, 11), catalogVolumeOf(d, 21));
    assert.equal(catalogVolumeOf(d, 11), catalogVolumeOf(d, 31));
    assert.equal(catalogVolumeOf(d, 12), catalogVolumeOf(d, 22), '"2 " and "2" are one volume');
    const vol2 = d.prepare('SELECT * FROM catalog_volumes WHERE id = ?').get(catalogVolumeOf(d, 12));
    // the preferred row's values first, a missing one from the next row
    assert.deepEqual([vol2.isbn, vol2.list_price, vol2.release_date, vol2.number_sort], ['9783551745729', 6.5, '2001-09', 2]);
    assert.ok(d.prepare("SELECT 1 FROM catalog_merge_log WHERE kind = 'volume_isbn'").get(), 'two ISBNs for volume 2 are logged');
    assert.ok(d.prepare("SELECT 1 FROM catalog_merge_log WHERE kind = 'series_field' AND detail LIKE 'total_volumes%'").get());
    assert.equal(d.prepare('SELECT count(*) AS n FROM volumes WHERE catalog_volume_id IS NULL').get().n, 0);
    assert.equal(d.prepare('SELECT count(*) AS n FROM mangas WHERE catalog_series_id IS NULL').get().n, 0);
});

test('migration 41 links anime to works: the linked series and the AniList relations', () => {
    const d = migratedFrom39(seedDuplicates);
    const links = d.prepare('SELECT anime_id, work_id, relation, origin FROM anime_work_links ORDER BY anime_id, origin').all().map(r => ({ ...r }));
    const work = d.prepare('SELECT work_id FROM mangas WHERE id = 1').get().work_id;
    // the work of the linked series and the AniList SOURCE relation name the same link: it is stored once
    assert.deepEqual(links, [{ anime_id: 1, work_id: work, relation: 'SOURCE', origin: 'collection' }]);
    // Frieren's work (AniList 118586) appears once a series names it: the anime links by its stored relations
    d.prepare("UPDATE mangas SET work_key = 'anilist:118586' WHERE id = 4").run();
    const frieren = d.prepare('SELECT work_id FROM mangas WHERE id = 4').get().work_id;
    assert.ok(frieren);
    assert.deepEqual({ ...d.prepare('SELECT relation, origin FROM anime_work_links WHERE anime_id = 2 AND work_id = ?').get(frieren) },
        { relation: 'SOURCE', origin: 'anilist' });
    // clearing the relations removes the automatic links, the anime keeps none
    d.prepare('UPDATE animes SET relations = NULL WHERE id = 2').run();
    assert.equal(d.prepare('SELECT count(*) AS n FROM anime_work_links WHERE anime_id = 2').get().n, 0);
});

test('migration 42 adds the missing foreign keys and keeps rows, indexes, triggers and AUTOINCREMENT state', () => {
    const d = migratedFrom39((conn) => {
        seedDuplicates(conn);
        conn.exec("INSERT INTO mangas (id, title, shelf_id) VALUES (90, 'Verwaist', 77)");   // shelf 77 never existed
        conn.exec('INSERT INTO mangas (id, title) VALUES (500, \'hoch\'); DELETE FROM mangas WHERE id = 500;');
    });
    const fks = (table) => d.prepare(`PRAGMA foreign_key_list(${table})`).all().map(f => `${f.from}->${f.table}:${f.on_delete}`).sort();
    assert.deepEqual(fks('mangas'), ['catalog_series_id->catalog_series:NO ACTION', 'shelf_id->shelves:RESTRICT', 'updated_by->users:SET NULL',
        'work_id->works:NO ACTION']);
    assert.deepEqual(fks('trash').filter(f => f.startsWith('shelf_id')), ['shelf_id->shelves:CASCADE']);
    assert.deepEqual(fks('shelves'), ['owner_user_id->users:SET NULL']);
    assert.ok(fks('animes').includes('updated_by->users:SET NULL'));
    assert.equal(d.prepare('SELECT shelf_id FROM mangas WHERE id = 90').get().shelf_id, 1, 'orphan moved into shelf 1');
    assert.equal(d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'mangas'").get().seq, 500, 'deleted ids are never handed out again');
    const triggers = d.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'mangas'").all().map(r => r.name);
    for (const name of ['trg_mangas_catalog_insert', 'trg_mangas_work_insert', 'trg_mangas_shelf_default', 'trg_dv_mangas_upd']) assert.ok(triggers.includes(name), name);
    assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_mangas_catalog'").get());
    assert.equal(d.prepare('SELECT count(*) AS n FROM volumes').get().n, 9, 'the rebuild of mangas cascaded nothing');
    assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(d.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys are on again');
    assert.throws(() => d.exec('DELETE FROM shelves WHERE id = 2'), /FOREIGN KEY/, 'a shelf with series stays');
    d.exec('DELETE FROM users WHERE id = 2');
    assert.equal(d.prepare('SELECT owner_user_id FROM shelves WHERE id = 2').get().owner_user_id, null);
});

test('a migration with foreignKeys: false rolls back and switches the keys on again when it leaves a violation', () => {
    const conn = new DatabaseSync(':memory:');
    conn.exec('PRAGMA foreign_keys = ON; CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER REFERENCES p(id));');
    schema.ensureMigrationsTable(conn);
    for (const m of schema.migrationList()) conn.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    const bad = { version: schema.LATEST_SCHEMA_VERSION + 1, name: 'bad', foreignKeys: false, up: (d) => d.exec('INSERT INTO c VALUES (5)') };
    assert.throws(() => schema.runSequentialMigrations(conn, { log: quiet, migrations: [...schema.migrationList(), bad] }), /foreign key violations/);
    assert.equal(conn.prepare('SELECT count(*) AS n FROM c').get().n, 0);
    assert.equal(conn.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

test('triggers link new series and volumes to the catalog on every write path', () => {
    const d = fresh();
    d.exec(`
        INSERT INTO mangas (id, title, publisher, language, manga_passion_id, shelf_id) VALUES (1, 'Dandadan', 'Crunchyroll', 'de', 7, 1);
        INSERT INTO mangas (id, title, publisher, language, manga_passion_id, shelf_id) VALUES (2, 'Dandadan', 'Crunchyroll', 'de', 7, 2);
        INSERT INTO mangas (id, title, publisher, language, shelf_id) VALUES (3, 'Dandadan!', 'Crunchyroll', 'de', 2);
        INSERT INTO mangas (id, title, publisher, language, shelf_id) VALUES (4, 'Dandadan', 'Crunchyroll', 'en', 2);
        INSERT INTO volumes (id, manga_id, volume_number, isbn, price, status) VALUES (11, 1, '1', '9782000000001', 7, 'Vorhanden');
        INSERT INTO volumes (id, manga_id, volume_number, isbn, status) VALUES (21, 2, '1', '9782000000001', 'Fehlt');
        INSERT INTO volumes (id, manga_id, volume_number, status) VALUES (31, 3, '1', 'Fehlt');
        INSERT INTO volumes (id, manga_id, volume_number, isbn, status) VALUES (41, 4, '1', '9782000000001', 'Fehlt');
    `);
    assert.equal(catalogOf(d, 1), catalogOf(d, 2), 'by Manga Passion id');
    assert.equal(catalogOf(d, 1), catalogOf(d, 3), 'by title key');
    assert.notEqual(catalogOf(d, 4), catalogOf(d, 1), 'another language is another edition');
    assert.equal(catalogVolumeOf(d, 11), catalogVolumeOf(d, 21));
    assert.equal(catalogVolumeOf(d, 11), catalogVolumeOf(d, 31));
    const english = d.prepare('SELECT isbn FROM catalog_volumes WHERE id = ?').get(catalogVolumeOf(d, 41));
    assert.equal(english.isbn, null, 'an ISBN of another catalog volume is not taken twice, the volume still links');
    assert.equal(d.prepare('SELECT list_price FROM catalog_volumes WHERE id = ?').get(catalogVolumeOf(d, 11)).list_price, 7);

    // shared fields: last write wins, NULL never clears
    d.exec("UPDATE volumes SET price = 7.5, release_date = '2025-03' WHERE id = 21");
    d.exec('UPDATE volumes SET price = NULL WHERE id = 11');
    assert.deepEqual({ ...d.prepare('SELECT list_price, release_date FROM catalog_volumes WHERE id = ?').get(catalogVolumeOf(d, 11)) },
        { list_price: 7.5, release_date: '2025-03' });
    d.exec("UPDATE mangas SET total_volumes = 20, author = 'Yukinobu Tatsu' WHERE id = 2");
    assert.deepEqual({ ...d.prepare('SELECT total_volumes, author FROM catalog_series WHERE id = ?').get(catalogOf(d, 1)) },
        { total_volumes: 20, author: 'Yukinobu Tatsu' });

    // a new volume number creates the catalog volume, a renumbered one relinks
    d.exec("INSERT INTO volumes (id, manga_id, volume_number, status) VALUES (12, 1, '2', 'Fehlt')");
    const two = catalogVolumeOf(d, 12);
    d.exec("UPDATE volumes SET volume_number = '1' WHERE id = 12");
    assert.equal(catalogVolumeOf(d, 12), catalogVolumeOf(d, 11));
    d.exec("UPDATE volumes SET volume_number = '2' WHERE id = 12");
    assert.equal(catalogVolumeOf(d, 12), two);
});

test('renaming a series renames its catalog series while it is the only edition, else moves the row', () => {
    const d = fresh();
    d.exec(`
        INSERT INTO mangas (id, title, publisher, language, shelf_id) VALUES (1, 'Friren', 'Egmont', 'de', 1);
        INSERT INTO volumes (id, manga_id, volume_number, isbn, status) VALUES (11, 1, '1', '9783770400001', 'Vorhanden');
    `);
    const original = catalogOf(d, 1);
    const volume = catalogVolumeOf(d, 11);
    d.exec("UPDATE mangas SET title = 'Frieren' WHERE id = 1");
    assert.equal(catalogOf(d, 1), original, 'typo fix of the only edition: same catalog row');
    assert.equal(d.prepare('SELECT title FROM catalog_series WHERE id = ?').get(original).title, 'Frieren');
    assert.equal(catalogVolumeOf(d, 11), volume);

    d.exec("INSERT INTO mangas (id, title, publisher, language, shelf_id) VALUES (2, 'Frieren', 'Egmont', 'de', 2)");
    assert.equal(catalogOf(d, 2), original);
    d.exec("UPDATE mangas SET language = 'en' WHERE id = 2");
    assert.notEqual(catalogOf(d, 2), original, 'a shared catalog series is not renamed by one of its editions');
    assert.equal(d.prepare('SELECT language FROM catalog_series WHERE id = ?').get(original).language, 'de');

    // moving to another catalog series takes the volumes along
    d.exec("INSERT INTO volumes (id, manga_id, volume_number, status) VALUES (21, 2, '1', 'Fehlt')");
    assert.notEqual(catalogVolumeOf(d, 21), volume);
    d.exec("UPDATE mangas SET language = 'de' WHERE id = 2");
    assert.equal(catalogOf(d, 2), original);
    assert.equal(catalogVolumeOf(d, 21), volume);
});

test('a deleted series leaves the catalog alone and a restored one links again', () => {
    const d = fresh();
    d.exec(`
        INSERT INTO mangas (id, title, language, manga_passion_id, shelf_id) VALUES (1, 'Berserk', 'de', 55, 1);
        INSERT INTO volumes (id, manga_id, volume_number, isbn, status) VALUES (11, 1, '1', '9783000000011', 'Vorhanden');
    `);
    const series = catalogOf(d, 1);
    const volume = catalogVolumeOf(d, 11);
    d.exec('DELETE FROM mangas WHERE id = 1');
    assert.ok(d.prepare('SELECT 1 FROM catalog_volumes WHERE id = ?').get(volume));
    d.exec(`
        INSERT INTO mangas (id, title, language, manga_passion_id, shelf_id) VALUES (1, 'Berserk', 'de', 55, 1);
        INSERT INTO volumes (id, manga_id, volume_number, isbn, status) VALUES (11, 1, '1', '9783000000011', 'Vorhanden');
    `);
    assert.equal(catalogOf(d, 1), series);
    assert.equal(catalogVolumeOf(d, 11), volume);
});

test('a fresh database runs every migration including the catalog ones', () => {
    const conn = new DatabaseSync(':memory:');
    conn.exec('PRAGMA foreign_keys = ON;');
    const report = schema.applySchema(conn, { log: quiet });
    assert.deepEqual(report.slice(-2).map(r => r.version), CATALOG_MIGRATIONS);
    assert.deepEqual(conn.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(conn.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('a volume written without a type or with a blank one links to the regular catalog volume and leaves no stray one', () => {
    const d = new DatabaseSync(':memory:');
    d.exec('PRAGMA foreign_keys = ON;');
    schema.applySchema(d, { log: quiet });
    const manga = Number(d.prepare("INSERT INTO mangas (title) VALUES ('Typlos')").run().lastInsertRowid);
    const insert = d.prepare('INSERT INTO volumes (manga_id, volume_number, type) VALUES (?, ?, ?)');
    [[null, '1'], ['', '2'], ['  ', '3'], ['volume', '4']].forEach(([type, number]) => insert.run(manga, number, type));
    // migration 40 turns the type into 'volume' after the insert; the catalog link must not keep a row of the blank type
    assert.deepEqual(d.prepare('SELECT DISTINCT volume_type FROM catalog_volumes').all().map(r => r.volume_type), ['volume']);
    assert.equal(d.prepare('SELECT count(*) AS n FROM catalog_volumes c WHERE NOT EXISTS (SELECT 1 FROM volumes v WHERE v.catalog_volume_id = c.id)').get().n, 0);
    d.prepare("UPDATE volumes SET type = '' WHERE volume_number = '4'").run();
    assert.equal(d.prepare('SELECT count(*) AS n FROM catalog_volumes').get().n, 4);
});
