process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('../fixtures/update/helpers');

const root = h.tmpDir();
process.env.DATA_DIR = path.join(root, 'live-data');
const preflight = require('../../services/update/preflight');
const { openRegular } = require('../../services/update/verifiedFile');

test.after(() => {
    try { require('../../db').closeDb(); } catch (e) {}
    fs.rmSync(root, { recursive: true, force: true });
});

const lock = (deps) => JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'manga-shelf-backend' }, ...deps }
});
const PROD = { 'node_modules/express': { version: '5.2.1', integrity: 'sha512-a' } };

function release(over = {}) {
    const pkg = { name: 'manga-shelf-backend', version: '3.2.0', engines: { node: '>=22.13.0' }, files: ['index.js', 'db.js'], ...over.pkg };
    return h.makeZip([
        { name: 'package.json', data: JSON.stringify(pkg) },
        { name: 'package-lock.json', data: over.lock || lock(PROD) },
        { name: 'index.js', data: 'module.exports = 1;\n' },
        { name: 'db.js', data: over.db || 'const x = 1;\nmodule.exports = x;\n' }
    ]);
}

let n = 0;
function setup(over = {}) {
    const dir = path.join(root, `case-${n++}`);
    const codeDir = path.join(dir, 'code');
    const workDir = path.join(dir, 'work');
    fs.mkdirSync(codeDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'package-lock.json'), over.oldLock || lock(PROD));
    const file = path.join(workDir, 'pterodactyl-manga-shelf.zip');
    fs.writeFileSync(file, release(over));
    return { file, codeDir, workDir, version: '3.2.0', env: over.env || {} };
}

const code = (expected, reason) => (err) => {
    assert.equal(err.code, expected);
    if (reason) assert.equal(err.extra.reason, reason);
    return true;
};

test('ZIP: version, engines, node --check and an unchanged dependency set pass', async () => {
    const r = await preflight.zipPreflight(setup());
    assert.equal(r.packageJson.version, '3.2.0');
    assert.equal(r.depsChanged, false);
});

test('ZIP: package.json must name the selected version', async () => {
    await assert.rejects(preflight.zipPreflight({ ...setup(), version: '3.3.0' }), code('PREFLIGHT_FAILED', 'version'));
});

test('ZIP: engines.node above this Node refuses NOT_INSTALLABLE', async () => {
    await assert.rejects(preflight.zipPreflight(setup({ pkg: { engines: { node: '>=99.0.0' } } })), code('NOT_INSTALLABLE', 'engines'));
    await assert.rejects(preflight.zipPreflight(setup({ pkg: { engines: { node: '>= 22 < weird' } } })), code('NOT_INSTALLABLE', 'engines'));
});

test('ZIP: a syntax error in index.js or db.js refuses', async () => {
    await assert.rejects(preflight.zipPreflight(setup({ db: 'const = ;' })), code('PREFLIGHT_FAILED', 'syntax'));
});

test('ZIP: changed production dependencies need npm install in the panel start command', async () => {
    const changed = { 'node_modules/express': { version: '5.3.0', integrity: 'sha512-b' } };
    await assert.rejects(preflight.zipPreflight(setup({ lock: lock(changed) })), code('NOT_INSTALLABLE', 'deps_changed'));
    await assert.rejects(preflight.zipPreflight(setup({ lock: lock(changed), env: { STARTUP: 'node index.js' } })), code('NOT_INSTALLABLE', 'deps_changed'));
    const ok = await preflight.zipPreflight(setup({ lock: lock(changed), env: { STARTUP: 'if [ -f package.json ]; then npm install --omit=dev --ignore-scripts; fi; node index.js' } }));
    assert.equal(ok.depsChanged, true);
    const devOnly = { ...PROD, 'node_modules/eslint': { version: '10.0.0', dev: true } };
    const r = await preflight.zipPreflight(setup({ lock: lock(devOnly) }));
    assert.equal(r.depsChanged, false, 'dev dependencies do not count');
});

const sea = { skip: process.platform === 'win32' ? 'shebang scripts' : false };

