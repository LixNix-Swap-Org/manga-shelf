const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let editor;
let visitor;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    editor = ctx.client();
    visitor = ctx.client();

    const setup = await admin('POST', '/setup', { username: 'admin', password: 'password123' });
    assert.equal(setup.status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'vis', password: 'password123', role: 'visitor' })).status, 200);
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
    assert.equal((await visitor('POST', '/auth/login', { username: 'vis', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

test('setup: second admin and short passwords are rejected', async () => {
    const anon = ctx.client();
    assert.equal((await anon('POST', '/setup', { username: 'x', password: 'password123' })).status, 400);
    assert.equal((await admin('POST', '/users', { username: 'weak', password: 'short' })).status, 400);
});

test('auth: unauthenticated requests are rejected, wrong password gives 401', async () => {
    const anon = ctx.client();
    assert.equal((await anon('GET', '/mangas')).status, 401);
    assert.equal((await anon('POST', '/auth/login', { username: 'admin', password: 'nope' })).status, 401);
    assert.equal((await anon('POST', '/auth/login', { username: 'ghost', password: 'nope' })).status, 401);
});

test('roles: visitors are read-only, editors cannot manage users or backups', async () => {
    assert.equal((await visitor('GET', '/mangas')).status, 200);
    assert.equal((await visitor('POST', '/mangas', { title: 'X' })).status, 403);
    assert.equal((await editor('GET', '/users')).status, 403);
    assert.equal((await editor('GET', '/backups')).status, 403);
    assert.equal((await editor('PUT', '/stats/settings', { collection_start_date: '2022-01-01' })).status, 403);
});

test('manga + volumes CRUD keeps owned_volumes in sync', async () => {
    const created = await editor('POST', '/mangas', { title: 'Test Manga', publisher: 'carlsen manga' });
    assert.equal(created.status, 200);
    const id = created.body.id;

    assert.equal((await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 5 })).status, 200);
    let manga = await editor('GET', `/mangas/${id}`);
    assert.equal(manga.body.volumes.length, 5);
    assert.equal(manga.body.owned_volumes, 5);

    const vol = manga.body.volumes[0];
    assert.equal((await editor('PUT', `/volumes/${vol.id}`, { status: 'Fehlt' })).status, 200);
    manga = await editor('GET', `/mangas/${id}`);
    assert.equal(manga.body.owned_volumes, 4);

    assert.equal((await editor('POST', `/volumes/${vol.id}/read`, {})).body.is_read, true);
    assert.equal((await editor('DELETE', `/mangas/${id}`)).status, 200);
    assert.equal((await editor('GET', `/mangas/${id}`)).status, 404);
});

test('manga detail lists every reader with their read counts (reader_stats)', async () => {
    const { body } = await editor('POST', '/mangas', { title: 'Reader Manga' });
    await editor('POST', '/volumes/batch', { manga_id: body.id, from: 1, to: 4 });
    const volumes = (await editor('GET', `/mangas/${body.id}`)).body.volumes;
    await editor('POST', `/volumes/${volumes[0].id}/read`, {});
    await editor('POST', `/volumes/${volumes[1].id}/read`, {});

    const stats = (await editor('GET', `/mangas/${body.id}`)).body.reader_stats;
    assert.ok(Array.isArray(stats) && stats.length >= 2, 'every user is listed');
    const mine = stats.find(r => r.read_count === 2);
    assert.ok(mine, 'the reader with two read volumes is present');
    assert.equal(mine.total_owned, 4);
    assert.equal(mine.unread_count, 2);
    assert.equal(mine.percentage, 50);
    assert.ok(mine.user_id && mine.username);
    assert.ok(stats.some(r => r.read_count === 0), 'other users have no reads');
});

test('batch volume creation is atomic and rejects invalid ranges', async () => {
    const { body } = await editor('POST', '/mangas', { title: 'Batch Manga' });
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: body.id, from: 5, to: 1 })).status, 400);
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: body.id, from: 1, to: 1000 })).status, 400);
});

test('stats settings validate the date', async () => {
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: 'xyz' })).status, 400);
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: '2999-01-01' })).status, 400);
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: '2022-01-05' })).status, 200);
    const stats = await admin('GET', '/stats');
    assert.equal(stats.body.collection_start_date, '2022-01-05');
    assert.ok(Number.isFinite(stats.body.collection_days));
});

