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
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: body.id, from: 0, to: 2 })).status, 400);
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: body.id, from: '1abc', to: 2 })).status, 400);
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: body.id, from: 1, to: '2.5' })).status, 400);
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: body.id, from: 1.5, to: 2 })).status, 400);
    const ok = await editor('POST', '/volumes/batch', { manga_id: body.id, from: ' 1 ', to: '2' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.created, 2);
});

test('users: a role change takes effect on an existing session cookie', async () => {
    const created = await admin('POST', '/users', { username: 'rolechange', password: 'password123', role: 'editor' });
    assert.equal(created.status, 200);
    const userId = (await admin('GET', '/users')).body.find(u => u.username === 'rolechange').id;
    const client = ctx.client();
    assert.equal((await client('POST', '/auth/login', { username: 'rolechange', password: 'password123' })).status, 200);
    assert.equal((await client('POST', '/mangas', { title: 'Rollenwechsel A' })).status, 200);

    assert.equal((await admin('PUT', `/users/${userId}`, { role: 'visitor' })).status, 200);
    assert.equal((await client('POST', '/mangas', { title: 'Rollenwechsel B' })).status, 403);
    assert.equal((await client('GET', '/mangas')).status, 200);
});

test('stats settings validate the date', async () => {
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: 'xyz' })).status, 400);
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: '2999-01-01' })).status, 400);
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: '2022-01-05' })).status, 200);
    const stats = await admin('GET', '/stats');
    assert.equal(stats.body.summary.collection_start_date, '2022-01-05');
    assert.ok(Number.isFinite(stats.body.summary.collection_days));
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
    const leftovers = fs.readdirSync(ctx.dataDir).filter(f => f.includes('restore-tmp'));
    assert.deepEqual(leftovers, []);

    assert.equal((await editor('GET', '/mangas')).status, 401);
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
    assert.equal((await visitor('POST', '/auth/login', { username: 'vis', password: 'password123' })).status, 200);
});

test('series total and batch: negative totals are rejected, batch on a missing series is a 404', async () => {
    const { body } = await editor('POST', '/mangas', { title: 'Total Check', total_volumes: 5 });
    const put = await editor('PUT', `/mangas/${body.id}`, { title: 'Total Check', total_volumes: -4 });
    assert.equal(put.status, 400);
    assert.equal((await editor('GET', `/mangas/${body.id}`)).body.total_volumes, 5);
    const batch = await editor('POST', '/volumes/batch', { manga_id: 999999, from: 1, to: 3 });
    assert.equal(batch.status, 404);
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

// --- volumes route: validation, identity, ownership/read targets ---
const newSeries = async (title) => (await editor('POST', '/mangas', { title })).body.id;
const detailOf = async (id) => (await editor('GET', `/mangas/${id}`)).body;
const userIds = async () => Object.fromEntries((await admin('GET', '/users')).body.map(u => [u.username, u.id]));
const rawDb = () => require('../db').db;
const seedRaw = (mangaId, number, extra = {}) => Number(rawDb().prepare('INSERT INTO volumes (manga_id, volume_number, status, type, price, pages) VALUES (?, ?, ?, ?, ?, ?)')
    .run(mangaId, number, extra.status || 'Vorhanden', extra.type || 'volume', extra.price ?? null, extra.pages ?? null).lastInsertRowid);
const regularNumbers = (m) => m.volumes.filter(v => (v.type || 'volume') === 'volume').map(v => v.volume_number).sort();

test('volumes: legacy status Gelesen is stored as Vorhanden with an owner and a read entry', async () => {
    const id = await newSeries('Gelesen Eingabe');
    assert.equal((await editor('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Gelesen' })).status, 200);
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: id, from: 2, to: 3, status: 'gelesen' })).status, 200);
    const missing = (await editor('POST', '/volumes', { manga_id: id, volume_number: '4', status: 'Fehlt' })).body.id;
    assert.equal((await editor('PUT', `/volumes/${missing}`, { status: 'Gelesen' })).status, 200);

    const m = await detailOf(id);
    assert.equal(m.owned_volumes, 4);
    for (const v of m.volumes) {
        assert.equal(v.status, 'Vorhanden', v.volume_number);
        assert.deepEqual(v.owners.map(o => o.username), ['ed'], v.volume_number);
        assert.equal(v.is_read, true, v.volume_number);
    }
    const bad = await editor('POST', '/volumes', { manga_id: id, volume_number: '5', status: 'Quatsch' });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(bad.body.error, /Gelesen/);
});

