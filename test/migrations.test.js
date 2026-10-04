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
    assert.deepEqual(report.map(r => r.version), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
    assert.equal(report[0].changes, db().prepare('SELECT count(*) AS n FROM mangas').get().n, 'the backfill touched every series');
    for (const row of db().prepare("SELECT m.owned_volumes AS stored, (SELECT count(*) FROM volumes v WHERE v.manga_id = m.id AND v.status = 'Vorhanden') AS counted FROM mangas m").all()) {
        assert.equal(row.stored, row.counted);
    }

    const snapshots = safetySnapshots();
    assert.equal(snapshots.length, 1);
    assert.match(snapshots[0], /^vor-update-v15-auf-v27-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/);
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
    assert.match(out, /Schema:\s+v14 -> v27/);
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
    assert.deepEqual(dbm.getLastMigrationReport().map(r => r.version), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
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
        assert.deepEqual(report.map(r => r.version), [27]);
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
