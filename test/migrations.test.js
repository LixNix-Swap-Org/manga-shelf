// Database migrations: fresh and pending runs, safety snapshots, triggers and dry run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-migrations-'));
process.env.DATA_DIR = dataDir;
if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = 'silent';
const AdmZip = require('adm-zip');
const dbm = require('../db');

const backupsDir = path.join(dataDir, 'backups');
const safetySnapshots = () => (fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter(f => f.startsWith('vor-update-')).sort() : []);
const db = () => dbm.db;

test.after(() => {
    dbm.closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Puts the live database back to "migrations 16 and 17 not applied" (triggers gone, a stale counter) and reopens it. */
function rerunMigration16(staleValue = 42) {
    db().exec(`
        DROP TRIGGER IF EXISTS trg_volumes_owned_ins;
        DROP TRIGGER IF EXISTS trg_volumes_owned_del;
        DROP TRIGGER IF EXISTS trg_volumes_owned_upd;
        DELETE FROM schema_migrations WHERE version >= 16;
    `);
    db().prepare('UPDATE mangas SET owned_volumes = ?').run(staleValue);
    dbm.initDb();
}

test('a fresh database runs every migration, takes no safety snapshot and uses synchronous=NORMAL', () => {
    const report = dbm.getLastMigrationReport();
    assert.deepEqual(report.map(r => r.version), Array.from({ length: dbm.LATEST_SCHEMA_VERSION }, (_, i) => i + 1));
    for (const r of report) {
        assert.equal(typeof r.name, 'string');
        assert.ok(Number.isInteger(r.changes) && r.changes >= 0, `changes of v${r.version}`);
        assert.ok(Number.isInteger(r.ms) && r.ms >= 0);
    }
    assert.deepEqual(safetySnapshots(), [], 'no users yet: nothing worth a snapshot');
    assert.deepEqual(dbm.pendingMigrations(db()), []);
    assert.equal(db().prepare('PRAGMA synchronous').get().synchronous, 1);
    assert.equal(db().prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
});

test('owned_volumes is kept by triggers and always equals the live count', () => {
    const users = [1, 2].map(i => Number(db().prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'admin')").run(`u${i}`).lastInsertRowid));
    db().prepare("INSERT INTO app_settings (key, value) VALUES ('jwt_secret', 'geheim')").run();
    const mangas = Array.from({ length: 4 }, (_, i) => Number(db().prepare('INSERT INTO mangas (title) VALUES (?)').run(`Reihe ${i}`).lastInsertRowid));
    let seed = 7;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const statuses = ['Vorhanden', 'Fehlt', 'Vorbestellt', null, 'Vorhanden'];
    const live = () => db().prepare("SELECT m.id, m.owned_volumes AS stored, (SELECT count(*) FROM volumes v WHERE v.manga_id = m.id AND v.status = 'Vorhanden') AS counted FROM mangas m").all();
    const ids = [];
    for (let step = 0; step < 600; step++) {
        const op = ids.length < 5 ? 0 : rand(6);
        if (op <= 1) {
            ids.push(Number(db().prepare('INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, ?, ?)').run(mangas[rand(4)], String(step), statuses[rand(5)]).lastInsertRowid));
        } else if (op === 2) {
            db().prepare('UPDATE volumes SET status = ? WHERE id = ?').run(statuses[rand(5)], ids[rand(ids.length)]);
        } else if (op === 3) {
            db().prepare('UPDATE volumes SET manga_id = ?, status = ? WHERE id = ?').run(mangas[rand(4)], statuses[rand(5)], ids[rand(ids.length)]);
        } else if (op === 4) {
            db().prepare('UPDATE volumes SET price = ?, notes = ? WHERE id = ?').run(rand(20), 'n', ids[rand(ids.length)]);
        } else {
            const [id] = ids.splice(rand(ids.length), 1);
            db().prepare('DELETE FROM volumes WHERE id = ?').run(id);
        }
    }
    for (const row of live()) assert.equal(row.stored, row.counted, `series ${row.id}`);
    assert.ok(live().some(r => r.counted > 0));

    // a rolled back write leaves the counter alone; deleting a series cascades without errors
    assert.throws(() => dbm.runTransaction(() => {
        db().prepare("INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, 'x', 'Vorhanden')").run(mangas[0]);
        throw new Error('abbrechen');
    }), /abbrechen/);
    db().prepare('DELETE FROM mangas WHERE id = ?').run(mangas[3]);
    for (const row of live()) assert.equal(row.stored, row.counted, `series ${row.id} after rollback and cascade`);
    assert.equal(users.length, 2);
});

test('pending migrations with users: DB-only safety snapshot first, then a counted backfill', () => {
    const generation = dbm.getConnectionGeneration();
    rerunMigration16();
    assert.equal(dbm.getConnectionGeneration(), generation + 1, 'reopening bumps the connection generation');
    const report = dbm.getLastMigrationReport();
    assert.deepEqual(report.map(r => r.version), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
    assert.equal(report[0].changes, db().prepare('SELECT count(*) AS n FROM mangas').get().n, 'the backfill touched every series');
    for (const row of db().prepare("SELECT m.owned_volumes AS stored, (SELECT count(*) FROM volumes v WHERE v.manga_id = m.id AND v.status = 'Vorhanden') AS counted FROM mangas m").all()) {
        assert.equal(row.stored, row.counted);
    }

    const snapshots = safetySnapshots();
    assert.equal(snapshots.length, 1);
    assert.match(snapshots[0], /^vor-update-v15-auf-v36-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/);
    const zip = new AdmZip(path.join(backupsDir, snapshots[0]));
    assert.deepEqual(zip.getEntries().map(e => e.entryName), ['manga.db']);
    const extracted = path.join(dataDir, 'temp', 'check.db');
    fs.writeFileSync(extracted, zip.getEntry('manga.db').getData());
    const copy = dbm.openRawDb(extracted, { readOnly: true });
    try {
        assert.equal(copy.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, 15, 'state before the update');
        assert.equal(copy.prepare('SELECT owned_volumes FROM mangas LIMIT 1').get().owned_volumes, 42);
        assert.equal(copy.prepare("SELECT 1 FROM app_settings WHERE key = 'jwt_secret'").get(), undefined, 'no signing secret in a backup');
        assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { copy.close(); }
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'temp')).filter(f => f.startsWith('vor-update-db-')), [], 'temp copy removed');
    dbm.validateDbFile(extracted);
    fs.unlinkSync(extracted);
});

test('only the newest three safety snapshots are kept; nothing pending means no snapshot', async () => {
    for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 5));
        rerunMigration16();
    }
    const kept = safetySnapshots();
    assert.equal(kept.length, 3);
    const other = path.join(backupsDir, 'manual-2020-01-01T00-00-00-000Z.zip');
    fs.writeFileSync(other, 'x');
    dbm.initDb();
    assert.deepEqual(dbm.getLastMigrationReport(), []);
    assert.deepEqual(safetySnapshots(), kept);
    assert.ok(fs.existsSync(other), 'other snapshots are never pruned here');
});