test('volumes: non-admins cannot change reads or ownership of other users (403), their own id is fine', async () => {
    const ids = await userIds();
    const id = await newSeries('Fremde Leser');
    await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 3 });
    const [v1] = (await detailOf(id)).volumes;

    const foreignRead = await editor('POST', `/volumes/${v1.id}/read`, { user_id: ids.admin, read: true });
    assert.equal(foreignRead.status, 403);
    assert.equal(foreignRead.body.code, 'FORBIDDEN');
    assert.equal((await editor('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: 3, user_id: ids.admin })).status, 403);
    assert.equal((await editor('POST', `/volumes/${v1.id}/owners`, { user_id: ids.admin, owned: false })).status, 403);
    let v = (await detailOf(id)).volumes[0];
    assert.deepEqual(v.read_by, []);
    assert.deepEqual(v.owners.map(o => o.username), ['ed']);

    assert.equal((await editor('POST', `/volumes/${v1.id}/read`, { user_id: String(ids.ed), read: true })).status, 200);
    assert.equal((await editor('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: 2, user_id: String(ids.ed) })).body.count, 2);
    assert.equal((await editor('POST', `/volumes/${v1.id}/owners`, { user_id: ids.ed, owned: true })).status, 200);
    assert.equal((await editor('POST', `/volumes/${v1.id}/read`, { user_id: 'abc' })).status, 400);

    const byAdmin = await admin('POST', `/volumes/${v1.id}/read`, { user_id: ids.ed, read: false });
    assert.equal(byAdmin.status, 200);
    assert.deepEqual(byAdmin.body.read_by, []);
    v = (await detailOf(id)).volumes[0];
    assert.equal(v.is_read, false);
});

test('volumes: impossible calendar dates are rejected, partial dates stay valid', async () => {
    const id = await newSeries('Datumspruefung');
    let n = 0;
    const add = (release_date) => editor('POST', '/volumes', { manga_id: id, volume_number: String(++n), release_date });
    for (const d of ['2024-02-31', '2023-02-29', '2023-04-31', '0000-01-01', '2024-13-01', '2024-00']) {
        assert.equal((await add(d)).status, 400, d);
    }
    for (const d of ['2024-02-29', '2024-02', '2024', '']) assert.equal((await add(d)).status, 200, d);
    const vid = (await detailOf(id)).volumes[0].id;
    assert.equal((await editor('PUT', `/volumes/${vid}`, { release_date: '2025-06-31' })).status, 400);
    assert.equal((await editor('PUT', `/volumes/${vid}`, { purchase_date: '2025-02-30' })).status, 400);
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: id, from: 50, to: 51, release_date: '2024-02-31' })).status, 400);
});

test('volumes: volume numbers must be non-empty strings or numbers of at most 80 characters', async () => {
    const id = await newSeries('Bandnummern');
    for (const volume_number of [null, '   ', { a: 1 }, [1], true, 'x'.repeat(81), undefined]) {
        assert.equal((await editor('POST', '/volumes', { manga_id: id, volume_number })).status, 400, JSON.stringify(volume_number));
    }
    assert.equal((await detailOf(id)).volumes.length, 0);
    const numeric = await editor('POST', '/volumes', { manga_id: id, volume_number: 5 });
    assert.equal(numeric.status, 200);
    assert.equal((await detailOf(id)).volumes[0].volume_number, '5');

    for (const volume_number of ['', '  ', null, {}, 'x'.repeat(81)]) {
        assert.equal((await editor('PUT', `/volumes/${numeric.body.id}`, { volume_number })).status, 400, JSON.stringify(volume_number));
    }
    assert.equal((await detailOf(id)).volumes[0].volume_number, '5');

    // legacy rows with an empty or overlong number stay editable as long as the number is not touched
    const empty = seedRaw(id, '');
    assert.equal((await editor('PUT', `/volumes/${empty}`, { notes: 'alt' })).status, 200);
    assert.equal((await editor('PUT', `/volumes/${empty}`, { volume_number: '', status: 'Fehlt' })).status, 200);
    const long = seedRaw(id, 'y'.repeat(90));
    assert.equal((await editor('PUT', `/volumes/${long}`, { volume_number: 'y'.repeat(90), status: 'Fehlt' })).status, 200);
});

