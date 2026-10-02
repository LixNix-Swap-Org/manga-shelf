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
    assert.equal(res.status, 500);
    assert.match(res.body.error, /Ungültige Backup-Datenbank/);

    const after = await admin('GET', '/mangas');
    assert.equal(after.status, 200);
    assert.equal(after.body.length, before.body.length);
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
