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
