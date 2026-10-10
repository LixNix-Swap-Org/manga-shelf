process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const apply = require('../../services/update/apply');
const swap = require('../../services/update/swap');
const stateFile = require('../../services/update/state');
const { openRegular } = require('../../services/update/verifiedFile');
const h = require('../fixtures/update/helpers');

const root = h.tmpDir();
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (name) => {
    const dir = path.join(root, `${name}-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

const NEW_FILES = ['index.js', 'db.js', 'core/', 'routes/', 'scripts/admin.js'];
const OLD_FILES = [...NEW_FILES, 'mangaPassion.js'];

function write(base, files) {
    for (const [rel, content] of Object.entries(files)) {
        const target = path.join(base, ...rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
}

function snapshot(base) {
    const out = {};
    const walk = (dir, rel) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!rel && e.name === '.update') continue;
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(dir, e.name), r);
            else out[r] = fs.readFileSync(path.join(dir, e.name), 'utf8');
        }
    };
    walk(base, '');
    return out;
}

const OLD_TREE = {
    'package.json': JSON.stringify({ version: '3.1.0', files: OLD_FILES }),
    'package-lock.json': 'old lock',
    'index.js': 'old index',
    'db.js': 'old db',
    'core/a.js': 'old a',
    'core/only-old.js': 'old only',
    'routes/r.js': 'old r',
    'scripts/admin.js': 'old admin',
    'scripts/operator.sh': 'operator file',
    'mangaPassion.js': 'old mp',
    'frontend/dist/index.html': 'old html',
    'frontend/dist/assets/app-OLD.js': 'old asset',
    '.manga-shelf-release.json': JSON.stringify({ version: '3.1.0', files: ['package.json', 'index.js', 'db.js', 'core/a.js', 'core/only-old.js', 'routes/r.js', 'scripts/admin.js', 'mangaPassion.js', 'frontend/dist/index.html'] }),
    '.env': 'JWT_SECRET=keep',
    'data/manga.db': 'database',
    'node_modules/express/index.js': 'module'
};

const NEW_ENTRIES = [
    { name: 'package.json', data: JSON.stringify({ version: '3.2.0', files: NEW_FILES }) },
    { name: 'package-lock.json', data: 'new lock' },
    { name: 'index.js', data: 'new index' },
    { name: 'db.js', data: 'new db' },
    { name: 'core/', type: 'dir' },
    { name: 'core/a.js', data: 'new a' },
    { name: 'core/b.js', data: 'new b' },
    { name: 'routes/r.js', data: 'new r' },
    { name: 'scripts/admin.js', data: 'new admin' },
    { name: 'frontend/dist/index.html', data: 'new html' },
    { name: 'frontend/dist/assets/app-NEW.js', data: 'new asset' },
    { name: 'frontend/dist/.vite/manifest.json', data: '{}' }
];

const EXPECTED_NEW = (() => {
    const tree = { ...OLD_TREE };
    for (const k of ['core/only-old.js', 'mangaPassion.js', 'frontend/dist/assets/app-OLD.js']) delete tree[k];
    for (const e of NEW_ENTRIES) if (e.type !== 'dir') tree[e.name] = e.data;
    return tree;
})();

async function staged(entries = NEW_ENTRIES) {
    const codeDir = fresh('code');
    write(codeDir, OLD_TREE);
    const zipFile = path.join(fresh('dl'), 'pterodactyl-manga-shelf.zip');
    fs.writeFileSync(zipFile, h.makeZip(entries));
    return { codeDir, zipFile };
}

async function journal() {
    const { codeDir, zipFile } = await staged();
    const unpacked = await apply.unpackRelease({ zipFile, codeDir });
    const state = {
        mode: 'pterodactyl',
        entries: unpacked.entries,
        removals: apply.computeRemovals({ codeDir, entries: unpacked.entries, files: unpacked.files }),
        previous: { sha256: swap.sha256FileSync(path.join(codeDir, 'package.json')) }
    };
    return { codeDir, state };
}

const bad = (reason) => (err) => {
    assert.equal(err.code, 'BAD_PACKAGE');
    if (reason) assert.equal(err.extra.reason, reason);
    return true;
};

test('unpack: zip-slip, absolute, backslash and empty segments are refused', async () => {
    for (const name of ['../evil.js', '/etc/evil', 'core/../../evil.js', 'core\\evil.js', 'core//a.js', './index.js', 'C:evil']) {
        const { codeDir, zipFile } = await staged([...NEW_ENTRIES, { name, data: 'x' }]);
        await assert.rejects(apply.unpackRelease({ zipFile, codeDir }), bad('path'), name);
        assert.equal(fs.existsSync(path.join(path.dirname(codeDir), 'evil.js')), false);
    }
});

test('unpack: symlinks and special entries are refused', async () => {
    const link = await staged([...NEW_ENTRIES, { name: 'core/link.js', type: 'symlink', data: '/etc/passwd' }]);
    await assert.rejects(apply.unpackRelease(link), bad('entry_type'));
    const fifo = await staged([...NEW_ENTRIES, { name: 'core/fifo', mode: 0o010644 }]);
    await assert.rejects(apply.unpackRelease(fifo), bad('entry_type'));
    const dosReparse = await staged([...NEW_ENTRIES, { name: 'core/x.js', madeBy: 20, mode: 0, data: 'x' }]);
    assert.ok(await apply.unpackRelease(dosReparse), 'a plain DOS entry is a file');
});

test('unpack: duplicates (also case-folded) and files outside the release entries are refused', async () => {
    await assert.rejects(apply.unpackRelease(await staged([...NEW_ENTRIES, { name: 'CORE/A.js', data: 'x' }])), bad('duplicate'));
    for (const name of ['.env', 'data/manga.db', 'node_modules/x.js', 'ssl/key.pem', 'scripts/other.js', 'evil.js', '.update/next/index.js']) {
        await assert.rejects(apply.unpackRelease(await staged([...NEW_ENTRIES, { name, data: 'x' }])), bad('unexpected_entry'), name);
    }
    const badList = [{ ...NEW_ENTRIES[0], data: JSON.stringify({ version: '3.2.0', files: ['../x'] }) }, ...NEW_ENTRIES.slice(1)];
    await assert.rejects(apply.unpackRelease(await staged(badList)), bad('files_list'));
});

test('unpack: a good release lands in .update/next with the swap order folders → files → index.js → lock → package.json', async () => {
    const { codeDir, zipFile } = await staged();
    const r = await apply.unpackRelease({ zipFile, codeDir });
    assert.equal(r.version, '3.2.0');
    assert.deepEqual(r.entries.map((e) => e.name), ['core', 'frontend/dist', 'routes', 'db.js', 'scripts/admin.js', 'index.js', 'package-lock.json', 'package.json']);
    assert.equal(fs.readFileSync(path.join(codeDir, '.update', 'next', 'core', 'b.js'), 'utf8'), 'new b');
    assert.deepEqual(snapshot(codeDir), OLD_TREE, 'nothing running was touched');
});

test('removals: only files of the previous manifest the new release lacks and no swapped folder covers', async () => {
    const { state } = await journal();
    assert.deepEqual(state.removals, ['mangaPassion.js']);
});

test('journaled swap: forward gives the new tree, revert the old one; removals are moved, never deleted', async () => {
    const { codeDir, state } = await journal();
    swap.swapForward(state, { codeDir });
    assert.deepEqual(snapshot(codeDir), EXPECTED_NEW);
    assert.equal(fs.readFileSync(path.join(codeDir, '.update', 'previous', 'mangaPassion.js'), 'utf8'), 'old mp');
    assert.equal(fs.readFileSync(path.join(codeDir, '.update', 'previous', 'core', 'only-old.js'), 'utf8'), 'old only');
    assert.equal(fs.readFileSync(path.join(codeDir, 'scripts', 'operator.sh'), 'utf8'), 'operator file');
    swap.revertCode(state, { codeDir });
    assert.deepEqual(snapshot(codeDir), OLD_TREE);
});

test('journaled swap: a crash after any rename is completed or reverted, never left mixed', async (t) => {
    const total = await (async () => {
        const { codeDir, state } = await journal();
        let count = 0;
        const real = fs.renameSync;
        t.mock.method(fs, 'renameSync', (a, b) => { count++; return real(a, b); });
        swap.swapForward(state, { codeDir });
        t.mock.restoreAll();
        return count;
    })();
    assert.ok(total >= 10);
    const seen = new Set();
    for (let k = 0; k < total; k++) {
        const { codeDir, state } = await journal();
        const real = fs.renameSync;
        let count = 0;
        t.mock.method(fs, 'renameSync', (a, b) => {
            if (count++ === k) throw Object.assign(new Error('SIGKILL'), { code: 'EKILLED' });
            return real(a, b);
        });
        assert.throws(() => swap.swapForward(state, { codeDir }), /SIGKILL/);
        t.mock.restoreAll();
        const how = swap.recoverJournal(state, { codeDir });
        seen.add(how);
        assert.deepEqual(snapshot(codeDir), how === 'completed' ? EXPECTED_NEW : OLD_TREE, `crash before rename ${k}: ${how}`);
    }
    assert.deepEqual([...seen].sort(), ['completed', 'reverted']);
});

test('rollback refuses when the kept previous files were changed', async () => {
    const { codeDir, state } = await journal();
    swap.swapForward(state, { codeDir });
    fs.writeFileSync(path.join(codeDir, '.update', 'previous', 'package.json'), 'tampered');
    assert.throws(() => swap.revertCode(state, { codeDir }), (e) => e.code === 'PREVIOUS_CHANGED');
    assert.deepEqual(snapshot(codeDir), EXPECTED_NEW);
});

const posix = { skip: process.platform === 'win32' ? 'POSIX link+rename' : false };

function binarySetup() {
    const dir = fresh('bin');
    const execPath = path.join(dir, 'manga-shelf-server');
    fs.writeFileSync(execPath, 'old binary', { mode: 0o750 });
    fs.chmodSync(execPath, 0o750);
    const stagedFile = path.join(fresh('dl'), 'manga-shelf-server-linux-x64');
    fs.writeFileSync(stagedFile, 'new binary');
    const state = {
        mode: 'sea-user',
        exec_path: execPath,
        previous: { sha256: h.sha256hex(Buffer.from('old binary')) },
        next: { sha256: h.sha256hex(Buffer.from('new binary')) }
    };
    return { dir, execPath, stagedFile, state };
}

test('SEA: <binary>.new is created exclusively with the old mode, re-hashed, never through a planted link', posix, () => {
    const { dir, execPath, stagedFile, state } = binarySetup();
    const victim = path.join(dir, 'victim');
    fs.writeFileSync(victim, 'keep me');
    fs.symlinkSync(victim, `${execPath}.new`);
    apply.writeNewBinary({ execPath, stagedFile, sha256: state.next.sha256 });
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
    const st = fs.lstatSync(`${execPath}.new`);
    assert.equal(st.isFile(), true);
    assert.equal(st.mode & 0o777, 0o750);
    assert.equal(fs.readFileSync(`${execPath}.new`, 'utf8'), 'new binary');
    assert.throws(() => apply.writeNewBinary({ execPath, stagedFile, sha256: 'f'.repeat(64) }), (e) => e.code === 'CHECKSUM_MISMATCH');
    assert.equal(fs.existsSync(`${execPath}.new`), false, 'a copy that does not match is removed');
});

test('SEA: link + one rename keeps the path present at every step; rollback restores the old binary', posix, (t) => {
    const { execPath, stagedFile, state } = binarySetup();
    apply.writeNewBinary({ execPath, stagedFile, sha256: state.next.sha256 });
    const real = fs.renameSync;
    let renames = 0;
    t.mock.method(fs, 'renameSync', (a, b) => {
        assert.equal(fs.existsSync(execPath), true);
        renames++;
        return real(a, b);
    });
    swap.swapForward(state, { codeDir: null, execPath });
    t.mock.restoreAll();
    assert.equal(renames, 1);
    assert.equal(fs.readFileSync(execPath, 'utf8'), 'new binary');
    assert.equal(fs.readFileSync(`${execPath}.previous`, 'utf8'), 'old binary');
    assert.equal(fs.statSync(execPath).mode & 0o777, 0o750);
    swap.revertCode(state, { execPath });
    assert.equal(fs.readFileSync(execPath, 'utf8'), 'old binary');
    assert.throws(() => fs.statSync(`${execPath}.previous`), { code: 'ENOENT' });
});

test('SEA: a crash between link and rename is reverted; after the rename it counts as completed', posix, (t) => {
    const a = binarySetup();
    apply.writeNewBinary({ execPath: a.execPath, stagedFile: a.stagedFile, sha256: a.state.next.sha256 });
    t.mock.method(fs, 'renameSync', () => { throw new Error('SIGKILL'); });
    assert.throws(() => swap.swapForward(a.state, { execPath: a.execPath }), /SIGKILL/);
    t.mock.restoreAll();
    assert.equal(swap.recoverJournal(a.state, { execPath: a.execPath }), 'reverted');
    assert.equal(fs.readFileSync(a.execPath, 'utf8'), 'old binary');
    assert.equal(fs.existsSync(`${a.execPath}.new`), false);
    assert.equal(fs.existsSync(`${a.execPath}.previous`), false);

    const b = binarySetup();
    apply.writeNewBinary({ execPath: b.execPath, stagedFile: b.stagedFile, sha256: b.state.next.sha256 });
    swap.swapForward(b.state, { execPath: b.execPath });
    assert.equal(swap.recoverJournal(b.state, { execPath: b.execPath }), 'completed');
    assert.throws(() => swap.recoverJournal({ ...b.state, exec_path: '/other/binary' }, { execPath: b.execPath }), /anderen Programmdatei/);
});

test('SEA rollback refuses a changed or missing .previous', posix, () => {
    const { execPath, stagedFile, state } = binarySetup();
    apply.writeNewBinary({ execPath, stagedFile, sha256: state.next.sha256 });
    swap.swapForward(state, { execPath });
    fs.unlinkSync(`${execPath}.previous`);
    fs.writeFileSync(`${execPath}.previous`, 'something else');
    assert.throws(() => swap.revertCode(state, { execPath }), (e) => e.code === 'PREVIOUS_CHANGED');
    fs.unlinkSync(`${execPath}.previous`);
    assert.throws(() => swap.revertCode(state, { execPath }), (e) => e.code === 'PREVIOUS_MISSING');
    assert.equal(fs.readFileSync(execPath, 'utf8'), 'new binary', 'nothing deleted');
});

test('prepareSwitch: verified backup held, state written atomically, new code next to the old one', async () => {
    const { codeDir, zipFile } = await staged();
    const dataDir = fresh('data');
    const backupsDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupsDir);
    const held = [];
    const calls = [];
    const deps = {
        backupsDir,
        schemaVersion: () => 27,
        holdSnapshot: (name) => { held.push(name); return () => held.splice(held.indexOf(name), 1); },
        createBackupSnapshot: async (prefix, options) => {
            calls.push({ prefix, options });
            const filename = `${prefix}-2026-10-10T10-00-00-000Z.zip`;
            fs.writeFileSync(path.join(backupsDir, filename), 'backup');
            return { filename, verified: true };
        }
    };
    const install = { mode: 'pterodactyl', codeDir, execPath: process.execPath, restart: 'pterodactyl' };
    const stagedRelease = { file: zipFile, sha256: swap.sha256FileSync(zipFile), version: '3.2.0' };
    const steps = [];
    const { state } = await apply.prepareSwitch({ staged: stagedRelease, install, from: '3.1.0', dataDir, userId: 1, deps, onStep: (s) => steps.push(s) });
    assert.deepEqual(calls, [{ prefix: 'vor-update-v3.1.0-auf-v3.2.0', options: { includeUploads: false } }]);
    assert.deepEqual(held, ['vor-update-v3.1.0-auf-v3.2.0-2026-10-10T10-00-00-000Z.zip']);
    assert.deepEqual(steps, ['verifying', 'backup', 'copying']);
    const onDisk = stateFile.readState(dataDir);
    assert.equal(onDisk.phase, 'ready-to-swap');
    assert.equal(onDisk.format, 1);
    assert.equal(onDisk.schema_before, 27);
    assert.equal(onDisk.attempts, 0);
    assert.equal(onDisk.backup.sha256, h.sha256hex(Buffer.from('backup')));
    assert.equal(onDisk.previous.sha256, swap.sha256FileSync(path.join(codeDir, 'package.json')));
    assert.deepEqual(onDisk.removals, ['mangaPassion.js']);
    assert.equal(stateFile.heldBackup(dataDir), onDisk.backup.file);
    assert.deepEqual(state, onDisk);
    assert.deepEqual(snapshot(codeDir), OLD_TREE);
    assert.ok(fs.existsSync(path.join(codeDir, '.update', 'next', 'index.js')));
});

test('prepareSwitch: an unverified backup or a changed staged file stops before anything is written', async () => {
    const { codeDir, zipFile } = await staged();
    const dataDir = fresh('data');
    const install = { mode: 'pterodactyl', codeDir, execPath: process.execPath, restart: 'pterodactyl' };
    const deps = { backupsDir: dataDir, schemaVersion: () => 1, holdSnapshot: () => () => {}, createBackupSnapshot: async () => ({ filename: 'x.zip', verified: false }) };
    const stagedRelease = { file: zipFile, sha256: swap.sha256FileSync(zipFile), version: '3.2.0' };
    await assert.rejects(apply.prepareSwitch({ staged: stagedRelease, install, from: '3.1.0', dataDir, userId: 1, deps }), (e) => e.code === 'BACKUP_FAILED');
    assert.equal(stateFile.readState(dataDir), null);
    await assert.rejects(apply.prepareSwitch({ staged: { ...stagedRelease, sha256: 'f'.repeat(64) }, install, from: '3.1.0', dataDir, userId: 1, deps }), (e) => e.code === 'CHECKSUM_MISMATCH');
    assert.equal(fs.existsSync(path.join(codeDir, '.update')), false);
});

test('prepareSwitch: a failure after the state was written marks it failed and removes .update', async () => {
    const { codeDir } = await staged();
    const zipFile = path.join(fresh('dl'), 'pterodactyl-manga-shelf.zip');
    fs.writeFileSync(zipFile, h.makeZip([...NEW_ENTRIES, { name: '../evil.js', data: 'x' }]));
    const dataDir = fresh('data');
    fs.writeFileSync(path.join(dataDir, 'b.zip'), 'b');
    let released = false;
    const deps = { backupsDir: dataDir, schemaVersion: () => 1, holdSnapshot: () => () => { released = true; }, createBackupSnapshot: async () => ({ filename: 'b.zip', verified: true }) };
    const install = { mode: 'pterodactyl', codeDir, execPath: process.execPath, restart: 'pterodactyl' };
    await assert.rejects(apply.prepareSwitch({ staged: { file: zipFile, sha256: swap.sha256FileSync(zipFile), version: '3.2.0' }, install, from: '3.1.0', dataDir, userId: 1, deps }), bad('path'));
    assert.equal(stateFile.readState(dataDir).phase, 'failed');
    assert.equal(stateFile.heldBackup(dataDir), null);
    assert.equal(released, true);
    assert.equal(fs.existsSync(path.join(codeDir, '.update')), false);
});

test('SEA: a .new changed after it was written is refused at the switch; nothing is renamed', posix, () => {
    const { execPath, stagedFile, state } = binarySetup();
    apply.writeNewBinary({ execPath, stagedFile, sha256: state.next.sha256 });
    fs.writeFileSync(`${execPath}.new`, 'tampered');
    assert.throws(() => swap.swapForward(state, { execPath }), (e) => e.code === 'NEXT_CHANGED');
    assert.equal(fs.readFileSync(execPath, 'utf8'), 'old binary');
    assert.throws(() => fs.statSync(`${execPath}.previous`), { code: 'ENOENT' });
});

const win32 = { platform: 'win32' };

test('Windows binary: two renames forward replace a stale .previous; rollback moves the failed binary aside', posix, () => {
    const { dir, execPath, stagedFile, state } = binarySetup();
    fs.writeFileSync(`${execPath}.previous`, 'stale');
    apply.writeNewBinary({ execPath, stagedFile, sha256: state.next.sha256, ...win32 });
    swap.swapForward(state, { execPath, ...win32 });
    assert.equal(fs.readFileSync(execPath, 'utf8'), 'new binary');
    assert.equal(fs.readFileSync(`${execPath}.previous`, 'utf8'), 'old binary');
    assert.equal(fs.existsSync(`${execPath}.new`), false);
    swap.revertCode(state, { execPath, ...win32 });
    assert.equal(fs.readFileSync(execPath, 'utf8'), 'old binary');
    assert.throws(() => fs.statSync(`${execPath}.previous`), { code: 'ENOENT' });
    const failed = fs.readdirSync(dir).filter((n) => n.startsWith('manga-shelf-server.failed-'));
    assert.equal(failed.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, failed[0]), 'utf8'), 'new binary');
});

test('Windows binary: a crash between the two renames is reverted, after both it counts as completed', posix, (t) => {
    const a = binarySetup();
    apply.writeNewBinary({ execPath: a.execPath, stagedFile: a.stagedFile, sha256: a.state.next.sha256, ...win32 });
    const real = fs.renameSync;
    let renames = 0;
    t.mock.method(fs, 'renameSync', (from, to) => {
        if (renames++ === 1) throw new Error('SIGKILL');
        return real(from, to);
    });
    assert.throws(() => swap.swapForward(a.state, { execPath: a.execPath, ...win32 }), /SIGKILL/);
    t.mock.restoreAll();
    assert.equal(fs.existsSync(a.execPath), false, 'the path is missing between the two renames');
    assert.equal(swap.recoverJournal(a.state, { execPath: a.execPath, ...win32 }), 'reverted');
    assert.equal(fs.readFileSync(a.execPath, 'utf8'), 'old binary');
    assert.equal(fs.existsSync(`${a.execPath}.new`), false);
    assert.equal(fs.existsSync(`${a.execPath}.previous`), false);

    const b = binarySetup();
    apply.writeNewBinary({ execPath: b.execPath, stagedFile: b.stagedFile, sha256: b.state.next.sha256, ...win32 });
    swap.swapForward(b.state, { execPath: b.execPath, ...win32 });
    assert.equal(swap.recoverJournal(b.state, { execPath: b.execPath, ...win32 }), 'completed');
});

test('Windows binary: rollback refuses a changed or missing .previous and keeps the new binary', posix, () => {
    const { execPath, stagedFile, state } = binarySetup();
    apply.writeNewBinary({ execPath, stagedFile, sha256: state.next.sha256, ...win32 });
    swap.swapForward(state, { execPath, ...win32 });
    fs.writeFileSync(`${execPath}.previous`, 'something else');
    assert.throws(() => swap.revertCode(state, { execPath, ...win32 }), (e) => e.code === 'PREVIOUS_CHANGED');
    fs.unlinkSync(`${execPath}.previous`);
    assert.throws(() => swap.revertCode(state, { execPath, ...win32 }), (e) => e.code === 'PREVIOUS_MISSING');
    assert.equal(fs.readFileSync(execPath, 'utf8'), 'new binary');
});

function backupDeps(dataDir, { onBackup } = {}) {
    const backupsDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const held = [];
    return {
        held,
        deps: {
            backupsDir,
            schemaVersion: () => 27,
            holdSnapshot: (name) => { held.push(name); return () => held.splice(held.indexOf(name), 1); },
            createBackupSnapshot: async (prefix) => {
                if (onBackup) onBackup();
                const filename = `${prefix}-2026-10-10T10-00-00-000Z.zip`;
                fs.writeFileSync(path.join(backupsDir, filename), 'backup');
                return { filename, verified: true };
            }
        }
    };
}

test('prepareSwitch reads the ZIP through the verified handle, not through the path', async () => {
    const { codeDir, zipFile } = await staged();
    const verifiedSha = swap.sha256FileSync(zipFile);
    const handle = await openRegular(zipFile);
    const planted = `${zipFile}.planted`;
    fs.writeFileSync(planted, h.makeZip(NEW_ENTRIES.map((e) => (e.name === 'index.js' ? { ...e, data: 'planted index' } : e))));
    fs.renameSync(planted, zipFile);
    const dataDir = fresh('data');
    const { deps } = backupDeps(dataDir);
    const install = { mode: 'pterodactyl', codeDir, execPath: process.execPath, restart: 'pterodactyl' };
    try {
        await apply.prepareSwitch({ staged: { file: zipFile, handle, sha256: verifiedSha, version: '3.2.0' }, install, from: '3.1.0', dataDir, userId: 1, deps });
        assert.equal(fs.readFileSync(path.join(codeDir, '.update', 'next', 'index.js'), 'utf8'), 'new index');
        assert.notEqual(handle.fd, -1, 'a handle of the staging stays open');
    } finally {
        await handle.close();
    }
});

test('prepareSwitch hashes the staged file again after the backup; bytes changed meanwhile stop it before the state', async () => {
    const { codeDir, zipFile } = await staged();
    const dataDir = fresh('data');
    const { deps, held } = backupDeps(dataDir, { onBackup: () => fs.writeFileSync(zipFile, h.makeZip([...NEW_ENTRIES, { name: 'core/evil.js', data: 'x' }])) });
    const install = { mode: 'pterodactyl', codeDir, execPath: process.execPath, restart: 'pterodactyl' };
    await assert.rejects(apply.prepareSwitch({ staged: { file: zipFile, sha256: swap.sha256FileSync(zipFile), version: '3.2.0' }, install, from: '3.1.0', dataDir, userId: 1, deps }),
        (e) => e.code === 'CHECKSUM_MISMATCH');
    assert.equal(stateFile.readState(dataDir), null);
    assert.deepEqual(held, [], 'the hold on the backup ends');
    assert.equal(fs.existsSync(path.join(codeDir, '.update')), false);
});

test('the release file list matches package.js', () => {
    const packager = require('../../package.js');
    assert.deepEqual([...apply.PACKAGE_FILES].sort(), [...packager.PACKAGE_FILES, packager.RELEASE_MANIFEST].sort());
    assert.equal(require('../../services/update/constants').RELEASE_MANIFEST, packager.RELEASE_MANIFEST);
});

test('a ZIP from package.js buildPackage() unpacks, swaps and passes the preflight', async () => {
    const { buildPackage } = require('../../package.js');
    const zip = require('../../services/update/zip');
    const preflight = require('../../services/update/preflight');
    const files = ['index.js', 'db.js', 'core/', 'scripts/admin.js'];
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/express': { version: '5.2.1', integrity: 'sha512-a' } } });
    const source = fresh('release-src');
    write(source, {
        'package.json': JSON.stringify({ name: 'manga-shelf-backend', version: '9.1.0', engines: { node: '>=22.13.0' }, files }),
        'package-lock.json': lock,
        '.env.example': 'PORT=3000\n',
        'index.js': 'module.exports = "new index";\n',
        'db.js': 'module.exports = "new db";\n',
        'core/a.js': 'module.exports = "new a";\n',
        'scripts/admin.js': 'module.exports = "new admin";\n',
        'frontend/dist/index.html': '<!doctype html>',
        'frontend/dist/assets/app-NEW.js': 'new asset',
        'frontend/dist/.well-known/security.txt': 'Contact: mailto:x@example.org'
    });
    const { zipPath } = await buildPackage({ root: source, outDir: fresh('release-out'), copyToRoot: false });
    const archive = await zip.openZip(zipPath);
    assert.ok(archive.entries.some((e) => e.flags & 0x8), 'archiver writes data descriptors');
    await zip.closeZip(archive);

    const codeDir = fresh('release-code');
    write(codeDir, {
        'package.json': JSON.stringify({ version: '9.0.0', files: [...files, 'mangaPassion.js'] }),
        'package-lock.json': lock,
        'index.js': 'old index',
        'db.js': 'old db',
        'core/a.js': 'old a',
        'scripts/admin.js': 'old admin',
        'mangaPassion.js': 'old mp',
        'frontend/dist/index.html': 'old html',
        '.manga-shelf-release.json': JSON.stringify({ format: 1, version: '9.0.0', files: ['package.json', 'index.js', 'db.js', 'core/a.js', 'scripts/admin.js', 'mangaPassion.js', 'frontend/dist/index.html'] })
    });
    const workDir = fresh('release-work');
    assert.equal((await preflight.zipPreflight({ file: zipPath, version: '9.1.0', codeDir, workDir, env: {} })).depsChanged, false);
    const unpacked = await apply.unpackRelease({ zipFile: zipPath, codeDir });
    assert.equal(unpacked.version, '9.1.0');
    assert.deepEqual(unpacked.entries.map((e) => e.name).sort(), ['.env.example', '.manga-shelf-release.json', 'core', 'db.js', 'frontend/dist', 'index.js', 'package-lock.json', 'package.json', 'scripts/admin.js']);
    const removals = apply.computeRemovals({ codeDir, entries: unpacked.entries, files: unpacked.files });
    assert.deepEqual(removals, ['mangaPassion.js']);
    swap.swapForward({ mode: 'pterodactyl', entries: unpacked.entries, removals }, { codeDir });
    assert.equal(fs.readFileSync(path.join(codeDir, 'index.js'), 'utf8'), 'module.exports = "new index";\n');
    assert.equal(fs.readFileSync(path.join(codeDir, 'frontend', 'dist', '.well-known', 'security.txt'), 'utf8'), 'Contact: mailto:x@example.org');
    assert.equal(JSON.parse(fs.readFileSync(path.join(codeDir, '.manga-shelf-release.json'), 'utf8')).version, '9.1.0');
    assert.equal(fs.existsSync(path.join(codeDir, 'mangaPassion.js')), false);
});
