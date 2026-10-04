const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let scheduler;
let backupsDir;
let tempDir;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    scheduler = require('../services/scheduler');
    backupsDir = scheduler.backupsDir;
    tempDir = path.join(ctx.dataDir, 'temp');
});

test.after(async () => { await ctx.close(); });

function clearBackups() {
    for (const f of fs.readdirSync(backupsDir)) fs.rmSync(path.join(backupsDir, f), { force: true });
}

const backupFiles = () => fs.readdirSync(backupsDir).sort();
const zipFiles = () => backupFiles().filter(f => f.endsWith('.zip'));
const tempDbCopies = () => fs.readdirSync(tempDir).filter(f => f.startsWith('backup-db-'));

function dbFromZip(buffer) {
    const zip = new AdmZip(buffer);
    const raw = zip.getEntry('manga.db').getData();
    const file = path.join(ctx.dataDir, `inspect-${Date.now()}.db`);
    fs.writeFileSync(file, raw);
    const { DatabaseSync } = require('node:sqlite');
    const probe = new DatabaseSync(file, { readOnly: true });
    const row = probe.prepare("SELECT value FROM app_settings WHERE key = 'jwt_secret'").get();
    probe.close();
    fs.rmSync(file, { force: true });
    return { raw, row };
}

function liveSecret() {
    const secret = require('../middleware/auth').JWT_SECRET;
    assert.ok(typeof secret === 'string' && secret.length >= 32, 'the test server generates a secret');
    return secret;
}

const secretRows = () => require('../db').db.prepare("SELECT value FROM app_settings WHERE key = 'jwt_secret'").all();

test('snapshots and the backup download contain neither the signing secret nor a legacy jwt_secret row', async () => {
    clearBackups();
    const secret = liveSecret();
    const legacy = 'legacy-secret-' + 'x'.repeat(40);
    const { db } = require('../db');
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('jwt_secret', ?)").run(legacy);
    try {
        const snap = await admin('POST', '/backups/create');
        assert.equal(snap.status, 200);
        const fromSnapshot = dbFromZip(fs.readFileSync(path.join(backupsDir, snap.body.snapshot.filename)));
        assert.equal(fromSnapshot.row, undefined);
        assert.ok(!fromSnapshot.raw.includes(Buffer.from(legacy)), 'legacy secret bytes are not left in free pages');
        assert.ok(!fromSnapshot.raw.includes(Buffer.from(secret)));

        const res = await fetch(ctx.base + '/backup', { headers: { Cookie: admin.cookie } });
        assert.equal(res.status, 200);
        const fromDownload = dbFromZip(Buffer.from(await res.arrayBuffer()));
        assert.equal(fromDownload.row, undefined);
        assert.ok(!fromDownload.raw.includes(Buffer.from(legacy)));
        assert.ok(!fromDownload.raw.includes(Buffer.from(secret)));
    } finally {
        db.prepare("DELETE FROM app_settings WHERE key = 'jwt_secret'").run();
    }
    assert.deepEqual(tempDbCopies(), []);
});

