process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const stage = require('../../services/update/stage');
const h = require('../fixtures/update/helpers');

const dataDir = h.tmpDir();
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
test.beforeEach(() => stage.reset());

test('a staging lives under temp/update/<uuid> with an informational state.json', () => {
    const rec = stage.create({ dataDir, version: '3.2.0', assetName: 'pterodactyl-manga-shelf.zip', userId: 1, now: 1000 });
    assert.equal(path.dirname(rec.dir), path.join(dataDir, 'temp', 'update'));
    assert.match(path.basename(rec.dir), /^[0-9a-f-]{36}$/);
    const info = JSON.parse(fs.readFileSync(path.join(rec.dir, 'state.json'), 'utf8'));
    assert.deepEqual(Object.keys(info).sort(), ['asset', 'created_at', 'expires_at', 'format', 'sha256', 'signer', 'size', 'user_id', 'verified', 'version'].sort());
    assert.equal(info.format, 1);
    assert.equal(info.verified, false);
    assert.equal(stage.assetPath(rec), path.join(rec.dir, 'pterodactyl-manga-shelf.zip'));
});

test('TTL: 15 minutes, counted again from the verification', () => {
    const rec = stage.create({ dataDir, version: '3.2.0', assetName: 'a', userId: 1, now: 0 });
    assert.equal(rec.expiresAt, 15 * 60 * 1000);
    assert.equal(stage.isExpired(rec, 15 * 60 * 1000 - 1), false);
    assert.equal(stage.isExpired(rec, 15 * 60 * 1000), true);
    stage.markVerified(rec, { sha256: 'a'.repeat(64), size: 3, signer: 'x', logIndex: '1', now: 10 * 60 * 1000 });
    assert.equal(rec.expiresAt, 25 * 60 * 1000);
    assert.equal(stage.isExpired(rec, 20 * 60 * 1000), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(rec.dir, 'state.json'), 'utf8')).verified, true);
});

test('ownership: only the user who prepared it gets the staging', () => {
    const rec = stage.create({ dataDir, version: '3.2.0', assetName: 'a', userId: 7 });
    assert.equal(stage.forUser(rec.id, 7), rec);
    assert.equal(stage.forUser(rec.id, 8), null);
    assert.equal(stage.forUser('other', 7), null);
});

test('one staging at a time: a new one discards the old folder and aborts its download', () => {
    const first = stage.create({ dataDir, version: '3.2.0', assetName: 'a', userId: 1 });
    fs.writeFileSync(path.join(first.dir, 'a.part'), 'x');
    const second = stage.create({ dataDir, version: '3.3.0', assetName: 'a', userId: 2 });
    assert.equal(first.abort.signal.aborted, true);
    assert.equal(fs.existsSync(first.dir), false);
    assert.equal(stage.get(), second);
    assert.equal(stage.discard('nope'), false);
    assert.equal(stage.discard(second.id), true);
    assert.equal(fs.existsSync(second.dir), false);
    assert.equal(stage.get(), null);
});

test('sweep removes leftovers of earlier processes but not the current staging', (t) => {
    const own = h.tmpDir();
    t.after(() => fs.rmSync(own, { recursive: true, force: true }));
    const leftover = path.join(own, 'temp', 'update', 'old-run');
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'x.part'), 'x');
    const rec = stage.create({ dataDir: own, version: '3.2.0', assetName: 'a', userId: 1 });
    assert.equal(stage.sweep(own), 1);
    assert.equal(fs.existsSync(leftover), false);
    assert.equal(fs.existsSync(rec.dir), true);
});

const posix = { skip: typeof process.getuid !== 'function' ? 'POSIX owners and modes' : false };

const refused = (problem) => (err) => {
    assert.equal(err.code, 'NOT_INSTALLABLE');
    assert.equal(err.extra.reason, `data_dir_${problem}`);
    return true;
};

test('the data folder must be private: shared, foreign or linked folders refuse the staging', posix, (t) => {
    const shared = h.tmpDir();
    t.after(() => fs.rmSync(shared, { recursive: true, force: true }));
    fs.chmodSync(shared, 0o777);
    assert.throws(() => stage.create({ dataDir: shared, version: '3.2.0', assetName: 'a', userId: 1 }), refused('shared_writable'));
    assert.equal(fs.existsSync(path.join(shared, 'temp')), false, 'nothing is created inside a shared data folder');
    fs.chmodSync(shared, 0o700);
    assert.throws(() => stage.create({ dataDir: shared, version: '3.2.0', assetName: 'a', userId: 1, uid: process.getuid() + 1 }), refused('foreign_owner'));

    const linked = h.tmpDir();
    const elsewhere = h.tmpDir();
    t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
    t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
    fs.mkdirSync(path.join(linked, 'temp'));
    fs.symlinkSync(elsewhere, path.join(linked, 'temp', 'update'));
    assert.throws(() => stage.create({ dataDir: linked, version: '3.2.0', assetName: 'a', userId: 1 }), refused('symlink'));
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    assert.equal(stage.get(), null);
});

test('temp and temp/update of this user are tightened before the staging goes in', posix, (t) => {
    const own = h.tmpDir();
    t.after(() => fs.rmSync(own, { recursive: true, force: true }));
    fs.mkdirSync(path.join(own, 'temp', 'update'), { recursive: true });
    fs.chmodSync(path.join(own, 'temp'), 0o777);
    fs.chmodSync(path.join(own, 'temp', 'update'), 0o775);
    const rec = stage.create({ dataDir: own, version: '3.2.0', assetName: 'a', userId: 1 });
    assert.equal(fs.statSync(path.join(own, 'temp')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(own, 'temp', 'update')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(rec.dir).mode & 0o777, 0o700);
});

test('openVerified: one handle of the downloaded file, kept only when its bytes match; later reads ignore the path', async () => {
    const { sha256Of } = require('../../services/update/verifiedFile');
    const rec = stage.create({ dataDir, version: '3.2.0', assetName: 'asset.zip', userId: 1 });
    fs.writeFileSync(stage.assetPath(rec), 'verified bytes');
    await assert.rejects(stage.openVerified(rec, h.sha256hex(Buffer.from('other bytes'))), (e) => e.code === 'CHECKSUM_MISMATCH');
    assert.equal(rec.handle, null);
    const handle = await stage.openVerified(rec, h.sha256hex(Buffer.from('verified bytes')));
    assert.equal(rec.handle, handle);
    fs.writeFileSync(`${stage.assetPath(rec)}.swap`, 'planted bytes');
    fs.renameSync(`${stage.assetPath(rec)}.swap`, stage.assetPath(rec));
    assert.equal(await sha256Of(handle), h.sha256hex(Buffer.from('verified bytes')));
    stage.discard(rec.id);
    assert.equal(rec.handle, null);
    await new Promise((r) => setImmediate(r));
    assert.equal(handle.fd, -1, 'discard closes the handle');
});

test('openVerified refuses a symlink in place of the download', { skip: process.platform === 'win32' ? 'symlinks' : false }, async () => {
    const rec = stage.create({ dataDir, version: '3.2.0', assetName: 'asset.zip', userId: 1 });
    const target = path.join(rec.dir, 'elsewhere');
    fs.writeFileSync(target, 'bytes');
    fs.symlinkSync(target, stage.assetPath(rec));
    await assert.rejects(stage.openVerified(rec, h.sha256hex(Buffer.from('bytes'))), (e) => e.code === 'BAD_PACKAGE' && e.extra.reason === 'staged_file');
    assert.equal(rec.handle, null);
});