function seaSetup(binary, { copies = [] } = {}) {
    const dir = path.join(root, `sea-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = h.writeFakeBinary(path.join(dir, 'manga-shelf-server-linux-x64'), binary);
    const copyDatabase = async (workDir) => {
        assert.equal(workDir, dir);
        const copy = path.join(dir, `copy-${copies.length}.db`);
        fs.writeFileSync(copy, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]));
        copies.push(copy);
        return copy;
    };
    return { file, sha256: h.sha256hex(fs.readFileSync(file)), assetName: 'manga-shelf-server-linux-x64', workDir: dir, copyDatabase, copies };
}

const runDirs = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith('run-'));

test('SEA: the staged binary must report the target version', sea, async () => {
    const ok = seaSetup({ version: '3.0.5' });
    assert.deepEqual(await preflight.seaPreflight({ ...ok, version: '3.0.5' }), { dbChecked: false });
    assert.equal(ok.copies.length, 0, 'no db-check below 3.1.0');
    assert.deepEqual(runDirs(ok.workDir), []);
    const wrong = seaSetup({ version: '3.0.4' });
    await assert.rejects(preflight.seaPreflight({ ...wrong, version: '3.0.5' }), code('PREFLIGHT_FAILED', 'version'));
    const failing = seaSetup({ version: '3.0.5', versionExit: 1 });
    await assert.rejects(preflight.seaPreflight({ ...failing, version: '3.0.5' }), code('PREFLIGHT_FAILED', 'version'));
});

test('SEA from 3.1.0: db-check migrates a copy of the database; a failure refuses, the copy is removed', sea, async () => {
    const ok = seaSetup({ version: '3.2.0' });
    assert.deepEqual(await preflight.seaPreflight({ ...ok, version: '3.2.0' }), { dbChecked: true });
    assert.equal(ok.copies.length, 1);
    assert.equal(fs.existsSync(ok.copies[0]), false);
    const bad = seaSetup({ version: '3.2.0', dbCheckExit: 1 });
    await assert.rejects(preflight.seaPreflight({ ...bad, version: '3.2.0' }), code('PREFLIGHT_FAILED', 'db_check'));
    assert.equal(fs.existsSync(bad.copies[0]), false);
    assert.deepEqual(runDirs(bad.workDir), []);
});

test('SEA: only the verified bytes run, from a private copy; whatever replaces the staged path is never executed', sea, async () => {
    const s = seaSetup({ version: '3.0.5' });
    const handle = await openRegular(s.file);
    const marker = path.join(s.workDir, 'planted-ran');
    const planted = `${s.file}.planted`;
    fs.writeFileSync(planted, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\nconsole.log('v3.0.5');\n`, { mode: 0o755 });
    fs.renameSync(planted, s.file);
    try {
        assert.deepEqual(await preflight.seaPreflight({ ...s, file: handle, version: '3.0.5' }), { dbChecked: false });
        assert.equal(fs.existsSync(marker), false);
        await assert.rejects(preflight.seaPreflight({ ...s, file: handle, sha256: h.sha256hex(fs.readFileSync(s.file)), version: '3.0.5' }), code('CHECKSUM_MISMATCH'));
        assert.equal(fs.existsSync(marker), false);
        await assert.rejects(preflight.seaPreflight({ ...s, file: handle, sha256: undefined, version: '3.0.5' }), code('CHECKSUM_MISSING'));
        assert.deepEqual(runDirs(s.workDir), []);
    } finally {
        await handle.close();
    }
});

test('SEA: the checks run beside the event loop, and a cancelled staging kills them', sea, async () => {
    const slow = seaSetup({ version: '3.0.5', delayMs: 400 });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    try {
        await preflight.seaPreflight({ ...slow, version: '3.0.5' });
    } finally {
        clearInterval(timer);
    }
    assert.ok(ticks >= 5, `the event loop ran ${ticks} times`);

    const stuck = seaSetup({ version: '3.0.5', delayMs: 20000 });
    const ctl = new AbortController();
    const started = Date.now();
    const running = preflight.seaPreflight({ ...stuck, version: '3.0.5', signal: ctl.signal });
    setTimeout(() => ctl.abort(), 100);
    await assert.rejects(running, code('DOWNLOAD_ABORTED'));
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(runDirs(stuck.workDir), []);
});

