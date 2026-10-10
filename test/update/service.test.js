process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const update = require('../../services/update');
const verify = require('../../services/update/verify');
const stateFile = require('../../services/update/state');
const pkg = require('../../package.json');
const h = require('../fixtures/update/helpers');

const NEXT = '9.1.0';
const DL = 'https://github.com/LixNix-Swap-Org/manga-shelf/releases/download/';
const LOCK = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/express': { version: '5.2.1', integrity: 'sha512-a' } } });
const ZIP = h.makeZip([
    { name: 'package.json', data: JSON.stringify({ version: NEXT, engines: { node: '>=22.13.0' }, files: ['index.js', 'db.js'] }) },
    { name: 'package-lock.json', data: LOCK },
    { name: 'index.js', data: 'module.exports = "new";\n' },
    { name: 'db.js', data: 'module.exports = 1;\n' }
]);
const release = h.makeRelease(NEXT, { 'pterodactyl-manga-shelf.zip': ZIP });
const BUNDLE = Buffer.from(JSON.stringify(h.makeBundle(release.sumsBytes)));

const root = h.tmpDir();
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

const asset = (v, name, size = 10) => ({ name, size, browser_download_url: `${DL}v${v}/${name}` });
const rawRelease = (v, { signed = true } = {}) => ({
    tag_name: `v${v}`, draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z',
    body: v === NEXT ? '### Before updating\nRe-import the egg.\n' : '',
    assets: [
        ...(signed ? [asset(v, 'SHA256SUMS.txt'), asset(v, 'SHA256SUMS.txt.sigstore.json'), asset(v, `manga-shelf-release-v${v}.json`)] : []),
        asset(v, 'pterodactyl-manga-shelf.zip', ZIP.length)
    ]
});

function fakeDownload({ zip = ZIP, gate, signed = release } = {}) {
    const bundle = signed === release ? BUNDLE : Buffer.from(JSON.stringify(h.makeBundle(signed.sumsBytes)));
    const files = { 'SHA256SUMS.txt': signed.sumsBytes, 'SHA256SUMS.txt.sigstore.json': bundle, [signed.markerName]: signed.markerBytes };
    return {
        fetchJson: async (url) => {
            if (url.includes('/releases/tags/')) return rawRelease(/v(\d+\.\d+\.\d+)$/.exec(url)[1]);
            return [rawRelease(NEXT), rawRelease('9.0.0', { signed: false }), rawRelease('0.0.1')];
        },
        fetchBuffer: async (url) => files[path.basename(url)],
        fetchToFile: async (url, { dest, expectedSha256, onProgress, signal }) => {
            if (gate) await gate(signal);
            fs.writeFileSync(dest, zip);
            onProgress(zip.length, zip.length);
            const sha256 = h.sha256hex(zip);
            if (expectedSha256 !== sha256) throw Object.assign(new Error('x'), { code: 'CHECKSUM_MISMATCH', expose: true });
            return { sha256, size: zip.length };
        }
    };
}

function setup(over = {}) {
    update.resetForTests();
    const dir = path.join(root, `s-${n++}`);
    const codeDir = path.join(dir, 'code');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
    fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'package.json'), JSON.stringify({ version: pkg.version, files: ['index.js', 'db.js'] }));
    fs.writeFileSync(path.join(codeDir, 'package-lock.json'), LOCK);
    fs.writeFileSync(path.join(codeDir, 'index.js'), 'module.exports = "old";\n');
    fs.writeFileSync(path.join(codeDir, 'db.js'), 'module.exports = 0;\n');
    const exits = [];
    update.configureForTests({
        dataDir,
        installMode: { mode: 'pterodactyl', canInstall: true, reason: null, supervisor: 'wings', codeDir, execPath: process.execPath, assetName: 'pterodactyl-manga-shelf.zip', restart: 'pterodactyl' },
        download: fakeDownload(over),
        verifier: verify.createVerifier({ verifyBundle: async () => over.signer || h.goodSigner() }),
        freeBytes: () => 1e12,
        apply: {
            backupsDir: path.join(dataDir, 'backups'),
            schemaVersion: () => 27,
            holdSnapshot: () => () => {},
            createBackupSnapshot: async (prefix) => {
                const filename = `${prefix}-2026-10-10T10-00-00-000Z.zip`;
                fs.writeFileSync(path.join(dataDir, 'backups', filename), 'backup');
                return { filename, verified: true };
            }
        },
        exit: (code) => exits.push(code),
        ...over.deps
    });
    return { codeDir, dataDir, exits };
}

async function until(fn) {
    for (let i = 0; i < 500; i++) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timed out');
}

const code = (expected) => (err) => {
    assert.equal(err.code, expected);
    return true;
};