test('migrate-dry-run migrates a copy and leaves the original untouched', () => {
    const original = path.join(dataDir, 'temp', 'alt.db');
    db().exec(`VACUUM INTO '${original.replace(/'/g, "''")}'`);
    const old = dbm.openRawDb(original);
    old.exec(`
        DROP TRIGGER trg_volumes_number_sort_ins;
        DROP TRIGGER trg_volumes_number_sort_upd;
        DROP INDEX idx_volumes_manga_number;
        ALTER TABLE volumes DROP COLUMN number_sort;
        DROP TRIGGER trg_volumes_owned_ins;
        DROP TRIGGER trg_volumes_owned_del;
        DROP TRIGGER trg_volumes_owned_upd;
        DELETE FROM schema_migrations WHERE version >= 15;
        PRAGMA journal_mode = WAL;
    `);
    old.close();
    const hash = () => crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex');
    const before = hash();
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'migrate-dry-run.js'), original], {
        encoding: 'utf8', env: { ...process.env, DATA_DIR: '', LOG_LEVEL: 'silent' }
    });
    assert.match(out, /Schema:\s+v14 -> v36/);
    assert.match(out, /v15 add_volumes_number_sort: [\d.]+ Zeilen geändert, \d+ ms/);
    assert.match(out, /v16 maintain_mangas_owned_volumes_by_triggers: /);
    assert.match(out, /v17 add_mangas_wish_priority: /);
    assert.match(out, /v19 add_user_api_credentials: /);
    assert.match(out, /v20 add_mangas_collecting: /);
    assert.match(out, /v21 add_trash: /);
    assert.match(out, /v22 add_publisher_aliases: /);
    assert.match(out, /v23 add_publisher_identity_aliases: /);
    assert.match(out, /v24 clear_seeded_start_date: /);
    assert.match(out, /v25 add_anime_watch: /);
    assert.match(out, /v26 add_users_locale: /);
    assert.match(out, /v27 add_editions: /);
    assert.match(out, /v28 add_media_kinds_and_languages: /);
    assert.match(out, /v29 add_anime_watched_episodes: /);
    assert.match(out, /v30 add_anime_episode_scores: /);
    assert.match(out, /v31 add_anime_custom_seasons: /);
    assert.match(out, /volumes\s+\d+ -> \d+/);
    assert.match(out, /integrity_check:\s+ok/);
    assert.match(out, /foreign_key_check: ok/);
    assert.equal(hash(), before);
    assert.equal(fs.existsSync(original + '-wal'), false);
    assert.equal(fs.existsSync(original + '-shm'), false);
    const check = dbm.openRawDb(original, { readOnly: true });
    try {
        assert.equal(check.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, 14);
    } finally { check.close(); }
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(original + suffix); } catch (e) { /* not there */ } }

    assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'migrate-dry-run.js'), path.join(dataDir, 'fehlt.db')], { stdio: 'pipe' }),
        (err) => err.status === 2);
});

