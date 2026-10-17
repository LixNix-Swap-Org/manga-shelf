const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ownData = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-dbrecovery-'));
process.env.DATA_DIR = ownData;
if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = 'silent';
const recovery = require('../../services/update/dbRecovery');
const stateFile = require('../../services/update/state');
const h = require('../fixtures/update/helpers');
const pkg = require('../../package.json');

const ROOT = path.join(__dirname, '..', '..');
const FROZEN = path.join(__dirname, '..', 'fixtures', 'update', 'prelude-v3.2.0');
const root = h.tmpDir();
test.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ownData, { recursive: true, force: true });
});
let n = 0;
const fresh = (name) => {
    const dir = path.join(root, `${name}-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

const FRESH = 'vor-update-v3.2.0-auf-v3.1.0-2026-10-11T10-00-00-000Z.zip';
const SOURCE = 'vor-update-v3.1.0-auf-v3.2.0-2026-10-01T10-00-00-000Z.zip';
const KEPT = 'manga.db.v3.2.0-2026-10-11T10-00-01-000Z';

function makeDb(file, schema, marker) {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); CREATE TABLE marker (v TEXT); CREATE TABLE users (id INTEGER PRIMARY KEY, password_changed_at INTEGER); CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
    for (let v = 1; v <= schema; v++) db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(v);
    db.prepare('INSERT INTO marker (v) VALUES (?)').run(marker);
    db.prepare('INSERT INTO users (id, password_changed_at) VALUES (1, 5)').run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('revoked_sessions', '{}')").run();
    db.close();
}

function readDb(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        return {
            schema: db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v,
            marker: db.prepare('SELECT v FROM marker').get().v,
            sessions: db.prepare('SELECT password_changed_at AS p FROM users WHERE id = 1').get().p,
            revoked: db.prepare("SELECT count(*) AS c FROM app_settings WHERE key = 'revoked_sessions'").get().c
        };
    } finally {
        db.close();
    }
}

function zipOfDb(dbFile, target) {
    const bytes = h.makeZip([{ name: 'manga.db', data: fs.readFileSync(dbFile) }]);
    fs.writeFileSync(target, bytes);
    return h.sha256hex(bytes);
}

function journal(dataDir, freshSha, over = {}) {
    const { db: dbOver, ...rest } = over;
    return {
        phase: 'failed', mode: 'sea-user', restart: 'supervised', from: '3.2.0', to: '3.1.0', at: '2026-10-11T10:00:00.000Z', user: 1,
        pid: deadPid(), schema_before: 28, backup: { file: FRESH, sha256: freshSha }, previous: { sha256: 'a'.repeat(64) },
        next: { sha256: 'b'.repeat(64) }, attempts: 0, exec_path: path.join(dataDir, 'bin'), error: 'UPDATE_FAILED',
        downgrade: {
            undoes: { from: '3.1.0', to: '3.2.0', at: '2026-10-01T10:00:00.000Z', backup: { file: SOURCE, sha256: 'c'.repeat(64) }, schema_before: 27 },
            db: { source: { file: SOURCE, sha256: 'c'.repeat(64) }, schema: 27, replaced_at: '2026-10-11T10:00:02.000Z', kept: KEPT, returned_at: null, ...dbOver }
        },
        ...rest
    };
}

function world(over = {}) {
    const dataDir = fresh('data');
    fs.mkdirSync(path.join(dataDir, 'backups'));
    const freshDb = path.join(dataDir, 'fresh.db');
    makeDb(freshDb, 28, 'newer');
    const freshSha = zipOfDb(freshDb, path.join(dataDir, 'backups', FRESH));
    fs.unlinkSync(freshDb);
    const dbFile = path.join(dataDir, 'manga.db');
    makeDb(dbFile, 27, 'target');
    stateFile.writeState(dataDir, journal(dataDir, freshSha, over));
    return { dataDir, dbFile, freshSha };
}

const lines = () => {
    const out = [];
    return { out, push: (line) => out.push(line) };
};
const run = (w, version = '3.2.0') => {
    const log = lines();
    const result = recovery.recoverReplacedDatabase({ dataDir: w.dataDir, version, out: log.push, now: () => 1e13 });
    return { result, out: log.out };
};
const keptCopies = (dataDir) => fs.readdirSync(dataDir).filter((f) => /^manga\.db\.v3\.1\.0-/.test(f));

test('a switch that failed after the replacement: the replaced database is kept, the fresh backup comes back, sessions end, returned_at is set', () => {
    const w = world();
    const { result, out } = run(w);
    assert.equal(result.action, 'recovered');
    assert.match(result.kept, /^manga\.db\.v3\.1\.0-\d{4}-\d\d-\d\dT[\d-]+Z$/);
    assert.deepEqual(readDb(w.dbFile), { schema: 28, marker: 'newer', sessions: 1e13, revoked: 0 });
    assert.deepEqual(keptCopies(w.dataDir), [result.kept], 'the database the recovery replaces is always kept');
    assert.equal(readDb(path.join(w.dataDir, result.kept)).marker, 'target');
    assert.equal(fs.existsSync(`${w.dbFile}.bak`), false);
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.downgrade.db.returned_at, new Date(1e13).toISOString());
    assert.equal(s.downgrade.db.returning_at, new Date(1e13).toISOString());
    assert.match(out.join('\n'), /Rückkehr zu v3\.2\.0: Datenbank aus backups\/vor-update-v3\.2\.0-auf-v3\.1\.0-.*wiederhergestellt/);
    assert.deepEqual(run(w).result, { action: 'none' }, 'done once');
});

test('a downgrade that never replaced the database (no kept copy journaled) leaves a schema-27 database and its journal alone', () => {
    const never = { replaced_at: null, kept: null };
    for (const over of [{ db: never }, { error: 'UPDATE_INTERRUPTED', db: never }, { phase: 'swapping', error: undefined, db: never }]) {
        const w = world(over);
        makeDb(path.join(w.dataDir, 'offline.db'), 27, 'restored by hand on the older version');
        fs.renameSync(path.join(w.dataDir, 'offline.db'), w.dbFile);
        const journal = fs.readFileSync(path.join(w.dataDir, 'update-state.json'), 'utf8');
        assert.deepEqual(run(w).result, { action: 'none' }, JSON.stringify(over));
        assert.equal(readDb(w.dbFile).marker, 'restored by hand on the older version');
        assert.deepEqual(fs.readdirSync(w.dataDir).filter((f) => f.startsWith('manga.db')), ['manga.db']);
        assert.equal(fs.readFileSync(path.join(w.dataDir, 'update-state.json'), 'utf8'), journal);
    }
});

test('an armed journal on a database at schema_before (the move never happened) is disarmed; a schema-27 database later stays', () => {
    const w = world({ db: { replaced_at: null } });
    makeDb(path.join(w.dataDir, 'live.db'), 28, 'live');
    fs.renameSync(path.join(w.dataDir, 'live.db'), w.dbFile);
    assert.deepEqual(run(w).result, { action: 'none' });
    assert.equal(readDb(w.dbFile).marker, 'live');
    assert.equal(stateFile.readState(w.dataDir).downgrade.db.returned_at, new Date(1e13).toISOString());
    fs.rmSync(w.dbFile);
    makeDb(w.dbFile, 27, 'older again');
    assert.deepEqual(run(w).result, { action: 'none' });
    assert.equal(readDb(w.dbFile).marker, 'older again');
    assert.deepEqual(keptCopies(w.dataDir), []);
});

test('swapping (dead owner) and rolled_back with a started target: the target database is kept with its -wal first', () => {
    const swapping = world({ phase: 'swapping', error: undefined });
    assert.equal(run(swapping).result.action, 'recovered');
    assert.equal(readDb(swapping.dbFile).marker, 'newer');

    const rolled = world({ phase: 'rolled_back', error: 'START_FAILED', swapped_at: '2026-10-11T10:00:03.000Z', started_at: '2026-10-11T10:01:00.000Z', attempts: 1 });
    const { result, out } = run(rolled);
    assert.match(result.kept, /^manga\.db\.v3\.1\.0-\d{4}-\d\d-\d\dT[\d-]+Z$/);
    assert.deepEqual(keptCopies(rolled.dataDir), [result.kept]);
    assert.equal(readDb(path.join(rolled.dataDir, result.kept)).marker, 'target');
    assert.ok(out.some((line) => line.endsWith(`aufbewahrt als ${result.kept}`)), out.join('\n'));
    assert.equal(readDb(rolled.dbFile).marker, 'newer');

    const dir = fresh('wal');
    fs.writeFileSync(path.join(dir, 'manga.db'), 'db');
    fs.writeFileSync(path.join(dir, 'manga.db-wal'), 'wal');
    recovery.keepCopy(path.join(dir, 'manga.db'), path.join(dir, 'kept'));
    assert.deepEqual([fs.readFileSync(path.join(dir, 'kept'), 'utf8'), fs.readFileSync(path.join(dir, 'kept-wal'), 'utf8')], ['db', 'wal']);
    assert.throws(() => recovery.keepCopy(path.join(dir, 'manga.db'), path.join(dir, 'kept')), /EEXIST/);
});

test('a swapped downgrade journal without started_at keeps the replaced database before the fresh backup is restored', () => {
    const w = world({ phase: 'swapped', error: undefined, swapped_at: '2026-10-11T10:00:03.000Z' });
    const { result } = run(w);
    assert.equal(result.action, 'recovered');
    assert.ok(result.kept);
    assert.equal(readDb(path.join(w.dataDir, result.kept)).marker, 'target');
    assert.equal(readDb(w.dbFile).marker, 'newer');
});

test('left alone: ROLLBACK_FAILED after attempts, running or confirmed phases, already returned, an older code', () => {
    const cases = [
        [{ phase: 'failed', error: 'ROLLBACK_FAILED', attempts: 1, swapped_at: 'x' }],
        ...['staged', 'ready-to-swap', 'started', 'confirmed'].map((phase) => [{ phase, error: undefined }]),
        [{ db: { returned_at: '2026-10-12T00:00:00.000Z' } }],
        [{}, '3.1.0'],
        [{ phase: 'swapping', pid: process.ppid, error: undefined }]
    ];
    for (const [over, version] of cases) {
        const w = world(over);
        assert.deepEqual(run(w, version).result, { action: 'none' }, JSON.stringify(over));
        assert.equal(readDb(w.dbFile).marker, 'target');
        assert.deepEqual(fs.readdirSync(w.dataDir).filter((f) => f.startsWith('manga.db')), ['manga.db']);
    }
    const plain = world();
    const s = stateFile.readState(plain.dataDir);
    delete s.downgrade;
    stateFile.writeState(plain.dataDir, s);
    assert.deepEqual(run(plain).result, { action: 'none' }, 'a plain update journal');
    const migrated = world();
    makeDb(path.join(migrated.dataDir, 'm.db'), 28, 'already newer');
    fs.renameSync(path.join(migrated.dataDir, 'm.db'), migrated.dbFile);
    assert.deepEqual(run(migrated).result, { action: 'none' }, 'schema not below schema_before');
});

test('a missing or changed fresh backup: exit 74 with the way out, nothing changed and no copy left', () => {
    for (const damage of ['missing', 'changed']) {
        const w = world({ swapped_at: 'x', started_at: 'y' });
        const file = path.join(w.dataDir, 'backups', FRESH);
        if (damage === 'missing') fs.unlinkSync(file);
        else fs.appendFileSync(file, 'x');
        assert.throws(() => run(w), (err) => {
            assert.equal(err.code, 'DOWNGRADE_RECOVERY_PENDING');
            assert.equal(err.exitCode, 74);
            assert.equal(err.message, `[Update] Rückkehr zu v3.2.0 nicht abgeschlossen: Backup ${damage === 'missing' ? 'fehlt' : 'wurde verändert'}: ${FRESH}. `
                + `Die Datenbank wird nicht geöffnet. Der Stand von vor dem Zurücksetzen liegt in backups/${FRESH} und als ${KEPT}. `
                + `Bei gestopptem Server ${KEPT} als manga.db einsetzen (die jetzige manga.db samt manga.db-wal und manga.db-shm vorher umbenennen) `
                + 'und neu starten – update-state.json nicht löschen.');
            return true;
        });
        assert.equal(readDb(w.dbFile).marker, 'target');
        assert.deepEqual(keptCopies(w.dataDir), []);
        assert.equal(stateFile.readState(w.dataDir).downgrade.db.returned_at, null);
    }
});

test('a manga.db.bak is put back (and logged) only while the journal shows an install in flight', () => {
    const w = world({ db: { replaced_at: null } });
    makeDb(`${w.dbFile}.bak`, 28, 'newer live copy');
    const { result, out } = run(w);
    assert.deepEqual(result, { action: 'recovered', kept: null });
    assert.equal(readDb(w.dbFile).marker, 'newer live copy', 'the newer database itself came back, no restore needed');
    assert.equal(fs.existsSync(`${w.dbFile}.bak`), false);
    assert.ok(out.includes('[Update] Rückkehr zu v3.2.0: manga.db.bak als manga.db zurückgelegt'), out.join('\n'));
    assert.ok(stateFile.readState(w.dataDir).downgrade.db.returned_at);

    const half = world({ db: { returning_at: '2026-10-11T11:00:00.000Z' } });
    fs.rmSync(half.dbFile);
    makeDb(half.dbFile, 28, 'newer');
    makeDb(`${half.dbFile}.bak`, 27, 'target before the restore');
    const again = run(half);
    assert.equal(again.result.action, 'recovered');
    assert.equal(readDb(half.dbFile).marker, 'newer', 'the recovery\'s own .bak is put back, then the fresh backup restored again');
    assert.equal(readDb(path.join(half.dataDir, again.result.kept)).marker, 'target before the restore');

    const broken = world({ db: { replaced_at: null } });
    fs.writeFileSync(`${broken.dbFile}.bak`, 'not a database');
    assert.throws(() => run(broken), (err) => err.code === 'DOWNGRADE_RECOVERY_PENDING' && err.exitCode === 74 && /manga\.db\.bak ist nicht lesbar/.test(err.message));
    assert.equal(readDb(broken.dbFile).marker, 'target', 'nothing is put over the database');
    assert.equal(fs.readFileSync(`${broken.dbFile}.bak`, 'utf8'), 'not a database');
    assert.deepEqual(keptCopies(broken.dataDir), []);
    assert.equal(stateFile.readState(broken.dataDir).downgrade.db.returned_at, null);
});

test('a stale or unreadable manga.db.bak is never put over the live database', () => {
    for (const content of ['stale', 'garbage']) {
        const w = world();
        fs.rmSync(w.dbFile);
        makeDb(w.dbFile, 28, 'live');
        if (content === 'stale') makeDb(`${w.dbFile}.bak`, 28, 'stale copy of an old restore');
        else fs.writeFileSync(`${w.dbFile}.bak`, 'not a database');
        const { result, out } = run(w);
        assert.deepEqual(result, { action: 'none' }, content);
        assert.equal(readDb(w.dbFile).marker, 'live');
        assert.ok(fs.existsSync(`${w.dbFile}.bak`), 'left to rollback-aufraeumen');
        assert.deepEqual(keptCopies(w.dataDir), []);
        assert.ok(stateFile.readState(w.dataDir).downgrade.db.returned_at, 'disarmed');
        assert.equal(out.some((line) => /zurückgelegt/.test(line)), false);
    }

    const target = world();
    makeDb(`${target.dbFile}.bak`, 28, 'stale copy of an old restore');
    assert.throws(() => run(target), (err) => err.code === 'DOWNGRADE_RECOVERY_PENDING' && /: manga\.db\.bak existiert bereits\. /.test(err.message));
    assert.equal(readDb(target.dbFile).marker, 'target');
    assert.equal(readDb(`${target.dbFile}.bak`).marker, 'stale copy of an old restore');
    assert.deepEqual(keptCopies(target.dataDir), []);
    assert.equal(stateFile.readState(target.dataDir).downgrade.db.returned_at, null);
});

test('db.js: the safety snapshot is named with its sha256, hold and anchor and downgrade backups survive its pruning, isDbOpen', () => {
    process.env.BACKUP_KEEP_PRE_UPDATE = '1';
    const dbm = require('../../db');
    try {
        assert.equal(dbm.isDbOpen(), true);
        assert.equal(dbm.getLastSafetySnapshot(), null, 'a fresh database takes no snapshot');
        const db = dbm.db;
        db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('kim', 'x', 'admin')").run();
        const backups = path.join(ownData, 'backups');
        fs.mkdirSync(backups, { recursive: true });
        const anchor = 'vor-update-v3.1.0-auf-v3.2.0-2026-01-01T10-00-00-000Z.zip';
        const downgrade = 'vor-update-v3.3.0-auf-v3.2.0-2026-01-02T10-00-00-000Z.zip';
        const ordinary = 'vor-update-v3.0.0-auf-v3.0.1-2026-01-03T10-00-00-000Z.zip';
        for (const name of [anchor, downgrade, ordinary]) fs.writeFileSync(path.join(backups, name), 'zip');
        stateFile.writeState(ownData, {
            phase: 'confirmed', mode: 'sea-user', restart: 'supervised', from: '3.1.0', to: pkg.version, at: '2026-01-01T10:00:00.000Z', user: 1, pid: 1,
            schema_before: 27, backup: { file: anchor, sha256: 'a'.repeat(64) }, previous: { sha256: 'b'.repeat(64) }, attempts: 0, exec_path: '/x'
        });
        db.exec('DROP TRIGGER IF EXISTS trg_volumes_owned_ins; DROP TRIGGER IF EXISTS trg_volumes_owned_del; DROP TRIGGER IF EXISTS trg_volumes_owned_upd; DELETE FROM schema_migrations WHERE version >= 16;');
        dbm.initDb();
        const snapshot = dbm.getLastSafetySnapshot();
        assert.match(snapshot.file, /^vor-update-v15-auf-v\d+-/);
        assert.equal(snapshot.sha256, h.sha256hex(fs.readFileSync(path.join(backups, snapshot.file))));
        assert.deepEqual(fs.readdirSync(backups).sort(), [anchor, downgrade, snapshot.file].sort());
        dbm.closeDb();
        assert.equal(dbm.isDbOpen(), false);
    } finally {
        delete process.env.BACKUP_KEEP_PRE_UPDATE;
        fs.rmSync(path.join(ownData, 'update-state.json'), { force: true });
        dbm.closeDb();
    }
});

test('db.js runs the recovery on the first initDb of a process only: a reopen (as a restore does) never puts a backup back', () => {
    const dbm = require('../../db');
    const journalFile = path.join(ownData, 'update-state.json');
    try {
        dbm.initDb();
        const latest = require('../../core/schema').appliedSchemaVersion(dbm.db);
        stateFile.writeState(ownData, journal(ownData, 'f'.repeat(64), { from: pkg.version, to: '3.1.0', schema_before: latest + 1 }));
        const before = fs.readFileSync(journalFile, 'utf8');
        assert.throws(() => recovery.recoverReplacedDatabase({ dataDir: ownData, version: pkg.version, out: () => {} }), (err) => err.code === 'DOWNGRADE_RECOVERY_PENDING', 'the journal is armed');
        assert.doesNotThrow(() => dbm.initDb());
        assert.equal(dbm.isDbOpen(), true);
        assert.equal(fs.readFileSync(journalFile, 'utf8'), before);
    } finally {
        fs.rmSync(journalFile, { force: true });
        dbm.closeDb();
    }
});

function realWorld(over = {}) {
    const dataDir = fresh('real');
    const made = spawnSync(process.execPath, ['-e', "require('./db.js').closeDb()"], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir, LOG_LEVEL: 'silent' }, encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const dbFile = path.join(dataDir, 'manga.db');
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA journal_mode = DELETE;');
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('kim', 'x', 'admin')").run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('test_marker', 'newer')").run();
    const latest = db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v;
    db.close();
    fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
    const freshSha = zipOfDb(dbFile, path.join(dataDir, 'backups', FRESH));
    const live = new DatabaseSync(dbFile);
    live.prepare("UPDATE app_settings SET value = 'replaced' WHERE key = 'test_marker'").run();
    live.prepare('DELETE FROM schema_migrations WHERE version = ?').run(latest);
    live.close();
    stateFile.writeState(dataDir, journal(dataDir, freshSha, { schema_before: latest, to: '3.1.0', from: pkg.version, ...over }));
    return { dataDir, dbFile, latest };
}

const marker = (file) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        return { marker: db.prepare("SELECT value FROM app_settings WHERE key = 'test_marker'").get().value, schema: db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v };
    } finally {
        db.close();
    }
};
const snapshotsOf = (dataDir) => fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => f.endsWith('.zip') && f !== FRESH);

function child(dataDir, body) {
    const file = path.join(fresh('child'), 'child.js');
    fs.writeFileSync(file, body);
    return spawnSync(process.execPath, [file], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir, LOG_LEVEL: 'warn', MANGA_SHELF_NO_LISTEN: '1' }, encoding: 'utf8' });
}

test('with the frozen v3.2.0 prelude, state, swap and constants cached under the live paths, db.js still restores before any migration', () => {
    const w = realWorld({ phase: 'failed', error: 'UPDATE_INTERRUPTED' });
    const live = path.join(ROOT, 'services', 'update');
    const res = child(w.dataDir, `
const Module = require('module');
const path = require('path');
for (const name of ['constants', 'state', 'swap', 'prelude']) {
    const frozen = require(path.join(${JSON.stringify(FROZEN)}, name + '.js'));
    const file = path.join(${JSON.stringify(live)}, name + '.js');
    const m = new Module(file, module);
    m.filename = file;
    m.loaded = true;
    m.exports = frozen;
    require.cache[file] = m;
}
const state = require(${JSON.stringify(path.join(live, 'state'))});
if (typeof state.heldBackups !== 'undefined') throw new Error('the live state.js was loaded');
require(${JSON.stringify(path.join(live, 'prelude'))}).run({ dataDir: process.env.DATA_DIR, server: false, version: ${JSON.stringify(pkg.version)} });
const dbm = require(${JSON.stringify(path.join(ROOT, 'db.js'))});
process.stdout.write(JSON.stringify(dbm.getLastMigrationReport().map((r) => r.version)) + '\\n');
dbm.closeDb();
`);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(res.stdout.trim().split('\n').pop(), '[]', 'no migration ran');
    assert.deepEqual(marker(w.dbFile), { marker: 'newer', schema: w.latest });
    assert.deepEqual(snapshotsOf(w.dataDir), [], 'no safety snapshot of the replaced database');
    assert.ok(stateFile.readState(w.dataDir).downgrade.db.returned_at);
});

test('a rolling_back downgrade journal with the code already reverted, then a console command (server: false), restores before any migration', () => {
    const w = realWorld({ phase: 'rolling_back', error: 'START_FAILED', swapped_at: '2026-10-11T10:00:03.000Z', started_at: '2026-10-11T10:01:00.000Z', attempts: 2 });
    const res = child(w.dataDir, `
require(${JSON.stringify(path.join(ROOT, 'services', 'update', 'prelude'))}).run({ dataDir: process.env.DATA_DIR, server: false, version: ${JSON.stringify(pkg.version)} });
const dbm = require(${JSON.stringify(path.join(ROOT, 'db.js'))});
process.stdout.write(JSON.stringify(dbm.getLastMigrationReport().map((r) => r.version)) + '\\n');
dbm.closeDb();
`);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(res.stdout.trim().split('\n').pop(), '[]');
    assert.deepEqual(marker(w.dbFile), { marker: 'newer', schema: w.latest });
    const kept = keptCopies(w.dataDir).filter((f) => !f.endsWith('-wal'));
    assert.equal(kept.length, 1, 'the target had started: its database is kept');
    assert.equal(marker(path.join(w.dataDir, kept[0])).marker, 'replaced');
    assert.equal(stateFile.readState(w.dataDir).phase, 'rolling_back', 'the next server start finishes the rollback itself');
});