test('volumes: "Band 5" and "5" are the same regular volume; other labels stay as typed', async () => {
    const id = await newSeries('Praefix Doppelte');
    const add = (volume_number, type) => editor('POST', '/volumes', { manga_id: id, volume_number, type });
    const first = await add('5');
    for (const n of ['Band 5', 'band  5', 'Bd. 5', 'BD 5']) {
        const dup = await add(n);
        assert.equal(dup.status, 409, n);
        assert.equal(dup.body.existing_id, first.body.id);
        assert.match(dup.body.error, /^Band 5 existiert bereits/);
    }
    assert.equal((await add('Band 6')).status, 200);
    assert.equal((await add('Starter 1')).status, 200);
    assert.equal((await add('Extra 3')).status, 200);
    assert.equal((await add('Schuber 5', 'schuber')).status, 200);
    let m = await detailOf(id);
    assert.deepEqual(m.volumes.map(v => v.volume_number).sort(), ['5', '6', 'Extra 3', 'Schuber 5', 'Starter 1']);

    const six = m.volumes.find(v => v.volume_number === '6');
    assert.equal((await editor('PUT', `/volumes/${six.id}`, { volume_number: 'Band 5' })).status, 409);

    // legacy rows that migration v8 left alone because the bare number existed
    const legacy = seedRaw(id, 'Band 7');
    assert.equal((await editor('PUT', `/volumes/${legacy}`, { volume_number: '7' })).status, 200);
    m = await detailOf(id);
    assert.equal(m.volumes.find(v => v.id === legacy).volume_number, '7');
    const pair = seedRaw(id, 'Band 5');
    assert.equal((await editor('PUT', `/volumes/${pair}`, { volume_number: 'Band 5', status: 'Fehlt' })).status, 200);
});

test('volumes: the 409 message names the entry type', async () => {
    const id = await newSeries('Doppelt Typen');
    const add = (volume_number, type) => editor('POST', '/volumes', { manga_id: id, volume_number, type });
    for (const [n, type, label] of [['5', 'schuber', /^Schuber 5 existiert/], ['5', 'special_edition', /^Special Edition 5 existiert/], ['5', 'special', /^Special 5 existiert/], ['Schuber 1', 'schuber', /^Schuber 1 existiert/], ['Band 9', 'volume', /^Band 9 existiert/]]) {
        assert.equal((await add(n, type)).status, 200);
        const dup = await add(n, type);
        assert.equal(dup.status, 409);
        assert.match(dup.body.error, label);
        assert.doesNotMatch(dup.body.error, /Schuber Schuber|Band Band/);
    }
    const other = (await add('8', 'schuber')).body.id;
    const retype = await editor('PUT', `/volumes/${other}`, { volume_number: '5' });
    assert.equal(retype.status, 409);
    assert.match(retype.body.error, /^Schuber 5 existiert/);
});

test('volumes: unknown types are rejected (400), case and spaces are normalised, an empty type keeps the default', async () => {
    const id = await newSeries('Typen');
    assert.equal((await editor('POST', '/volumes', { manga_id: id, volume_number: 'Sonderband', type: 'bogus' })).status, 400);
    const plain = await editor('POST', '/volumes', { manga_id: id, volume_number: '1', type: '' });
    assert.equal(plain.status, 200);
    const schuber = await editor('POST', '/volumes', { manga_id: id, volume_number: 'Schuber 1' });
    assert.equal(schuber.status, 200);
    assert.equal((await editor('POST', '/volumes', { manga_id: id, volume_number: '2', notes: 12345 })).status, 200);

    assert.equal((await editor('PUT', `/volumes/${plain.body.id}`, { type: 'bogus' })).status, 400);
    assert.equal((await editor('PUT', `/volumes/${plain.body.id}`, { type: null })).status, 200);
    assert.equal((await editor('PUT', `/volumes/${plain.body.id}`, { type: '' })).status, 200);
    let byId = Object.fromEntries((await detailOf(id)).volumes.map(v => [v.id, v]));
    assert.equal(byId[plain.body.id].type, 'volume');
    assert.equal(byId[schuber.body.id].type, 'volume');
    assert.equal((await editor('PUT', `/volumes/${plain.body.id}`, { type: ' Special_Edition ' })).status, 200);
    byId = Object.fromEntries((await detailOf(id)).volumes.map(v => [v.id, v]));
    assert.equal(byId[plain.body.id].type, 'special_edition');
});

test('volumes: batch creates regular volumes next to editions with the same number and skips existing regular ones', async () => {
    const id = await newSeries('Batch Sonderausgaben');
    for (const [n, type] of [['7', 'special_edition'], ['2', 'schuber'], ['3', 'special']]) {
        assert.equal((await editor('POST', '/volumes', { manga_id: id, volume_number: n, type })).status, 200);
    }
    seedRaw(id, ' 4 ');
    seedRaw(id, 'Band 5');
    const res = await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 8 });
    assert.equal(res.status, 200);
    assert.equal(res.body.created, 6);
    assert.deepEqual(res.body.skipped, ['4', '5']);

    const m = await detailOf(id);
    assert.deepEqual(regularNumbers(m), [' 4 ', '1', '2', '3', '6', '7', '8', 'Band 5']);
    assert.equal(m.volumes.filter(v => v.type !== 'volume').length, 3);
    assert.equal(m.owned_volumes, m.volumes.filter(v => v.status === 'Vorhanden').length);
});

