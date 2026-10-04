const test = require('node:test');
const assert = require('node:assert/strict');
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
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'vis', password: 'password123', role: 'visitor' })).status, 200);
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
    assert.equal((await visitor('POST', '/auth/login', { username: 'vis', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

test('offline-snapshot requires authentication', async () => {
    const res = await ctx.client()('GET', '/offline-snapshot');
    assert.equal(res.status, 401);
});

test('offline-snapshot: empty collection', async () => {
    const res = await visitor('GET', '/offline-snapshot');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.mangas, []);
    assert.deepEqual(res.body.details, {});
    assert.equal(res.body.user.role, 'visitor');
    assert.ok(!Number.isNaN(Date.parse(res.body.generated_at)));
});

test('offline-snapshot mirrors /mangas and /mangas/:id for the requesting user', async () => {
    const a = (await editor('POST', '/mangas', { title: 'Alpha', total_volumes: 3 })).body.id;
    const b = (await editor('POST', '/mangas', { title: 'Beta', total_volumes: 2 })).body.id;
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: a, from: 1, to: 3, status: 'Vorhanden' })).status, 200);
    const vols = (await editor('GET', `/mangas/${a}`)).body.volumes;
    assert.equal((await editor('POST', `/volumes/${vols[0].id}/read`, { read: true })).status, 200);

    for (const client of [editor, visitor]) {
        const snap = (await client('GET', '/offline-snapshot')).body;
        const list = (await client('GET', '/mangas')).body;
        assert.deepEqual(snap.mangas, list);
        assert.ok(snap.mangas.every(m => 'volume_search' in m), 'the dashboard search works offline too');
        assert.deepEqual(Object.keys(snap.details).sort(), [String(a), String(b)].sort());
        for (const id of [a, b]) {
            assert.deepEqual(snap.details[id], (await client('GET', `/mangas/${id}`)).body);
        }
    }
    // read flags are per user
    const edSnap = (await editor('GET', '/offline-snapshot')).body;
    const visSnap = (await visitor('GET', '/offline-snapshot')).body;
    assert.equal(edSnap.details[a].volumes.filter(v => v.is_read).length, 1);
    assert.equal(visSnap.details[a].volumes.filter(v => v.is_read).length, 0);
});

test('read_users entries expose the reader under both id and user_id (same shape as POST /volumes/:id/read)', async () => {
    const m = (await editor('POST', '/mangas', { title: 'Reader Shape' })).body.id;
    await editor('POST', '/volumes/batch', { manga_id: m, from: 1, to: 1, status: 'Vorhanden' });
    const vol = (await editor('GET', `/mangas/${m}`)).body.volumes[0];
    const toggled = await editor('POST', `/volumes/${vol.id}/read`, { read: true });
    assert.equal(toggled.status, 200);
    const reader = (await editor('GET', `/mangas/${m}`)).body.volumes[0].read_users[0];
    assert.equal(reader.id, reader.user_id);
    assert.equal(reader.username, 'ed');
    assert.equal(toggled.body.read_users[0].user_id, reader.user_id);
});

test('offline-snapshot details equal /mangas/:id per user for mixed types, owners and readers', async () => {
    const users = (await admin('GET', '/users')).body;
    const edId = users.find(u => u.username === 'ed').id;
    const visId = users.find(u => u.username === 'vis').id;
    const mixed = (await editor('POST', '/mangas', { title: 'Gemischt', description: 'Text' })).body.id;
    const other = (await editor('POST', '/mangas', { title: 'Zweite', total_volumes: 2 })).body.id;
    const add = async (manga_id, volume_number, type = 'volume', status = 'Vorhanden') => {
        const res = await editor('POST', '/volumes', { manga_id, volume_number, type, status });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.id;
    };
    const ids = [];
    for (const [n, type, status] of [['10', 'volume'], ['2', 'volume'], ['0', 'volume'], ['2', 'special_edition'], ['Extra', 'special'],
        ['East Blue Leerschuber', 'schuber'], ['Schuber 1', 'schuber', 'Fehlt'], ['3', 'volume', 'Fehlt'], ['Starter 1', 'volume']]) {
        ids.push(await add(mixed, n, type, status));
    }
    ids.push(await add(other, '1'));
    assert.equal((await admin('POST', `/volumes/${ids[0]}/owners`, { owned: true })).status, 200);
    assert.equal((await admin('POST', `/volumes/${ids[1]}/owners`, { owned: true })).status, 200);
    for (const [vol, userId] of [[ids[0], edId], [ids[0], visId], [ids[3], visId], [ids[7], edId], [ids[9], visId]]) {
        assert.equal((await admin('POST', `/volumes/${vol}/read`, { read: true, user_id: userId })).status, 200);
    }

    for (const client of [editor, visitor, admin]) {
        const snap = (await client('GET', '/offline-snapshot')).body;
        assert.deepEqual(snap.mangas, (await client('GET', '/mangas')).body);
        for (const id of Object.keys(snap.details)) {
            assert.deepEqual(snap.details[id], (await client('GET', `/mangas/${id}`)).body, `details of ${id}`);
        }
        assert.equal(snap.details[mixed].description, 'Text');
        assert.equal('manga_passion_edition_data' in snap.details[mixed], false);
    }
});

