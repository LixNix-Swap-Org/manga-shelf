process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const restart = require('../../services/update/restart');
const lock = require('../../services/update/lock');
const apply = require('../../services/update/apply');
const swap = require('../../services/update/swap');
const stateFile = require('../../services/update/state');
const h = require('../fixtures/update/helpers');

const root = h.tmpDir();
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test.beforeEach(() => {
    restart.reset();
    lock.reset();
});
let n = 0;

async function ready({ restartKind = 'pterodactyl' } = {}) {
    const dir = path.join(root, `w-${n++}`);
    const codeDir = path.join(dir, 'code');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(codeDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'package.json'), JSON.stringify({ version: '3.1.0', files: ['index.js'] }));
    fs.writeFileSync(path.join(codeDir, 'index.js'), 'old');
    const zipFile = path.join(dir, 'p.zip');
    fs.writeFileSync(zipFile, h.makeZip([{ name: 'package.json', data: JSON.stringify({ version: '3.2.0', files: ['index.js'] }) }, { name: 'index.js', data: 'new' }]));
    const unpacked = await apply.unpackRelease({ zipFile, codeDir });
    stateFile.writeState(dataDir, {
        phase: 'ready-to-swap', mode: 'pterodactyl', restart: restartKind, from: '3.1.0', to: '3.2.0', at: 'x', user: 1, pid: process.pid,
        schema_before: 5, backup: { file: 'b.zip', sha256: 'a'.repeat(64) }, attempts: 0, code_dir: codeDir,
        entries: unpacked.entries, removals: [], previous: { sha256: swap.sha256FileSync(path.join(codeDir, 'package.json')) }
    });
    return { codeDir, dataDir };
}

function exitPromise() {
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    return { exit: (code) => resolve(code), done };
}

test('without a registered handler (desktop, tests) a restart is refused', async () => {
    assert.equal(restart.hasRestartHandler(), false);
    assert.throws(() => restart.requestRestart({ dataDir: root }), (e) => e.code === 'NOT_INSTALLABLE' && e.extra.reason === 'no_restart');
});

test('shutdown first, then the switch as the last step, then exit 75', async () => {
    const w = await ready();
    const order = [];
    restart.registerRestart(async () => {
        order.push(`shutdown sees ${fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8')}`);
    });
    const { exit, done } = exitPromise();
    restart.requestRestart({ ...w, exit });
    assert.equal(lock.currentPhase(), 'restarting');
    const code = await done;
    assert.equal(code, 75);
    assert.deepEqual(order, ['shutdown sees old']);
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'new');
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'swapped');
    assert.equal(s.pending_start, false);
});

test('unsupervised: the switch happens, exit 0 and the state says pending_start', async () => {
    const w = await ready({ restartKind: 'manual' });
    restart.registerRestart(async () => {});
    const { exit, done } = exitPromise();
    restart.requestRestart({ ...w, exit });
    assert.equal(await done, 0);
    assert.equal(stateFile.readState(w.dataDir).pending_start, true);
    assert.equal(stateFile.lastResult(w.dataDir).result, 'pending_start');
});

test('a hanging shutdown does not block the switch past the deadline', async () => {
    const w = await ready();
    restart.registerRestart(() => new Promise(() => {}));
    const { exit, done } = exitPromise();
    restart.requestRestart({ ...w, exit, deadlineMs: 50 });
    assert.equal(await done, 75);
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'new');
});

test('a failing switch is undone, recorded as failed and the old code restarts', async () => {
    const w = await ready();
    fs.rmSync(path.join(w.codeDir, '.update', 'next', 'index.js'));
    fs.mkdirSync(path.join(w.codeDir, '.update', 'previous', 'index.js'), { recursive: true });
    restart.registerRestart(async () => {});
    const { exit, done } = exitPromise();
    restart.requestRestart({ ...w, exit });
    assert.equal(await done, 75);
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'old');
    assert.equal(stateFile.readState(w.dataDir).phase, 'failed');
});