test('release list for this server with reasons; older and unsigned versions are not installable', async () => {
    setup();
    const list = await update.listReleases();
    const byVersion = Object.fromEntries(list.releases.map((r) => [r.version, r]));
    assert.equal(byVersion[NEXT].installable, true);
    assert.equal(byVersion[NEXT].has_admin_notes, true);
    assert.equal(byVersion['9.0.0'].reason, 'unsigned');
    assert.equal(byVersion['0.0.1'].reason, 'older');
});

test('prepare refuses unknown, older and unsigned versions before any download', async () => {
    setup();
    await assert.rejects(update.prepareUpdate({ version: 'v9.1.0', userId: 1 }), code('VERSION_UNKNOWN'));
    await assert.rejects(update.prepareUpdate({ version: '9.9.9', userId: 1 }), code('VERSION_UNKNOWN'));
    await assert.rejects(update.prepareUpdate({ version: '0.0.1', userId: 1 }), code('VERSION_NOT_NEWER'));
    await assert.rejects(update.prepareUpdate({ version: '9.0.0', userId: 1 }), code('RELEASE_UNSIGNED'));
    update.configureForTests({ installMode: { mode: 'docker', canInstall: false, reason: 'docker' } });
    await assert.rejects(update.prepareUpdate({ version: NEXT, userId: 1 }), (e) => e.code === 'NOT_INSTALLABLE' && e.extra.reason === 'docker');
});

test('prepare → ready → apply → backup, new code, switch at restart, exit 75', async () => {
    const w = setup();
    const started = await update.prepareUpdate({ version: NEXT, userId: 1 });
    assert.match(started.staging_id, /^[0-9a-f-]{36}$/);
    await assert.rejects(update.prepareUpdate({ version: NEXT, userId: 2 }), code('UPDATE_BUSY'));
    await until(() => update.getStatus().phase === 'ready');
    const status = update.getStatus();
    assert.equal(status.version, NEXT);
    assert.equal(status.bytes, ZIP.length);
    assert.deepEqual(status.verified, { identity: 'https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/heads/main', log_index: '123456' });
    assert.deepEqual(status.admin_notes.map((a) => [a.version, a.text]), [[NEXT, 'Re-import the egg.']]);

    assert.throws(() => update.applyUpdate({ stagingId: started.staging_id, userId: 1 }), (e) => e.code === 'NOT_INSTALLABLE' && e.extra.reason === 'no_restart');
    let shutdowns = 0;
    update.registerRestart(async () => { shutdowns++; });
    assert.throws(() => update.applyUpdate({ stagingId: started.staging_id, userId: 2 }), code('STAGING_NOT_FOUND'));
    const accepted = update.applyUpdate({ stagingId: started.staging_id, userId: 1, audit: { username: 'admin', authScheme: 'cookie', ip: '127.0.0.1' } });
    assert.deepEqual(accepted, { accepted: true, version: NEXT, restart: 'pterodactyl' });
    assert.equal(update.isUpdateRunning(), true);
    assert.equal(update.lock.isMaintenance(), true);
    assert.throws(() => update.lock.assertNoUpdate(), code('UPDATE_RUNNING'));
    await until(() => w.exits.length === 1);
    assert.deepEqual(w.exits, [75]);
    assert.equal(shutdowns, 1);
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'module.exports = "new";\n');
    const s = stateFile.readState(w.dataDir);
    assert.equal(s.phase, 'swapped');
    assert.equal(s.to, NEXT);
    assert.equal(update.heldBackup(), `vor-update-v${pkg.version}-auf-v${NEXT}-2026-10-10T10-00-00-000Z.zip`);
});

test('a refused signature fails the preparation and deletes the download', async () => {
    const w = setup({ signer: h.goodSigner('https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/heads/main-x') });
    await update.prepareUpdate({ version: NEXT, userId: 1 });
    await until(() => update.getStatus().phase === 'failed');
    assert.equal(update.getStatus().error.code, 'SIGNATURE_IDENTITY');
    assert.deepEqual(fs.readdirSync(path.join(w.dataDir, 'temp', 'update')), []);
    assert.equal(update.lock.isBusy(), false);
});

test('a damaged download is refused with CHECKSUM_MISMATCH', async () => {
    setup({ zip: Buffer.concat([ZIP, Buffer.from('x')]) });
    await update.prepareUpdate({ version: NEXT, userId: 1 });
    await until(() => update.getStatus().phase === 'failed');
    assert.equal(update.getStatus().error.code, 'CHECKSUM_MISMATCH');
});

test('discard cancels a running download; an expired staging cannot be applied', async () => {
    let release;
    const w = setup({ gate: (signal) => new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'DOWNLOAD_ABORTED', expose: true }))); }) });
    const started = await update.prepareUpdate({ version: NEXT, userId: 1 });
    await until(() => typeof release === 'function');
    assert.throws(() => update.discardStaging('other'), code('STAGING_NOT_FOUND'));
    assert.deepEqual(update.discardStaging(started.staging_id), { discarded: true });
    assert.equal(update.getStatus().phase, 'idle');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(update.getStatus().phase, 'idle', 'the aborted download does not report a failure');
    assert.deepEqual(fs.readdirSync(path.join(w.dataDir, 'temp', 'update')), []);

    let now = Date.now();
    setup({ deps: { now: () => now } });
    update.registerRestart(async () => {});
    const second = await update.prepareUpdate({ version: NEXT, userId: 1 });
    await until(() => update.getStatus().phase === 'ready');
    now += 16 * 60 * 1000;
    assert.throws(() => update.applyUpdate({ stagingId: second.staging_id, userId: 1 }), code('STAGING_EXPIRED'));
    assert.equal(update.lock.isBusy(), false);
});

