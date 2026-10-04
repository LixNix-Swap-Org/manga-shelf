// Migrations, database restore and backup validation, ZIP safety limits, streaming of large archives and backup scheduling.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let dbm;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    dbm = require('../db');
});

test.after(async () => { await ctx.close(); });

const mangaCount = () => dbm.db.prepare('SELECT count(*) AS c FROM mangas').get().c;
const dataFiles = () => fs.readdirSync(ctx.dataDir);
const leftovers = () => dataFiles().filter(f => f.includes('restore-tmp') || f.startsWith('manga.db.bak'));

function seedMangas(n, prefix) {
    dbm.runTransaction(() => {
        const insert = dbm.db.prepare('INSERT INTO mangas (title, description) VALUES (?, ?)');
        for (let i = 0; i < n; i++) insert.run(`${prefix} ${i}`, 'x'.repeat(200));
    });
}

function integrityOk() {
    const probe = new DatabaseSync(dbm.dbPath, { readOnly: true });
    try {
        return probe.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
    } finally {
        probe.close();
    }
}

async function createSnapshot() {
    const res = await admin('POST', '/backups/create');
    assert.equal(res.status, 200);
    return res.body.snapshot.filename;
}

async function snapshotDbBuffer(mutate) {
    const zip = new AdmZip(path.join(ctx.dataDir, 'backups', await createSnapshot()));
    const tmp = path.join(ctx.dataDir, 'temp', `test-${Date.now()}.db`);
    fs.writeFileSync(tmp, zip.getEntry('manga.db').getData());
    if (mutate) {
        const d = new DatabaseSync(tmp);
        mutate(d);
        d.close();
    }
    const data = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return data;
}

async function uploadZip(buffer, url = '/backup/restore', fields = {}) {
    const fd = new FormData();
    for (const [key, value] of Object.entries(fields)) fd.append(key, value);
    fd.append('backup', new Blob([buffer], { type: 'application/zip' }), 'backup.zip');
    const res = await fetch(ctx.base + url, { method: 'POST', headers: { Cookie: admin.cookie }, body: fd });
    const set = res.headers.get('set-cookie');
    if (set && set.startsWith('token=') && !set.startsWith('token=;')) admin.cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
}

function zipOf(files) {
    const zip = new AdmZip();
    for (const [name, data] of Object.entries(files)) zip.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
    return zip;
}

test('migration v12: ISBN lookups use an index, the redundant volume_reads index is gone', () => {
    const { db } = dbm;
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(r => r.name);
    assert.ok(indexes.includes('idx_volumes_isbn'));
    assert.ok(!indexes.includes('idx_volume_reads_vol'));
    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version = 12').get());
    const plan = (sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(r => r.detail).join(' | ');
    assert.match(plan('SELECT 1 FROM volumes WHERE isbn = ? LIMIT 1'), /INDEX idx_volumes_isbn/);
    assert.doesNotMatch(plan('SELECT id FROM volumes WHERE isbn = ? ORDER BY id LIMIT 1'), /TEMP B-TREE/);
    assert.match(plan('DELETE FROM volume_reads WHERE volume_id = ?'), /SEARCH volume_reads USING (COVERING )?INDEX sqlite_autoindex_volume_reads_1/);
});

test('migration v13 turns legacy Gelesen volumes into owned volumes with a read entry, once', () => {
    const { db } = dbm;
    const adminId = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get().id;
    const mangaId = db.prepare("INSERT INTO mangas (title, owned_volumes) VALUES ('Migration Gelesen', 0)").run().lastInsertRowid;
    const volId = db.prepare("INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, '1', 'Gelesen')").run(mangaId).lastInsertRowid;
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, '2', 'Fehlt')").run(mangaId);
    db.prepare('DELETE FROM schema_migrations WHERE version = 13').run();

    const state = () => ({
        status: db.prepare('SELECT status FROM volumes WHERE id = ?').get(volId).status,
        owners: db.prepare('SELECT user_id FROM volume_owners WHERE volume_id = ?').all(volId).map(r => r.user_id),
        reads: db.prepare('SELECT user_id FROM volume_reads WHERE volume_id = ?').all(volId).map(r => r.user_id),
        owned: db.prepare('SELECT owned_volumes FROM mangas WHERE id = ?').get(mangaId).owned_volumes
    });
    try {
        dbm.initDb();
        const after = state();
        assert.deepEqual(after, { status: 'Vorhanden', owners: [adminId], reads: [adminId], owned: 1 });
        assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version = 13').get());

        db.prepare('DELETE FROM schema_migrations WHERE version = 13').run();
        dbm.initDb();
        assert.deepEqual(state(), after);
    } finally {
        db.prepare('DELETE FROM mangas WHERE id = ?').run(mangaId);
    }
});

