// "Zuletzt geändert von" (migration 55): volumes name the account that last changed them, reading marks do not count.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let editor;
const ids = {};

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    editor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    ids.ed = (await admin('POST', '/users', { username: 'Jörg', password: 'password123', role: 'editor' })).body.user.id;
    assert.equal((await editor('POST', '/auth/login', { username: 'Jörg', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

const volumeOf = async (client, mangaId, number = '1') =>
    (await client('GET', `/mangas/${mangaId}`)).body.volumes.find((v) => v.volume_number === number);

test('create, edit, ownership and copy changes name the person; reading does not', async () => {
    const { id } = (await admin('POST', '/mangas', { title: 'Wer wars' })).body;
    assert.equal((await admin('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt' })).status, 200);
    let vol = await volumeOf(admin, id);
    assert.equal(vol.updated_by_name, 'admin');
    assert.ok(vol.updated_at);

    assert.equal((await editor('PUT', `/volumes/${vol.id}`, { notes: 'neu' })).status, 200);
    vol = await volumeOf(admin, id);
    assert.deepEqual([vol.updated_by, vol.updated_by_name], [ids.ed, 'Jörg']);

    assert.equal((await admin('POST', `/volumes/${vol.id}/owners`, { owned: true })).status, 200);
    assert.equal((await volumeOf(admin, id)).updated_by_name, 'admin');

    vol = await volumeOf(admin, id);
    const copy = vol.copies.find((c) => c.owner_user_id !== null);
    assert.equal((await admin('POST', `/volumes/${vol.id}/read`, {})).status < 300, true);
    assert.equal((await editor('POST', `/volumes/${vol.id}/read`, {})).status < 300, true);
    assert.equal((await volumeOf(admin, id)).updated_by_name, 'admin', 'a reading mark is not a change of the volume');

    assert.equal((await admin('PUT', `/volumes/${vol.id}/copies/${copy.id}`, { condition: 'Gut' })).status, 200);
    assert.equal((await volumeOf(admin, id)).updated_by_name, 'admin');
});

test('bulk changes and batch creation name the person, a deleted account leaves no name', async () => {
    const { id } = (await editor('POST', '/mangas', { title: 'Viele' })).body;
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 2 })).body.created, 2);
    const vols = (await admin('GET', `/mangas/${id}`)).body.volumes;
    assert.deepEqual(vols.map((v) => v.updated_by_name), ['Jörg', 'Jörg']);

    const tmp = (await admin('POST', '/users', { username: 'kurz', password: 'password123', role: 'editor' })).body.user.id;
    const other = ctx.client();
    assert.equal((await other('POST', '/auth/login', { username: 'kurz', password: 'password123' })).status, 200);
    const bulk = await other('POST', '/volumes/bulk', { ids: vols.map((v) => v.id), set: { price: 7.5 } });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    assert.deepEqual((await admin('GET', `/mangas/${id}`)).body.volumes.map((v) => v.updated_by_name), ['kurz', 'kurz']);

    assert.equal((await admin('DELETE', `/users/${tmp}`)).status, 200);
    const after = (await admin('GET', `/mangas/${id}`)).body.volumes;
    assert.deepEqual(after.map((v) => [v.updated_by, v.updated_by_name]), [[null, null], [null, null]]);
});

test('the series detail names who last changed the series itself', async () => {
    const { id } = (await admin('POST', '/mangas', { title: 'Reihe mit Namen' })).body;
    assert.equal((await admin('GET', `/mangas/${id}`)).body.updated_by_name, 'admin');
    assert.equal((await editor('PUT', `/mangas/${id}`, { title: 'Reihe mit Namen', description: 'Neu' })).status, 200);
    const detail = (await admin('GET', `/mangas/${id}`)).body;
    assert.equal(detail.updated_by_name, 'Jörg');
    assert.ok(detail.updated_at);
});