test('restoring a snapshot keeps the session and the live secret, and stores no secret in the database', async () => {
    clearBackups();
    const secret = liveSecret();
    const snap = await admin('POST', '/backups/create');
    assert.equal(snap.status, 200);
    const restored = await admin('POST', `/backups/${snap.body.snapshot.filename}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.relogin, false);
    assert.equal((await admin('GET', '/mangas')).status, 200);
    assert.equal(liveSecret(), secret);
    assert.deepEqual(secretRows(), []);
});

test('a snapshot whose output cannot be written fails cleanly instead of crashing the process', { skip: isRoot && 'root ignores directory permissions' }, async () => {
    clearBackups();
    let uncaught = null;
    const spy = (err) => { uncaught = err; };
    process.on('uncaughtException', spy);
    fs.chmodSync(backupsDir, 0o555);
    try {
        const started = Date.now();
        const res = await admin('POST', '/backups/create');
        assert.equal(res.status, 500);
        assert.equal(res.body.error, 'Fehler beim Erstellen des Snapshots');
        assert.ok(Date.now() - started < 5000);
    } finally {
        fs.chmodSync(backupsDir, 0o755);
        process.removeListener('uncaughtException', spy);
    }
    assert.equal(uncaught, null);
    assert.deepEqual(backupFiles(), []);
    assert.deepEqual(tempDbCopies(), []);
});

test('a write error in the middle of the archive (disk full) rejects and leaves no file', async (t) => {
    clearBackups();
    const { Writable } = require('stream');
    t.mock.method(fs, 'createWriteStream', () => new Writable({
        write(chunk, enc, cb) { cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })); }
    }));
    let uncaught = null;
    const spy = (err) => { uncaught = err; };
    process.on('uncaughtException', spy);
    try {
        await assert.rejects(scheduler.createBackupSnapshot('manual'), { code: 'ENOSPC' });
    } finally {
        process.removeListener('uncaughtException', spy);
    }
    assert.equal(uncaught, null);
    assert.deepEqual(backupFiles(), []);
    assert.deepEqual(tempDbCopies(), []);
});

test('a failing archive leaves no partial snapshot and never evicts a good one', { skip: isRoot && 'root can read mode 000 files' }, async () => {
    clearBackups();
    const good = await admin('POST', '/backups/create');
    assert.equal(good.status, 200);

    const unreadable = path.join(ctx.dataDir, 'uploads', 'unreadable.jpg');
    fs.writeFileSync(unreadable, Buffer.alloc(4096, 1));
    fs.chmodSync(unreadable, 0o000);
    try {
        for (let i = 0; i < 12; i++) {
            const res = await admin('POST', '/backups/create');
            assert.equal(res.status, 500);
        }
    } finally {
        fs.chmodSync(unreadable, 0o644);
        fs.rmSync(unreadable, { force: true });
    }
    assert.deepEqual(zipFiles(), [good.body.snapshot.filename]);
    const list = await admin('GET', '/backups');
    assert.deepEqual(list.body.backups.map(b => b.filename), [good.body.snapshot.filename]);
    assert.deepEqual(tempDbCopies(), []);
});

function fakeSnapshot(prefix, day) {
    const name = `${prefix}-2026-09-${String(day).padStart(2, '0')}T10-00-00-000Z.zip`;
    fs.writeFileSync(path.join(backupsDir, name), 'zip');
    return name;
}

test('retention is per prefix: manual snapshots never push out daily ones, unknown names stay', () => {
    clearBackups();
    const daily = [];
    for (let d = 1; d <= 9; d++) daily.push(fakeSnapshot('daily-auto', d));
    const manual = [];
    for (let d = 1; d <= 12; d++) manual.push(fakeSnapshot('manual', d));
    fs.writeFileSync(path.join(backupsDir, 'my-own-copy.zip'), 'zip');
    // an older daily file with a newer mtime: the name decides, not the mtime
    fs.utimesSync(path.join(backupsDir, daily[0]), new Date(), new Date());

    scheduler.pruneBackups('manual');
    let files = backupFiles();
    assert.deepEqual(files.filter(f => f.startsWith('manual-')), manual.slice(-10));
    assert.equal(files.filter(f => f.startsWith('daily-auto-')).length, 9, 'manual pruning leaves daily snapshots alone');

    scheduler.pruneBackups('daily-auto');
    files = backupFiles();
    assert.deepEqual(files.filter(f => f.startsWith('daily-auto-')), daily.slice(-7));
    assert.ok(files.includes('my-own-copy.zip'));

    scheduler.pruneBackups('manga-shelf-backup');
    assert.deepEqual(backupFiles(), files, 'prefixes without a retention are never pruned');
});

test('a retention above the cap keeps the cap, not the smaller default', () => {
    clearBackups();
    const daily = [];
    for (let d = 1; d <= 9; d++) daily.push(fakeSnapshot('daily-auto', d));
    process.env.BACKUP_KEEP_DAILY = '9999';
    try {
        assert.equal(scheduler.retentionFor('daily-auto'), 1000);
        scheduler.pruneBackups('daily-auto');
    } finally {
        delete process.env.BACKUP_KEEP_DAILY;
    }
    assert.deepEqual(zipFiles(), daily);
});

test('a malformed retention (30d, -1) keeps every good snapshot, failed ones only while newest', async () => {
    clearBackups();
    const daily = [];
    for (let d = 1; d <= 9; d++) daily.push(fakeSnapshot('daily-auto', d));
    const failedOld = daily.splice(3, 1)[0];
    fs.writeFileSync(path.join(backupsDir, failedOld.replace(/\.zip$/, '.json')), JSON.stringify({ verified: false, error: 'x' }));
    const manual = [];
    for (let d = 1; d <= 12; d++) manual.push(fakeSnapshot('manual', d));
    process.env.BACKUP_KEEP_DAILY = '30d';
    process.env.BACKUP_KEEP_MANUAL = '-1';
    try {
        scheduler.pruneBackups('daily-auto');
        scheduler.pruneBackups('manual');
        assert.equal((await admin('POST', '/backups/create')).status, 200);
    } finally {
        delete process.env.BACKUP_KEEP_DAILY;
        delete process.env.BACKUP_KEEP_MANUAL;
    }
    const files = zipFiles();
    for (const name of [...daily, ...manual]) assert.ok(files.includes(name), name);
    assert.ok(!files.includes(failedOld), 'a failed snapshot older than a good one is pruned');
    assert.equal(files.filter(f => f.startsWith('manual-')).length, 13);
});

test('BACKUP_KEEP_DAILY=7d: failed daily retries are cut down to the newest one, good ones all stay', () => {
    clearBackups();
    const good = [1, 2, 3, 4, 5, 6, 7, 8].map(d => fakeSnapshot('daily-auto', d));
    const failed = [9, 10, 11].map(d => fakeSnapshot('daily-auto', d));
    for (const name of failed) fs.writeFileSync(path.join(backupsDir, name.replace(/\.zip$/, '.json')), JSON.stringify({ verified: false, error: 'x' }));
    process.env.BACKUP_KEEP_DAILY = '7d';
    try {
        scheduler.pruneBackups('daily-auto');
    } finally {
        delete process.env.BACKUP_KEEP_DAILY;
    }
    const files = zipFiles();
    for (const name of good) assert.ok(files.includes(name), name);
    assert.deepEqual(failed.filter(n => files.includes(n)), [failed[2]]);
    assert.ok(!fs.existsSync(path.join(backupsDir, failed[0].replace(/\.zip$/, '.json'))), 'the sidecar goes with it');
});

test('creating manual snapshots does not delete the daily snapshot', async () => {
    clearBackups();
    const daily = fakeSnapshot('daily-auto', 1);
    process.env.BACKUP_KEEP_MANUAL = '2';
    try {
        for (let i = 0; i < 4; i++) assert.equal((await admin('POST', '/backups/create')).status, 200);
    } finally {
        delete process.env.BACKUP_KEEP_MANUAL;
    }
    const files = zipFiles();
    assert.ok(files.includes(daily));
    assert.equal(files.filter(f => f.startsWith('manual-')).length, 2);
});

const entry = (filename, verified = true) => ({ filename, verified });
const BERLIN_3 = { hour: 3, timeZone: 'Europe/Berlin' };

test('needsDailyBackup only counts a verified daily snapshot of the current local day, from the daily hour on', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    assert.equal(scheduler.needsDailyBackup([], now, BERLIN_3), true);
    assert.equal(scheduler.needsDailyBackup([entry('manual-2026-10-03T08-00-00-000Z.zip')], now, BERLIN_3), true);
    assert.equal(scheduler.needsDailyBackup([entry('daily-auto-2026-10-02T08-00-00-000Z.zip')], now, BERLIN_3), true);
    assert.equal(scheduler.needsDailyBackup([entry('daily-auto-2026-10-03T08-00-00-000Z.zip', false)], now, BERLIN_3), true, 'a failed snapshot does not count');
    assert.equal(scheduler.needsDailyBackup([entry('daily-auto-2026-10-03T08-00-00-000Z.zip', null)], now, BERLIN_3), true, 'an unchecked snapshot does not count');
    assert.equal(scheduler.needsDailyBackup([entry('daily-auto-2026-10-03T08-00-00-000Z.zip')], now, BERLIN_3), false);
});

test('the daily window uses the local calendar day: 00:30 Berlin is the new day, but before 03:00 nothing runs', () => {
    // 2026-10-03 22:30 UTC = 2026-10-04 00:30 CEST
    const lateUtc = new Date('2026-10-03T22:30:00Z');
    assert.deepEqual(scheduler.localParts(lateUtc, 'Europe/Berlin'), { date: '2026-10-04', hour: 0 });
    assert.equal(scheduler.needsDailyBackup([], lateUtc, BERLIN_3), false, 'before the daily hour');
    const atThree = new Date('2026-10-04T01:00:00Z');
    const yesterdayUtcButTodayLocal = entry('daily-auto-2026-10-03T22-45-00-000Z.zip');
    assert.equal(scheduler.needsDailyBackup([yesterdayUtcButTodayLocal], atThree, BERLIN_3), false, 'taken after local midnight');
    assert.equal(scheduler.needsDailyBackup([entry('daily-auto-2026-10-03T21-45-00-000Z.zip')], atThree, BERLIN_3), true, 'taken before local midnight');
    assert.equal(scheduler.needsDailyBackup([], atThree, BERLIN_3), true);
    assert.equal(scheduler.needsDailyBackup([], new Date('2026-10-04T00:59:00Z'), BERLIN_3), false, '02:59 local');
    // winter time: 2026-12-01 02:00 UTC = 03:00 CET
    assert.deepEqual(scheduler.localParts(new Date('2026-12-01T02:00:00Z'), 'Europe/Berlin'), { date: '2026-12-01', hour: 3 });
});

test('backupSchedule reads BACKUP_HOUR and BACKUP_TIMEZONE with safe fallbacks', () => {
    const saved = { hour: process.env.BACKUP_HOUR, tz: process.env.BACKUP_TIMEZONE };
    try {
        delete process.env.BACKUP_HOUR;
        delete process.env.BACKUP_TIMEZONE;
        assert.deepEqual(scheduler.backupSchedule(), { hour: 3, timeZone: 'Europe/Berlin' });
        process.env.BACKUP_HOUR = '23';
        process.env.BACKUP_TIMEZONE = 'UTC';
        assert.deepEqual(scheduler.backupSchedule(), { hour: 23, timeZone: 'UTC' });
        process.env.BACKUP_HOUR = '24';
        process.env.BACKUP_TIMEZONE = 'Mars/Olympus_Mons';
        assert.deepEqual(scheduler.backupSchedule(), { hour: 23, timeZone: 'UTC' });
        process.env.BACKUP_HOUR = '3am';
        assert.equal(scheduler.backupSchedule().hour, 3);
    } finally {
        for (const [key, value] of [['BACKUP_HOUR', saved.hour], ['BACKUP_TIMEZONE', saved.tz]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

const ANY_TIME = { hour: 0, timeZone: 'UTC' };

test('the daily check runs despite a manual snapshot from today and does not duplicate', async () => {
    clearBackups();
    assert.equal((await admin('POST', '/backups/create')).status, 200);
    const [first, second] = await Promise.all([scheduler.runDailyBackupIfDue(new Date(), ANY_TIME), scheduler.runDailyBackupIfDue(new Date(), ANY_TIME)]);
    assert.equal(first, true);
    assert.equal(second, true, 'concurrent checks share one run');
    assert.equal(await scheduler.runDailyBackupIfDue(new Date(), ANY_TIME), false);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(backupFiles().filter(f => f.startsWith(`daily-auto-${today}`) && f.endsWith('.zip')).length, 1);
    assert.equal(scheduler.listSnapshots().find(s => s.category === 'daily').verified, true);
});

test('a daily snapshot that fails its test is retried on the next check; failed ones never pile up', async (t) => {
    clearBackups();
    const archive = require('../services/backupArchive');
    const verify = archive.verifyArchive;
    let fail = true;
    t.mock.method(archive, 'verifyArchive', async (...args) => (fail
        ? { verified: false, error: 'kaputt', verified_at: new Date().toISOString() }
        : verify(...args)));
    assert.equal(await scheduler.runDailyBackupIfDue(new Date(), ANY_TIME), true);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(await scheduler.runDailyBackupIfDue(new Date(), ANY_TIME), true, 'an unverified daily does not count');
    const dailies = () => scheduler.listSnapshots().filter(s => s.category === 'daily');
    assert.deepEqual(dailies().map(s => s.verified), [false], 'only the newest failed attempt is kept');
    fail = false;
    await new Promise(r => setTimeout(r, 5));
    assert.equal(await scheduler.runDailyBackupIfDue(new Date(), ANY_TIME), true);
    assert.deepEqual(dailies().map(s => s.verified), [true], 'a good snapshot supersedes the failed one');
    assert.equal(await scheduler.runDailyBackupIfDue(new Date(), ANY_TIME), false);
});

test('selectForPruning keeps the newest good snapshots and at most one newer failed one', () => {
    const s = (day, verified = true) => ({ filename: `d-${day}`, time: Date.UTC(2026, 8, day), verified });
    assert.deepEqual(scheduler.selectForPruning([s(1), s(2), s(3)], 2), ['d-1']);
    assert.deepEqual(scheduler.selectForPruning([s(1), s(2, null), s(3)], 3), [], 'unchecked (older) snapshots count as good');
    assert.deepEqual(scheduler.selectForPruning([s(1), s(2), s(3, false), s(4, false)], 2), ['d-3'], 'only the newest failed one stays');
    assert.deepEqual(scheduler.selectForPruning([s(1), s(2, false), s(3)], 2), ['d-2'], 'a failed one older than a good one goes');
    assert.deepEqual(scheduler.selectForPruning([s(1, false), s(2, false)], 7), ['d-1']);
    assert.deepEqual(scheduler.selectForPruning([], 3), []);
});

test('categories: pre-restore keeps 3, all vor-update-* names share one retention sorted by time, sidecars go too', () => {
    clearBackups();
    assert.equal(scheduler.categoryOf('daily-auto-2026-09-01T10-00-00-000Z.zip'), 'daily');
    assert.equal(scheduler.categoryOf('manual-2026-09-01T10-00-00-000Z.zip'), 'manual');
    assert.equal(scheduler.categoryOf('vor-wiederherstellung-2026-09-01T10-00-00-000Z.zip'), 'pre-restore');
    assert.equal(scheduler.categoryOf('vor-update-v9-auf-v10-2026-09-01T10-00-00-000Z.zip'), 'pre-update');
    assert.equal(scheduler.categoryOf('manual-copy.zip'), 'other');
    assert.equal(scheduler.categoryOf('handmade.zip'), 'other');

    const pre = [];
    for (let d = 1; d <= 5; d++) pre.push(fakeSnapshot('vor-wiederherstellung', d));
    fs.writeFileSync(path.join(backupsDir, pre[0].replace(/\.zip$/, '.json')), JSON.stringify({ verified: true }));
    scheduler.pruneBackups('vor-wiederherstellung');
    assert.deepEqual(backupFiles().filter(f => f.startsWith('vor-wiederherstellung-')), pre.slice(-3));
    assert.ok(!fs.existsSync(path.join(backupsDir, pre[0].replace(/\.zip$/, '.json'))), 'the sidecar is removed with its snapshot');

    clearBackups();
    // lexically v9 sorts after v14: retention must go by the timestamp
    const updates = [
        fakeSnapshot('vor-update-v9-auf-v10', 1),
        fakeSnapshot('vor-update-v10-auf-v12', 2),
        fakeSnapshot('vor-update-v12-auf-v14', 3),
        fakeSnapshot('vor-update-v14-auf-v16', 4)
    ];
    scheduler.pruneBackups('vor-update-v14-auf-v16');
    assert.deepEqual(backupFiles(), updates.slice(1).sort());
    process.env.BACKUP_KEEP_PRE_UPDATE = '1';
    try {
        scheduler.pruneBackups('vor-update');
    } finally {
        delete process.env.BACKUP_KEEP_PRE_UPDATE;
    }
    assert.deepEqual(backupFiles(), [updates[3]]);
});

test('snapshots get a sidecar; deleting through the API removes it as well', async () => {
    clearBackups();
    const res = await admin('POST', '/backups/create');
    assert.equal(res.status, 200);
    const name = res.body.snapshot.filename;
    const sidecar = path.join(backupsDir, name.replace(/\.zip$/, '.json'));
    assert.equal(scheduler.readSidecar(name).verified, true);
    assert.deepEqual(backupFiles(), [name.replace(/\.zip$/, '.json'), name].sort());
    assert.equal((await admin('DELETE', `/backups/${name}`)).status, 200);
    assert.ok(!fs.existsSync(sidecar));
    assert.equal(scheduler.lastVerifiedSnapshot(), null);
});

test('initScheduler returns a stop function that clears its timers', () => {
    const stop = scheduler.initScheduler();
    assert.equal(typeof stop, 'function');
    stop();
});

test('the startup sweep removes leftovers of crashed backups and restores, nothing else', () => {
    const write = (file) => { fs.writeFileSync(file, 'leftover'); return file; };
    const stale = [
        write(path.join(tempDir, 'backup-db-1-2.db')),
        write(path.join(tempDir, 'restore-1-2.zip')),
        write(path.join(ctx.dataDir, 'manga.db.restore-tmp')),
        write(path.join(ctx.dataDir, 'manga.db.restore-tmp-wal')),
        write(path.join(backupsDir, 'manual-2026-09-01T10-00-00-000Z.zip.part')),
        write(path.join(tempDir, 'verify-1-ab.db')),
        write(path.join(tempDir, 'vor-update-db-1-2.db-journal')),
        write(path.join(tempDir, 'inspect-1-ab.db-wal')),
        write(path.join(tempDir, 'restore-staged-1234.zip')),
        write(path.join(backupsDir, 'manual-2026-09-01T10-00-00-000Z.json.tmp')),
        write(path.join(backupsDir, 'manual-2026-09-03T10-00-00-000Z.json'))
    ];
    const kept = [
        write(path.join(ctx.dataDir, 'manga.db.bak')),
        write(path.join(tempDir, 'something-else.txt')),
        write(path.join(backupsDir, 'manual-2026-09-02T10-00-00-000Z.zip')),
        write(path.join(backupsDir, 'manual-2026-09-02T10-00-00-000Z.json'))
    ];
    const live = ['manga.db', 'manga.db-wal', 'manga.db-shm'].map(f => path.join(ctx.dataDir, f)).filter(f => fs.existsSync(f));
    try {
        const result = scheduler.sweepTempArtefacts();
        assert.equal(result.removed, stale.length);
        for (const f of stale) assert.ok(!fs.existsSync(f), path.basename(f) + ' is removed');
        for (const f of [...kept, ...live]) assert.ok(fs.existsSync(f), path.basename(f) + ' stays');
    } finally {
        for (const f of kept) fs.rmSync(f, { force: true });
    }
});

test('the startup sweep removes staged restore covers and a half-written safety copy, keeps manga.db.bak', () => {
    const staging = path.join(tempDir, 'restore-uploads-AbC123');
    fs.mkdirSync(path.join(staging, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'cover.jpg'), 'jpeg');
    fs.writeFileSync(path.join(staging, 'nested', 'x.png'), 'png');
    const bakTmp = path.join(ctx.dataDir, 'manga.db.bak.tmp');
    fs.writeFileSync(bakTmp, 'half a copy');
    const bak = path.join(ctx.dataDir, 'manga.db.bak');
    fs.writeFileSync(bak, 'rollback copy');
    const otherDir = path.join(tempDir, 'restore-something');
    fs.mkdirSync(otherDir);
    try {
        const result = scheduler.sweepTempArtefacts();
        assert.equal(result.removed, 2);
        assert.ok(!fs.existsSync(staging));
        assert.ok(!fs.existsSync(bakTmp));
        assert.ok(fs.existsSync(bak));
        assert.ok(fs.existsSync(otherDir));
    } finally {
        fs.rmSync(bak, { force: true });
        fs.rmSync(otherDir, { recursive: true, force: true });
    }
});

test('a full disk while creating a snapshot answers 507 with a German message and leaves no file', async (t) => {
    clearBackups();
    const { Writable } = require('stream');
    t.mock.method(fs, 'createWriteStream', () => new Writable({
        write(chunk, enc, cb) { cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })); }
    }));
    const res = await admin('POST', '/backups/create');
    assert.equal(res.status, 507);
    assert.match(res.body.error, /Speicherplatz/);
    assert.deepEqual(backupFiles(), []);
    assert.deepEqual(tempDbCopies(), []);
});

test('a database copy that fails halfway (file size limit) leaves no partial copy or journal', { skip: process.platform === 'win32' && 'needs ulimit' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-vacuum-'));
    try {
        const file = path.join(dir, 'manga.db');
        const { DatabaseSync } = require('node:sqlite');
        const d = new DatabaseSync(file);
        d.exec('CREATE TABLE filler (b BLOB)');
        const insert = d.prepare('INSERT INTO filler VALUES (randomblob(65536))');
        for (let i = 0; i < 64; i++) insert.run();
        d.close();
        require('../db').migrateDbFile(file);

        const script = `const s = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'scheduler'))});
            try { s.copyDatabaseToTemp(); console.log('copied'); } catch (e) { console.log('failed: ' + e.message); }`;
        // 2048 blocks of 512 or 1024 bytes: the 4 MB copy cannot be written completely
        const out = execFileSync('/bin/sh', ['-c', 'ulimit -f 2048 && exec "$0" -e "$1"', process.execPath, script], {
            env: { ...process.env, DATA_DIR: dir, LOG_LEVEL: 'silent' },
            encoding: 'utf8'
        });
        assert.match(out, /failed: /);
        assert.deepEqual(fs.readdirSync(path.join(dir, 'temp')), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('pruning skips a snapshot that is being restored', () => {
    clearBackups();
    const names = [1, 2, 3].map(d => fakeSnapshot('manual', d));
    const release = scheduler.holdSnapshot(names[0]);
    try {
        scheduler.pruneBackups('manual', 1);
        assert.deepEqual(backupFiles(), [names[0], names[2]]);
    } finally {
        release();
    }
    release();
    assert.equal(scheduler.isSnapshotHeld(names[0]), false);
    scheduler.pruneBackups('manual', 1);
    assert.deepEqual(backupFiles(), [names[2]]);
});

test('a DB-only snapshot lists the uploads its database references in the sidecar; a full one does not', async () => {
    clearBackups();
    const { db, uploadsDir } = require('../db');
    fs.writeFileSync(path.join(uploadsDir, 'sidecar-used.jpg'), 'x');
    fs.writeFileSync(path.join(uploadsDir, 'sidecar-orphan.jpg'), 'x');
    const manga = db.prepare("INSERT INTO mangas (title, cover_image) VALUES ('Sidecar', '/uploads/sidecar-used.jpg')").run().lastInsertRowid;
    try {
        const pre = await scheduler.createBackupSnapshot(scheduler.PRE_RESTORE_PREFIX, { includeUploads: false });
        const list = scheduler.readSidecar(pre.filename).referenced_uploads;
        assert.ok(list.includes('sidecar-used.jpg'), JSON.stringify(list));
        assert.ok(!list.includes('sidecar-orphan.jpg'));
        const full = await scheduler.createBackupSnapshot('manual');
        assert.equal(scheduler.readSidecar(full.filename).referenced_uploads, undefined);
    } finally {
        db.prepare('DELETE FROM mangas WHERE id = ?').run(manga);
        for (const f of ['sidecar-used.jpg', 'sidecar-orphan.jpg']) fs.rmSync(path.join(uploadsDir, f), { force: true });
    }
});

test('a sidecar holding only the upload list leaves the snapshot unchecked, so retention never treats it as failed', () => {
    clearBackups();
    const updates = [fakeSnapshot('vor-update-v1-auf-v2', 1), fakeSnapshot('vor-update-v2-auf-v3', 2)];
    for (const name of updates) {
        fs.writeFileSync(path.join(backupsDir, name.replace(/\.zip$/, '.json')), JSON.stringify({ referenced_uploads: ['a.jpg'] }));
    }
    assert.deepEqual(scheduler.listSnapshots().map(s => [s.verified, s.verify_error]), [[null, null], [null, null]]);
    scheduler.pruneBackups('vor-update');
    assert.deepEqual(zipFiles(), updates);
});

test('the daily snapshot is tracked as a job, so a shutdown waits for it', async () => {
    clearBackups();
    const lifecycle = require('../services/lifecycle');
    const run = scheduler.runDailyBackupIfDue(new Date(), ANY_TIME);
    await new Promise(r => setImmediate(r));
    assert.ok(lifecycle.runningJobs().includes('Täglicher Snapshot'), lifecycle.runningJobs().join(','));
    assert.equal(await run, true);
    assert.deepEqual(lifecycle.runningJobs(), []);
});

test('backupSchedule and retention read utils/config.js', () => {
    process.env.BACKUP_KEEP_DAILY = '5';
    process.env.BACKUP_HOUR = '7';
    try {
        assert.equal(scheduler.retentionFor('daily-auto'), 5);
        assert.equal(scheduler.backupSchedule().hour, 7);
        process.env.BACKUP_KEEP_DAILY = '0';
        assert.equal(scheduler.retentionFor('daily-auto'), Infinity, 'an invalid value keeps everything');
    } finally {
        delete process.env.BACKUP_KEEP_DAILY;
        delete process.env.BACKUP_HOUR;
    }
});