test('db-check time grows with the database: two minutes plus a second per MB, at most an hour', () => {
    assert.equal(preflight.dbCheckTimeout(0), 120000);
    assert.equal(preflight.dbCheckTimeout(500 * 1024 * 1024), 620000);
    assert.equal(preflight.dbCheckTimeout(50 * 1024 * 1024 * 1024), 60 * 60 * 1000);
});

test('the live database is copied with the SQLite backup API into the staging folder', async () => {
    const { db } = require('../../db');
    const workDir = path.join(root, 'copy-work');
    fs.mkdirSync(workDir);
    const copy = await preflight.copyLiveDatabase(workDir);
    assert.equal(path.dirname(copy), workDir);
    const { DatabaseSync } = require('node:sqlite');
    const conn = new DatabaseSync(copy, { readOnly: true });
    try {
        const live = db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v;
        assert.equal(conn.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, live);
    } finally {
        conn.close();
    }
});

test('version token: exact vX.Y.Z only', () => {
    assert.equal(preflight.reportsVersion('manga-shelf-server v3.1.0 (Node v22.13.0, linux-x64)', '3.1.0'), true);
    assert.equal(preflight.reportsVersion('manga-shelf-server v3.1.01', '3.1.0'), false);
    assert.equal(preflight.reportsVersion('manga-shelf-server v3.1.0.1', '3.1.0'), false);
    assert.equal(preflight.reportsVersion('manga-shelf-server v13.1.0', '3.1.0'), false);
    assert.equal(preflight.reportsVersion('manga-shelf-server 3.1.0', '3.1.0'), false);
});

test('the child gets a small environment with its own data and cache folders', () => {
    const env = preflight.childEnv('/w', { PATH: '/bin', JWT_SECRET: 'x'.repeat(40), SETUP_TOKEN: 'y', DATA_DIR: '/real' });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.JWT_SECRET, undefined);
    assert.equal(env.SETUP_TOKEN, undefined);
    assert.equal(env.DATA_DIR, path.join('/w', 'check-data'));
});

test('space: data and code volume are checked, NO_SPACE carries the numbers', () => {
    const dataDir = path.join(root, 'space-data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'manga.db'), Buffer.alloc(1024 * 1024));
    const args = { mode: 'sea-user', dataDir, execPath: process.execPath, assetSize: 50 * 1024 * 1024 };
    assert.throws(() => preflight.checkSpace({ ...args, freeBytes: () => 5 * 1024 * 1024 }), (err) => {
        assert.equal(err.code, 'NO_SPACE');
        assert.equal(err.status, 507);
        assert.match(err.message, /^Nicht genug Speicherplatz für das Update \(frei: 5\.0 MB, benötigt: \d+ MB\)\.$/);
        assert.equal(err.extra.msg, 'Nicht genug Speicherplatz für das Update (frei: {free}, benötigt: {needed}).');
        return true;
    });
    const need = preflight.checkSpace({ ...args, freeBytes: () => 1e12 });
    assert.equal(need.dataNeeded, 2 * 50 * 1024 * 1024 + 2 * 1024 * 1024 + Math.ceil(1.2 * 1024 * 1024) + 100 * 1024 * 1024, 'the binary is staged and copied to run it');
    const zipNeed = preflight.checkSpace({ ...args, mode: 'pterodactyl', codeDir: dataDir, freeBytes: () => 1e12 });
    assert.equal(zipNeed.dataNeeded, 50 * 1024 * 1024 + 2 * 1024 * 1024 + Math.ceil(1.2 * 1024 * 1024) + 100 * 1024 * 1024);
    assert.doesNotThrow(() => preflight.checkSpace({ ...args, freeBytes: () => null }), 'unknown free space never blocks');
});
