// Second backup location (services/backupCopy.js): PUT /api/backup/copy, copies of verified snapshots with the same
// retention, the failure reason, BACKUP_COPY_DIR and the hint "all backups on the same disk".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let scheduler;
let backupCopy;
let outside;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    scheduler = require('../services/scheduler');
    backupCopy = require('../services/backupCopy');
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-copy-'));
});

test.after(async () => {
    delete process.env.BACKUP_COPY_DIR;
    await ctx.close();
    fs.rmSync(outside, { recursive: true, force: true });
});

const clearBackups = () => {
    for (const f of fs.readdirSync(scheduler.backupsDir)) fs.rmSync(path.join(scheduler.backupsDir, f), { force: true });
};
const zips = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.zip')).sort();

test('without a second location the list says nothing about copies and the dialog shows the same-disk hint', async () => {
    clearBackups();
    await scheduler.createBackupSnapshot('manual');
    const res = await admin('GET', '/backups');
    assert.equal(res.status, 200);
    assert.equal(res.body.backups[0].copied, null);
    assert.equal(res.body.copy.dir, null);
    assert.equal(res.body.copy.same_disk_hint, true);
    const system = await admin('GET', '/system');
    assert.equal(system.body.backups.copy.same_disk_hint, true);
});

test('a downloaded Direkt-ZIP keeps the hint away for 30 days', async () => {
    const res = await admin('GET', '/backup');
    assert.equal(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await admin('GET', '/backups')).body.copy.same_disk_hint, false);
    assert.equal(backupCopy.recentDownload(Date.now() + backupCopy.DOWNLOAD_FRESH_MS + 1000), false);
    require('../db').db.prepare("DELETE FROM app_settings WHERE key = 'backup_downloaded_at'").run();
});

test('the folder must be a full path outside the data folder', async () => {
    for (const dir of ['relativ/ordner', ctx.dataDir, path.join(ctx.dataDir, 'backups', 'kopie'), path.dirname(ctx.dataDir)]) {
        const res = await admin('PUT', '/backup/copy', { dir });
        assert.equal(res.status, 400, dir);
        assert.equal(res.body.code, 'BACKUP_COPY_DIR');
    }
});

test('saving a folder copies every verified snapshot with its sidecar; new snapshots follow; the list marks them', async () => {
    clearBackups();
    const first = await scheduler.createBackupSnapshot('manual');
    const res = await admin('PUT', '/backup/copy', { dir: outside });
    assert.equal(res.status, 200);
    assert.equal(res.body.copy.dir, path.resolve(outside));
    assert.equal(res.body.copy.error, null);
    assert.ok(res.body.copy.ok_at);
    assert.equal(res.body.copy.copies, 1);
    assert.equal(res.body.copy.same_disk_hint, false);
    assert.deepEqual(zips(outside), [first.filename]);
    assert.ok(fs.existsSync(path.join(outside, first.filename.replace(/\.zip$/, '.json'))));
    assert.equal(res.body.backups[0].copied, true);
    assert.equal(fs.readFileSync(path.join(outside, first.filename)).equals(fs.readFileSync(path.join(scheduler.backupsDir, first.filename))), true);

    const second = await scheduler.createBackupSnapshot('manual');
    await backupCopy.syncCopies();
    assert.deepEqual(zips(outside), [first.filename, second.filename].sort());
    assert.ok(!fs.readdirSync(outside).some((f) => f.endsWith('.part')));
});

test('the copies keep the retention of their kind; hand-copied names are not copied', async () => {
    process.env.BACKUP_KEEP_MANUAL = '2';
    try {
        await scheduler.createBackupSnapshot('manual');
        await scheduler.createBackupSnapshot('manual');
        await backupCopy.syncCopies();
        const copies = zips(outside);
        assert.equal(copies.length, 2);
        assert.deepEqual(copies, zips(scheduler.backupsDir).filter((f) => f.startsWith('manual-')));
        fs.writeFileSync(path.join(scheduler.backupsDir, 'von-hand.zip'), 'x');
        await backupCopy.syncCopies();
        assert.ok(!zips(outside).includes('von-hand.zip'));
    } finally {
        delete process.env.BACKUP_KEEP_MANUAL;
        fs.rmSync(path.join(scheduler.backupsDir, 'von-hand.zip'), { force: true });
    }
});

test('an unreachable folder is reported, never created, and the snapshots on the server stay', async () => {
    const gone = path.join(outside, 'usb-stick');
    assert.equal((await admin('PUT', '/backup/copy', { dir: gone })).status, 200);
    const before = zips(scheduler.backupsDir);
    const snapshot = await scheduler.createBackupSnapshot('manual');
    assert.equal(snapshot.verified, true);
    const status = await backupCopy.syncCopies();
    assert.match(status.error, /nicht erreichbar/);
    assert.equal(status.error_msg.msg, backupCopy.COPY_TEXTS.unreachable);
    assert.ok(status.error_at);
    assert.equal(fs.existsSync(gone), false);
    assert.ok(zips(scheduler.backupsDir).includes(snapshot.filename));
    assert.ok(before.every((f) => zips(scheduler.backupsDir).includes(f) || f.startsWith('manual-')));
    const res = await admin('GET', '/backups');
    assert.match(res.body.copy.error, /nicht erreichbar/);
    assert.ok(res.body.backups.every((b) => b.copied === false));
});

test('an empty field removes the location; BACKUP_COPY_DIR wins and locks the field', async () => {
    let res = await admin('PUT', '/backup/copy', { dir: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.copy.dir, null);
    process.env.BACKUP_COPY_DIR = outside;
    try {
        res = await admin('GET', '/backups');
        assert.equal(res.body.copy.dir, path.resolve(outside));
        assert.equal(res.body.copy.from_env, true);
        res = await admin('PUT', '/backup/copy', { dir: path.join(outside, 'x') });
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'BACKUP_COPY_DIR');
    } finally {
        delete process.env.BACKUP_COPY_DIR;
    }
});

test('only admins see or change the second location', async () => {
    assert.equal((await admin('POST', '/users', { username: 'lena', password: 'password123', role: 'editor' })).status < 300, true);
    const lena = ctx.client();
    assert.equal((await lena('POST', '/auth/login', { username: 'lena', password: 'password123' })).status, 200);
    assert.equal((await lena('PUT', '/backup/copy', { dir: outside })).status, 403);
});
