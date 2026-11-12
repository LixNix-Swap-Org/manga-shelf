// "Aktivität" (GET /activity): what happened recently in the shelves, from the rows' own timestamps.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let lena;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    lena = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'Lena', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await lena('POST', '/auth/login', { username: 'Lena', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

test('reads, owned copies, new volumes and series, grouped per person, series and day', async () => {
    const { id } = (await lena('POST', '/mangas', { title: 'Verlauf-Reihe' })).body;
    assert.equal((await lena('POST', '/volumes/batch', { manga_id: id, from: 1, to: 3 })).status, 200);
    const vols = (await lena('GET', `/mangas/${id}`)).body.volumes;
    for (const v of vols) assert.equal((await lena('POST', `/volumes/${v.id}/owners`, { owned: true })).status, 200);
    for (const v of vols.slice(0, 2)) assert.ok((await admin('POST', `/volumes/${v.id}/read`, {})).status < 300);
    // everything so far happened an hour ago; admin changes volume 3 now: a change of its own (not the step that added or owned it)
    const db = require('../db').db;
    db.prepare("UPDATE volumes SET created_at = datetime(created_at, '-1 hour'), updated_at = datetime(updated_at, '-1 hour') WHERE manga_id = ?").run(id);
    db.prepare("UPDATE volume_copies SET created_at = datetime(created_at, '-1 hour') WHERE volume_id IN (SELECT id FROM volumes WHERE manga_id = ?)").run(id);
    assert.equal((await admin('PUT', `/volumes/${vols[2].id}`, { ...vols[2], notes: 'Knick' })).status, 200);

    const res = await lena('GET', '/activity');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const mine = res.body.items.filter(i => i.manga_id === id);
    const brief = mine.map(i => [i.kind, i.username, i.volumes]).sort((a, b) => a[0].localeCompare(b[0]) || String(a[1]).localeCompare(String(b[1])));
    // who added volume 3 is gone with its later change (volumes keep only the last one): added without a name
    assert.deepEqual(brief, [
        ['added', 'Lena', ['1', '2']],
        ['added', null, ['3']],
        ['changed', 'admin', ['3']],
        ['owned', 'Lena', ['1', '2', '3']],
        ['read', 'admin', ['1', '2']],
        ['series_added', 'Lena', []]
    ]);
    assert.ok(mine.every(i => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(i.at)));
    assert.equal(mine[0].title, 'Verlauf-Reihe');
    // newest first
    const times = res.body.items.map(i => i.at);
    assert.deepEqual(times, [...times].sort().reverse());
});

test('only the caller\'s shelves, a foreign shelf is 404, days is clamped', async () => {
    const foreign = (await admin('POST', '/shelves', { name: 'Nur Admin' })).body.id;
    await admin('POST', '/mangas', { title: 'Geheim', shelf_id: foreign });
    assert.equal(JSON.stringify((await lena('GET', '/activity')).body).includes('Geheim'), false);
    assert.equal((await lena('GET', `/activity?shelf_id=${foreign}`)).status, 404);
    assert.equal((await admin('GET', `/activity?shelf_id=${foreign}`)).body.items[0].title, 'Geheim');
    assert.equal((await lena('GET', '/activity?days=9999')).body.days, 365);
    assert.equal((await lena('GET', '/activity?days=abc')).body.days, 30);
});