test('offline-snapshot runs a fixed number of queries, independent of the number of series', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const original = DatabaseSync.prototype.prepare;
    let prepares = 0;
    const countSnapshot = async () => {
        prepares = 0;
        DatabaseSync.prototype.prepare = function (...args) { prepares++; return original.apply(this, args); };
        try {
            assert.equal((await editor('GET', '/offline-snapshot')).status, 200);
        } finally { DatabaseSync.prototype.prepare = original; }
        return prepares;
    };
    const before = await countSnapshot();
    assert.ok(before > 0, "prepare calls are counted");
    for (let i = 0; i < 5; i++) {
        const id = (await editor('POST', '/mangas', { title: `Abfragen ${i}` })).body.id;
        await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 2, status: 'Vorhanden' });
    }
    assert.equal(await countSnapshot(), before);
});

test('offline-snapshot is built in blocks: 300 series, identical output, other work runs in between', async () => {
    const snapshot = require('../services/snapshot');
    const { db } = require('../db');
    const editorId = (await admin('GET', '/users')).body.find(u => u.username === 'ed').id;
    const insManga = db.prepare('INSERT INTO mangas (title, total_volumes) VALUES (?, 3)');
    const insVol = db.prepare('INSERT INTO volumes (manga_id, volume_number, status, type, images, price) VALUES (?, ?, ?, ?, ?, ?)');
    const insRead = db.prepare('INSERT INTO volume_reads (volume_id, user_id) VALUES (?, ?)');
    const insOwner = db.prepare('INSERT INTO volume_owners (volume_id, user_id) VALUES (?, ?)');
    require('../db').runTransaction(() => {
        for (let i = 0; i < 300; i++) {
            const m = Number(insManga.run(`Block ${String(i).padStart(3, '0')}`).lastInsertRowid);
            if (i % 7 === 0) continue;
            for (const [n, type, status] of [['1', 'volume', 'Vorhanden'], ['2', 'volume', 'Fehlt'], ['Schuber 1', 'schuber', 'Vorhanden']]) {
                const v = Number(insVol.run(m, n, status, type, i % 5 === 0 ? '["/uploads/a.jpg"]' : null, 7.5).lastInsertRowid);
                if (status === 'Vorhanden') insOwner.run(v, editorId);
                if (i % 3 === 0 && status === 'Vorhanden') insRead.run(v, editorId);
            }
        }
    });

    const previous = snapshot.options.chunkSize;
    snapshot.options.chunkSize = 50;
    try {
        const series = db.prepare('SELECT count(*) AS n FROM mangas').get().n;
        assert.ok(series >= 300);
        const snap = (await editor('GET', '/offline-snapshot')).body;
        assert.deepEqual(snap.mangas, (await editor('GET', '/mangas')).body);
        assert.equal(Object.keys(snap.details).length, series);
        for (const id of Object.keys(snap.details)) {
            assert.deepEqual(snap.details[id], (await editor('GET', `/mangas/${id}`)).body, `details of ${id}`);
        }

        let ticks = 0;
        let done = false;
        const tick = () => { if (!done) { ticks++; setImmediate(tick); } };
        const build = snapshot.buildOfflineSnapshot({ id: editorId, username: 'ed', role: 'editor' });
        setImmediate(tick);
        await build.finally(() => { done = true; });
        assert.ok(ticks >= Math.ceil(series / 50) - 1, `other callbacks ran between the blocks (${ticks})`);
    } finally {
        snapshot.options.chunkSize = previous;
    }
});

test('offline-snapshot: a database reopened during the build (restore) fails it with 503 instead of mixing data', async () => {
    const snapshot = require('../services/snapshot');
    const dbm = require('../db');
    const previous = snapshot.options.chunkSize;
    snapshot.options.chunkSize = 1;
    try {
        const build = snapshot.buildOfflineSnapshot({ id: 1, username: 'admin', role: 'admin' });
        await new Promise(r => setImmediate(r));
        dbm.initDb();
        await assert.rejects(build, (err) => err.status === 503);
    } finally {
        snapshot.options.chunkSize = previous;
    }
    assert.equal((await editor('GET', '/offline-snapshot')).status, 200);
});

test('reader_stats name the role of each user; volumes carry no internal number_sort', async () => {
    const id = (await editor('POST', '/mangas', { title: 'Rollen' })).body.id;
    await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 2, status: 'Vorhanden' });
    const detail = (await visitor('GET', `/mangas/${id}`)).body;
    assert.deepEqual(detail.reader_stats.map(r => [r.username, r.role]), [['admin', 'admin'], ['ed', 'editor'], ['vis', 'visitor']]);
    assert.deepEqual(Object.keys(detail.reader_stats[0]), ['user_id', 'username', 'role', 'read_count', 'total_owned', 'unread_count', 'percentage']);
    assert.ok(detail.volumes.length === 2 && detail.volumes.every(v => !('number_sort' in v)));
    const snap = (await visitor('GET', '/offline-snapshot')).body;
    assert.deepEqual(snap.details[id].reader_stats, detail.reader_stats);
});

// runs last: it empties the collection
test('offline-snapshot: a reopen to a database without series still fails with 503', async () => {
    const snapshot = require('../services/snapshot');
    const dbm = require('../db');
    assert.ok(dbm.db.prepare('SELECT count(*) AS n FROM mangas').get().n > 0);
    const build = snapshot.buildOfflineSnapshot({ id: 1, username: 'admin', role: 'admin' });
    dbm.db.exec('DELETE FROM mangas');
    dbm.initDb();
    await assert.rejects(build, (err) => err.status === 503);
    const snap = (await editor('GET', '/offline-snapshot')).body;
    assert.deepEqual([snap.mangas, snap.details], [[], {}]);
});