test('volumes: batch range is limited to 300 volumes and validates date, price and year', async () => {
    const id = await newSeries('Batch Grenzen');
    const batch = (extra) => editor('POST', '/volumes/batch', { manga_id: id, ...extra });
    assert.equal((await batch({ from: 1, to: 301 })).status, 400);
    assert.equal((await batch({ from: 0, to: 300 })).status, 400);
    assert.equal((await batch({ from: 1, to: 1, release_date: 'garbage' })).status, 400);
    assert.equal((await batch({ from: 1, to: 1, default_price: 'x' })).status, 400);
    assert.equal((await batch({ from: 1, to: 1, release_year: '20x4' })).status, 400);
    assert.equal((await detailOf(id)).volumes.length, 0);

    const ok = await batch({ from: 1, to: 300, release_date: '2025-03', default_price: '7,50', status: 'Fehlt' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.created, 300);
    const m = await detailOf(id);
    assert.equal(m.volumes.length, 300);
    assert.equal(m.volumes[0].release_date, '2025-03');
    assert.equal(m.volumes[0].price, 7.5);
});

test('volumes: invalid prices and numbers are a 400 instead of silently clearing the value', async () => {
    const id = await newSeries('Preise');
    assert.equal((await editor('POST', '/volumes', { manga_id: id, volume_number: '9', price: 'abc' })).status, 400);
    assert.equal((await editor('POST', '/volumes', { manga_id: id, volume_number: '9', pages: '12abc' })).status, 400);
    const vid = (await editor('POST', '/volumes', { manga_id: id, volume_number: '1', price: 7.5 })).body.id;
    const put = (body) => editor('PUT', `/volumes/${vid}`, body);
    const stored = async () => (await detailOf(id)).volumes.find(v => v.id === vid);

    assert.equal((await put({ price: 'abc' })).status, 400);
    assert.equal((await stored()).price, 7.5);
    for (const [input, expected] of [['€ 7,99', 7.99], ['1.234,56', 1234.56], ['7.5', 7.5], [12, 12], ['', null]]) {
        assert.equal((await put({ price: input })).status, 200, String(input));
        assert.equal((await stored()).price, expected, String(input));
    }
    for (const body of [{ price: '7abc' }, { price: -1 }, { target_price: '-3' }, { pages: 'x' }, { pages: -5 }, { release_year: 'abc' }, { release_year: 20240 }]) {
        assert.equal((await put(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await put({ target_price: '4,50', pages: '192', release_year: '2024' })).status, 200);
    const v = await stored();
    assert.equal(v.target_price, 4.5);
    assert.equal(v.pages, 192);
    assert.equal(v.release_year, 2024);

    // a full-row echo (status toggle) still works when the stored row holds a value the parser would reject today
    const legacy = seedRaw(id, '2', { pages: -1, price: 3 });
    const row = (await detailOf(id)).volumes.find(x => x.id === legacy);
    assert.equal((await editor('PUT', `/volumes/${legacy}`, { ...row, status: 'Fehlt' })).status, 200);
});

test('volumes: correcting price, date or condition updates owners that still hold the old value', async () => {
    const ids = await userIds();
    const id = await newSeries('Besitzerpreis');
    const vid = (await editor('POST', '/volumes', { manga_id: id, volume_number: '1', price: 70, purchase_date: '2024-01-01' })).body.id;
    assert.equal((await admin('POST', `/volumes/${vid}/owners`, { owned: true, price: 50 })).status, 200);
    assert.equal((await editor('PUT', `/volumes/${vid}`, { price: 7, purchase_date: '2024-02-02', condition: 'Gut' })).status, 200);

    const rows = rawDb().prepare('SELECT user_id, price, purchase_date, condition FROM volume_owners WHERE volume_id = ?').all(vid);
    const byUser = Object.fromEntries(rows.map(r => [r.user_id, r]));
    assert.equal(byUser[ids.ed].price, 7);
    assert.equal(byUser[ids.ed].purchase_date, '2024-02-02');
    assert.equal(byUser[ids.ed].condition, 'Gut');
    assert.equal(byUser[ids.admin].price, 50);
    assert.equal(byUser[ids.admin].purchase_date, '2024-02-02');

});

test('owners: string flags, purchase date and price are validated', async () => {
    const id = await newSeries('Besitz Flags');
    const vid = (await editor('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt', price: 8, purchase_date: '2024-03-03' })).body.id;
    const owners = (body) => editor('POST', `/volumes/${vid}/owners`, body);

    let res = await owners({ owned: 'false' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'Fehlt');
    assert.deepEqual(res.body.owners, []);
    assert.equal((await admin('POST', `/volumes/${vid}/owners`, { owned: 'false' })).body.owners.length, 0);

    assert.equal((await owners({ owned: true, purchase_date: 'kaputt' })).status, 400);
    assert.equal((await owners({ owned: true, purchase_date: '2024-02-30' })).status, 400);
    assert.equal((await owners({ owned: true, price: '-5' })).status, 400);
    assert.equal((await owners({ owned: true, price: 'x' })).status, 400);
    assert.equal(rawDb().prepare('SELECT count(*) AS c FROM volume_owners WHERE volume_id = ?').get(vid).c, 0);

    res = await owners({ owned: 'true', price: '', purchase_date: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'Vorhanden');
    assert.deepEqual(res.body.owners.map(o => [o.username, o.price, o.purchase_date]), [['ed', 8, '2024-03-03']]);
    res = await owners({ owned: '0' });
    assert.equal(res.body.status, 'Fehlt');
    assert.equal((await detailOf(id)).owned_volumes, 0);
    res = await owners({ owned: '1', purchase_date: '2024-05-17', price: '6,50' });
    assert.deepEqual(res.body.owners.map(o => [o.price, o.purchase_date]), [[6.5, '2024-05-17']]);
});

test('volumes: DELETE recounts, removes reads and owners, and answers 404 the second time', async () => {
    const ids = await userIds();
    const id = await newSeries('Loeschen');
    await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 3 });
    const vol = (await detailOf(id)).volumes[0];
    await editor('POST', `/volumes/${vol.id}/read`, { read: true });
    await admin('POST', `/volumes/${vol.id}/owners`, { owned: true, user_id: ids.admin });
    assert.equal((await visitor('DELETE', `/volumes/${vol.id}`)).status, 403);

    assert.equal((await editor('DELETE', `/volumes/${vol.id}`)).status, 200);
    assert.equal((await detailOf(id)).owned_volumes, 2);
    assert.equal(rawDb().prepare('SELECT count(*) AS c FROM volume_reads WHERE volume_id = ?').get(vol.id).c, 0);
    assert.equal(rawDb().prepare('SELECT count(*) AS c FROM volume_owners WHERE volume_id = ?').get(vol.id).c, 0);
    assert.equal((await editor('DELETE', `/volumes/${vol.id}`)).status, 404);
});

test('volumes: batch-read skips schuber, missing and unnumbered entries; unknown series or user is a 404', async () => {
    const id = await newSeries('Batch Lesen');
    await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 3 });
    await editor('POST', '/volumes', { manga_id: id, volume_number: '1', type: 'schuber' });
    await editor('POST', '/volumes', { manga_id: id, volume_number: '4', status: 'Fehlt' });
    await editor('POST', '/volumes', { manga_id: id, volume_number: 'Extra 1' });
    const res = await editor('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: 5 });
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 3);
    const read = (await detailOf(id)).volumes.filter(v => v.is_read).map(v => v.volume_number).sort();
    assert.deepEqual(read, ['1', '2', '3']);
    const vols = (await detailOf(id)).volumes;
    const idOf = (number) => vols.find(v => v.volume_number === number && v.type !== 'schuber').id;
    assert.deepEqual(res.body.changed_ids.sort((a, b) => a - b), ['1', '2', '3'].map(idOf).sort((a, b) => a - b));

    assert.equal((await editor('POST', `/volumes/${idOf('2')}/read`, { read: false })).status, 200);
    const again = await editor('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: 5 });
    assert.deepEqual([again.body.count, again.body.changed_ids], [3, [idOf('2')]], 'only entries whose state flipped are listed');
    const unread = await editor('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: 1, read: false });
    assert.deepEqual([unread.body.count, unread.body.changed_ids], [1, [idOf('1')]]);

    assert.equal((await editor('POST', '/volumes/batch-read', { manga_id: 987654, up_to_volume: 5 })).status, 404);
    assert.equal((await admin('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: 5, user_id: 987654 })).status, 404);
});

test('volumes: unread answers previous_read_at and an undo restores the read with that date', async () => {
    const { db } = require('../db');
    const readAt = (volumeId) => db.prepare('SELECT read_at FROM volume_reads WHERE volume_id = ? AND user_id = (SELECT id FROM users WHERE username = ?)')
        .get(volumeId, 'ed')?.read_at ?? null;
    const id = await newSeries('Lesen Rueckgaengig');
    await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 3 });
    const vols = (await detailOf(id)).volumes;
    const idOf = (number) => vols.find(v => v.volume_number === number).id;

    await editor('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: 3 });
    db.prepare("UPDATE volume_reads SET read_at = '2023-02-03 04:05:06' WHERE volume_id = ?").run(idOf('1'));
    const unread = await editor('POST', `/volumes/${idOf('1')}/read`, { read: false });
    assert.deepEqual([unread.body.is_read, unread.body.previous_read_at], [false, '2023-02-03 04:05:06']);
    const again = await editor('POST', `/volumes/${idOf('1')}/read`, { read: false });
    assert.equal(again.body.previous_read_at, null, 'nothing was removed');

    for (const bad of ['2023-02-03', '2023-02-30 04:05:06', '2023-02-03T04:05:06Z', 'gestern', 5]) {
        assert.equal((await editor('POST', `/volumes/${idOf('1')}/read`, { read: true, read_at: bad })).status, 400, String(bad));
    }
    assert.equal(readAt(idOf('1')), null, 'a rejected read_at changes nothing');
    const undo = await editor('POST', `/volumes/${idOf('1')}/read`, { read: true, read_at: unread.body.previous_read_at });
    assert.deepEqual([undo.status, undo.body.is_read, 'previous_read_at' in undo.body], [200, true, false]);
    assert.equal(readAt(idOf('1')), '2023-02-03 04:05:06');
    await editor('POST', `/volumes/${idOf('1')}/read`, { read: true, read_at: '2020-01-01 00:00:00' });
    assert.equal(readAt(idOf('1')), '2023-02-03 04:05:06', 'an existing read keeps its date');

    db.prepare("UPDATE volume_reads SET read_at = '2022-12-24 18:00:00' WHERE volume_id = ?").run(idOf('2'));
    await editor('POST', `/volumes/${idOf('3')}/read`, { read: false });
    const batch = await editor('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: 3, read: false });
    assert.deepEqual(batch.body.changed_ids.sort((a, b) => a - b), [idOf('1'), idOf('2')].sort((a, b) => a - b));
    assert.deepEqual(batch.body.previous_read_at, { [idOf('1')]: '2023-02-03 04:05:06', [idOf('2')]: '2022-12-24 18:00:00' });
    const batchRead = await editor('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: 3 });
    assert.equal('previous_read_at' in batchRead.body, false);
});

test('volume lookup is editor-only; lookup, sync-edition and autofill work from cached Manga Passion data', async () => {
    const editionId = 77001;
    rawDb().prepare('INSERT OR REPLACE INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, ?)').run(
        `mp_edition_vols_${editionId}`,
        JSON.stringify({
            edition: { title: 'Cache Reihe', publisher: 'Carlsen Manga', total_volumes: 2, author: 'X' },
            volumes: [
                { volume_number: '1', num: 1, title: 'Anfang', price: 8, pages: 192, release_date: '2024-05-02', is_released: true },
                { volume_number: '2', num: 2, title: 'Weiter', price: 8, pages: 200, release_date: '2024-08-01', is_released: true }
            ]
        }),
        Date.now()
    );
    const id = await newSeries('Cache Reihe');
    await editor('POST', '/volumes', { manga_id: id, volume_number: '1' });

    const realFetch = global.fetch;
    global.fetch = (url, opts) => (String(url).startsWith(ctx.base) ? realFetch(url, opts) : Promise.reject(new Error('no network in tests')));
    try {
        assert.equal((await visitor('GET', '/volumes/lookup?mp_volume_id=9736')).status, 403);
        assert.equal((await editor('POST', `/mangas/${id}/sync-edition`, {})).status, 400);
        const sync = await editor('POST', `/mangas/${id}/sync-edition`, { edition_id: editionId });
        assert.equal(sync.status, 200);
        assert.equal(sync.body.manga.manga_passion_id, editionId);
        assert.equal(sync.body.manga.total_volumes, 2);

        const lookup = await editor('GET', `/volumes/lookup?manga_id=${id}&volume_number=2`);
        assert.equal(lookup.status, 200);
        assert.equal(lookup.body.matched, true);
        assert.equal(lookup.body.data.release_date, '2024-08-01');
        assert.equal(lookup.body.data.pages, 200);

        const autofill = await editor('POST', `/mangas/${id}/autofill-volumes`, {});
        assert.equal(autofill.status, 200);
        assert.equal(autofill.body.success, true);
        assert.equal(autofill.body.updated_count, 1);
        const v = (await detailOf(id)).volumes[0];
        assert.equal(v.release_date, '2024-05-02');
        assert.equal(v.pages, 192);
    } finally {
        global.fetch = realFetch;
    }
});

// Restore swaps the users table and the stored JWT secret. These tests come last because the second one removes the admin.
async function uploadModifiedBackup(client, mutate) {
    const created = await client('POST', '/backups/create');
    assert.equal(created.status, 200);
    const zip = new AdmZip(path.join(ctx.dataDir, 'backups', created.body.snapshot.filename));
    const tmpDb = path.join(ctx.dataDir, 'temp', 'modified-backup.db');
    fs.mkdirSync(path.dirname(tmpDb), { recursive: true });
    fs.writeFileSync(tmpDb, zip.getEntry('manga.db').getData());
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(tmpDb);
    mutate(old);
    old.close();
    zip.updateFile('manga.db', fs.readFileSync(tmpDb));
    fs.unlinkSync(tmpDb);
    const fd = new FormData();
    fd.append('backup', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'old.zip');
    const res = await fetch(ctx.base + '/backup/restore', { method: 'POST', headers: { Cookie: client.cookie }, body: fd });
    return { res, body: await res.json() };
}

test('errors from the central handler: German text plus code, extras like existing_id stay', async () => {
    const m = (await editor('POST', '/mangas', { title: 'Fehlerformen' })).body.id;
    assert.equal((await editor('POST', '/volumes', { manga_id: m, volume_number: '1' })).status, 200);
    const dup = await editor('POST', '/volumes', { manga_id: m, volume_number: 'Band 1' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'VOLUME_DUPLICATE');
    assert.equal(typeof dup.body.existing_id, 'number');
    assert.match(dup.body.error, /^Band 1 existiert bereits \(Vorhanden\)/);

    const adminId = (await admin('GET', '/auth/me')).body.user.id;
    const other = await editor('POST', `/volumes/${dup.body.existing_id}/owners`, { user_id: adminId });
    assert.deepEqual([other.status, other.body.code], [403, 'FORBIDDEN']);
    assert.equal(other.body.error, 'Nur Administratoren dürfen das für andere Benutzer ändern');
    const unknownUser = await admin('POST', `/volumes/${dup.body.existing_id}/read`, { user_id: 999999 });
    assert.deepEqual([unknownUser.status, unknownUser.body], [404, { error: 'Benutzer nicht gefunden', code: 'NOT_FOUND' }]);
    const badUser = await admin('POST', '/volumes/batch-read', { manga_id: m, up_to_volume: 3, user_id: 'abc' });
    assert.deepEqual([badUser.status, badUser.body.code], [400, 'BAD_REQUEST']);

    const readOnly = await visitor('POST', '/mangas', { title: 'x' });
    assert.deepEqual([readOnly.status, readOnly.body.code], [403, 'READ_ONLY']);
    const gone = await editor('DELETE', '/volumes/987654');
    assert.deepEqual(gone.body, { error: 'Band nicht gefunden', code: 'NOT_FOUND' });
    const notConfirmed = await editor('POST', `/mangas/${m}/batch-import-gaps`, { volume_numbers: ['2'], edition_id: 4242 });
    assert.equal(notConfirmed.status, 409);
    assert.deepEqual([notConfirmed.body.needs_confirmation, notConfirmed.body.code], [true, 'EDITION_NOT_CONFIRMED']);
});

test('batch-import-gaps answers with the ids of the entries it created', async () => {
    const m = await newSeries('Lücken Import IDs');
    await editor('POST', '/volumes', { manga_id: m, volume_number: '1' });
    const listed = (await editor('POST', '/volumes', { manga_id: m, volume_number: '2', status: 'Fehlt' })).body.id;
    const res = await editor('POST', `/mangas/${m}/batch-import-gaps`, { volume_numbers: ['1', '2', '3', 4] });
    assert.equal(res.status, 200);
    const created = (await detailOf(m)).volumes.filter(v => ['3', '4'].includes(v.volume_number)).map(v => v.id).sort((a, b) => a - b);
    assert.equal(created.length, 2);
    assert.deepEqual([...res.body.imported_ids].sort((a, b) => a - b), created);
    assert.deepEqual([res.body.imported_count, res.body.updated_count, res.body.skipped_owned_count], [2, 1, 1]);
    assert.ok(!res.body.imported_ids.includes(listed));
});

test('volume notes are capped at 10000 characters on create and edit; an old longer note may be sent back unchanged', async () => {
    const m = (await editor('POST', '/mangas', { title: 'Notizlänge' })).body.id;
    const tooLong = await editor('POST', '/volumes', { manga_id: m, volume_number: '1', notes: 'n'.repeat(10001) });
    assert.deepEqual([tooLong.status, tooLong.body.code], [400, 'NOTES_TOO_LONG']);
    const id = (await editor('POST', '/volumes', { manga_id: m, volume_number: '1', notes: 'n'.repeat(10000) })).body.id;
    assert.equal((await editor('PUT', `/volumes/${id}`, { notes: 'm'.repeat(10001) })).status, 400);
    const { db } = require('../db');
    const legacy = 'alt'.repeat(4000);
    db.prepare('UPDATE volumes SET notes = ? WHERE id = ?').run(legacy, id);
    assert.equal((await editor('PUT', `/volumes/${id}`, { notes: legacy, price: '7,50' })).status, 200);
    assert.equal(db.prepare('SELECT notes, price FROM volumes WHERE id = ?').get(id).price, 7.5);
});

test('owned_volumes follows every volume write without hand-written recounts (triggers)', async () => {
    const m = (await editor('POST', '/mangas', { title: 'Zähler ohne Nachzählen' })).body.id;
    const owned = async () => (await editor('GET', '/mangas')).body.find(x => x.id === m).owned_volumes;
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: m, from: 1, to: 3, status: 'Vorhanden' })).status, 200);
    assert.equal(await owned(), 3);
    const vols = (await editor('GET', `/mangas/${m}`)).body.volumes;
    assert.equal((await editor('PUT', `/volumes/${vols[0].id}`, { status: 'Fehlt' })).status, 200);
    assert.equal(await owned(), 2);
    assert.equal((await editor('POST', `/volumes/${vols[1].id}/owners`, { owned: false })).status, 200);
    assert.equal(await owned(), 1);
    assert.equal((await editor('DELETE', `/volumes/${vols[2].id}`)).status, 200);
    assert.equal(await owned(), 0);
    assert.equal((await editor('POST', '/volumes', { manga_id: m, volume_number: '9' })).status, 200);
    assert.equal(await owned(), 1);
});

test('calendar import: a second row of another type does not get the same Manga Passion volume id', async () => {
    const { db } = require('../db');
    const m = (await editor('POST', '/mangas', { title: 'Kaiju Repro' })).body.id;
    const body = (extra) => ({ manga_id: m, title: 'Kaiju Repro', volume_number: '4', mp_volume_id: 5150, edition_id: 1, ...extra });
    const ce = await editor('POST', '/manga-passion/import', body({ type: 'special_edition', target_status: 'Vorbestellt' }));
    const regular = await editor('POST', '/manga-passion/import', body({ type: 'volume', target_status: 'Fehlt' }));
    assert.equal(ce.status, 200);
    assert.equal(regular.status, 200);
    assert.notEqual(regular.body.volume_id, ce.body.volume_id);
    const linked = (id) => db.prepare('SELECT manga_passion_volume_id AS mp FROM volumes WHERE id = ?').get(id).mp;
    assert.equal(linked(ce.body.volume_id), 5150);
    assert.equal(linked(regular.body.volume_id), null);
    // the same import again still finds and updates its own row
    const again = await editor('POST', '/manga-passion/import', body({ type: 'special_edition', target_status: 'Bestellt' }));
    assert.equal(again.body.volume_id, ce.body.volume_id);
    assert.equal(again.body.status, 'Bestellt');
});

test('lookups that ask external services share the per-account limit (volume lookup, edition search)', () => {
    const { lookupLimiter } = require('../middleware/userLimits');
    const handlers = (router, routePath) => router.stack.find(l => l.route && l.route.path === routePath).route.stack.map(s => s.handle);
    assert.ok(handlers(require('../routes/volumes'), '/volumes/lookup').includes(lookupLimiter));
    assert.ok(handlers(require('../routes/radar'), '/manga-passion/editions').includes(lookupLimiter));
});

test('restore: admin stays signed in with a new token and the live JWT secret survives a backup with another secret', async () => {
    const { res, body } = await uploadModifiedBackup(admin, (d) => {
        d.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('jwt_secret', 'secret-of-the-old-installation')").run();
        d.exec("PRAGMA foreign_keys = OFF; UPDATE users SET id = id + 100;"); // other ids than the live session token knows
    });
    assert.equal(res.status, 200);
    assert.equal(body.relogin, false);
    const set = res.headers.get('set-cookie');
    assert.ok(set && set.startsWith('token='), 'a fresh session cookie is issued');
    admin.cookie = set.split(';')[0];
    assert.equal((await admin('GET', '/mangas')).status, 200);
    assert.equal(require('../db').db.prepare("SELECT value FROM app_settings WHERE key = 'jwt_secret'").get(), undefined);
});

test('restore: backup without the current user ends the session cleanly instead of failing with "Invalid token"', async () => {
    const { res, body } = await uploadModifiedBackup(admin, (d) => {
        d.prepare("UPDATE users SET username = 'someone-else' WHERE role = 'admin'").run();
    });
    assert.equal(res.status, 200);
    assert.equal(body.relogin, true);
    assert.match(res.headers.get('set-cookie') || '', /token=;/);
    const fresh = ctx.client();
    assert.equal((await fresh('POST', '/auth/login', { username: 'someone-else', password: 'password123' })).status, 200);
});

