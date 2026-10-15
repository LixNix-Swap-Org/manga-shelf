// Shelves: isolation between accounts, sharing with a role, moving a series, members, scoping of lists and statistics.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let anna;
let ben;
let guest;
let annaId;
let benId;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    anna = ctx.client();
    ben = ctx.client();
    guest = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    annaId = (await admin('POST', '/users', { username: 'anna', password: 'password123', role: 'editor', separate_shelf: true })).body.user.id;
    benId = (await admin('POST', '/users', { username: 'ben', password: 'password123', role: 'editor', separate_shelf: true })).body.user.id;
    assert.equal((await admin('POST', '/users', { username: 'gast', password: 'password123', role: 'visitor', separate_shelf: true })).status, 200);
    assert.equal((await anna('POST', '/auth/login', { username: 'anna', password: 'password123' })).status, 200);
    assert.equal((await ben('POST', '/auth/login', { username: 'ben', password: 'password123' })).status, 200);
    assert.equal((await guest('POST', '/auth/login', { username: 'gast', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

const myShelf = async (client) => (await client('GET', '/shelves')).body.shelves[0];

test('shelves: separate accounts start with an own empty shelf, the first admin keeps the household shelf', async () => {
    const adminShelves = (await admin('GET', '/shelves')).body.shelves;
    assert.equal(adminShelves.length, 1);
    assert.equal(adminShelves[0].is_default, true);
    assert.equal(adminShelves[0].role, 'owner');
    const own = await myShelf(anna);
    assert.equal(own.role, 'owner');
    assert.equal(own.series_count, 0);
    assert.notEqual(own.id, adminShelves[0].id);
});

test('shelves: a foreign shelf is invisible everywhere and its ids answer 404', async () => {
    const id = (await anna('POST', '/mangas', { title: 'Anna Only' })).body.id;
    await anna('POST', '/volumes', { manga_id: id, volume_number: '1', price: 7.5 });
    assert.equal((await ben('GET', '/mangas')).body.length, 0);
    assert.equal((await ben('GET', `/mangas/${id}`)).status, 404);
    assert.equal((await ben('PUT', `/mangas/${id}`, { title: 'Hacked' })).status, 404);
    assert.equal((await ben('POST', '/volumes', { manga_id: id, volume_number: '2' })).status, 404);
    assert.equal((await ben('DELETE', `/mangas/${id}`)).status, 404);
    assert.equal((await ben('GET', '/stats')).body.summary.total_series, 0);
    assert.equal((await anna('GET', '/stats')).body.summary.total_series, 1);
    assert.equal((await admin('GET', '/mangas')).body.some(m => m.id === id), false, 'server admins see no foreign shelves');
    assert.equal((await ben('GET', '/offline-snapshot')).body.mangas.length, 0);
    assert.equal((await ben('GET', `/shelves/${(await myShelf(anna)).id}`)).status, 404);
});

test('shelves: sharing as viewer reads, editor writes, removing the member closes the door', async () => {
    const shelf = await myShelf(anna);
    const [series] = (await anna('GET', '/mangas')).body;
    const added = await anna('POST', `/shelves/${shelf.id}/members`, { username: 'ben', role: 'viewer' });
    assert.equal(added.status, 201);
    assert.equal(added.body.members.length, 2);
    assert.equal((await ben('GET', `/mangas/${series.id}`)).status, 200);
    assert.equal((await ben('GET', '/mangas')).body.length, 1);
    assert.equal((await ben('PUT', `/mangas/${series.id}`, { title: 'Nope' })).status, 403);
    assert.equal((await ben('POST', `/shelves/${shelf.id}/members`, { username: 'gast' })).status, 403);

    assert.equal((await anna('PUT', `/shelves/${shelf.id}/members/${benId}`, { role: 'editor' })).status, 200);
    assert.equal((await ben('PUT', `/mangas/${series.id}`, { title: 'Anna Only' })).status, 200);
    assert.equal((await ben('POST', '/volumes', { manga_id: series.id, volume_number: '2' })).status, 200);

    assert.equal((await anna('DELETE', `/shelves/${shelf.id}/members/${benId}`)).status, 200);
    assert.equal((await ben('GET', `/mangas/${series.id}`)).status, 404);
});

test('shelves: a read-only account is capped at viewer even with an editor membership', async () => {
    const shelf = await myShelf(anna);
    assert.equal((await anna('POST', `/shelves/${shelf.id}/members`, { username: 'gast', role: 'editor' })).status, 201);
    const [series] = (await anna('GET', '/mangas')).body;
    assert.equal((await guest('GET', `/mangas/${series.id}`)).status, 200);
    assert.equal((await guest('PUT', `/mangas/${series.id}`, { title: 'x' })).status, 403);
    assert.equal((await guest('POST', '/volumes', { manga_id: series.id, volume_number: '9' })).status, 403);
});

test('shelves: members rules - last owner stays, members can leave, unknown users and roles are rejected', async () => {
    const shelf = await myShelf(anna);
    assert.equal((await anna('PUT', `/shelves/${shelf.id}/members/${annaId}`, { role: 'viewer' })).status, 409);
    assert.equal((await anna('DELETE', `/shelves/${shelf.id}/members/${annaId}`)).status, 409);
    assert.equal((await anna('POST', `/shelves/${shelf.id}/members`, { username: 'niemand' })).status, 404);
    assert.equal((await anna('POST', `/shelves/${shelf.id}/members`, { username: 'ben', role: 'boss' })).status, 400);
    assert.equal((await anna('POST', `/shelves/${shelf.id}/members`, { username: 'ben', role: 'viewer' })).status, 201);
    assert.equal((await anna('POST', `/shelves/${shelf.id}/members`, { username: 'ben', role: 'viewer' })).status, 409);
    assert.equal((await ben('DELETE', `/shelves/${shelf.id}/members/${benId}`)).status, 200, 'a member may leave');
    assert.equal((await ben('GET', `/shelves/${shelf.id}`)).status, 404);
});

test('shelves: create, rename, delete only when empty, the default shelf stays', async () => {
    const made = await ben('POST', '/shelves', { name: 'Lesestapel', color: '#ff0000' });
    assert.equal(made.status, 201);
    assert.equal(made.body.role, 'owner');
    assert.equal((await ben('POST', '/shelves', { name: '  ' })).status, 400);
    assert.equal((await ben('PUT', `/shelves/${made.body.id}`, { name: 'Stapel' })).body.name, 'Stapel');
    const id = (await ben('POST', '/mangas', { title: 'In Stapel', shelf_id: made.body.id })).body.id;
    assert.equal((await ben('GET', `/mangas/${id}`)).body.shelf_id, made.body.id);
    assert.equal((await ben('DELETE', `/shelves/${made.body.id}`)).status, 409);
    assert.equal((await ben('DELETE', `/mangas/${id}`)).status, 200);
    assert.equal((await ben('DELETE', `/shelves/${made.body.id}`)).status, 200);
    const home = (await admin('GET', '/shelves')).body.shelves[0];
    const delHome = await admin('DELETE', `/shelves/${home.id}`);
    assert.equal(delHome.status, 409);
    assert.equal(delHome.body.code, 'SHELF_DEFAULT');
    assert.equal((await anna('POST', '/mangas', { title: 'Wrong', shelf_id: home.id })).status, 404);
});

test('shelves: moving a series needs editor rights in both shelves; trash and lookups follow the shelf', async () => {
    const own = await myShelf(ben);
    const id = (await ben('POST', '/mangas', { title: 'Wanderer' })).body.id;
    await ben('POST', '/volumes', { manga_id: id, volume_number: '1', isbn: '9783551757210' });
    const annaShelf = await myShelf(anna);
    assert.equal((await ben('PUT', `/mangas/${id}/shelf`, { shelf_id: annaShelf.id })).status, 404, 'foreign target shelf');
    await anna('POST', `/shelves/${annaShelf.id}/members`, { username: 'ben', role: 'viewer' });
    assert.equal((await ben('PUT', `/mangas/${id}/shelf`, { shelf_id: annaShelf.id })).status, 403, 'viewer in the target');
    await anna('PUT', `/shelves/${annaShelf.id}/members/${benId}`, { role: 'editor' });
    assert.equal((await ben('PUT', `/mangas/${id}/shelf`, { shelf_id: annaShelf.id })).status, 200);
    assert.equal((await ben('GET', `/mangas/${id}`)).body.shelf_id, annaShelf.id);

    // delete in the shared shelf: ben trashes, anna sees it, a stranger does not
    const trashed = (await ben('DELETE', `/mangas/${id}`)).body.trash_id;
    assert.ok((await anna('GET', '/trash')).body.items.some(i => i.id === trashed));
    assert.equal((await admin('GET', '/trash')).body.items.some(i => i.id === trashed), false);
    assert.equal((await admin('POST', `/trash/${trashed}/restore`)).status, 404);
    assert.equal((await anna('POST', `/trash/${trashed}/restore`)).status, 200);
    assert.equal((await ben('GET', `/mangas/${id}`)).status, 200);
    // ISBN lookup only matches shelves of the caller
    const outsider = ctx.client();
    assert.equal((await admin('POST', '/users', { username: 'otto', password: 'password123', role: 'editor', separate_shelf: true })).status, 200);
    await outsider('POST', '/auth/login', { username: 'otto', password: 'password123' });
    const found = await outsider('GET', '/lookup/isbn?isbn=9783551757210');
    assert.equal(found.body.matched_volume ?? null, null);
    assert.ok(own.id);
});

test('shelves: the user directory lists names only and is closed to guests', async () => {
    const res = await anna('GET', '/users/directory');
    assert.equal(res.status, 200);
    assert.ok(res.body.users.some(u => u.username === 'ben'));
    assert.deepEqual(Object.keys(res.body.users[0]).sort(), ['id', 'username']);
    assert.equal((await guest('GET', '/users/directory')).status, 403);
});

test('shelves: user creation modes - personal, share_same, and share_mutual', async () => {
    // 1. Personal shelf (default when shelf_mode is personal or separate_shelf: true)
    const userA = ctx.client();
    const resA = await admin('POST', '/users', { username: 'user_a', password: 'password123', role: 'editor', shelf_mode: 'personal' });
    assert.equal(resA.status, 200);
    await userA('POST', '/auth/login', { username: 'user_a', password: 'password123' });
    const shelvesA = (await userA('GET', '/shelves')).body.shelves;
    assert.equal(shelvesA.length, 1);
    assert.equal(shelvesA[0].role, 'owner');

    // 2. share_same as viewer: joins user_a's shelf as viewer
    const userB = ctx.client();
    const resB = await admin('POST', '/users', {
        username: 'user_b',
        password: 'password123',
        role: 'editor',
        shelf_mode: 'share_same',
        share_with_user_id: resA.body.user.id,
        share_role: 'viewer'
    });
    assert.equal(resB.status, 200);
    await userB('POST', '/auth/login', { username: 'user_b', password: 'password123' });
    const shelvesB = (await userB('GET', '/shelves')).body.shelves;
    assert.equal(shelvesB.length, 1);
    assert.equal(shelvesB[0].id, shelvesA[0].id);
    assert.equal(shelvesB[0].role, 'viewer');
    assert.equal((await userB('POST', '/mangas', { title: 'Forbidden', shelf_id: shelvesB[0].id })).status, 403);

    // 3. share_mutual: user_c gets personal shelf AND both user_a and user_c share each other's shelves
    const userC = ctx.client();
    const resC = await admin('POST', '/users', {
        username: 'user_c',
        password: 'password123',
        role: 'editor',
        shelf_mode: 'share_mutual',
        share_with_user_id: resA.body.user.id,
        share_role: 'editor'
    });
    assert.equal(resC.status, 200);
    await userC('POST', '/auth/login', { username: 'user_c', password: 'password123' });
    const shelvesC = (await userC('GET', '/shelves')).body.shelves;
    assert.equal(shelvesC.length, 2);
    assert.ok(shelvesC.some(s => s.role === 'owner'));
    assert.ok(shelvesC.some(s => s.id === shelvesA[0].id && s.role === 'editor'));

    // User A now also sees User C's shelf
    const shelvesANew = (await userA('GET', '/shelves')).body.shelves;
    assert.equal(shelvesANew.length, 2);
    assert.ok(shelvesANew.some(s => s.role === 'editor'));
});

