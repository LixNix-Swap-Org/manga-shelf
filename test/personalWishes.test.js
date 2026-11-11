// Wishlists per person (migration 57): everyone keeps their own wishes, the shelf sees them with names, and the series
// counts as wished while anybody wishes it.
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
    ids.ed = (await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).body.user.id;
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

const detailOf = async (client, id) => (await client('GET', `/mangas/${id}`)).body;
const wishedOf = async (client) => (await client('GET', '/shopping-list')).body.wished_series;

test('each person wishes on their own; everybody sees who wishes what', async () => {
    const { id } = (await admin('POST', '/mangas', { title: 'Wunschreihe', wish_priority: 1 })).body;
    let d = await detailOf(admin, id);
    assert.deepEqual(d.wishes.map((w) => [w.username, w.priority]), [['admin', 1]]);
    assert.equal(d.my_wish, 1);
    assert.equal((await detailOf(editor, id)).my_wish, null, 'the editor wishes nothing yet');

    const res = await editor('PUT', `/mangas/${id}/wish`, { priority: 3 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.wish_priority, 3, 'the series takes the highest wish');
    d = await detailOf(admin, id);
    assert.deepEqual(d.wishes.map((w) => [w.username, w.priority]), [['ed', 3], ['admin', 1]]);
    assert.equal(d.wish_priority, 3);

    const list = (await wishedOf(admin)).find((s) => s.id === id);
    assert.deepEqual(list.wishes.map((w) => w.username), ['ed', 'admin']);
    assert.equal(list.my_wish, 1);

    // the editor drops their wish: still wished by admin, at admin's priority
    assert.equal((await editor('PUT', `/mangas/${id}/wish`, { priority: null })).body.wish_priority, 1);
    // the series form changes only the own wish
    assert.equal((await admin('PUT', `/mangas/${id}`, { wish_priority: null })).status, 200);
    d = await detailOf(editor, id);
    assert.deepEqual([d.wishes, d.wish_priority, d.wished], [[], null, 0]);
    assert.ok(!(await wishedOf(editor)).some((s) => s.id === id));
});

test('an old shared wish is the household wish until somebody decides', async () => {
    const { id } = (await admin('POST', '/mangas', { title: 'Alter Wunsch' })).body;
    // as migration 57 leaves it: a household row for the old shared value
    require('../db').db.prepare('INSERT INTO series_wishes (manga_id, user_id, priority) VALUES (?, NULL, 2)').run(id);
    let d = await detailOf(editor, id);
    assert.deepEqual([d.wish_priority, d.household_wish, d.my_wish], [2, 2, null]);
    assert.deepEqual(d.wishes.map((w) => [w.user_id, w.priority]), [[null, 2]]);
    assert.equal((await editor('PUT', `/mangas/${id}/wish`, { priority: 1 })).status, 200);
    d = await detailOf(editor, id);
    assert.deepEqual(d.wishes.map((w) => [w.username, w.priority]), [['ed', 1]], 'the household wish gave way');
});

test('wishes go to the trash with the series and come back', async () => {
    const { id } = (await admin('POST', '/mangas', { title: 'Weg und zurück', wish_priority: 2 })).body;
    await editor('PUT', `/mangas/${id}/wish`, { priority: 0 });
    assert.equal((await admin('DELETE', `/mangas/${id}`)).status, 200);
    const trash = (await admin('GET', '/trash')).body;
    const entry = (trash.items || trash.entries || trash).find((e) => e.kind === 'manga' && e.ref_id === id);
    assert.equal((await admin('POST', `/trash/${entry.id}/restore`)).status, 200);
    const d = await detailOf(admin, id);
    assert.deepEqual(d.wishes.map((w) => [w.username, w.priority]), [['admin', 2], ['ed', 0]]);
    assert.equal(d.wish_priority, 2);
});

test('a wish needs a valid priority and access to the series', async () => {
    const { id } = (await admin('POST', '/mangas', { title: 'Prüfung' })).body;
    assert.equal((await editor('PUT', `/mangas/${id}/wish`, { priority: 7 })).status, 400);
    assert.equal((await editor('PUT', `/mangas/${id}/wish`, {})).status, 400);
    const shelf = (await admin('POST', '/shelves', { name: 'Privat' })).body;
    const hidden = (await admin('POST', '/mangas', { title: 'Geheim', shelf_id: shelf.id })).body;
    assert.equal((await editor('PUT', `/mangas/${hidden.id}/wish`, { priority: 1 })).status, 404);
});

test('a person who leaves the shelf: their wish no longer shows or counts, and returns with them', async () => {
    const shelf = (await admin('POST', '/shelves', { name: 'Gemeinsam' })).body;
    assert.ok((await admin('POST', `/shelves/${shelf.id}/members`, { username: 'ed', role: 'editor' })).status < 300);
    const { id } = (await admin('POST', '/mangas', { title: 'Nur Ed', shelf_id: shelf.id })).body;
    await editor('PUT', `/mangas/${id}/wish`, { priority: 2 });
    assert.equal((await detailOf(admin, id)).wish_priority, 2);
    assert.equal((await editor('DELETE', `/shelves/${shelf.id}/members/${ids.ed}`)).status, 200);
    let d = await detailOf(admin, id);
    assert.deepEqual([d.wishes, d.wish_priority], [[], null]);
    assert.ok((await admin('POST', `/shelves/${shelf.id}/members`, { username: 'ed', role: 'editor' })).status < 300);
    d = await detailOf(admin, id);
    assert.deepEqual([d.wishes.map((w) => w.username), d.wish_priority], [['ed'], 2]);
});