test('no prepared state: no switch at all', async () => {
    const dataDir = path.join(root, 'none');
    fs.mkdirSync(dataDir);
    assert.equal(restart.performSwap({ dataDir, codeDir: dataDir }), 75);
    const unregister = restart.registerRestart(async () => {});
    unregister();
    assert.equal(restart.hasRestartHandler(), false);
});

const { DatabaseSync } = require('node:sqlite');
const SOURCE = 'vor-update-v3.1.0-auf-v3.2.0-2026-10-01T10-00-00-000Z.zip';
const FRESH = 'vor-update-v3.2.0-auf-v3.1.0-2026-10-11T10-00-00-000Z.zip';

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
            ended: db.prepare('SELECT password_changed_at AS p FROM users').get().p > 5,
            revoked: db.prepare("SELECT count(*) AS c FROM app_settings WHERE key = 'revoked_sessions'").get().c
        };
    } finally {
        db.close();
    }
}

async function downgradeReady({ removals = [] } = {}) {
    const dir = path.join(root, `d-${n++}`);
    const codeDir = path.join(dir, 'code');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(codeDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'package.json'), JSON.stringify({ version: '3.2.0', files: ['index.js'] }));
    fs.writeFileSync(path.join(codeDir, 'index.js'), 'newer');
    const zipFile = path.join(dir, 'p.zip');
    fs.writeFileSync(zipFile, h.makeZip([{ name: 'package.json', data: JSON.stringify({ version: '3.1.0', files: ['index.js'] }) }, { name: 'index.js', data: 'older' }]));
    const unpacked = await apply.unpackRelease({ zipFile, codeDir });
    const zipDb = (schema, marker, name) => {
        const file = path.join(dir, `${name}.db`);
        makeDb(file, schema, marker);
        const bytes = h.makeZip([{ name: 'manga.db', data: fs.readFileSync(file) }]);
        fs.writeFileSync(path.join(dataDir, 'backups', name), bytes);
        return h.sha256hex(bytes);
    };
    const sourceSha = zipDb(27, 'before the update', SOURCE);
    const freshSha = zipDb(28, 'newer', FRESH);
    fs.writeFileSync(path.join(dataDir, 'backups', FRESH.replace(/\.zip$/, '.json')), '{"verified":true}');
    const dbFile = path.join(dataDir, 'manga.db');
    makeDb(dbFile, 28, 'newer');
    stateFile.writeState(dataDir, {
        phase: 'ready-to-swap', mode: 'pterodactyl', restart: 'pterodactyl', from: '3.2.0', to: '3.1.0', at: 'x', user: 1, pid: process.pid,
        schema_before: 28, backup: { file: FRESH, sha256: freshSha }, attempts: 0, code_dir: codeDir, entries: unpacked.entries, removals,
        previous: { sha256: swap.sha256FileSync(path.join(codeDir, 'package.json')) },
        downgrade: {
            undoes: { from: '3.1.0', to: '3.2.0', at: '2026-10-01T10:00:00.000Z', backup: { file: SOURCE, sha256: sourceSha }, schema_before: 27 },
            db: { source: { file: SOURCE, sha256: sourceSha }, schema: 27, replaced_at: null, kept: null, returned_at: null }
        }
    });
    return { codeDir, dataDir, dbFile };
}

const keptCopies = (dataDir) => fs.readdirSync(dataDir).filter((f) => f.startsWith('manga.db.v'));