test('no safety snapshot, no migration: the start stops unless MIGRATE_WITHOUT_SNAPSHOT is set', (t) => {
    const before = safetySnapshots();
    const realWrite = fs.writeFileSync;
    const failing = t.mock.method(fs, 'writeFileSync', function (file, ...rest) {
        if (String(file).endsWith('.zip.part')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        return realWrite.call(this, file, ...rest);
    });
    assert.throws(() => rerunMigration16(7), (err) => {
        assert.equal(err.code, 'PRE_UPDATE_SNAPSHOT_FAILED');
        assert.match(err.message, /Sicherung vor dem Update .*ließ sich nicht schreiben \(ENOSPC/);
        assert.match(err.message, /nicht verändert/);
        assert.match(err.message, /MIGRATE_WITHOUT_SNAPSHOT=1/);
        return true;
    });
    assert.throws(() => dbm.db.prepare('SELECT 1').get(), undefined, 'the server does not run on');
    const raw = dbm.openRawDb(dbm.dbPath, { readOnly: true });
    try {
        assert.equal(raw.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, 15, 'no migration ran');
        assert.equal(raw.prepare('SELECT owned_volumes FROM mangas LIMIT 1').get().owned_volumes, 7);
    } finally { raw.close(); }
    assert.deepEqual(safetySnapshots(), before);

    process.env.MIGRATE_WITHOUT_SNAPSHOT = '1';
    try {
        dbm.initDb();
    } finally {
        delete process.env.MIGRATE_WITHOUT_SNAPSHOT;
        failing.mock.restore();
    }
    assert.deepEqual(dbm.getLastMigrationReport().map(r => r.version), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
    assert.deepEqual(safetySnapshots(), before, 'migrated without a snapshot');
    assert.equal(require('../utils/config').readConfig({ MIGRATE_WITHOUT_SNAPSHOT: 'vielleicht' }).warnings.length, 1);
});

test('BACKUP_KEEP_PRE_UPDATE changes how many safety snapshots stay', () => {
    process.env.BACKUP_KEEP_PRE_UPDATE = '1';
    try {
        rerunMigration16();
        assert.equal(safetySnapshots().length, 1);
    } finally {
        delete process.env.BACKUP_KEEP_PRE_UPDATE;
    }
});

test('migration 13 (v2.19.1 data): the oldest admin owns legacy Gelesen volumes but reads only those nobody had read', () => {
    const schema = require('../core/schema');
    const file = path.join(dataDir, 'temp', 'legacy-gelesen.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = dbm.openRawDb(file);
    try {
        schema.applySchema(conn);
        const user = (name, role) => Number(conn.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', ?)").run(name, role).lastInsertRowid);
        const editor = user('editor-alt', 'editor');
        const admin = user('admin-alt', 'admin');
        const manga = Number(conn.prepare("INSERT INTO mangas (title) VALUES ('Altbestand')").run().lastInsertRowid);
        const vol = (n) => Number(conn.prepare("INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, ?, 'Gelesen')").run(manga, n).lastInsertRowid);
        const readByEditor = vol('1');
        const readByNobody = vol('2');
        conn.prepare('INSERT INTO volume_reads (volume_id, user_id) VALUES (?, ?)').run(readByEditor, editor);
        conn.exec('DELETE FROM schema_migrations WHERE version >= 13');

        schema.runSequentialMigrations(conn);
        const owners = (id) => conn.prepare('SELECT user_id FROM volume_owners WHERE volume_id = ? ORDER BY user_id').all(id).map(r => r.user_id);
        const readers = (id) => conn.prepare('SELECT user_id FROM volume_reads WHERE volume_id = ? ORDER BY user_id').all(id).map(r => r.user_id);
        for (const id of [readByEditor, readByNobody]) {
            assert.equal(conn.prepare('SELECT status FROM volumes WHERE id = ?').get(id).status, 'Vorhanden');
            assert.deepEqual(owners(id), [admin]);
        }
        assert.deepEqual(readers(readByEditor), [editor], 'the existing read says who read it');
        assert.deepEqual(readers(readByNobody), [admin], 'without reads the owner becomes the reader');
    } finally {
        conn.close();
        fs.rmSync(file, { force: true });
    }
});

test('migration 24 removes the seeded start date 2021-04-09 unless a volume was bought or entered before it', () => {
    const schema = require('../core/schema');
    const file = path.join(dataDir, 'temp', 'seeded-start.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const run = (setup) => {
        const conn = dbm.openRawDb(file);
        try {
            schema.applySchema(conn);
            const manga = Number(conn.prepare("INSERT INTO mangas (title, created_at) VALUES ('Start', '2020-01-01 10:00:00')").run().lastInsertRowid);
            setup(conn, manga);
            conn.exec('DELETE FROM schema_migrations WHERE version >= 24');
            schema.runSequentialMigrations(conn);
            return conn.prepare("SELECT value FROM app_settings WHERE key = 'collection_start_date'").get()?.value ?? null;
        } finally {
            conn.close();
            for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
        }
    };
    const seed = (conn) => conn.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('collection_start_date', ?)").run('2021-04-09');
    const volume = (conn, manga, purchase, created) => conn.prepare("INSERT INTO volumes (manga_id, volume_number, purchase_date, created_at) VALUES (?, '1', ?, ?)").run(manga, purchase, created);

    assert.equal(run((c, m) => { seed(c); volume(c, m, '2024-02-01', '2024-02-01 08:00:00'); }), null, 'seed without earlier data is removed');
    assert.equal(run((c) => seed(c)), null, 'an empty collection loses the seed too');
    assert.equal(run((c, m) => { seed(c); volume(c, m, '2021-04-09', '2024-02-01 08:00:00'); }), null, 'the same day is not earlier');
    assert.equal(run((c, m) => { seed(c); volume(c, m, '2020-12-24', '2024-02-01 08:00:00'); }), '2021-04-09', 'an earlier purchase keeps it');
    assert.equal(run((c, m) => { seed(c); volume(c, m, '2021', '2024-02-01 08:00:00'); }), '2021-04-09', 'a purchase year counts from January');
    assert.equal(run((c, m) => { seed(c); volume(c, m, null, '2019-06-01 08:00:00'); }), '2021-04-09', 'an earlier entry keeps it');
    assert.equal(run((c, m) => {
        c.prepare("INSERT INTO app_settings (key, value) VALUES ('collection_start_date', '2023-01-15')").run();
        volume(c, m, '2024-02-01', '2024-02-01 08:00:00');
    }), '2023-01-15', 'a chosen date stays');
});

test('migration 25 adds resume links, link lists, anime_links (one per entry and service) and anime_sync (gone with the user)', () => {
    const schema = require('../core/schema');
    const file = path.join(dataDir, 'temp', 'anime-watch.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = dbm.openRawDb(file);
    try {
        conn.exec('PRAGMA foreign_keys = ON;');
        schema.applySchema(conn);
        const user = Number(conn.prepare("INSERT INTO users (username, password_hash) VALUES ('w25', 'x')").run().lastInsertRowid);
        const anime = Number(conn.prepare("INSERT INTO animes (title, anilist_id) VALUES ('Frieren', 154587)").run().lastInsertRowid);
        conn.prepare("INSERT INTO anime_progress (anime_id, user_id, episodes_watched) VALUES (?, ?, 7)").run(anime, user);
        conn.exec(`
            DELETE FROM schema_migrations WHERE version >= 25;
            DROP TABLE anime_links;
            DROP TABLE anime_sync;
            ALTER TABLE anime_progress DROP COLUMN resume_url;
            ALTER TABLE anime_progress DROP COLUMN resume_episode;
            ALTER TABLE animes DROP COLUMN external_links;
            ALTER TABLE animes DROP COLUMN streaming_episodes;
        `);
        schema.runSequentialMigrations(conn);
        const cols = (table) => conn.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        assert.ok(['resume_url', 'resume_episode'].every(c => cols('anime_progress').includes(c)));
        assert.ok(['external_links', 'streaming_episodes'].every(c => cols('animes').includes(c)));
        assert.deepEqual({ ...conn.prepare('SELECT episodes_watched, resume_url FROM anime_progress').get() }, { episodes_watched: 7, resume_url: null }, 'existing progress kept');

        const link = conn.prepare("INSERT INTO anime_links (anime_id, service, external_id, url) VALUES (?, 'crunchyroll', ?, NULL)");
        link.run(anime, 'GG5H5XQ7D');
        assert.throws(() => link.run(anime, 'OTHER1234'), /UNIQUE/, 'one link per entry and service');
        const second = Number(conn.prepare("INSERT INTO animes (title) VALUES ('Frieren 2')").run().lastInsertRowid);
        link.run(second, 'GG5H5XQ7D');
        assert.equal(conn.prepare("SELECT count(*) AS n FROM anime_links WHERE external_id = 'GG5H5XQ7D'").get().n, 2, 'a series id may span entries');
        conn.prepare('DELETE FROM animes WHERE id = ?').run(anime);
        assert.equal(conn.prepare('SELECT count(*) AS n FROM anime_links').get().n, 1, 'links go with their entry');

        conn.prepare("INSERT INTO anime_sync (user_id, service, enabled) VALUES (?, 'anilist', 1)").run(user);
        assert.throws(() => conn.prepare("INSERT INTO anime_sync (user_id, service) VALUES (?, 'anilist')").run(user), /UNIQUE|PRIMARY/);
        conn.prepare('DELETE FROM users WHERE id = ?').run(user);
        assert.equal(conn.prepare('SELECT count(*) AS n FROM anime_sync').get().n, 0, 'sync state goes with the user');

        conn.exec('DELETE FROM schema_migrations WHERE version >= 25');
        schema.runSequentialMigrations(conn);
        assert.equal(schema.appliedSchemaVersion(conn), schema.LATEST_SCHEMA_VERSION, 'a second run is harmless');
    } finally {
        conn.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
});

test('migration 26 adds users.locale (NULL = follow the device) and users.default_language (de)', () => {
    const schema = require('../core/schema');
    const file = path.join(dataDir, 'temp', 'users-locale.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = dbm.openRawDb(file);
    try {
        schema.applySchema(conn);
        conn.prepare("INSERT INTO users (username, password_hash) VALUES ('alt', 'x')").run();
        conn.exec(`
            DELETE FROM schema_migrations WHERE version >= 26;
            ALTER TABLE users DROP COLUMN locale;
            ALTER TABLE users DROP COLUMN default_language;
        `);
        schema.runSequentialMigrations(conn);
        assert.deepEqual({ ...conn.prepare("SELECT locale, default_language FROM users WHERE username = 'alt'").get() }, { locale: null, default_language: 'de' });
        conn.prepare("INSERT INTO users (username, password_hash) VALUES ('neu', 'x')").run();
        assert.deepEqual({ ...conn.prepare("SELECT locale, default_language FROM users WHERE username = 'neu'").get() }, { locale: null, default_language: 'de' });
        conn.exec('DELETE FROM schema_migrations WHERE version >= 26');
        schema.runSequentialMigrations(conn);
        assert.equal(schema.appliedSchemaVersion(conn), schema.LATEST_SCHEMA_VERSION, 'a second run is harmless');
    } finally {
        conn.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
});

test('migration 27 turns language names into codes, adds region, work key, currency and volumes.language, and logs unknown text', () => {
    const schema = require('../core/schema');
    const file = path.join(dataDir, 'temp', 'editions.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = dbm.openRawDb(file);
    try {
        schema.applySchema(conn);
        conn.exec(`
            DELETE FROM schema_migrations WHERE version >= 27;
            DROP INDEX idx_mangas_work_key;
            ALTER TABLE mangas DROP COLUMN region;
            ALTER TABLE mangas DROP COLUMN work_key;
            ALTER TABLE mangas DROP COLUMN currency;
            ALTER TABLE volumes DROP COLUMN language;
        `);
        const insert = conn.prepare('INSERT INTO mangas (title, language) VALUES (?, ?)');
        const stored = [['A', 'Deutsch'], ['B', 'Englisch'], ['C', 'English'], ['D', 'ja'], ['E', 'en-US'], ['F', null], ['G', ''],
            ['H', 'Klingonisch'], ['I', 'Klingonisch'], ['J', 'Französisch']];
        for (const [title, language] of stored) insert.run(title, language);
        const series = Number(conn.prepare("SELECT id FROM mangas WHERE title = 'A'").get().id);
        conn.prepare("INSERT INTO volumes (manga_id, volume_number, status, price) VALUES (?, '1', 'Fehlt', 7)").run(series);

        const warnings = [];
        const log = { debug() {}, info() {}, error() {}, warn: (...args) => warnings.push(args.join(' ')) };
        const report = schema.runSequentialMigrations(conn, { log });
        assert.deepEqual(report.map(r => r.version), [27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
        const rows = conn.prepare('SELECT title, language, region, work_key, currency FROM mangas ORDER BY title').all().map(r => ({ ...r }));
        assert.deepEqual(rows.map(r => [r.title, r.language, r.region]), [
            ['A', 'de', null], ['B', 'en', null], ['C', 'en', null], ['D', 'ja', null], ['E', 'en', 'US'], ['F', 'de', null], ['G', 'de', null],
            ['H', 'de', null], ['I', 'de', null], ['J', 'fr', null]
        ]);
        assert.ok(rows.every(r => r.work_key === null && r.currency === 'EUR'));
        assert.equal(conn.prepare('SELECT language FROM volumes').get().language, null, 'a volume inherits the series language');
        assert.ok(conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_mangas_work_key'").get());
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /v27: unknown series languages set to 'de': "Klingonisch" \(2\)/);

        conn.exec('DELETE FROM schema_migrations WHERE version >= 27');
        schema.runSequentialMigrations(conn);
        assert.equal(schema.appliedSchemaVersion(conn), schema.LATEST_SCHEMA_VERSION, 'a second run is harmless');
        assert.equal(conn.prepare("SELECT region FROM mangas WHERE title = 'E'").get().region, 'US');
        assert.equal(conn.prepare("INSERT INTO mangas (title) VALUES ('neu') RETURNING currency").get().currency, 'EUR');
    } finally {
        conn.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
});

test('migration 28 adds kinds, TMDb columns and watched languages and rebuilds user_api_credentials with tmdb, keeping every row', () => {
    const schema = require('../core/schema');
    const file = path.join(dataDir, 'temp', 'media.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = dbm.openRawDb(file);
    try {
        schema.applySchema(conn);
        conn.exec(`
            DELETE FROM schema_migrations WHERE version >= 28;
            DROP INDEX idx_animes_tmdb;
            ALTER TABLE animes DROP COLUMN kind;
            ALTER TABLE animes DROP COLUMN tmdb_id;
            ALTER TABLE animes DROP COLUMN tmdb_kind;
            ALTER TABLE animes DROP COLUMN imdb_id;
            ALTER TABLE animes DROP COLUMN original_language;
            ALTER TABLE animes DROP COLUMN spoken_languages;
            ALTER TABLE animes DROP COLUMN seasons;
            ALTER TABLE anime_progress DROP COLUMN audio_language;
            ALTER TABLE anime_progress DROP COLUMN subtitle_language;
            DROP TABLE user_api_credentials;
            CREATE TABLE user_api_credentials (
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
            CREATE UNIQUE INDEX idx_user_api_credentials_owner ON user_api_credentials (COALESCE(user_id, 0), provider);
            INSERT INTO users (id, username, password_hash) VALUES (7, 'kim', 'x');
            INSERT INTO animes (id, title, anilist_id) VALUES (3, 'Frieren', 154587);
            INSERT INTO anime_progress (anime_id, user_id, episodes_watched) VALUES (3, 7, 4);
            INSERT INTO user_api_credentials (id, user_id, provider, secret_enc, label, last4, allow_background, last_ok_at, last_error)
                VALUES (5, 7, 'mal', 'enc-a', 'Client-ID …cdef', 'cdef', 1, 123, NULL), (9, NULL, 'google_books', 'enc-b', NULL, 'xxxx', 0, NULL, 'abgelehnt');
        `);
        assert.throws(() => conn.prepare("INSERT INTO user_api_credentials (user_id, provider, secret_enc) VALUES (7, 'tmdb', 'x')").run(), /CHECK constraint/);
        const credentials = () => conn.prepare('SELECT * FROM user_api_credentials ORDER BY id').all().map(r => ({ ...r }));
        const before = credentials();
        const report = schema.runSequentialMigrations(conn);
        assert.deepEqual(report.map(r => r.version), [28, 29, 30, 31, 32, 33, 34, 35, 36]);
        assert.deepEqual(credentials(), before, 'every column of every row, ids included');
        conn.prepare("INSERT INTO user_api_credentials (user_id, provider, secret_enc) VALUES (7, 'tmdb', 'enc-c')").run();
        assert.throws(() => conn.prepare("INSERT INTO user_api_credentials (user_id, provider, secret_enc) VALUES (7, 'tmdb', 'enc-d')").run(), /UNIQUE/);
        assert.throws(() => conn.prepare("INSERT INTO user_api_credentials (user_id, provider, secret_enc) VALUES (7, 'kitsu', 'x')").run(), /CHECK constraint/);
        assert.ok(conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_api_credentials_owner'").get());
        conn.exec('DELETE FROM users WHERE id = 7');
        assert.equal(conn.prepare('SELECT count(*) AS n FROM user_api_credentials WHERE user_id = 7').get().n, 0, 'still cascades');

        const anime = conn.prepare('SELECT kind, tmdb_id, tmdb_kind, imdb_id, original_language, spoken_languages, seasons FROM animes WHERE id = 3').get();
        assert.deepEqual({ ...anime }, { kind: 'anime', tmdb_id: null, tmdb_kind: null, imdb_id: null, original_language: null, spoken_languages: null, seasons: null });
        const progressCols = conn.prepare('PRAGMA table_info(anime_progress)').all().map(c => c.name);
        assert.ok(progressCols.includes('audio_language') && progressCols.includes('subtitle_language'));
        conn.exec("INSERT INTO animes (title, kind, tmdb_id, tmdb_kind) VALUES ('Film', 'movie', 7, 'movie'), ('Serie', 'tv', 7, 'tv')");
        assert.throws(() => conn.exec("INSERT INTO animes (title, kind, tmdb_id, tmdb_kind) VALUES ('Doppelt', 'tv', 7, 'tv')"), /UNIQUE/);

        conn.exec('DELETE FROM schema_migrations WHERE version >= 28');
        assert.deepEqual(schema.runSequentialMigrations(conn).map(r => r.version), [28, 29, 30, 31, 32, 33, 34, 35, 36], 'a second run is harmless');
        assert.equal(conn.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'user_api_credentials%'").get().n, 1);
    } finally {
        conn.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
});

test('newerSchema and acceptNewerSchema (core/schema.js): only the exact accepted version counts', () => {
    const schema = require('../core/schema');
    const { DatabaseSync } = require('node:sqlite');
    const conn = new DatabaseSync(':memory:');
    try {
        schema.applySchema(conn);
        assert.equal(schema.newerSchema(conn), null);
        const future = schema.LATEST_SCHEMA_VERSION + 2;
        conn.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, 'future')").run(future);
        assert.deepEqual(schema.newerSchema(conn), { version: future, known: schema.LATEST_SCHEMA_VERSION, accepted: false });
        conn.prepare("INSERT INTO app_settings (key, value) VALUES ('schema_newer_accepted', ?)").run(String(future - 1));
        assert.equal(schema.newerSchema(conn).accepted, false, 'the consent of another version does not count');
        assert.equal(schema.acceptNewerSchema(conn), future);
        assert.equal(schema.newerSchema(conn).accepted, true);
    } finally {
        conn.close();
    }
});

test('a database of a newer version is refused (SCHEMA_NEWER, exit code 78, a panel route on Pterodactyl) unless a restore accepted it or it is allowed', () => {
    const future = dbm.LATEST_SCHEMA_VERSION + 1;
    db().prepare("INSERT INTO schema_migrations (version, name) VALUES (?, 'future')").run(future);
    try {
        assert.throws(() => dbm.initDb(), (err) => {
            assert.equal(err.code, 'SCHEMA_NEWER');
            assert.equal(err.exitCode, 78);
            assert.match(err.message, new RegExp(`Schema v${future} und stammt aus einer neueren Version von Manga Shelf \\(diese Version kennt Schema bis v${dbm.LATEST_SCHEMA_VERSION}\\)`));
            assert.match(err.message, /"manga-shelf-server restore <backup\.zip>"/);
            assert.match(err.message, /"node scripts\/admin\.js wiederherstellen <backup\.zip>"/);
            assert.match(err.message, /ALLOW_NEWER_SCHEMA=1/);
            return true;
        });
        assert.throws(() => dbm.db.prepare('SELECT 1').get(), (err) => err.code === 'SCHEMA_NEWER', 'nothing runs on the refused database');
        assert.throws(() => dbm.ensureDbOpen(), (err) => err.code === 'SCHEMA_NEWER');

        const panel = process.env.P_SERVER_UUID;
        process.env.P_SERVER_UUID = 'test-server';
        try {
            assert.throws(() => dbm.initDb(), (err) => {
                assert.equal(err.exitCode, 78);
                assert.ok(err.message.includes(`im Dateimanager in die Datei ${path.join(process.cwd(), '.env')} die Zeile ALLOW_NEWER_SCHEMA=1 eintragen`), err.message);
                assert.match(err.message, /im Dialog "Backups" das Backup von vor dem Update \(vor-update-…zip aus /);
                assert.match(err.message, /die Zeile danach wieder entfernen/);
                assert.doesNotMatch(err.message, /wiederherstellen <backup\.zip>|restore <backup\.zip>/, 'a stopped Pterodactyl server has no shell');
                return true;
            });
        } finally {
            if (panel === undefined) delete process.env.P_SERVER_UUID;
            else process.env.P_SERVER_UUID = panel;
        }

        dbm.initDb({ allowNewerSchema: true });
        assert.equal(dbm.ensureDbOpen().prepare('SELECT max(version) AS v FROM schema_migrations').get().v, future);

        process.env.ALLOW_NEWER_SCHEMA = '1';
        try {
            dbm.initDb();
        } finally {
            delete process.env.ALLOW_NEWER_SCHEMA;
        }
        db().prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_newer_accepted', ?)").run(String(future));
        dbm.initDb();
        assert.deepEqual(dbm.getLastMigrationReport(), []);

        const out = execFileSync(process.execPath, ['-e', `
            const d = require('./db.js');
            d.db.prepare("UPDATE app_settings SET value = 'x' WHERE key = 'schema_newer_accepted'").run();
            d.closeDb();
            const again = require('child_process').spawnSync(process.execPath, ['-e', "const d = require('./db.js'); try { d.db.prepare('SELECT 1').get(); console.log('open'); } catch (e) { console.log(e.code, e.exitCode); }"], { encoding: 'utf8', env: process.env });
            process.stdout.write(again.stdout);
        `], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dataDir, LOG_LEVEL: 'silent' }, encoding: 'utf8' });
        assert.equal(out.trim(), 'SCHEMA_NEWER 78', 'loading db.js does not throw; the first use does');
    } finally {
        dbm.initDb({ allowNewerSchema: true });
        db().prepare('DELETE FROM schema_migrations WHERE version = ?').run(future);
        db().prepare("DELETE FROM app_settings WHERE key = 'schema_newer_accepted'").run();
        dbm.initDb();
    }
});

test('the safety snapshot before migrations never prunes the backup an unconfirmed update needs', () => {
    const stateFile = path.join(dataDir, 'update-state.json');
    process.env.BACKUP_KEEP_PRE_UPDATE = '1';
    try {
        rerunMigration16();
        const [held] = safetySnapshots().slice(-1);
        fs.writeFileSync(stateFile, JSON.stringify({
            format: 1, phase: 'swapped', mode: 'pterodactyl', restart: 'pterodactyl', from: '3.0.0', to: '3.0.1', at: new Date().toISOString(),
            user: 1, pid: 1, schema_before: 15, backup: { file: held, sha256: 'a'.repeat(64) }, previous: { sha256: 'b'.repeat(64) }, attempts: 1
        }));
        rerunMigration16();
        rerunMigration16();
        const kept = safetySnapshots();
        assert.equal(kept.length, 2);
        assert.ok(kept.includes(held), 'the update backup stays next to the newest one');
        fs.rmSync(stateFile);
        rerunMigration16();
        assert.equal(safetySnapshots().length, 1);
        assert.ok(!safetySnapshots().includes(held));
    } finally {
        delete process.env.BACKUP_KEEP_PRE_UPDATE;
        fs.rmSync(stateFile, { force: true });
    }
});

test('migration 32 puts every series and trash entry into shelf 1 and every account into it with a role from its global role', () => {
    const schema = require('../core/schema');
    const file = path.join(dataDir, 'temp', 'shelves.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = dbm.openRawDb(file);
    const all = (sql) => conn.prepare(sql).all().map(r => ({ ...r }));
    try {
        schema.applySchema(conn);
        conn.exec(`
            DROP TRIGGER trg_mangas_shelf_default;
            DROP TRIGGER trg_trash_shelf_default;
            DROP INDEX idx_mangas_shelf;
            DROP TABLE shelf_members;
            DROP TABLE shelves;
            ALTER TABLE mangas DROP COLUMN shelf_id;
            ALTER TABLE trash DROP COLUMN shelf_id;
            DELETE FROM schema_migrations WHERE version >= 32;
            INSERT INTO users (id, username, password_hash, role) VALUES (11, 'ada', 'x', 'admin'), (12, 'bo', 'x', 'editor'), (13, 'cy', 'x', 'guest');
            INSERT INTO mangas (id, title) VALUES (1, 'A'), (2, 'B');
            INSERT INTO trash (id, kind, ref_id, manga_id, title, payload) VALUES (1, 'manga', 7, 7, 'Weg', '{}'), (2, 'volume', 9, 2, 'B', '{}');
        `);
        const report = schema.runSequentialMigrations(conn);
        assert.deepEqual(report.map(r => r.version), [32, 33, 34, 35, 36]);
        assert.deepEqual(conn.prepare('SELECT DISTINCT shelf_id FROM mangas').all().map(r => r.shelf_id), [1]);
        assert.deepEqual(all('SELECT id, shelf_id FROM trash ORDER BY id'), [{ id: 1, shelf_id: 1 }, { id: 2, shelf_id: 1 }]);
        assert.equal(conn.prepare('SELECT owner_user_id FROM shelves WHERE id = 1').get().owner_user_id, 11);
        const members = all('SELECT user_id, role FROM shelf_members WHERE shelf_id = 1 ORDER BY user_id');
        assert.deepEqual(members, [{ user_id: 11, role: 'owner' }, { user_id: 12, role: 'editor' }, { user_id: 13, role: 'viewer' }]);
        conn.exec("INSERT INTO mangas (id, title) VALUES (3, 'C')");
        assert.equal(conn.prepare('SELECT shelf_id FROM mangas WHERE id = 3').get().shelf_id, 1, 'a series without a shelf lands in shelf 1');

        // a populated database: bo moved series B into an own shelf and left the household shelf
        conn.exec(`
            INSERT INTO shelves (id, name, owner_user_id) VALUES (2, 'Bo', 12);
            UPDATE shelf_members SET shelf_id = 2, role = 'owner' WHERE user_id = 12;
            UPDATE mangas SET shelf_id = 2 WHERE id = 2;
            UPDATE trash SET shelf_id = 2 WHERE id = 2;
            INSERT INTO users (id, username, password_hash, role) VALUES (14, 'di', 'x', 'editor');
        `);
        conn.exec("INSERT INTO trash (id, kind, ref_id, manga_id, title, payload) VALUES (3, 'volume', 10, 2, 'B', '{}'), (4, 'manga', 8, 8, 'Alt', '{}')");
        assert.deepEqual(all('SELECT id, shelf_id FROM trash WHERE id >= 3 ORDER BY id'), [{ id: 3, shelf_id: 2 }, { id: 4, shelf_id: 1 }],
            'a trash entry written without a shelf takes the one of its series, else shelf 1');
        const state = () => ({
            shelves: all('SELECT id, name, owner_user_id, is_default FROM shelves ORDER BY id'),
            members: all('SELECT shelf_id, user_id, role FROM shelf_members ORDER BY shelf_id, user_id'),
            mangas: all('SELECT id, shelf_id FROM mangas ORDER BY id'),
            trash: all('SELECT id, shelf_id FROM trash ORDER BY id')
        });
        const before = state();
        conn.exec('DELETE FROM schema_migrations WHERE version >= 32');
        assert.deepEqual(schema.runSequentialMigrations(conn).map(r => r.version), [32, 33, 34, 35, 36]);
        const after = state();
        assert.deepEqual({ ...after, members: after.members.filter(m => m.user_id !== 14) }, before, 'a second run changes nothing that exists');
        assert.deepEqual(after.members.filter(m => m.user_id === 14), [{ shelf_id: 1, user_id: 14, role: 'editor' }], 'an account without a shelf joins shelf 1');
    } finally {
        conn.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
});

test('migration 33 adds rating_visibility (public), public_comment and users.default_anime_visibility (public) to existing rows', () => {
    const schema = require('../core/schema');
    const file = path.join(dataDir, 'temp', 'visibility.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = dbm.openRawDb(file);
    try {
        schema.applySchema(conn);
        conn.exec(`
            ALTER TABLE anime_progress DROP COLUMN rating_visibility;
            ALTER TABLE anime_progress DROP COLUMN public_comment;
            ALTER TABLE users DROP COLUMN default_anime_visibility;
            DELETE FROM schema_migrations WHERE version >= 33;
            INSERT INTO users (id, username, password_hash, role) VALUES (21, 'eli', 'x', 'editor');
            INSERT INTO animes (id, title) VALUES (31, 'Alt');
            INSERT INTO anime_progress (anime_id, user_id, status, score) VALUES (31, 21, 'Gesehen', 8);
        `);
        assert.deepEqual(schema.runSequentialMigrations(conn).map(r => r.version), [33, 34, 35, 36]);
        const progress = () => ({ ...conn.prepare('SELECT rating_visibility, public_comment, score FROM anime_progress WHERE anime_id = 31 AND user_id = 21').get() });
        assert.deepEqual(progress(), { rating_visibility: 'public', public_comment: null, score: 8 });
        assert.equal(conn.prepare('SELECT default_anime_visibility AS v FROM users WHERE id = 21').get().v, 'public');
        conn.exec("INSERT INTO users (id, username, password_hash) VALUES (22, 'fe', 'x'); INSERT INTO anime_progress (anime_id, user_id) VALUES (31, 22)");
        assert.equal(conn.prepare('SELECT rating_visibility AS v FROM anime_progress WHERE user_id = 22').get().v, 'public');
        assert.equal(conn.prepare('SELECT default_anime_visibility AS v FROM users WHERE id = 22').get().v, 'public');

        conn.exec("UPDATE anime_progress SET rating_visibility = 'private', public_comment = 'gut' WHERE user_id = 21; UPDATE users SET default_anime_visibility = 'anonymous' WHERE id = 21");
        conn.exec('DELETE FROM schema_migrations WHERE version >= 33');
        schema.runSequentialMigrations(conn);
        assert.equal(schema.appliedSchemaVersion(conn), schema.LATEST_SCHEMA_VERSION, 'a second run is harmless');
        assert.deepEqual(progress(), { rating_visibility: 'private', public_comment: 'gut', score: 8 });
        assert.equal(conn.prepare('SELECT default_anime_visibility AS v FROM users WHERE id = 21').get().v, 'anonymous');
    } finally {
        conn.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
});

test('a new database logs one line for all migrations, an existing one lists each of them', () => {
    const schema = require('../core/schema');
    const infos = [];
    const log = { debug() {}, info: (...args) => infos.push(args.join(' ')), error() {}, warn() {} };
    const file = path.join(dataDir, 'temp', 'quiet.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = dbm.openRawDb(file);
    try {
        schema.applySchema(conn, { log });
        assert.equal(infos.length, 1, infos.join('\n'));
        assert.match(infos[0], new RegExp(`Neue Datenbank angelegt \\(Schema v${dbm.LATEST_SCHEMA_VERSION}, ${dbm.LATEST_SCHEMA_VERSION} Migrationen, \\d+ ms\\)`));

        conn.exec("INSERT INTO mangas (title) VALUES ('A'); DELETE FROM schema_migrations WHERE version >= 32;");
        infos.length = 0;
        schema.applySchema(conn, { log });
        assert.equal(infos.filter(line => /\] v3[23456] /.test(line)).length, 5, infos.join('\n'));
        assert.ok(!infos.some(line => /Neue Datenbank/.test(line)));

        conn.exec("DELETE FROM schema_migrations; DELETE FROM mangas;");
        conn.exec("INSERT INTO users (username, password_hash) VALUES ('a', 'x'); DELETE FROM schema_migrations;");
        infos.length = 0;
        schema.applySchema(conn, { log });
        assert.ok(infos.length > 1, 'an old database with accounts keeps the full list');
    } finally {
        conn.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
});

test('migrations 34 and 35 add animes.tags and anime_airings to existing rows and run twice without harm', () => {
    const schema = require('../core/schema');
    const file = path.join(dataDir, 'temp', 'airings.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = dbm.openRawDb(file);
    try {
        schema.applySchema(conn);
        conn.exec(`
            DROP TABLE anime_airings;
            ALTER TABLE animes DROP COLUMN tags;
            DELETE FROM schema_migrations WHERE version >= 34;
            INSERT INTO animes (id, title) VALUES (41, 'Alt');
        `);
        assert.deepEqual(schema.runSequentialMigrations(conn).map(r => r.version), [34, 35, 36]);
        assert.equal(conn.prepare('SELECT tags FROM animes WHERE id = 41').get().tags, null);
        conn.prepare('INSERT INTO anime_airings (anime_id, episode, at) VALUES (41, 1, 1000)').run();
        assert.throws(() => conn.prepare('INSERT INTO anime_airings (anime_id, episode, at) VALUES (41, 1, 2000)').run(), 'one row per episode');
        conn.exec('DELETE FROM schema_migrations WHERE version >= 34');
        schema.runSequentialMigrations(conn);
        assert.equal(conn.prepare('SELECT count(*) AS n FROM anime_airings').get().n, 1);
        conn.exec('PRAGMA foreign_keys = ON; DELETE FROM animes WHERE id = 41');
        assert.equal(conn.prepare('SELECT count(*) AS n FROM anime_airings').get().n, 0, 'removed with the entry');
    } finally {
        conn.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
});

test('migration 36 adds mangas.format (print), mangas.total_chapters and chapter_progress, which cascades with its series', () => {
    const schema = require('../core/schema');
    const file = path.join(dataDir, 'temp', 'webtoon.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = dbm.openRawDb(file);
    try {
        schema.applySchema(conn);
        conn.exec(`
            DROP TABLE chapter_progress;
            ALTER TABLE mangas DROP COLUMN format;
            ALTER TABLE mangas DROP COLUMN total_chapters;
            DELETE FROM schema_migrations WHERE version >= 36;
            INSERT INTO users (id, username, password_hash, role) VALUES (31, 'gin', 'x', 'editor');
            INSERT INTO mangas (id, title) VALUES (41, 'Alt');
        `);
        assert.deepEqual(schema.runSequentialMigrations(conn).map(r => r.version), [36]);
        assert.deepEqual({ ...conn.prepare('SELECT format, total_chapters FROM mangas WHERE id = 41').get() }, { format: 'print', total_chapters: null });
        conn.exec("INSERT INTO mangas (id, title, format, total_chapters) VALUES (42, 'Neu', 'webtoon', 200); INSERT INTO chapter_progress (manga_id, user_id, chapters_read) VALUES (42, 31, 150)");
        conn.exec('PRAGMA foreign_keys = ON; DELETE FROM mangas WHERE id = 42');
        assert.equal(conn.prepare('SELECT count(*) AS n FROM chapter_progress').get().n, 0, 'progress goes with its series');

        conn.exec("UPDATE mangas SET format = 'webtoon', total_chapters = 12 WHERE id = 41; INSERT INTO chapter_progress (manga_id, user_id, chapters_read) VALUES (41, 31, 3)");
        conn.exec('DELETE FROM schema_migrations WHERE version >= 36');
        schema.runSequentialMigrations(conn);
        assert.equal(schema.appliedSchemaVersion(conn), schema.LATEST_SCHEMA_VERSION, 'a second run is harmless');
        assert.deepEqual({ ...conn.prepare('SELECT format, total_chapters FROM mangas WHERE id = 41').get() }, { format: 'webtoon', total_chapters: 12 });
        assert.equal(conn.prepare('SELECT chapters_read AS n FROM chapter_progress WHERE manga_id = 41').get().n, 3);
    } finally {
        conn.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
});
