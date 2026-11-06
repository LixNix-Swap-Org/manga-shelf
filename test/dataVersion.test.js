// The data version counters: stable on reads and on writes outside their area, changed by every write there, a restore or another connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let dv;
let dbm;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    dv = require('../utils/dataVersion');
    dbm = require('../db');
});

test.after(async () => { await ctx.close(); });

test('data version: stable while only reading, changes with every write', async () => {
    const first = dv.dataVersionKey();
    await admin('GET', '/mangas');
    await admin('GET', '/stats');
    assert.equal(dv.dataVersionKey(), first);

    const id = (await admin('POST', '/mangas', { title: 'Version' })).body.id;
    const afterInsert = dv.dataVersionKey();
    assert.notEqual(afterInsert, first);
    assert.equal((await admin('POST', '/volumes/batch', { manga_id: id, from: 1, to: 2, status: 'Vorhanden' })).status, 200);
    const afterVolumes = dv.dataVersionKey();
    assert.notEqual(afterVolumes, afterInsert);
    // a cascade counts as well
    assert.equal((await admin('DELETE', `/mangas/${id}`)).status, 200);
    assert.notEqual(dv.dataVersionKey(), afterVolumes);
});

test('data version: a reopened database (restore) gets a new generation, the boot id stays', () => {
    const before = dv.readDataVersion();
    dbm.initDb();
    const after = dv.readDataVersion();
    assert.equal(after.generation, before.generation + 1);
    assert.equal(after.boot, before.boot);
    assert.match(after.boot, /^[0-9a-f]{8}$/);
    assert.equal(dv.dataVersionKey(), `${after.boot}.${after.generation}.c${after.versions.collection}`);
    assert.equal(dv.dataVersionKey(['collection', 'anime']), `${after.boot}.${after.generation}.c${after.versions.collection}.a${after.versions.anime}`);
});

test('data version: a commit by another connection to a collection table changes it, one to a cache does not', () => {
    const before = dv.dataVersionKey();
    const other = dbm.openRawDb(dbm.dbPath);
    try {
        other.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('probe', 'x')").run();
        other.prepare("INSERT OR REPLACE INTO api_cache (cache_key, json_data, created_at, expires_at) VALUES ('probe', '{}', 1, 2)").run();
        other.prepare("INSERT OR REPLACE INTO manga_passion_cache (cache_key, json_data, created_at) VALUES ('probe', '{}', 1)").run();
        assert.equal(dv.dataVersionKey(), before, 'caches and settings leave the collection version alone');
        other.prepare("INSERT INTO mangas (title) VALUES ('Fremd')").run();
    } finally { other.close(); }
    assert.notEqual(dv.dataVersionKey(), before);
});

test('data version: the collection start date counts for the collection, anime writes only for the anime scope', () => {
    const collection = dv.dataVersionKey();
    const both = dv.dataVersionKey(['collection', 'anime']);
    dbm.db.prepare("INSERT INTO animes (title) VALUES ('Probe')").run();
    assert.equal(dv.dataVersionKey(), collection, 'an anime row is not part of the collection');
    assert.notEqual(dv.dataVersionKey(['collection', 'anime']), both);
    dbm.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('collection_start_date', '2020-01-01')").run();
    assert.notEqual(dv.dataVersionKey(), collection);
});

test('every table is either part of a data version or known to leave it alone', () => {
    // volume_owners is a view of volume_copies since migration 43
    const versioned = new Set(['mangas', 'volumes', 'volume_copies', 'volume_reads', 'chapter_progress', 'shelves', 'shelf_members', 'users',
        'animes', 'anime_progress', 'app_settings']);
    // read by no endpoint with an ETag (or only through a versioned table): a new table has to be put in one of the lists
    const unversioned = new Set(['api_cache', 'manga_passion_cache', 'schema_migrations', 'data_versions', 'trash', 'publisher_aliases',
        'user_api_credentials', 'anime_links', 'anime_sync', 'anime_airings', 'works', 'sqlite_sequence', 'sqlite_stat1', 'sqlite_stat4',
        // written only by triggers of versioned tables (mangas, volumes, animes, works through mangas)
        'catalog_series', 'catalog_volumes', 'catalog_merge_log', 'anime_work_links']);
    const tables = dbm.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    for (const name of tables) assert.ok(versioned.has(name) || unversioned.has(name), `table ${name} is in neither list`);
    const triggers = new Set(dbm.db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_dv_%'").all().map(r => r.tbl_name));
    for (const name of versioned) assert.ok(triggers.has(name), `no data version trigger on ${name}`);
});