test('a downgrade that replaces the database: source backup in place (sessions ended) and the live one kept before the code switch', async () => {
    const w = await downgradeReady();
    const order = [];
    restart.registerRestart(async () => { order.push(readDb(w.dbFile).marker); });
    const { exit, done } = exitPromise();
    restart.requestRestart({ dataDir: w.dataDir, codeDir: w.codeDir, exit, isDbOpen: () => false });
    assert.equal(await done, 75);
    assert.deepEqual(order, ['newer'], 'the database is replaced after the shutdown');
    assert.deepEqual(readDb(w.dbFile), { schema: 27, marker: 'before the update', ended: true, revoked: 0 });
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'older');
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'swapped');
    assert.match(s.downgrade.db.kept, /^manga\.db\.v3\.2\.0-\d{4}-\d\d-\d\dT[\d-]+Z$/);
    assert.ok(s.downgrade.db.replaced_at && s.swapped_at);
    assert.deepEqual(keptCopies(w.dataDir), [s.downgrade.db.kept]);
    assert.equal(readDb(path.join(w.dataDir, s.downgrade.db.kept)).marker, 'newer');
    assert.equal(fs.existsSync(`${w.dbFile}.bak`), false);
    assert.equal(fs.existsSync(`${w.dbFile}.restore-tmp`), false);
});

test('a shutdown past the deadline or an open database leaves code and database of a replacing downgrade unchanged', async () => {
    const w = await downgradeReady();
    restart.registerRestart(() => new Promise(() => {}));
    const { exit, done } = exitPromise();
    restart.requestRestart({ dataDir: w.dataDir, codeDir: w.codeDir, exit, deadlineMs: 50, isDbOpen: () => false });
    assert.equal(await done, 75);
    assert.equal(readDb(w.dbFile).marker, 'newer');
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'newer');
    assert.equal(fs.existsSync(path.join(w.codeDir, '.update')), false);
    assert.deepEqual(keptCopies(w.dataDir), []);
    const s = stateFile.readState(w.dataDir);
    assert.deepEqual([s.phase, s.error, s.swapped_at, s.downgrade.db.replaced_at], ['failed', 'UPDATE_FAILED', undefined, null]);

    const open = await downgradeReady();
    assert.equal(restart.performSwap({ dataDir: open.dataDir, codeDir: open.codeDir, isDbOpen: () => true }), 75);
    assert.equal(readDb(open.dbFile).marker, 'newer');
    assert.equal(stateFile.readState(open.dataDir).phase, 'failed');
});

test('a switch that fails after the replacement puts the newer database back from the fresh backup', async () => {
    const w = await downgradeReady({ removals: ['lib/extra.js'] });
    fs.mkdirSync(path.join(w.codeDir, 'lib'));
    fs.writeFileSync(path.join(w.codeDir, 'lib', 'extra.js'), 'x');
    fs.mkdirSync(path.join(w.codeDir, '.update', 'previous'), { recursive: true });
    fs.writeFileSync(path.join(w.codeDir, '.update', 'previous', 'lib'), 'blocks the removal');
    assert.equal(restart.performSwap({ dataDir: w.dataDir, codeDir: w.codeDir, isDbOpen: () => false }), 75);
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'newer');
    assert.deepEqual(readDb(w.dbFile), { schema: 28, marker: 'newer', ended: true, revoked: 0 });
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'failed');
    assert.equal(s.swapped_at, undefined);
    assert.ok(s.downgrade.db.replaced_at && s.downgrade.db.returned_at);
});

const dbRecovery = require('../../services/update/dbRecovery');
const dataFiles = (dataDir) => fs.readdirSync(dataDir).filter((f) => f.startsWith('manga.db'));

test('a manga.db.bak (stale or unreadable) stops a replacing downgrade before swapping; nothing is armed or put back', async () => {
    for (const content of ['stale', 'garbage']) {
        const w = await downgradeReady();
        if (content === 'stale') makeDb(`${w.dbFile}.bak`, 28, 'stale copy of an old restore');
        else fs.writeFileSync(`${w.dbFile}.bak`, 'not a database');
        assert.equal(restart.performSwap({ dataDir: w.dataDir, codeDir: w.codeDir, isDbOpen: () => false }), 75);
        assert.equal(readDb(w.dbFile).marker, 'newer');
        assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'newer');
        assert.deepEqual(dataFiles(w.dataDir), ['manga.db', 'manga.db.bak']);
        const s = stateFile.readState(w.dataDir);
        assert.deepEqual([s.phase, s.error, s.swapped_at, s.downgrade.db.kept, s.downgrade.db.replaced_at], ['failed', 'UPDATE_FAILED', undefined, null, null]);
        assert.deepEqual(dbRecovery.recoverReplacedDatabase({ dataDir: w.dataDir, version: '3.2.0', out: () => {} }), { action: 'none' });
        assert.equal(readDb(w.dbFile).marker, 'newer');
    }
});