test('a backup or snapshot job blocks apply with JOB_RUNNING', async () => {
    setup();
    update.registerRestart(async () => {});
    const started = await update.prepareUpdate({ version: NEXT, userId: 1 });
    await until(() => update.getStatus().phase === 'ready');
    const lifecycle = require('../../services/lifecycle');
    let finish;
    lifecycle.trackJob('Snapshot', new Promise((r) => { finish = r; }));
    assert.throws(() => update.applyUpdate({ stagingId: started.staging_id, userId: 1 }), code('JOB_RUNNING'));
    finish();
});

const BAD_ZIP = h.makeZip([
    { name: 'package.json', data: JSON.stringify({ version: NEXT, engines: { node: '>=22.13.0' }, files: ['index.js', 'db.js'] }) },
    { name: 'package-lock.json', data: LOCK },
    { name: 'index.js', data: 'module.exports = "new";\n' },
    { name: 'db.js', data: 'module.exports = 1;\n' },
    { name: 'evil.js', data: 'x' }
]);

test('a failed background install ends maintenance, frees the lock and discards the staging', async () => {
    const unverifiedBackup = (dataDir) => ({
        backupsDir: path.join(dataDir, 'backups'),
        schemaVersion: () => 27,
        holdSnapshot: () => () => {},
        createBackupSnapshot: async () => ({ filename: 'x.zip', verified: false })
    });
    const cases = [
        { expected: 'BACKUP_FAILED', over: {}, apply: unverifiedBackup },
        { expected: 'BAD_PACKAGE', over: { zip: BAD_ZIP, signed: h.makeRelease(NEXT, { 'pterodactyl-manga-shelf.zip': BAD_ZIP }) } }
    ];
    for (const c of cases) {
        const w = setup(c.over);
        if (c.apply) update.configureForTests({ apply: c.apply(w.dataDir) });
        update.registerRestart(async () => { throw new Error('no restart after a failure'); });
        const started = await update.prepareUpdate({ version: NEXT, userId: 1 });
        await until(() => update.getStatus().phase === 'ready');
        update.applyUpdate({ stagingId: started.staging_id, userId: 1 });
        assert.equal(update.lock.isMaintenance(), true);
        await until(() => update.getStatus().phase === 'failed');
        assert.equal(update.getStatus().error.code, c.expected);
        assert.equal(update.lock.isMaintenance(), false, c.expected);
        assert.equal(update.lock.isBusy(), false);
        assert.equal(update.isUpdateRunning(), false);
        assert.deepEqual(fs.readdirSync(path.join(w.dataDir, 'temp', 'update')), []);
        assert.deepEqual(w.exits, []);
        assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'module.exports = "old";\n');
        let passed = null;
        update.maintenanceGuard()({ method: 'POST', originalUrl: '/api/mangas' }, { set: () => {} }, (err) => { passed = err || 'ok'; });
        assert.equal(passed, 'ok', 'writes are accepted again');
    }
});

test('what is installed is what was verified, even when the staged file is replaced afterwards', async () => {
    const w = setup();
    update.registerRestart(async () => {});
    const started = await update.prepareUpdate({ version: NEXT, userId: 1 });
    await until(() => update.getStatus().phase === 'ready');
    const staged = path.join(w.dataDir, 'temp', 'update', started.staging_id, 'pterodactyl-manga-shelf.zip');
    const planted = h.makeZip([
        { name: 'package.json', data: JSON.stringify({ version: NEXT, files: ['index.js', 'db.js'] }) },
        { name: 'index.js', data: 'module.exports = "planted";\n' },
        { name: 'db.js', data: 'module.exports = 1;\n' }
    ]);
    fs.writeFileSync(`${staged}.planted`, planted);
    fs.renameSync(`${staged}.planted`, staged);
    update.applyUpdate({ stagingId: started.staging_id, userId: 1 });
    await until(() => w.exits.length === 1);
    assert.deepEqual(w.exits, [75]);
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'module.exports = "new";\n');
});

test('the binary hands in its Windows ACL helpers; the install mode is detected again on next use', () => {
    update.resetForTests();
    const first = update.installMode();
    assert.equal(update.installMode(), first);
    update.useWindowsAcl({ SID: {}, currentSid: () => 'S-1-5-21-1', readWindowsSecurity: () => ({}), foreignAces: () => [] });
    assert.notEqual(update.installMode(), first);
    update.resetForTests();
});
