process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const apply = require('../../services/update/apply');
const swap = require('../../services/update/swap');
const stateFile = require('../../services/update/state');
const { ROLLED_BACK_LINE } = require('../../services/update/prelude');
const h = require('../fixtures/update/helpers');

const root = h.tmpDir();
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (name) => {
    const dir = path.join(root, `${name}-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

const CHILD = path.join(root, 'child.js');
fs.writeFileSync(CHILD, `
const prelude = require(${JSON.stringify(path.join(__dirname, '..', '..', 'services', 'update', 'prelude.js'))});
const opts = JSON.parse(process.env.PRELUDE_OPTS);
const result = prelude.run(opts);
process.stdout.write(JSON.stringify(result) + '\\n');
const scenario = process.argv[2];
if (scenario === 'listen') {
    prelude.markStarted({ confirmAfterMs: 600000 });
    if (process.env.CONFIRM_NOW) process.stdout.write('confirm=' + prelude.confirm() + '\\n');
    process.stdout.write('held=' + prelude.heldBackup() + '\\n');
    process.exit(0);
}
if (scenario === 'listen-crash') {
    prelude.markStarted({ confirmAfterMs: 600000 });
    throw new Error('crash after listen');
}
if (scenario === 'throw') throw new Error('MODULE_NOT_FOUND during start');
if (scenario === 'eaddrinuse') {
    prelude.markListenFailed(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
    process.exit(1);
}
process.exit(0);
`);

function runChild(scenario, opts, env = {}) {
    const r = spawnSync(process.execPath, [CHILD, scenario], { env: { ...process.env, ...env, PRELUDE_OPTS: JSON.stringify(opts) }, encoding: 'utf8' });
    const first = r.stdout.split('\n')[0];
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, result: first ? JSON.parse(first) : null };
}

function makeDb(file, versions, marker) {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); CREATE TABLE marker (v TEXT)');
    for (const v of versions) db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(v);
    db.prepare('INSERT INTO marker (v) VALUES (?)').run(marker);
    db.close();
}

function readDb(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        return { version: db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, marker: db.prepare('SELECT v FROM marker').get().v };
    } finally {
        db.close();
    }
}

function dataWorld({ migrated = true } = {}) {
    const dataDir = fresh('data');
    fs.mkdirSync(path.join(dataDir, 'backups'));
    const dbFile = path.join(dataDir, 'manga.db');
    makeDb(dbFile, [1, 2, 3, 4, 5], 'before update');
    const name = 'vor-update-v3.1.0-auf-v3.2.0-2026-10-10T10-00-00-000Z.zip';
    const zipBytes = h.makeZip([{ name: 'manga.db', data: fs.readFileSync(dbFile) }, { name: 'manifest.json', data: '{}' }]);
    fs.writeFileSync(path.join(dataDir, 'backups', name), zipBytes);
    if (migrated) {
        const db = new DatabaseSync(dbFile);
        db.exec("INSERT INTO schema_migrations (version) VALUES (6); UPDATE marker SET v = 'half migrated'");
        db.close();
    }
    return { dataDir, dbFile, backup: { file: name, sha256: h.sha256hex(zipBytes) } };
}

const base = (data, over = {}) => ({
    phase: 'swapped', from: '3.1.0', to: '3.2.0', at: '2026-10-10T10:00:00Z', user: 1, pid: 2 ** 22 + 12345,
    schema_before: 5, backup: data.backup, attempts: 0, ...over
});

async function pteroWorld(options = {}) {
    const data = dataWorld(options);
    const codeDir = fresh('code');
    fs.writeFileSync(path.join(codeDir, 'package.json'), JSON.stringify({ version: '3.1.0', files: ['index.js'] }));
    fs.writeFileSync(path.join(codeDir, 'index.js'), 'old');
    const zipFile = path.join(fresh('dl'), 'p.zip');
    fs.writeFileSync(zipFile, h.makeZip([
        { name: 'package.json', data: JSON.stringify({ version: options.zipVersion || '3.2.0', files: ['index.js'] }) },
        { name: 'index.js', data: 'new' }
    ]));
    const unpacked = await apply.unpackRelease({ zipFile, codeDir });
    const state = stateFile.writeState(data.dataDir, base(data, {
        phase: 'swapping', mode: 'pterodactyl', restart: 'pterodactyl', code_dir: codeDir, entries: unpacked.entries, removals: [],
        previous: { sha256: swap.sha256FileSync(path.join(codeDir, 'package.json')) }, ...options.state
    }));
    swap.swapForward(state, { codeDir });
    stateFile.writeState(data.dataDir, { ...state, phase: options.phase || 'swapped' });
    return { ...data, codeDir, opts: { dataDir: data.dataDir, codeDir } };
}

const posix = process.platform === 'win32' ? { skip: 'POSIX binary swap' } : {};

function seaWorld(options = {}) {
    const data = dataWorld(options);
    const dir = fresh('bin');
    const execPath = path.join(dir, 'manga-shelf-server');
    fs.writeFileSync(execPath, 'old binary');
    fs.writeFileSync(`${execPath}.new`, 'new binary');
    const state = stateFile.writeState(data.dataDir, base(data, {
        phase: 'swapping', mode: 'sea-user', restart: 'supervised', exec_path: execPath,
        previous: { sha256: h.sha256hex(Buffer.from('old binary')) }, next: { sha256: h.sha256hex(Buffer.from('new binary')) }
    }));
    swap.swapForward(state, { execPath, ...(options.platform ? { platform: options.platform } : {}) });
    stateFile.writeState(data.dataDir, { ...state, phase: 'swapped' });
    return { ...data, dir, execPath, opts: { dataDir: data.dataDir, execPath, version: '3.2.0', ...(options.platform ? { platform: options.platform } : {}) } };
}

function revertPackageJsonOnly(codeDir) {
    fs.renameSync(path.join(codeDir, 'package.json'), path.join(codeDir, '.update', 'next', 'package.json'));
    fs.renameSync(path.join(codeDir, '.update', 'previous', 'package.json'), path.join(codeDir, 'package.json'));
}

const tree = (codeDir) => ({
    index: fs.readFileSync(path.join(codeDir, 'index.js'), 'utf8'),
    version: JSON.parse(fs.readFileSync(path.join(codeDir, 'package.json'), 'utf8')).version,
    update: fs.existsSync(path.join(codeDir, '.update'))
});

test('Pterodactyl: the first failed start (no listen) rolls code and database back in the exit guard', async () => {
    const w = await pteroWorld();
    const r = runChild('throw', w.opts);
    assert.equal(r.result.action, 'counted');
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(ROLLED_BACK_LINE));
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'old');
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.codeDir, 'package.json'), 'utf8')).version, '3.1.0');
    assert.deepEqual(readDb(w.dbFile), { version: 5, marker: 'before update' });
    assert.equal(fs.existsSync(`${w.dbFile}.bak`), false);
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'rolled_back');
    assert.equal(s.error, 'START_FAILED');
    assert.equal(s.db_restored, true);
    assert.deepEqual(stateFile.lastResult(w.dataDir).result, 'rolled_back');
    assert.equal(stateFile.heldBackup(w.dataDir), null);
    const again = runChild('listen', w.opts);
    assert.equal(again.result.action, 'none', 'the old version starts normally afterwards');
});

test('a successful start counts as good; confirm removes the previous code and ends the hold', async () => {
    const w = await pteroWorld();
    const leftover = path.join(w.dataDir, 'temp', 'update', 'before-restart');
    fs.mkdirSync(leftover, { recursive: true });
    fs.utimesSync(leftover, new Date('2026-01-01'), new Date('2026-01-01'));
    const r = runChild('listen', w.opts, { CONFIRM_NOW: '1' });
    assert.equal(fs.existsSync(leftover), false, 'the staging of the update is removed');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /confirm=true/);
    assert.match(r.stdout, /held=null/);
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'confirmed');
    assert.equal(fs.existsSync(path.join(w.codeDir, '.update')), false);
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'new');
    assert.equal(stateFile.lastResult(w.dataDir).result, 'ok');
    assert.equal(readDb(w.dbFile).version, 6, 'the migrated database stays');
});

test('started, not yet confirmed: a clean stop does not count, the backup stays held, a crash in the window is rolled back', async () => {
    const w = await pteroWorld();
    const r = runChild('listen', w.opts);
    assert.match(r.stdout, /held=vor-update-v3\.1\.0-auf-v3\.2\.0/);
    let s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'started');
    assert.equal(s.attempts, 0, 'exit 0 after listen is a clean stop');
    const crash = runChild('throw', w.opts);
    assert.equal(crash.result.action, 'counted');
    assert.equal(crash.result.phase, 'started');
    assert.ok(crash.stderr.includes(ROLLED_BACK_LINE));
    assert.deepEqual(tree(w.codeDir), { index: 'old', version: '3.1.0', update: false });
    s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'rolled_back');
    assert.equal(s.error, 'START_FAILED');
    assert.equal(readDb(w.dbFile).version, 5);
});

test('Pterodactyl: a crash after listen inside the confirm window rolls back; the database of the new version is kept', async () => {
    const w = await pteroWorld();
    const r = runChild('listen-crash', w.opts);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(ROLLED_BACK_LINE));
    assert.deepEqual(tree(w.codeDir), { index: 'old', version: '3.1.0', update: false });
    assert.deepEqual(readDb(w.dbFile), { version: 5, marker: 'before update' });
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'rolled_back');
    assert.equal(s.db_restored, true);
    assert.match(s.db_kept, /^manga\.db\.v3\.2\.0-\d{4}-\d\d-\d\dT[\d-]+Z$/);
    assert.ok(r.stderr.includes(`aufbewahrt als ${s.db_kept}`));
    assert.deepEqual(readDb(path.join(w.dataDir, s.db_kept)), { version: 6, marker: 'half migrated' });
    assert.equal(stateFile.heldBackup(w.dataDir), null);
});

test('SEA: two crashes inside the confirm window roll back; a start killed after listen is counted by the next start', posix, () => {
    const w = seaWorld({ migrated: false });
    const first = runChild('listen-crash', w.opts);
    assert.notEqual(first.status, 0);
    assert.match(first.stderr, /fehlgeschlagen \(Versuch 1\)/);
    assert.equal(fs.readFileSync(w.execPath, 'utf8'), 'new binary');
    assert.equal(stateFile.readState(w.dataDir).phase, 'started');
    const second = runChild('listen-crash', w.opts);
    assert.equal(second.result.attempts, 2);
    assert.equal(fs.readFileSync(w.execPath, 'utf8'), 'old binary');
    assert.equal(stateFile.readState(w.dataDir).phase, 'rolled_back');

    const killed = seaWorld({ migrated: false });
    assert.equal(runChild('listen', killed.opts).status, 0);
    stateFile.patchState(killed.dataDir, { attempts: 2 });
    const next = runChild('listen', killed.opts);
    assert.equal(next.status, 75);
    assert.equal(fs.readFileSync(killed.execPath, 'utf8'), 'old binary');
    assert.equal(stateFile.readState(killed.dataDir).phase, 'rolled_back');
});

test('an interrupted rollback (rolling_back) is finished by the next start before any version check', async () => {
    const w = await pteroWorld();
    stateFile.patchState(w.dataDir, { phase: 'rolling_back', error: 'START_FAILED' });
    revertPackageJsonOnly(w.codeDir);
    assert.equal(stateFile.heldBackup(w.dataDir), w.backup.file, 'the backup stays held while rolling back');
    const r = runChild('listen', w.opts);
    assert.equal(r.status, 75);
    assert.equal(r.result, null);
    assert.deepEqual(tree(w.codeDir), { index: 'old', version: '3.1.0', update: false });
    assert.equal(readDb(w.dbFile).version, 5);
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'rolled_back');
    assert.equal(s.error, 'START_FAILED');
});

test('swapped with a half-reverted tree: the old package.json is not taken for the old version, the rollback is completed', async () => {
    const w = await pteroWorld();
    revertPackageJsonOnly(w.codeDir);
    const r = runChild('listen', w.opts);
    assert.equal(r.status, 75);
    assert.deepEqual(tree(w.codeDir), { index: 'old', version: '3.1.0', update: false });
    assert.equal(readDb(w.dbFile).version, 5);
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'rolled_back');
    assert.equal(s.error, 'VERSION_MISMATCH');
});

test('a revert that fails midway keeps the journal and exits 74 instead of booting; the next start finishes it', async () => {
    const w = await pteroWorld();
    stateFile.patchState(w.dataDir, { attempts: 1 });
    const blocker = path.join(w.codeDir, '.update', 'next', 'index.js');
    fs.writeFileSync(blocker, 'blocks the revert');
    const r = runChild('listen', w.opts);
    assert.equal(r.status, 74);
    assert.equal(r.result, null);
    let s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'rolling_back');
    assert.equal(s.db_restored, true);
    assert.match(s.rollback_error, /doppelt/);
    assert.equal(tree(w.codeDir).version, '3.1.0');
    assert.equal(tree(w.codeDir).index, 'new');
    fs.unlinkSync(blocker);
    const again = runChild('listen', w.opts);
    assert.equal(again.status, 75);
    assert.deepEqual(tree(w.codeDir), { index: 'old', version: '3.1.0', update: false });
    s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'rolled_back');
    assert.equal(s.db_restored, true);
    assert.equal(readDb(w.dbFile).version, 5);

    const guarded = await pteroWorld();
    const guardBlocker = path.join(guarded.codeDir, '.update', 'next', 'index.js');
    fs.writeFileSync(guardBlocker, 'blocks the revert');
    const crash = runChild('throw', guarded.opts);
    assert.match(crash.stderr, /Zurücksetzen beim nächsten Start/);
    assert.equal(stateFile.readState(guarded.dataDir).phase, 'rolling_back');
    fs.unlinkSync(guardBlocker);
    assert.equal(runChild('listen', guarded.opts).status, 75);
    assert.deepEqual(tree(guarded.codeDir), { index: 'old', version: '3.1.0', update: false });
});

test('Windows binary: the exit guard rolls back with the two-step rename', posix, () => {
    const w = seaWorld({ migrated: false, platform: 'win32' });
    assert.equal(fs.readFileSync(`${w.execPath}.previous`, 'utf8'), 'old binary');
    runChild('throw', w.opts);
    const second = runChild('throw', w.opts);
    assert.equal(second.result.attempts, 2);
    assert.equal(fs.readFileSync(w.execPath, 'utf8'), 'old binary');
    assert.ok(fs.readdirSync(w.dir).some((n) => n.startsWith('manga-shelf-server.failed-')));
    assert.equal(stateFile.readState(w.dataDir).phase, 'rolled_back');
});

test('EADDRINUSE on listen is not the new version\'s fault: not counted, no rollback', async () => {
    const w = await pteroWorld();
    const r = runChild('eaddrinuse', w.opts);
    assert.equal(r.status, 1);
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'swapped');
    assert.equal(s.attempts, 0);
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'new');
});

test('a start killed before its guard ran (SIGKILL) is rolled back by the next start, which exits 75', async () => {
    const w = await pteroWorld({ state: { attempts: 0 } });
    stateFile.patchState(w.dataDir, { attempts: 1 });
    const r = runChild('listen', w.opts);
    assert.equal(r.status, 75);
    assert.equal(r.result, null, 'the process ended inside run()');
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'old');
    assert.equal(stateFile.readState(w.dataDir).phase, 'rolled_back');
    assert.equal(readDb(w.dbFile).version, 5);
});

test('SEA: two attempts before the rollback; the database is untouched when no migration ran', posix, () => {
    const w = seaWorld({ migrated: false });
    const first = runChild('throw', w.opts);
    assert.equal(first.result.attempts, 1);
    assert.match(first.stderr, /fehlgeschlagen \(Versuch 1\)/);
    assert.equal(fs.readFileSync(w.execPath, 'utf8'), 'new binary');
    const second = runChild('throw', w.opts);
    assert.equal(second.result.attempts, 2);
    assert.equal(fs.readFileSync(w.execPath, 'utf8'), 'old binary');
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'rolled_back');
    assert.equal(s.db_restored, false);
    assert.equal(readDb(w.dbFile).marker, 'before update');
});

test('VERSION_MISMATCH: a binary that reports another version is rolled back at once', posix, () => {
    const w = seaWorld();
    const r = runChild('listen', { ...w.opts, version: '3.3.0' });
    assert.equal(r.status, 75);
    assert.equal(fs.readFileSync(w.execPath, 'utf8'), 'old binary');
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'rolled_back');
    assert.equal(s.error, 'VERSION_MISMATCH');
    assert.equal(readDb(w.dbFile).version, 5);
});

test('VERSION_MISMATCH with the old version running: recorded as failed, code never touched', posix, () => {
    const w = seaWorld();
    const r = runChild('listen', { ...w.opts, version: '3.1.0' });
    assert.equal(r.result.action, 'version_mismatch');
    assert.equal(r.status, 0);
    assert.equal(fs.readFileSync(w.execPath, 'utf8'), 'new binary');
    assert.equal(stateFile.readState(w.dataDir).error, 'VERSION_MISMATCH');
});

test('another binary path (a copy started by hand) leaves the state alone', posix, () => {
    const w = seaWorld();
    const r = runChild('throw', { ...w.opts, execPath: path.join(path.dirname(w.execPath), 'copy') });
    assert.equal(r.result.action, 'none');
    assert.equal(stateFile.readState(w.dataDir).attempts, 0);
});

test('CLI runs (admin.js, version) never count attempts or roll back', async () => {
    const w = await pteroWorld();
    const r = runChild('throw', { ...w.opts, server: false });
    assert.equal(r.result.action, 'none');
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'swapped');
    assert.equal(s.attempts, 0);
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'new');
});

test('an interrupted journal: index.js not yet moved → reverted and recorded as interrupted', async () => {
    const w = await pteroWorld({ phase: 'swapping' });
    const s = stateFile.readState(w.dataDir);
    swap.revertCode(s, { codeDir: w.codeDir });
    const r = runChild('listen', w.opts);
    assert.equal(r.result.action, 'reverted');
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'old');
    assert.equal(stateFile.readState(w.dataDir).error, 'UPDATE_INTERRUPTED');
});

test('an interrupted journal with index.js already moved is completed and counted as the new version', async () => {
    const w = await pteroWorld({ phase: 'swapping' });
    const r = runChild('listen', w.opts);
    assert.equal(r.result.action, 'counted');
    assert.equal(r.result.recovered, true);
    assert.equal(stateFile.readState(w.dataDir).phase, 'started');
});

test('staged / ready-to-swap: a dead owner means the update never happened; a live owner is left alone', async () => {
    const w = await pteroWorld();
    stateFile.patchState(w.dataDir, { phase: 'ready-to-swap', pid: process.pid });
    assert.equal(runChild('listen', w.opts).result.action, 'none');
    assert.equal(stateFile.readState(w.dataDir).phase, 'ready-to-swap');
    stateFile.patchState(w.dataDir, { pid: 2 ** 22 + 54321 });
    assert.equal(runChild('listen', w.opts).result.action, 'interrupted');
    assert.equal(stateFile.readState(w.dataDir).phase, 'failed');
    assert.equal(fs.existsSync(path.join(w.codeDir, '.update')), false);
});

test('a missing or changed backup stops the rollback; nothing is deleted', async () => {
    const w = await pteroWorld();
    fs.writeFileSync(path.join(w.dataDir, 'backups', w.backup.file), 'tampered');
    stateFile.patchState(w.dataDir, { attempts: 1 });
    const r = runChild('listen', w.opts);
    assert.equal(r.result.action, 'rollback_failed');
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'new');
    assert.equal(readDb(w.dbFile).version, 6);
    assert.equal(stateFile.readState(w.dataDir).error, 'ROLLBACK_FAILED');
});

test('no state, unreadable state, foreign format: the prelude does nothing', () => {
    const dataDir = fresh('empty');
    assert.equal(runChild('listen', { dataDir }).result.action, 'none');
    fs.writeFileSync(path.join(dataDir, 'update-state.json'), '{"format":2,"phase":"swapped"}');
    assert.equal(runChild('listen', { dataDir }).result.action, 'none');
    fs.writeFileSync(path.join(dataDir, 'update-state.json'), 'not json');
    assert.equal(runChild('listen', { dataDir }).result.action, 'none');
});

test('resolveDataDir: environment, then the .env in the working folder, then <codeDir>/data', () => {
    const { resolveDataDir } = require('../../services/update/prelude');
    const cwd = fresh('cwd');
    assert.equal(resolveDataDir({ codeDir: '/srv/app', env: {}, cwd }), path.join('/srv/app', 'data'));
    fs.writeFileSync(path.join(cwd, '.env'), '# comment\nPORT=3000\nDATA_DIR="/srv/manga" # inline\n');
    assert.equal(resolveDataDir({ codeDir: '/srv/app', env: {}, cwd }), path.resolve('/srv/manga'));
    assert.equal(resolveDataDir({ codeDir: '/srv/app', env: { DATA_DIR: '/env/wins' }, cwd }), path.resolve('/env/wins'));
    assert.equal(resolveDataDir({ codeDir: '/srv/app', env: { DATA_DIR: '  ' }, cwd }), path.join('/srv/app', 'data'));
});