test('a manga.db.bak that appears after the check: nothing is moved, the recovery is not called and the unused copies go', async () => {
    const w = await downgradeReady();
    const original = dbRecovery.endSessions;
    dbRecovery.endSessions = (file) => {
        original(file);
        makeDb(`${w.dbFile}.bak`, 28, 'stale copy of an old restore');
    };
    try {
        assert.equal(restart.performSwap({ dataDir: w.dataDir, codeDir: w.codeDir, isDbOpen: () => false }), 75);
    } finally {
        dbRecovery.endSessions = original;
    }
    assert.equal(readDb(w.dbFile).marker, 'newer');
    assert.equal(readDb(`${w.dbFile}.bak`).marker, 'stale copy of an old restore');
    assert.deepEqual(dataFiles(w.dataDir), ['manga.db', 'manga.db.bak'], 'no kept copy, no staged file');
    const s = stateFile.readState(w.dataDir);
    assert.deepEqual([s.phase, s.downgrade.db.kept, s.downgrade.db.replaced_at, s.downgrade.db.returned_at], ['failed', null, null, null]);
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'newer');
});

test('a replacement that fails once files moved is put back by the recovery and the replaced database is kept', async () => {
    const w = await downgradeReady();
    const original = dbRecovery.installDatabase;
    dbRecovery.installDatabase = (dataDir, staged, schema, onMove) => {
        original(dataDir, staged, schema, onMove);
        throw new Error('disk gone');
    };
    try {
        assert.equal(restart.performSwap({ dataDir: w.dataDir, codeDir: w.codeDir, isDbOpen: () => false }), 75);
    } finally {
        dbRecovery.installDatabase = original;
    }
    assert.deepEqual(readDb(w.dbFile), { schema: 28, marker: 'newer', ended: true, revoked: 0 });
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'failed');
    assert.match(s.downgrade.db.kept, /^manga\.db\.v3\.2\.0-/);
    assert.equal(s.downgrade.db.replaced_at, null);
    assert.ok(s.downgrade.db.returned_at);
    assert.equal(readDb(path.join(w.dataDir, s.downgrade.db.kept)).marker, 'newer');
    const replaced = keptCopies(w.dataDir).filter((f) => f.startsWith('manga.db.v3.1.0-'));
    assert.equal(replaced.length, 1);
    assert.equal(readDb(path.join(w.dataDir, replaced[0])).marker, 'before the update');
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'newer');
});

test('a replacement that undoes itself after moving files leaves the live database and a disarmed journal', async () => {
    const w = await downgradeReady();
    const original = dbRecovery.installDatabase;
    dbRecovery.installDatabase = (dataDir, staged, schema, onMove) => original(dataDir, staged, schema + 1, onMove);
    try {
        assert.equal(restart.performSwap({ dataDir: w.dataDir, codeDir: w.codeDir, isDbOpen: () => false }), 75);
    } finally {
        dbRecovery.installDatabase = original;
    }
    assert.equal(readDb(w.dbFile).marker, 'newer');
    assert.equal(readDb(w.dbFile).ended, false, 'the live database itself, not the fresh backup');
    const s = stateFile.readState(w.dataDir);
    assert.deepEqual([s.phase, s.downgrade.db.replaced_at], ['failed', null]);
    assert.ok(s.downgrade.db.kept && s.downgrade.db.returned_at);
    assert.deepEqual(dataFiles(w.dataDir), ['manga.db', s.downgrade.db.kept]);
});