test('upload-remote blocks private and loopback targets (SSRF)', async () => {
    for (const url of ['http://127.0.0.1/a.jpg', 'http://localhost/a.jpg', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/a.jpg']) {
        const res = await editor('POST', '/upload-remote', { url });
        assert.equal(res.status, 400, url);
    }
});

test('deleted users lose access immediately', async () => {
    const temp = ctx.client();
    const created = await admin('POST', '/users', { username: 'temp', password: 'password123', role: 'editor' });
    await temp('POST', '/auth/login', { username: 'temp', password: 'password123' });
    assert.equal((await temp('GET', '/mangas')).status, 200);
    assert.equal((await admin('DELETE', `/users/${created.body.user.id}`)).status, 200);
    assert.equal((await temp('GET', '/mangas')).status, 401);
});

test('restore rejects invalid archives and keeps the live database', async () => {
    const before = await admin('GET', '/mangas');

    const garbageDb = new AdmZip();
    garbageDb.addFile('manga.db', Buffer.from('this is not a sqlite database'));
    const snapshotDir = path.join(ctx.dataDir, 'backups');
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'broken.zip'), garbageDb.toBuffer());

    const res = await admin('POST', '/backups/broken.zip/restore');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Ungültige Backup-Datenbank/);

    const after = await admin('GET', '/mangas');
    assert.equal(after.status, 200);
    assert.equal(after.body.length, before.body.length);
});

test('uploaded backups that are not valid archives are rejected with 400 and keep the live database', async () => {
    const before = (await admin('GET', '/mangas')).body.length;
    const upload = async (name, data) => {
        const fd = new FormData();
        fd.append('backup', new Blob([data], { type: 'application/zip' }), name);
        const res = await fetch(ctx.base + '/backup/restore', { method: 'POST', headers: { Cookie: admin.cookie }, body: fd });
        return { status: res.status, body: await res.json() };
    };

    const notZip = await upload('x.zip', Buffer.from('definitely not a zip'));
    assert.equal(notZip.status, 400);
    assert.match(notZip.body.error, /Ungültiges ZIP-Archiv/);

    const noDb = new AdmZip();
    noDb.addFile('readme.txt', Buffer.from('no database in here'));
    const missing = await upload('nodb.zip', noDb.toBuffer());
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /Keine manga\.db/);

    const badDb = new AdmZip();
    badDb.addFile('manga.db', Buffer.from('this is not a sqlite database'));
    const garbage = await upload('bad.zip', badDb.toBuffer());
    assert.equal(garbage.status, 400);
    assert.match(garbage.body.error, /Ungültige Backup-Datenbank/);

    assert.equal((await admin('GET', '/mangas')).body.length, before);
});

test('snapshot create + restore round-trip', async () => {
    const created = await admin('POST', '/backups/create');
    assert.equal(created.status, 200);

    const { body } = await editor('POST', '/mangas', { title: 'Added After Snapshot' });
    assert.ok(body.id);
    const withExtra = (await admin('GET', '/mangas')).body.length;

    const restored = await admin('POST', `/backups/${created.body.snapshot.filename}/restore`);
    assert.equal(restored.status, 200);
    assert.equal((await admin('GET', '/mangas')).body.length, withExtra - 1);
});

test('health: public readiness probe reports ok without authentication', async () => {
    const anon = ctx.client();
    const res = await anon('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(typeof res.body.version, 'string');
    assert.equal(typeof res.body.uptime, 'number');
});

test('Wunschliste: Priorität und Zielpreis werden gespeichert, geprüft und in der Einkaufsliste geliefert', async () => {
    const made = await editor('POST', '/mangas', { title: 'Wunsch Reihe' });
    const add = await editor('POST', '/volumes', { manga_id: made.body.id, volume_number: '1', status: 'Fehlt', priority: 3, target_price: '4,50' });
    assert.equal(add.status, 200);
    assert.equal((await editor('POST', '/volumes', { manga_id: made.body.id, volume_number: '2', status: 'Fehlt', priority: 9 })).status, 400);
    let item = (await editor('GET', '/shopping-list')).body.items.find(i => i.id === add.body.id);
    assert.equal(item.priority, 3);
    assert.equal(item.target_price, 4.5);
    assert.equal((await editor('PUT', `/volumes/${add.body.id}`, { priority: '1', target_price: '' })).status, 200);
    assert.equal((await editor('PUT', `/volumes/${add.body.id}`, { priority: 'viel' })).status, 400);
    item = (await editor('GET', '/shopping-list')).body.items.find(i => i.id === add.body.id);
    assert.equal(item.priority, 1);
    assert.equal(item.target_price, null);
});

test('Statistik: Ausgaben nach Kaufdatum (Jahr, letzte 12 Monate, ohne Datum)', async () => {
    const made = await editor('POST', '/mangas', { title: 'Ausgaben Reihe' });
    const y = new Date().getFullYear();
    const m = String(new Date().getMonth() + 1).padStart(2, '0');
    const add = (n, extra) => editor('POST', '/volumes', { manga_id: made.body.id, volume_number: n, status: 'Vorhanden', ...extra });
    await add('1', { price: 10, purchase_date: `${y}-${m}-01` });
    await add('2', { price: 5, purchase_date: `${y}-${m}-15` });
    await add('3', { price: 7 });
    const sp = (await editor('GET', '/stats')).body.spending;
    assert.equal(sp.by_month.length, 12);
    const cur = sp.by_month.at(-1);
    assert.equal(cur.month, `${y}-${m}`);
    assert.ok(cur.total >= 15 && cur.volumes >= 2);
    assert.ok(sp.by_year.find(r => r.year === y).total >= 15);
    assert.ok(sp.without_date.volumes >= 1);
});
