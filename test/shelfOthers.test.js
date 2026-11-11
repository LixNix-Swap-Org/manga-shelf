// GET /api/shelves/others: an admin learns that shelves without him exist (name, Verwalter, counts), never their content.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let lea;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    lea = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    await admin('POST', '/users', { username: 'lea', password: 'password123', role: 'editor' });
    assert.equal((await lea('POST', '/auth/login', { username: 'lea', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

test('admins see the private shelves of others with name, Verwalter and counts only', async () => {
    const shelf = (await lea('POST', '/shelves', { name: 'Leas Regal' })).body;
    await lea('POST', '/mangas', { title: 'Frieren', shelf_id: shelf.id });
    const res = await admin('GET', '/shelves/others');
    assert.equal(res.status, 200);
    const row = res.body.shelves.find((s) => s.id === shelf.id);
    assert.deepEqual(Object.keys(row).sort(), ['color', 'id', 'managers', 'member_count', 'name', 'series_count']);
    assert.deepEqual([row.name, row.managers, row.series_count, row.member_count], ['Leas Regal', ['lea'], 1, 1]);
    const mine = (await admin('GET', '/shelves')).body.shelves.map((s) => s.id);
    assert.ok(res.body.shelves.every((s) => !mine.includes(s.id)), 'own shelves are not listed');
    assert.equal((await admin('GET', `/shelves/${shelf.id}`)).status, 404, 'the content stays closed');
});

test('other accounts may not ask', async () => {
    assert.equal((await lea('GET', '/shelves/others')).status, 403);
});
