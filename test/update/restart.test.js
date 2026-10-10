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