test('migration v14: usernames are unique regardless of case', () => {
    const { db } = dbm;
    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version = 14').get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_username_nocase'").get());
    assert.throws(() => db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('ADMIN', 'x', 'editor')").run(), /UNIQUE constraint failed/);
});

test('migration v14 skips the index with a warning when case duplicates exist and retries on the next start', async (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (line) => { warnings.push(String(line)); });
    const data = await snapshotDbBuffer((d) => {
        d.exec(`
            DROP INDEX idx_users_username_nocase;
            DELETE FROM schema_migrations WHERE version = 14;
            INSERT INTO users (username, password_hash, role) VALUES ('Kim', 'x', 'editor'), ('kim', 'x', 'visitor');
        `);
    });
    const file = path.join(ctx.dataDir, 'temp', 'case-duplicates.db');
    fs.writeFileSync(file, data);
    const inspect = (fn) => {
        const d = new DatabaseSync(file);
        try { return fn(d); } finally { d.close(); }
    };
    const hasIndex = () => inspect(d => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_username_nocase'").get());
    try {
        assert.doesNotThrow(() => dbm.migrateDbFile(file));
        assert.equal(hasIndex(), false);
        assert.ok(inspect(d => d.prepare('SELECT 1 FROM schema_migrations WHERE version = 14').get()), 'startup goes on');
        assert.deepEqual(inspect(d => d.prepare("SELECT username FROM users WHERE lower(username) = 'kim' ORDER BY username").all().map(r => r.username)), ['Kim', 'kim'], 'nobody is renamed');
        if (!/^(silent|error)$/i.test(process.env.LOG_LEVEL || '')) {
            assert.equal(warnings.filter(w => w.includes('Kim, kim')).length, 1, 'one warning naming the duplicates');
        }

        inspect(d => d.exec("DELETE FROM users WHERE username = 'kim'"));
        dbm.migrateDbFile(file);
        assert.equal(hasIndex(), true);
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test('the session issued after a restore carries the session claims and survives', async () => {
    const jwt = require('jsonwebtoken');
    const snapshot = await createSnapshot();
    const res = await admin('POST', `/backups/${snapshot}/restore`);
    assert.equal(res.status, 200);
    assert.equal(res.body.relogin, false);
    const claims = jwt.decode(admin.cookie.slice('token='.length));
    const row = dbm.db.prepare("SELECT password_changed_at FROM users WHERE username = 'admin'").get();
    assert.equal(claims.pv, row.password_changed_at);
    assert.equal(typeof claims.jti, 'string');
    assert.equal((await admin('GET', '/auth/me')).status, 200);
});

test('runTransaction/withTransaction reject async callbacks and roll back their writes', () => {
    const before = mangaCount();
    for (const helper of [dbm.runTransaction, dbm.withTransaction]) {
        assert.throws(() => helper(async () => {
            dbm.db.prepare("INSERT INTO mangas (title) VALUES ('async tx')").run();
        }), /asynchrone Callbacks/);
        assert.equal(dbm.db.isTransaction, false);
    }
    assert.equal(mangaCount(), before);
    assert.throws(() => dbm.runTransaction(() => {
        dbm.db.prepare("INSERT INTO mangas (title) VALUES ('rolled back')").run();
        throw new Error('boom');
    }), /boom/);
    assert.equal(mangaCount(), before);
});

test('a failed initDb leaves no half-migrated handle behind; the next access re-initialises', () => {
    const raw = new DatabaseSync(dbm.dbPath);
    try {
        raw.exec("DELETE FROM schema_migrations WHERE version = 12; CREATE TRIGGER block_migration BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
        assert.throws(() => dbm.initDb(), /blocked/);
        // a stale handle would answer here; the proxy instead re-opens and runs into the same failure
        assert.throws(() => dbm.db.prepare('SELECT 1').get(), /blocked/);
        raw.exec('DROP TRIGGER block_migration');
    } finally {
        raw.close();
    }
    assert.equal(dbm.db.prepare('SELECT 1 AS one').get().one, 1);
    assert.ok(dbm.db.prepare('SELECT 1 FROM schema_migrations WHERE version = 12').get());
});

test('a backup that passes validation but cannot be migrated is rejected with 400 and the live database stays intact', async () => {
    seedMangas(300, 'Live Reihe');
    const before = mangaCount();
    const tmp = path.join(ctx.dataDir, 'temp', 'unmigratable.db');
    const d = new DatabaseSync(tmp);
    d.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, role TEXT);
        CREATE TABLE mangas (id INTEGER PRIMARY KEY, title TEXT, description TEXT);
        CREATE TABLE volumes (id INTEGER PRIMARY KEY, manga_id INTEGER, volume_number TEXT, status TEXT);
        INSERT INTO users (username, password_hash, role) VALUES ('admin', 'x', 'admin');
        INSERT INTO mangas (title) VALUES ('Fremd 1'), ('Fremd 2');
    `);
    d.close();
    const res = await uploadZip(zipOf({ 'manga.db': fs.readFileSync(tmp) }).toBuffer());
    fs.unlinkSync(tmp);

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Migration fehlgeschlagen/);
    assert.equal(mangaCount(), before);
    assert.equal((await admin('GET', '/mangas')).status, 200);
    assert.equal((await admin('GET', '/health')).status, 200);
    assert.ok(integrityOk());
    assert.deepEqual(leftovers(), []);
    execFileSync(process.execPath, ['-e', "require('./db.js')"], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DATA_DIR: ctx.dataDir, LOG_LEVEL: 'silent' },
        stdio: 'pipe'
    });
});

test('an older-schema backup is migrated to the latest version on restore', async () => {
    const data = await snapshotDbBuffer((d) => {
        d.exec(`
            DROP TABLE volume_owners;
            ALTER TABLE volumes DROP COLUMN priority;
            ALTER TABLE volumes DROP COLUMN target_price;
            DROP INDEX IF EXISTS idx_volumes_isbn;
            DELETE FROM schema_migrations WHERE version >= 10;
        `);
    });
    const res = await uploadZip(zipOf({ 'manga.db': data }).toBuffer());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const versions = dbm.db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v;
    assert.equal(versions, require('../services/backupArchive').latestSchemaVersion());
    assert.ok(versions >= 14);
    const cols = dbm.db.prepare('PRAGMA table_info(volumes)').all().map(c => c.name);
    assert.ok(cols.includes('priority') && cols.includes('target_price'));
    assert.equal((await admin('GET', '/mangas')).status, 200);
});

test('restoring a backup with legacy Gelesen volumes converts them on the staged copy (migration v13)', async () => {
    const data = await snapshotDbBuffer((d) => {
        const mangaId = d.prepare("INSERT INTO mangas (title, owned_volumes) VALUES ('Restore Gelesen', 0)").run().lastInsertRowid;
        d.prepare("INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, '1', 'Gelesen')").run(mangaId);
        d.exec('DELETE FROM schema_migrations WHERE version = 13');
    });
    const res = await uploadZip(zipOf({ 'manga.db': data }).toBuffer());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { db } = dbm;
    const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    const vol = db.prepare("SELECT v.id, v.status, m.owned_volumes FROM volumes v JOIN mangas m ON m.id = v.manga_id WHERE m.title = 'Restore Gelesen'").get();
    assert.equal(vol.status, 'Vorhanden');
    assert.equal(vol.owned_volumes, 1);
    assert.deepEqual(db.prepare('SELECT user_id FROM volume_owners WHERE volume_id = ?').all(vol.id).map(r => r.user_id), [adminId]);
    assert.deepEqual(db.prepare('SELECT user_id FROM volume_reads WHERE volume_id = ?').all(vol.id).map(r => r.user_id), [adminId]);
    assert.equal(db.prepare("SELECT count(*) AS c FROM volumes WHERE status = 'Gelesen'").get().c, 0);
});

test('a failure after the swap rolls back to the previous database and removes the safety copy', async () => {
    const snapshot = await createSnapshot();
    seedMangas(5, 'Nach dem Snapshot');
    const before = mangaCount();
    const auth = require('../middleware/auth');
    const original = auth.persistJwtSecret;
    auth.persistJwtSecret = () => { throw new Error('persist failed'); };
    let res;
    try {
        res = await admin('POST', `/backups/${snapshot}/restore`);
    } finally {
        auth.persistJwtSecret = original;
    }
    assert.equal(res.status, 500);
    assert.doesNotMatch(res.body.error, /persist failed/, 'no raw error text for a server error');
    assert.equal(mangaCount(), before);
    assert.ok(integrityOk());
    assert.deepEqual(leftovers(), []);
    assert.equal((await admin('GET', '/mangas')).status, 200);
});

test('if the rollback itself fails, manga.db.bak is kept for manual recovery', async () => {
    const snapshot = await createSnapshot();
    seedMangas(3, 'Rollback kaputt');
    const before = mangaCount();
    const bak = path.join(ctx.dataDir, 'manga.db.bak');
    const auth = require('../middleware/auth');
    const originalPersist = auth.persistJwtSecret;
    const originalCopy = fs.copyFileSync;
    auth.persistJwtSecret = () => { throw new Error('persist failed'); };
    fs.copyFileSync = (src, ...rest) => {
        if (src === bak) throw new Error('copy back failed');
        return originalCopy(src, ...rest);
    };
    let res;
    try {
        res = await admin('POST', `/backups/${snapshot}/restore`);
    } finally {
        auth.persistJwtSecret = originalPersist;
        fs.copyFileSync = originalCopy;
    }
    assert.equal(res.status, 500);
    assert.ok(fs.existsSync(bak), 'the safety copy survives a failed rollback');

    const blocked = await admin('POST', `/backups/${snapshot}/restore`);
    assert.equal(blocked.status, 503);
    assert.match(blocked.body.error, /manga\.db\.bak/);
    const upload = await uploadZip(zipOf({ 'manga.db': fs.readFileSync(bak) }).toBuffer());
    assert.equal(upload.status, 503);
    assert.ok(fs.existsSync(bak), 'no further restore may overwrite the safety copy');

    // manual recovery as an operator would do it
    dbm.closeDb();
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dbm.dbPath + suffix, { force: true });
    fs.copyFileSync(bak, dbm.dbPath);
    fs.unlinkSync(bak);
    dbm.initDb();
    assert.equal(mangaCount(), before);
    assert.equal((await admin('POST', `/backups/${snapshot}/restore`)).status, 200, 'restores work again once the copy is dealt with');
});

test('initDb refuses to create an empty database while manga.db.bak waits for recovery', () => {
    const before = mangaCount();
    const bak = dbm.dbPath + '.bak';
    dbm.closeDb();
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dbm.dbPath + suffix, { force: true });
    fs.renameSync(dbm.dbPath, bak);
    try {
        fs.writeFileSync(dbm.dbPath, '');
        assert.throws(() => dbm.initDb(), /manga\.db\.bak/);
        assert.equal(fs.statSync(dbm.dbPath).size, 0, 'no schema written into the empty file');
        fs.unlinkSync(dbm.dbPath);
        assert.throws(() => dbm.db.prepare('SELECT 1').get(), { code: 'DB_ROLLBACK_COPY_PENDING' });
        assert.ok(!fs.existsSync(dbm.dbPath), 'no fresh database is created');
    } finally {
        fs.rmSync(dbm.dbPath, { force: true });
        fs.renameSync(bak, dbm.dbPath);
        dbm.initDb();
    }
    assert.equal(mangaCount(), before);
});

test('a failing safety copy leaves no staged files behind and keeps the live database usable', async (t) => {
    const snapshot = await createSnapshot();
    const before = mangaCount();
    const copy = fs.copyFileSync;
    t.mock.method(fs, 'copyFileSync', (src, dest, ...rest) => {
        if (String(dest).endsWith('manga.db.bak.tmp')) throw Object.assign(new Error('EIO: copy failed'), { code: 'EIO' });
        return copy(src, dest, ...rest);
    });
    const res = await admin('POST', `/backups/${snapshot}/restore`);
    assert.equal(res.status, 500);
    assert.deepEqual(dataFiles().filter(f => f.includes('restore-tmp') || f.startsWith('manga.db.bak')), []);
    const list = await admin('GET', '/mangas');
    assert.equal(list.status, 200);
    assert.equal(mangaCount(), before);
    t.mock.restoreAll();
    assert.equal((await admin('POST', `/backups/${snapshot}/restore`)).status, 200);
});

test('restore limits are enforced on the inflated size, not on what the archive claims', async () => {
    const before = mangaCount();
    process.env.RESTORE_MAX_DB_BYTES = String(1024 * 1024);
    try {
        const bomb = await uploadZip(zipOf({ 'manga.db': Buffer.alloc(2 * 1024 * 1024) }).toBuffer());
        assert.equal(bomb.status, 400);
        assert.match(bomb.body.error, /zu groß/);
    } finally {
        delete process.env.RESTORE_MAX_DB_BYTES;
    }

    // central directory claims 1000 bytes, the entry inflates to 64 KB
    const buf = zipOf({ 'manga.db': Buffer.alloc(64 * 1024) }).toBuffer();
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(1000, cd + 24);
    const lying = await uploadZip(buf);
    assert.equal(lying.status, 400);
    assert.match(lying.body.error, /größer als im Archiv angegeben/);

    const db = await snapshotDbBuffer();
    process.env.RESTORE_MAX_UPLOADS_BYTES = String(10 * 1024);
    try {
        const big = await uploadZip(zipOf({ 'manga.db': db, 'uploads/huge.png': Buffer.alloc(64 * 1024) }).toBuffer());
        assert.equal(big.status, 400);
        assert.match(big.body.error, /zu groß/);
    } finally {
        delete process.env.RESTORE_MAX_UPLOADS_BYTES;
    }

    process.env.RESTORE_MAX_ENTRIES = '2';
    try {
        const many = await uploadZip(zipOf({ 'manga.db': db, 'uploads/a.png': 'a', 'uploads/b.png': 'b' }).toBuffer());
        assert.equal(many.status, 400);
        assert.match(many.body.error, /zu viele Dateien/);
    } finally {
        delete process.env.RESTORE_MAX_ENTRIES;
    }

    assert.equal(mangaCount(), before);
    assert.deepEqual(leftovers(), []);
    assert.deepEqual(fs.readdirSync(path.join(ctx.dataDir, 'temp')).filter(f => f.startsWith('restore-uploads-')), []);
    assert.ok(!fs.existsSync(path.join(dbm.uploadsDir, 'huge.png')));
});

/** A stored (uncompressed) ZIP written by hand, so entry counts and EOCD fields are exactly as given. */
function storedZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, data] of files) {
        const nameBuf = Buffer.from(name);
        const crc = zlib.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, data);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

test('a backup with exactly 65535 entries (count 0xffff without ZIP64) restores', async () => {
    const files = [['manga.db', await snapshotDbBuffer()], ['uploads/count.png', Buffer.from('png')]];
    for (let i = files.length; i < 0xffff; i++) files.push([`x/${i}`, Buffer.alloc(0)]);
    const buf = storedZip(files);
    assert.equal(buf.readUInt16LE(buf.length - 22 + 10), 0xffff);
    const res = await uploadZip(buf);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.restoredImagesCount, 1);
    assert.equal(fs.readFileSync(path.join(dbm.uploadsDir, 'count.png'), 'utf8'), 'png');
});

test('a snapshot deleted while it is extracted still restores (entries are read through the open handle)', async (t) => {
    const cover = path.join(dbm.uploadsDir, 'cover-pruned.jpg');
    fs.writeFileSync(cover, 'jpeg bytes');
    const snapshot = await createSnapshot();
    fs.unlinkSync(cover);
    const file = path.join(ctx.dataDir, 'backups', snapshot);
    const open = fs.promises.open;
    t.mock.method(fs.promises, 'open', async (...args) => {
        const fh = await open.apply(fs.promises, args);
        if (args[0] === file) fs.unlinkSync(file);
        return fh;
    });
    const res = await admin('POST', `/backups/${snapshot}/restore`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(!fs.existsSync(file));
    assert.equal(fs.readFileSync(cover, 'utf8'), 'jpeg bytes');
});

test('retention pruning during a restore keeps the snapshot being restored', async (t) => {
    const scheduler = require('../services/scheduler');
    const older = await createSnapshot();
    const newer = await createSnapshot();
    const file = path.join(ctx.dataDir, 'backups', older);
    const open = fs.promises.open;
    const routes = require('../routes/backups');
    let runningDuringRestore = null;
    t.mock.method(fs.promises, 'open', async (...args) => {
        if (args[0] === file) {
            runningDuringRestore = routes.isRestoreRunning();
            scheduler.pruneBackups('manual', 1);
        }
        return open.apply(fs.promises, args);
    });
    const res = await admin('POST', `/backups/${older}/restore`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(runningDuringRestore, true);
    assert.equal(routes.isRestoreRunning(), false);
    assert.ok(fs.existsSync(file), 'the restored snapshot was not pruned');
    t.mock.restoreAll();
    scheduler.pruneBackups('manual', 1);
    assert.ok(!fs.existsSync(file), 'released after the restore');
    assert.ok(fs.existsSync(path.join(ctx.dataDir, 'backups', newer)));
});

test('restore only brings back flat image files from the backup\'s own uploads/ folder', async () => {
    const db = await snapshotDbBuffer();
    const zip = zipOf({
        'manga-shelf-backup/manga.db': db,
        'manga-shelf-backup/uploads/ok.png': 'png',
        '__MACOSX/manga-shelf-backup/uploads/._ok.png': 'appledouble',
        '__MACOSX/manga-shelf-backup/._manga.db': 'appledouble',
        'manga-shelf-backup/uploads/.DS_Store': 'junk',
        'manga-shelf-backup/uploads/.hidden.png': 'hidden',
        'manga-shelf-backup/uploads/evil.html': '<script src="evil.js"></script>',
        'manga-shelf-backup/uploads/evil.js': 'alert(1)',
        'manga-shelf-backup/uploads/sub/x.png': 'nested',
        'myuploads/uploads/b.png': 'elsewhere',
        'manga-shelf-backup/uploads/traversal.png': 'escape'
    });
    zip.getEntry('manga-shelf-backup/uploads/traversal.png').entryName = 'manga-shelf-backup/uploads/../../escape.png';

    const res = await uploadZip(zip.toBuffer(), '/restore');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.restoredImagesCount, 1);
    const uploads = fs.readdirSync(dbm.uploadsDir);
    assert.ok(uploads.includes('ok.png'));
    for (const name of ['._ok.png', '.DS_Store', '.hidden.png', 'evil.html', 'evil.js', 'sub', 'b.png', 'uploads']) {
        assert.ok(!uploads.includes(name), `${name} must not be restored`);
    }
    assert.ok(!fs.existsSync(path.join(ctx.dataDir, 'escape.png')));
    assert.ok(!fs.existsSync(path.join(ctx.dataDir, '..', 'escape.png')));
});

test('a snapshot round-trip restores the covers it contains', async () => {
    const cover = path.join(dbm.uploadsDir, 'cover-roundtrip.jpg');
    fs.writeFileSync(cover, 'jpeg bytes');
    const snapshot = await createSnapshot();
    fs.unlinkSync(cover);
    const res = await admin('POST', `/backups/${snapshot}/restore`);
    assert.equal(res.status, 200);
    assert.ok(res.body.restoredImagesCount >= 1);
    assert.equal(fs.readFileSync(cover, 'utf8'), 'jpeg bytes');
});

test('a request running in parallel to a restore is answered normally', async () => {
    const snapshot = await createSnapshot();
    const [restore, list] = await Promise.all([
        admin('POST', `/backups/${snapshot}/restore`),
        admin('GET', '/backups')
    ]);
    assert.equal(restore.status, 200);
    assert.equal(list.status, 200);

    const results = await Promise.all([
        admin('POST', `/backups/${snapshot}/restore`),
        admin('POST', `/backups/${snapshot}/restore`)
    ]);
    const statuses = results.map(r => r.status).sort();
    assert.ok(statuses[0] === 200 && [200, 409].includes(statuses[1]), statuses.join(','));
    assert.equal((await admin('GET', '/mangas')).status, 200);
});

test('snapshot list is ordered by the time in the file name, falling back to mtime', async () => {
    const dir = path.join(ctx.dataDir, 'backups');
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    const content = zipOf({ 'readme.txt': 'x' }).toBuffer();
    const files = {
        'manual-2026-01-02T00-00-00-000Z.zip': new Date('2020-01-01T00:00:00Z'),
        'daily-auto-2026-01-01T12-30-45-123Z.zip': new Date('2030-01-01T00:00:00Z'),
        'handmade.zip': new Date('2025-06-01T00:00:00Z')
    };
    for (const [name, mtime] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
        fs.utimesSync(path.join(dir, name), mtime, mtime);
    }
    const res = await admin('GET', '/backups');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.backups.map(b => [b.filename, b.created_at]), [
        ['manual-2026-01-02T00-00-00-000Z.zip', '2026-01-02T00:00:00.000Z'],
        ['daily-auto-2026-01-01T12-30-45-123Z.zip', '2026-01-01T12:30:45.123Z'],
        ['handmade.zip', '2025-06-01T00:00:00.000Z']
    ]);
});

test('snapshot download, delete and the direct backup stream', async () => {
    const name = await createSnapshot();

    const dl = await fetch(`${ctx.base}/backups/${name}/download`, { headers: { Cookie: admin.cookie } });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-type'), /zip/);
    assert.match(dl.headers.get('content-disposition'), new RegExp(name));
    await dl.arrayBuffer();
    assert.equal((await admin('GET', '/backups/nope.zip/download')).status, 404);
    assert.equal((await admin('GET', '/backups/..%2F..%2Fmanga.db/download')).status, 404);

    const stream = await fetch(`${ctx.base}/backup`, { headers: { Cookie: admin.cookie } });
    assert.equal(stream.status, 200);
    const zip = new AdmZip(Buffer.from(await stream.arrayBuffer()));
    assert.ok(zip.getEntry('manga.db'));
    for (let i = 0; i < 20 && fs.readdirSync(dbm.tempDir).some(f => f.startsWith('backup-db-')); i++) {
        await new Promise(r => setTimeout(r, 25));
    }
    assert.deepEqual(fs.readdirSync(dbm.tempDir).filter(f => f.startsWith('backup-db-')), []);

    assert.equal((await admin('DELETE', '/backups/nope.zip')).status, 404);
    assert.equal((await admin('DELETE', '/backups/..%2F..%2Fmanga.db')).status, 404);
    assert.ok(fs.existsSync(dbm.dbPath));
    assert.equal((await admin('DELETE', `/backups/${name}`)).status, 200);
    assert.ok(!fs.existsSync(path.join(ctx.dataDir, 'backups', name)));
    assert.ok(!(await admin('GET', '/backups')).body.backups.some(b => b.filename === name));
});

const backupsPath = (name) => path.join(ctx.dataDir, 'backups', name);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stagedFiles = () => fs.readdirSync(dbm.tempDir).filter(f => f.startsWith('restore-staged-') || f.startsWith('inspect-'));

test('snapshots carry manifest.json and a verified sidecar; images are stored, the database deflated', async () => {
    const cover = path.join(dbm.uploadsDir, 'manifest-cover.jpg');
    fs.writeFileSync(cover, Buffer.alloc(4096, 7));
    try {
        const res = await admin('POST', '/backups/create');
        assert.equal(res.status, 200);
        const { snapshot } = res.body;
        assert.equal(snapshot.verified, true);
        assert.equal(snapshot.category, 'manual');
        assert.equal(res.body.warning, undefined);

        const zip = new AdmZip(backupsPath(snapshot.filename));
        const manifest = JSON.parse(zip.readAsText('manifest.json'));
        assert.equal(manifest.app_version, require('../package.json').version);
        assert.equal(manifest.schema_version, require('../services/backupArchive').latestSchemaVersion());
        assert.equal(manifest.counts.mangas, mangaCount());
        assert.equal(manifest.counts.users, dbm.db.prepare('SELECT count(*) AS c FROM users').get().c);
        assert.equal(manifest.db.sha256, sha256(zip.getEntry('manga.db').getData()));
        assert.ok(manifest.uploads.count >= 1 && manifest.uploads.bytes >= 4096);
        assert.equal(zip.getEntry('uploads/manifest-cover.jpg').header.method, 0, 'images are stored');
        assert.equal(zip.getEntry('manga.db').header.method, 8, 'the database is deflated');

        const sidecar = JSON.parse(fs.readFileSync(backupsPath(snapshot.filename.replace(/\.zip$/, '.json')), 'utf8'));
        assert.equal(sidecar.verified, true);
        assert.deepEqual(sidecar.manifest, manifest);

        const listed = (await admin('GET', '/backups')).body.backups.find(b => b.filename === snapshot.filename);
        assert.equal(listed.verified, true);
        assert.equal(listed.verify_error, null);
        assert.equal(listed.category, 'manual');
        assert.equal(listed.manifest.db.sha256, manifest.db.sha256);

        const stream = await fetch(`${ctx.base}/backup`, { headers: { Cookie: admin.cookie } });
        const download = new AdmZip(Buffer.from(await stream.arrayBuffer()));
        const downloadManifest = JSON.parse(download.readAsText('manifest.json'));
        assert.equal(downloadManifest.category, 'download');
        assert.equal(downloadManifest.db.sha256, sha256(download.getEntry('manga.db').getData()));
        assert.equal(download.getEntry('uploads/manifest-cover.jpg').header.method, 0);
    } finally {
        fs.rmSync(cover, { force: true });
    }
});

test('a snapshot that fails its restore test is kept, marked and reported', async (t) => {
    const archive = require('../services/backupArchive');
    t.mock.method(archive, 'verifyArchive', async () => ({ verified: false, error: 'quick_check: kaputt', verified_at: new Date().toISOString() }));
    const res = await admin('POST', '/backups/create');
    assert.equal(res.status, 200);
    assert.equal(res.body.snapshot.verified, false);
    assert.match(res.body.warning, /Prüfung nicht bestanden: quick_check: kaputt/);
    const listed = (await admin('GET', '/backups')).body.backups.find(b => b.filename === res.body.snapshot.filename);
    assert.equal(listed.verified, false);
    assert.equal(listed.verify_error, 'quick_check: kaputt');
});

test('verifyArchive detects a database that does not match its manifest, and a missing manifest', async () => {
    const { verifyArchive } = require('../services/backupArchive');
    const name = await createSnapshot();
    const zip = new AdmZip(backupsPath(name));
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    assert.equal((await verifyArchive(backupsPath(name), manifest)).verified, true);

    const tmpDb = path.join(dbm.tempDir, 'tampered.db');
    fs.writeFileSync(tmpDb, zip.getEntry('manga.db').getData());
    const d = new DatabaseSync(tmpDb);
    d.exec("INSERT INTO mangas (title) VALUES ('untergeschoben')");
    d.close();
    zip.updateFile('manga.db', fs.readFileSync(tmpDb));
    fs.unlinkSync(tmpDb);
    const tampered = path.join(dbm.tempDir, 'tampered.zip');
    zip.writeZip(tampered);
    const bad = await verifyArchive(tampered, manifest);
    assert.equal(bad.verified, false);
    assert.match(bad.error, /Prüfsumme/);

    zip.deleteFile('manifest.json');
    zip.writeZip(tampered);
    assert.match((await verifyArchive(tampered, manifest)).error, /manifest\.json/);
    fs.unlinkSync(tampered);
    assert.deepEqual(fs.readdirSync(dbm.tempDir).filter(f => f.startsWith('verify-')), []);
});

test('every restore takes a DB-only pre-restore snapshot that undoes it', async () => {
    const snapshot = await createSnapshot();
    seedMangas(4, 'Nach dem Snapshot (Undo)');
    const before = mangaCount();
    const res = await admin('POST', `/backups/${snapshot}/restore`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const pre = res.body.preRestoreSnapshot;
    assert.match(pre, /^vor-wiederherstellung-\d{4}-.*Z\.zip$/);
    assert.equal(mangaCount(), before - 4);

    const names = new AdmZip(backupsPath(pre)).getEntries().map(e => e.entryName).sort();
    assert.deepEqual(names, ['manga.db', 'manifest.json'], 'DB only, uploads are never deleted by a restore');
    const listed = (await admin('GET', '/backups')).body.backups.find(b => b.filename === pre);
    assert.equal(listed.category, 'pre-restore');
    assert.equal(listed.verified, true);
    assert.equal(listed.manifest.counts.mangas, before);

    const undo = await admin('POST', `/backups/${pre}/restore`);
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal(mangaCount(), before);
    assert.match(undo.body.preRestoreSnapshot, /^vor-wiederherstellung-/);
});

test('a restore whose safety snapshot fails is aborted before the live database is touched', async (t) => {
    const snapshot = await createSnapshot();
    seedMangas(2, 'Bleibt trotz Abbruch');
    const before = mangaCount();
    const archive = require('../services/backupArchive');
    t.mock.method(archive, 'verifyArchive', async () => ({ verified: false, error: 'kaputt', verified_at: new Date().toISOString() }));
    const res = await admin('POST', `/backups/${snapshot}/restore`);
    assert.equal(res.status, 500);
    assert.match(res.body.error, /Details im Server-Log/);
    assert.equal(mangaCount(), before);
    assert.deepEqual(leftovers(), []);
});

test('a leftover manga.db.bak blocks every restore, also after a restart (state read from disk)', async () => {
    const snapshot = await createSnapshot();
    const bak = path.join(ctx.dataDir, 'manga.db.bak');
    fs.writeFileSync(bak, 'only good copy');
    try {
        const res = await admin('POST', `/backups/${snapshot}/restore`);
        assert.equal(res.status, 503);
        assert.equal(res.body.code, 'ROLLBACK_COPY_PENDING');
        assert.match(res.body.error, /manga\.db\.bak/);
        assert.match(res.body.error, /rollback-aufraeumen/);
        assert.match(res.body.error, /Eine frühere .*Von Hand: Server stoppen.*node scripts/, 'the manual procedure comes first');
        assert.match(res.body.error, /node scripts\/admin\.js rollback-aufraeumen/);
        assert.equal((await uploadZip(zipOf({ 'manga.db': await snapshotDbBuffer() }).toBuffer())).status, 503);
        assert.equal((await admin('POST', '/backup/inspect', { filename: snapshot })).status, 503);
        assert.equal(fs.readFileSync(bak, 'utf8'), 'only good copy', 'the copy is never overwritten');
    } finally {
        fs.rmSync(bak, { force: true });
    }
    assert.equal((await admin('POST', `/backups/${snapshot}/restore`)).status, 200);
});

test('a backup from a newer schema is refused unless explicitly allowed', async () => {
    const data = await snapshotDbBuffer((d) => d.exec("INSERT INTO schema_migrations (version, name) VALUES (999, 'future')"));
    const current = require('../services/backupArchive').latestSchemaVersion();
    seedMangas(1, 'Vor neuerem Schema');
    const before = mangaCount();
    try {
        const refused = await uploadZip(zipOf({ 'manga.db': data }).toBuffer());
        assert.equal(refused.status, 400);
        assert.equal(refused.body.code, 'SCHEMA_NEWER');
        assert.match(refused.body.error, new RegExp(`neueren Version \\(Schema v999 > v${current}\\) – erst Manga Shelf aktualisieren`));
        assert.equal(mangaCount(), before);
        assert.deepEqual(leftovers(), []);

        const inspected = await uploadZip(zipOf({ 'manga.db': data }).toBuffer(), '/backup/inspect');
        assert.equal(inspected.status, 200);
        assert.equal(inspected.body.schema_newer, true);
        assert.ok(inspected.body.warnings.some(w => /neueren Version/.test(w)));
        const step2 = await admin('POST', `/backup/restore/${inspected.body.staging_id}`);
        assert.equal(step2.status, 400);
        assert.equal(step2.body.code, 'SCHEMA_NEWER');
        const forced = await admin('POST', `/backup/restore/${inspected.body.staging_id}`, { allow_newer_schema: true });
        assert.equal(forced.status, 200, JSON.stringify(forced.body));

        const viaForm = await uploadZip(zipOf({ 'manga.db': data }).toBuffer(), '/backup/restore', { allow_newer_schema: 'true' });
        assert.equal(viaForm.status, 200, JSON.stringify(viaForm.body));
    } finally {
        dbm.db.prepare('DELETE FROM schema_migrations WHERE version = 999').run();
    }
});

test('inspect stages an uploaded backup, reports its content and restores it in a second step', async () => {
    seedMangas(2, 'Inspect Live');
    const data = await snapshotDbBuffer((d) => d.exec("INSERT INTO mangas (title) VALUES ('Nur im Backup')"));
    const expected = mangaCount() + 1;
    const live = mangaCount();
    const manifest = { created_at: '2026-01-02T03:04:05.000Z', app_version: '9.9.9' };
    const zip = zipOf({ 'manga.db': data, 'uploads/inspect.png': 'png', 'manifest.json': JSON.stringify(manifest) });

    const res = await uploadZip(zip.toBuffer(), '/backup/inspect');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const b = res.body;
    assert.match(b.staging_id, /^[0-9a-f-]{36}$/);
    assert.ok(Date.parse(b.expires_at) - Date.now() > 14 * 60 * 1000);
    assert.equal(b.source.type, 'upload');
    assert.equal(b.counts.mangas, expected);
    assert.equal(b.counts.uploads, 1);
    assert.equal(b.current_counts.mangas, live);
    assert.equal(b.created_at, manifest.created_at);
    assert.equal(b.created_at_source, 'manifest');
    assert.equal(b.app_version, '9.9.9');
    assert.equal(b.schema_newer, false);
    assert.equal(b.schema_version, b.current_schema_version);
    assert.deepEqual(b.current_user, { username: 'admin', exists: true, role: 'admin' });
    assert.equal(b.relogin, false);
    assert.deepEqual(b.accounts_without_password, []);
    assert.ok(b.warnings.some(w => /Sitzungen/.test(w)));
    assert.ok(!b.warnings.some(w => /Passwort-Reset/.test(w)));
    assert.equal(mangaCount(), live, 'inspect never touches the live database');
    assert.deepEqual(stagedFiles(), [`restore-staged-${b.staging_id}.zip`]);

    const done = await admin('POST', `/backup/restore/${b.staging_id}`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.mangaCount, expected);
    assert.equal(done.body.restoredImagesCount, 1);
    assert.match(done.body.preRestoreSnapshot, /^vor-wiederherstellung-/);
    assert.equal(mangaCount(), expected);
    assert.deepEqual(stagedFiles(), []);
    const again = await admin('POST', `/backup/restore/${b.staging_id}`);
    assert.equal(again.status, 404);
    assert.equal(again.body.code, 'STAGING_NOT_FOUND');
});

test('inspect names the accounts without a password (app backup after a pull) in a field and a warning', async () => {
    const data = await snapshotDbBuffer((d) => {
        const add = d.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'editor')");
        add.run('kim', '!local-profile');
        add.run('Anna', '!local-profile');
        add.run('leer', '');
        add.run('mit-passwort', '$2b$10$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0');
    });
    const one = await snapshotDbBuffer((d) => d.prepare("INSERT INTO users (username, password_hash, role) VALUES ('solo', '!local-profile', 'visitor')").run());
    const res = await uploadZip(zipOf({ 'manga.db': data }).toBuffer(), '/backup/inspect');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.accounts_without_password, ['Anna', 'kim', 'leer']);
    assert.ok(res.body.warnings.includes('3 Konten brauchen nach der Wiederherstellung einen Passwort-Reset (kein Passwort in der Sicherung): Anna, kim, leer.'),
        JSON.stringify(res.body.warnings));
    assert.equal((await admin('DELETE', `/backup/restore/${res.body.staging_id}`)).status, 200);

    const single = await uploadZip(zipOf({ 'manga.db': one }).toBuffer(), '/backup/inspect');
    assert.ok(single.body.warnings.includes('1 Konto braucht nach der Wiederherstellung einen Passwort-Reset (kein Passwort in der Sicherung): solo.'));
    assert.equal((await admin('DELETE', `/backup/restore/${single.body.staging_id}`)).status, 200);
});

test('inspect of a server snapshot, of a backup without the current user, cancel and invalid input', async () => {
    const snapshot = await createSnapshot();
    const res = await admin('POST', '/backup/inspect', { filename: snapshot });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.source.type, 'snapshot');
    assert.equal(res.body.source.filename, snapshot);
    assert.equal(res.body.has_manifest, true);
    assert.equal(res.body.created_at_source, 'manifest');
    assert.equal(res.body.app_version, require('../package.json').version);
    assert.equal((await admin('DELETE', `/backup/restore/${res.body.staging_id}`)).status, 200);
    assert.equal((await admin('POST', `/backup/restore/${res.body.staging_id}`)).status, 404);

    const noUser = await snapshotDbBuffer((d) => d.exec("UPDATE users SET username = 'jemand' WHERE username = 'admin'"));
    const other = await uploadZip(zipOf({ 'manga.db': noUser }).toBuffer(), '/backup/inspect');
    assert.equal(other.status, 200);
    assert.equal(other.body.current_user.exists, false);
    assert.equal(other.body.relogin, true);
    assert.equal(other.body.has_manifest, false);
    assert.equal(other.body.created_at, null);
    assert.ok(other.body.warnings.some(w => /nicht vorhanden: Du wirst danach abgemeldet/.test(w)));
    assert.equal((await admin('DELETE', `/backup/restore/${other.body.staging_id}`)).status, 200);

    assert.equal((await admin('POST', '/backup/inspect', { filename: 'nope.zip' })).status, 404);
    assert.equal((await admin('POST', '/backup/inspect', { filename: '../manga.db' })).status, 404);
    assert.equal((await admin('POST', '/backup/inspect', {})).status, 400);
    const broken = await uploadZip(Buffer.from('not a zip at all, definitely not'), '/backup/inspect');
    assert.equal(broken.status, 400);
    assert.match(broken.body.error, /Ungültiges ZIP-Archiv/);
    assert.deepEqual(stagedFiles(), []);
});

test('at most three backups stay staged; the oldest is dropped first', async () => {
    const snapshot = await createSnapshot();
    const ids = [];
    for (let i = 0; i < 4; i++) {
        const res = await admin('POST', '/backup/inspect', { filename: snapshot });
        assert.equal(res.status, 200);
        ids.push(res.body.staging_id);
    }
    assert.equal((await admin('DELETE', `/backup/restore/${ids[0]}`)).status, 404);
    for (const id of ids.slice(1)) assert.equal((await admin('DELETE', `/backup/restore/${id}`)).status, 200);
    const scheduler = require('../services/scheduler');
    assert.equal(scheduler.isSnapshotHeld(snapshot), false, 'dropping a staging releases the snapshot');
});

test('an inspect whose client went away stages nothing and releases the snapshot', async (t) => {
    const http = require('http');
    const scheduler = require('../services/scheduler');
    const snapshot = await createSnapshot();
    const parse = scheduler.parseSnapshotName;
    // holds the request inside the handler long enough for the abort to arrive before the inspect finishes
    t.mock.method(scheduler, 'parseSnapshotName', (name) => {
        const until = Date.now() + 200;
        while (Date.now() < until) { /* busy */ }
        return parse(name);
    });
    const body = JSON.stringify({ filename: snapshot });
    await new Promise((resolve) => {
        const req = http.request(ctx.base + '/backup/inspect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: admin.cookie }
        });
        req.on('error', () => resolve());
        req.end(body, () => setTimeout(() => { req.destroy(); resolve(); }, 50));
    });
    for (let i = 0; i < 100 && scheduler.isSnapshotHeld(snapshot); i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(scheduler.isSnapshotHeld(snapshot), false, 'no staging keeps the snapshot');
    assert.deepEqual(stagedFiles(), []);
    t.mock.restoreAll();
    const res = await admin('POST', '/backup/inspect', { filename: snapshot });
    assert.equal(res.status, 200, 'a later inspect still works');
    assert.equal((await admin('DELETE', `/backup/restore/${res.body.staging_id}`)).status, 200);
});

test('too little free space answers 507 before a snapshot, an upload or a restore starts', async (t) => {
    const snapshot = await createSnapshot();
    const before = mangaCount();
    const files = fs.readdirSync(path.join(ctx.dataDir, 'backups')).sort();
    const disk = require('../utils/disk');
    t.mock.method(disk, 'freeBytes', () => 1024);

    const create = await admin('POST', '/backups/create');
    assert.equal(create.status, 507);
    assert.equal(create.body.code, 'INSUFFICIENT_SPACE');
    assert.match(create.body.error, /Nicht genug Speicherplatz auf dem Server für den Snapshot \(frei: 0\.0 MB, benötigt: /);
    assert.deepEqual(fs.readdirSync(path.join(ctx.dataDir, 'backups')).sort(), files);
    assert.deepEqual(fs.readdirSync(dbm.tempDir).filter(f => f.startsWith('backup-db-')), []);

    const restore = await admin('POST', `/backups/${snapshot}/restore`);
    assert.equal(restore.status, 507);
    assert.match(restore.body.error, /Speicherplatz/);
    assert.equal(mangaCount(), before);
    assert.deepEqual(leftovers(), []);

    const body = zipOf({ 'manga.db': Buffer.alloc(64 * 1024) }).toBuffer();
    assert.equal((await uploadZip(body)).status, 507);
    assert.equal((await uploadZip(body, '/backup/inspect')).status, 507);
    assert.deepEqual(fs.readdirSync(dbm.tempDir).filter(f => /^restore-/.test(f)), []);
});

/** Writes a stored ZIP with manga.db and one big zero-filled cover straight to disk, never holding it in memory. */
function writeBigZip(file, dbData, coverBytes) {
    const fd = fs.openSync(file, 'w');
    const chunk = Buffer.alloc(1024 * 1024);
    let offset = 0;
    const centrals = [];
    const write = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };
    const addEntry = (name, size, crc, writeData) => {
        const nameBuf = Buffer.from(name);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(size, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(size, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        write(local);
        write(nameBuf);
        writeData();
    };
    try {
        addEntry('manga.db', dbData.length, zlib.crc32(dbData), () => write(dbData));
        let crc = 0;
        for (let left = coverBytes; left > 0; left -= chunk.length) crc = zlib.crc32(chunk.subarray(0, Math.min(chunk.length, left)), crc);
        addEntry('uploads/big-cover.jpg', coverBytes, crc, () => {
            for (let left = coverBytes; left > 0; left -= chunk.length) write(chunk.subarray(0, Math.min(chunk.length, left)));
        });
        const cdOffset = offset;
        const cd = Buffer.concat(centrals);
        write(cd);
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(2, 8);
        eocd.writeUInt16LE(2, 10);
        eocd.writeUInt32LE(cd.length, 12);
        eocd.writeUInt32LE(cdOffset, 16);
        write(eocd);
    } finally {
        fs.closeSync(fd);
    }
}

const BIG_ARCHIVE_MB = Number(process.env.BIG_ARCHIVE_MB) || 500;
const bigArchiveSkip = (() => {
    if (process.env.CI && !process.env.BIG_ARCHIVE_MB) return 'slow on CI (set BIG_ARCHIVE_MB to run it)';
    const free = require('../utils/disk').freeBytes(os.tmpdir());
    return free !== null && free < 3 * BIG_ARCHIVE_MB * 1024 * 1024 ? 'not enough free disk space' : false;
})();

test(`a ${BIG_ARCHIVE_MB} MB archive restores with bounded memory (streaming extraction)`, { skip: bigArchiveSkip, timeout: 300000 }, async (t) => {
    const name = 'handmade-big.zip';
    const file = backupsPath(name);
    const cover = path.join(dbm.uploadsDir, 'big-cover.jpg');
    try {
        writeBigZip(file, await snapshotDbBuffer(), BIG_ARCHIVE_MB * 1024 * 1024);
        if (global.gc) global.gc();
        const baseline = process.memoryUsage().rss;
        let peak = baseline;
        const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
        let res;
        try {
            res = await admin('POST', `/backups/${name}/restore`);
        } finally {
            clearInterval(sampler);
        }
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.restoredImagesCount, 1);
        assert.equal(fs.statSync(cover).size, BIG_ARCHIVE_MB * 1024 * 1024);
        const growthMb = Math.round((peak - baseline) / 1024 / 1024);
        t.diagnostic(`peak RSS growth while restoring ${BIG_ARCHIVE_MB} MB: ${growthMb} MB`);
        // reading the archive into memory (adm-zip) costs at least its full size; streaming stays far below
        const limitMb = Math.max(100, Math.round(BIG_ARCHIVE_MB * 0.4));
        assert.ok(growthMb < limitMb, `RSS grew by ${growthMb} MB (limit ${limitMb} MB)`);
    } finally {
        fs.rmSync(file, { force: true });
        fs.rmSync(cover, { force: true });
    }
});

test('undoing a restore after the nightly orphan cleanup still finds the covers of the undone collection', async () => {
    const emptyish = await createSnapshot();
    const cover = path.join(dbm.uploadsDir, 'undo-orig-cover.png');
    fs.writeFileSync(cover, 'png');
    const created = await admin('POST', '/mangas', { title: 'Undo Original', cover_image: '/uploads/undo-orig-cover.png' });
    assert.equal(created.status, 200);
    const res = await admin('POST', `/backups/${emptyish}/restore`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const pre = res.body.preRestoreSnapshot;

    const result = require('../services/uploadCleanup').cleanOrphanUploads({ minAgeMs: 0 });
    assert.ok(!result.files.includes('undo-orig-cover.png'), 'the retained pre-restore snapshot still references it');
    assert.ok(fs.existsSync(cover));

    const undo = await admin('POST', `/backups/${pre}/restore`);
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    const list = (await admin('GET', '/mangas')).body;
    assert.ok(list.some(m => m.title === 'Undo Original' && m.cover_image === '/uploads/undo-orig-cover.png'));
    assert.ok(fs.existsSync(cover));
});

test('restored covers lose their EXIF/GPS metadata before they reach uploads/', async () => {
    const seg = (marker, payload) => {
        const head = Buffer.from([0xff, marker, 0, 0]);
        head.writeUInt16BE(payload.length + 2, 2);
        return Buffer.concat([head, payload]);
    };
    const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0MM\0*\0\0\0\x08\0\0', 'latin1'), Buffer.from('GPS-SECRET')])),
        seg(0xfe, Buffer.from('GPS-SECRET comment')),
        seg(0xdb, Buffer.alloc(65, 1)),
        seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
        Buffer.from([0x12, 0x34, 0xff, 0xd9])
    ]);
    const res = await uploadZip(zipOf({ 'manga.db': await snapshotDbBuffer(), 'uploads/restored-gps.jpg': jpeg }).toBuffer());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const restored = fs.readFileSync(path.join(dbm.uploadsDir, 'restored-gps.jpg'));
    assert.ok(!restored.includes('GPS-SECRET'), 'metadata is stripped');
    assert.deepEqual([...restored.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual(fs.readdirSync(dbm.uploadsDir).filter(f => f.startsWith('.strip-')), []);
});

test('inspecting or staging a backup leaves the live publisher aliases alone; a restore loads its own', async () => {
    const { normalizePublisher } = require('../core/lib/publishers');
    const before = await createSnapshot();
    const merged = await admin('POST', '/publishers/merge', { from: ['Kaze Manga'], to: 'Crunchyroll' });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(normalizePublisher('Kaze Manga'), 'Crunchyroll');

    const inspected = await admin('POST', '/backup/inspect', { filename: before });
    assert.equal(inspected.status, 200);
    assert.equal((await admin('DELETE', `/backup/restore/${inspected.body.staging_id}`)).status, 200);
    const uploaded = await uploadZip(fs.readFileSync(path.join(ctx.dataDir, 'backups', before)), '/backup/inspect');
    assert.equal(uploaded.status, 200);
    assert.equal((await admin('DELETE', `/backup/restore/${uploaded.body.staging_id}`)).status, 200);
    assert.equal(normalizePublisher('Kaze Manga'), 'Crunchyroll');
    const created = await admin('POST', '/mangas', { title: 'Alias nach Prüfung', publisher: 'Kaze Manga' });
    assert.equal(created.status, 200);
    assert.equal(dbm.db.prepare('SELECT publisher FROM mangas WHERE id = ?').get(created.body.id).publisher, 'Crunchyroll');

    const restored = await admin('POST', `/backups/${before}/restore`);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(normalizePublisher('Kaze Manga'), 'Kazé Manga', 'the restored database has no such alias');
    assert.equal(normalizePublisher('EMA'), 'Egmont Manga', 'its seeded aliases are live');
});
