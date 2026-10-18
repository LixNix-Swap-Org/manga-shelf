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
    assert.equal((await admin('POST', '/users', { username: 'gast', password: 'password123', role: 'visitor' })).status, 200);
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
    assert.equal(own.name, 'Sammlung von anna');
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

test('shelves: a read-only account is never more than a viewer of a shelf', async () => {
    const shelf = await myShelf(anna);
    const higher = await anna('POST', `/shelves/${shelf.id}/members`, { username: 'gast', role: 'editor' });
    assert.deepEqual([higher.status, higher.body.code], [400, 'SHELF_ROLE_CAPPED']);
    assert.equal((await anna('POST', `/shelves/${shelf.id}/members`, { username: 'gast', role: 'viewer' })).status, 201);
    const gastId = (await guest('GET', '/auth/me')).body.user.id;
    assert.equal((await anna('PUT', `/shelves/${shelf.id}/members/${gastId}`, { role: 'owner' })).status, 400);
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

test('shelves: user creation modes - household by default, personal, share_same and share_mutual only from own shelves', async () => {
    const adminId = (await admin('GET', '/auth/me')).body.user.id;
    const home = (await admin('GET', '/shelves')).body.shelves.find(s => s.is_default);
    const login = async (username) => {
        const client = ctx.client();
        assert.equal((await client('POST', '/auth/login', { username, password: 'password123' })).status, 200, username);
        return client;
    };
    const create = (username, extra = {}) => admin('POST', '/users', { username, password: 'password123', role: 'editor', ...extra });
    const userNames = async () => (await admin('GET', '/users')).body.map(u => u.username);

    // 1. no shelf fields: the household shelf, as editor
    assert.equal((await create('user_h')).status, 200);
    const shelvesH = (await (await login('user_h'))('GET', '/shelves')).body.shelves;
    assert.deepEqual(shelvesH.map(s => [s.id, s.role]), [[home.id, 'editor']]);

    // 2. personal: an own empty shelf
    const resA = await create('user_a', { shelf_mode: 'personal' });
    assert.equal(resA.status, 200);
    const userA = await login('user_a');
    const shelvesA = (await userA('GET', '/shelves')).body.shelves;
    assert.deepEqual(shelvesA.map(s => [s.role, s.is_default]), [['owner', false]]);

    // 3. share_same / share_mutual with a shelf the admin does not own: 400 and no account is left behind
    for (const mode of ['share_same', 'share_mutual']) {
        const refused = await create(`user_x_${mode}`, { shelf_mode: mode, share_with_user_id: resA.body.user.id });
        assert.equal(refused.status, 400, mode);
        assert.equal((await userNames()).includes(`user_x_${mode}`), false, `${mode}: rolled back`);
    }
    assert.equal((await userA('GET', '/shelves')).body.shelves.length, 1, 'user_a got nobody added without consent');
    // user_h's shelf is the household shelf the admin owns: share_same works, share_mutual stays the admin's own choice
    const userH = (await admin('GET', '/users')).body.find(u => u.username === 'user_h').id;
    const mutual = await create('user_x_mutual_h', { shelf_mode: 'share_mutual', share_with_user_id: userH });
    assert.deepEqual([mutual.status, mutual.body.code], [400, 'SHELF_SHARE_USER']);
    assert.equal((await create('user_g', { shelf_mode: 'share_same', share_with_user_id: userH })).status, 200);
    assert.deepEqual((await (await login('user_g'))('GET', '/shelves')).body.shelves.map(s => [s.id, s.role]), [[home.id, 'editor']]);
    assert.equal((await (await login('user_h'))('GET', '/shelves')).body.shelves.length, 1, 'user_h got no shelf of user_g');

    // 4. share_same with the admin itself: the admin's own (household) shelf, as viewer when asked
    assert.equal((await create('user_b', { shelf_mode: 'share_same', share_with_user_id: String(adminId), share_role: 'viewer' })).status, 200);
    const userB = await login('user_b');
    const shelvesB = (await userB('GET', '/shelves')).body.shelves;
    assert.deepEqual(shelvesB.map(s => [s.id, s.role]), [[home.id, 'viewer']]);
    assert.equal((await userB('POST', '/mangas', { title: 'Forbidden', shelf_id: home.id })).status, 403);

    // 5. the granted role is capped at the role of the account it is shared from (user_b is a viewer there)
    assert.equal((await create('user_d', { shelf_mode: 'share_same', share_with_user_id: (await userB('GET', '/auth/me')).body.user.id, share_role: 'editor' })).status, 200);
    assert.deepEqual((await (await login('user_d'))('GET', '/shelves')).body.shelves.map(s => [s.id, s.role]), [[home.id, 'viewer']]);

    // 6. share_mutual with the admin: an own shelf, editor in the admin's shelf, and the admin edits the new one
    assert.equal((await create('user_c', { shelf_mode: 'share_mutual', share_with_user_id: adminId, share_role: 'editor' })).status, 200);
    const shelvesC = (await (await login('user_c'))('GET', '/shelves')).body.shelves;
    assert.equal(shelvesC.length, 2);
    const ownC = shelvesC.find(s => s.role === 'owner');
    assert.ok(ownC && !ownC.is_default);
    assert.ok(shelvesC.some(s => s.id === home.id && s.role === 'editor'));
    assert.ok((await admin('GET', '/shelves')).body.shelves.some(s => s.id === ownC.id && s.role === 'editor'));

    // 7. bad values answer 400
    assert.equal((await create('user_bad1', { shelf_mode: 'everything' })).status, 400);
    assert.equal((await create('user_bad2', { shelf_mode: 'share_same', share_with_user_id: '1e0' })).status, 400);
    assert.equal((await create('user_bad3', { shelf_mode: 'share_same', share_with_user_id: 987654 })).status, 400);
    assert.equal((await create('user_bad4', { separate_shelf: 'false' })).status, 400);
    assert.equal((await create('user_bad5', { shelf_mode: 'household', share_role: 'owner' })).status, 400);
    assert.equal((await userNames()).some(n => n.startsWith('user_bad')), false);

    // 8. a visitor or guest gets no shelf of its own (it could not fill it): personal and share_mutual answer 400
    for (const [role, extra] of [['visitor', { shelf_mode: 'personal' }], ['guest', { shelf_mode: 'share_mutual', share_with_user_id: adminId }], ['visitor', { separate_shelf: true }]]) {
        const refused = await create(`user_ro_${role}_${Object.keys(extra)[0]}`, { role, ...extra });
        assert.deepEqual([refused.status, refused.body.code], [400, 'SHELF_MODE'], `${role} ${JSON.stringify(extra)}`);
    }
    assert.equal((await userNames()).some(n => n.startsWith('user_ro_')), false);
    assert.equal((await create('user_ro_same', { role: 'guest', shelf_mode: 'share_same', share_with_user_id: adminId })).status, 200);
    assert.deepEqual((await (await login('user_ro_same'))('GET', '/shelves')).body.shelves.map(s => [s.id, s.role]), [[home.id, 'viewer']]);

    // 9. a new admin joins the household shelf as editor, never as owner, and cannot add accounts there
    assert.equal((await admin('POST', '/users', { username: 'admin_two', password: 'password123', role: 'admin', current_password: 'password123' })).status, 200);
    const adminTwo = await login('admin_two');
    assert.deepEqual((await adminTwo('GET', '/shelves')).body.shelves.map(s => [s.id, s.role]), [[home.id, 'editor']]);
    const notOwner = await adminTwo('POST', '/users', { username: 'user_e', password: 'password123', role: 'editor' });
    assert.deepEqual([notOwner.status, notOwner.body.code], [400, 'SHELF_NOT_OWNER']);
    assert.equal((await adminTwo('POST', '/users', { username: 'user_e', password: 'password123', role: 'editor', shelf_mode: 'personal' })).status, 200);
});

let outsiderClient;
const outsider = async (...args) => {
    if (!outsiderClient) {
        assert.equal((await admin('POST', '/users', { username: 'carl', password: 'password123', role: 'editor', separate_shelf: true })).status, 200);
        outsiderClient = ctx.client();
        assert.equal((await outsiderClient('POST', '/auth/login', { username: 'carl', password: 'password123' })).status, 200);
    }
    return outsiderClient(...args);
};

test('shelves: malformed ids cannot slip past the shelf guard', async () => {
    const id = (await anna('POST', '/mangas', { title: 'Guarded' })).body.id;
    const vol = (await anna('POST', '/volumes', { manga_id: id, volume_number: '1' })).body.id;
    for (const bad of [`${id}x`, `+${id}`, `%20${id}`, `${id}.0`]) {
        assert.equal((await outsider('GET', `/mangas/${bad}/gaps`)).status, 404, `gaps ${bad}`);
        assert.equal((await outsider('GET', `/mangas/${bad}`)).status, 404, `detail ${bad}`);
        assert.equal((await outsider('POST', `/volumes/${bad}/read`, { read: true })).status, 404, `read ${bad}`);
        assert.equal((await outsider('POST', `/volumes/${bad}/owners`, { owned: true })).status, 404, `owners ${bad}`);
        assert.equal((await outsider('PUT', `/volumes/${bad}`, { notes: 'x' })).status, 404, `put ${bad}`);
    }
    assert.equal((await outsider('GET', `/mangas/${id}/gaps`)).status, 404);
    assert.equal((await anna('GET', `/mangas/${id}`)).status, 200);
    assert.ok(vol);
});

test('shelves: readers and owners of a series are the shelf members, not every account', async () => {
    const id = (await anna('POST', '/mangas', { title: 'Members Only' })).body.id;
    const names = async (client) => (await client('GET', `/mangas/${id}`)).body.reader_stats.map(r => r.username).sort();
    const initial = await names(anna);
    assert.ok(!initial.includes('admin') && !initial.includes('carl'), 'accounts outside the shelf stay out');
    assert.deepEqual((await anna('GET', '/offline-snapshot')).body.details[id].reader_stats.map(r => r.username).sort(), initial);
    const shelf = await myShelf(anna);
    const before = await names(anna);
    assert.ok(!before.includes('carl'));
    await anna('POST', `/shelves/${shelf.id}/members`, { username: 'carl', role: 'viewer' });
    assert.deepEqual(await names(anna), [...before, 'carl'].sort());
});

test('shelves: deleting an account hands its shelves to the deleting admin, empty ones go', async () => {
    const adminId = (await admin('GET', '/auth/me')).body.user.id;
    const cleo = ctx.client();
    const cleoId = (await admin('POST', '/users', { username: 'cleo', password: 'password123', role: 'editor', separate_shelf: true })).body.user.id;
    await cleo('POST', '/auth/login', { username: 'cleo', password: 'password123' });
    const full = await myShelf(cleo);
    const seriesId = (await cleo('POST', '/mangas', { title: 'Cleo Only' })).body.id;
    const empty = (await cleo('POST', '/shelves', { name: 'Leer' })).body.id;
    assert.equal((await admin('GET', `/mangas/${seriesId}`)).status, 404);
    assert.equal((await admin('DELETE', `/users/${cleoId}`)).status, 200);
    const shelves = (await admin('GET', '/shelves')).body.shelves;
    const kept = shelves.find(s => s.id === full.id);
    assert.ok(kept, 'the shelf with series survives');
    assert.equal(kept.role, 'owner');
    assert.equal(shelves.some(s => s.id === empty), false, 'the empty shelf is removed');
    assert.equal((await admin('GET', `/mangas/${seriesId}`)).status, 200);
    assert.ok(adminId);
});

test('shelves: only an owner of the source shelf can move a series out of it', async () => {
    const own = await myShelf(anna);
    const benShelf = await myShelf(ben);
    const id = (await anna('POST', '/mangas', { title: 'Bleibt hier' })).body.id;
    await anna('POST', `/shelves/${own.id}/members`, { username: 'ben', role: 'editor' });
    assert.equal((await ben('PUT', `/mangas/${id}/shelf`, { shelf_id: benShelf.id })).status, 403, 'an editor member cannot take it away');
    assert.equal((await anna('GET', `/mangas/${id}`)).status, 200, 'the series stays in the owner shelf');
    await ben('POST', `/shelves/${benShelf.id}/members`, { username: 'anna', role: 'editor' });
    assert.equal((await anna('PUT', `/mangas/${id}/shelf`, { shelf_id: benShelf.id })).status, 200, 'the owner can move it');
    await ben('DELETE', `/shelves/${benShelf.id}/members/${annaId}`);
    await anna('DELETE', `/shelves/${own.id}/members/${benId}`);
});

test('shelves: leaving or being removed takes ownership and reading marks of that shelf along', async () => {
    const own = await myShelf(anna);
    const id = (await anna('POST', '/mangas', { title: 'Marken-Test' })).body.id;
    const alone = (await anna('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt' })).body.id;
    const shared = (await anna('POST', '/volumes', { manga_id: id, volume_number: '2', status: 'Fehlt' })).body.id;
    await anna('POST', `/shelves/${own.id}/members`, { username: 'ben', role: 'editor' });
    for (const vol of [alone, shared]) {
        assert.equal((await ben('POST', `/volumes/${vol}/owners`, { owned: true })).status, 200);
        assert.equal((await ben('POST', `/volumes/${vol}/read`, { read: true })).status, 200);
    }
    assert.equal((await anna('POST', `/volumes/${shared}/owners`, { owned: true })).status, 200);
    assert.equal((await anna('DELETE', `/shelves/${own.id}/members/${benId}`)).status, 200);
    const volumes = (await anna('GET', `/mangas/${id}`)).body.volumes;
    const one = volumes.find(v => v.id === alone);
    const two = volumes.find(v => v.id === shared);
    assert.equal(one.owners.length, 0, 'no owner left on the volume only ben owned');
    assert.equal(one.status, 'Fehlt');
    assert.deepEqual(two.owners.map(o => o.user_id), [annaId], 'the other owner stays');
    assert.equal(two.status, 'Vorhanden');
    assert.equal(volumes.some(v => (v.read_users || []).some(r => r.user_id === benId)), false, 'ben reading marks are gone');
});

test('shelves: losing the last shelf creates a personal shelf instead of auto-joining the household shelf', async () => {
    const dora = ctx.client();
    const doraId = (await admin('POST', '/users', { username: 'dora', password: 'password123', role: 'editor', separate_shelf: true })).body.user.id;
    await dora('POST', '/auth/login', { username: 'dora', password: 'password123' });
    const doraShelf = await myShelf(dora);
    const annaShelf = await myShelf(anna);
    await anna('POST', `/shelves/${annaShelf.id}/members`, { username: 'dora', role: 'editor' });
    assert.equal((await dora('DELETE', `/shelves/${doraShelf.id}`)).status, 200);
    assert.equal((await anna('DELETE', `/shelves/${annaShelf.id}/members/${doraId}`)).status, 200);
    const after = (await dora('GET', '/shelves')).body.shelves;
    assert.equal(after.length, 1, 'dora gets a fresh personal shelf');
    assert.equal(after[0].is_default, false, 'dora is not placed into the default household shelf');
    assert.equal(after[0].role, 'owner');
    assert.deepEqual((await dora('GET', '/mangas')).body, [], 'dora cannot see household series');
});

test('shelves: moving a series strips marks of non-target members and moves trashed volumes along', async () => {
    const own = await myShelf(anna);
    const target = (await anna('POST', '/shelves', { name: 'Archiv' })).body;
    await anna('POST', `/shelves/${own.id}/members`, { username: 'ben', role: 'editor' });
    const id = (await anna('POST', '/mangas', { title: 'Umzugs-Reihe', shelf_id: own.id })).body.id;
    const v1 = (await anna('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt' })).body.id;
    const v2 = (await anna('POST', '/volumes', { manga_id: id, volume_number: '2', status: 'Vorhanden' })).body.id;
    assert.equal((await ben('POST', `/volumes/${v1}/owners`, { owned: true })).status, 200);
    assert.equal((await ben('POST', `/volumes/${v1}/read`, { read: true })).status, 200);
    const trashId = (await anna('DELETE', `/volumes/${v2}`)).body.trash_id;
    assert.equal((await anna('PUT', `/mangas/${id}/shelf`, { shelf_id: target.id })).status, 200);
    const detail = (await anna('GET', `/mangas/${id}`)).body;
    assert.equal(detail.shelf_id, target.id);
    const vol1 = detail.volumes.find(v => v.id === v1);
    assert.equal(vol1.owners.length, 0, 'ben is not a member of Archiv, so his ownership is removed');
    assert.equal(vol1.status, 'Fehlt');
    assert.equal((vol1.read_users || []).some(r => r.user_id === benId), false, 'ben reading mark is removed');
    assert.equal((await ben('GET', '/trash')).body.items.some(t => t.id === trashId), false, 'trashed volume moved to target shelf');
    await anna('DELETE', `/shelves/${own.id}/members/${benId}`);
});

test('shelves: maintenance fix only modifies series in the caller editable shelves', async () => {
    const { db } = require('../db');
    const annaSeries = (await anna('POST', '/mangas', { title: 'Anna Publisher' })).body.id;
    const benSeries = (await ben('POST', '/mangas', { title: 'Ben Publisher' })).body.id;
    db.prepare('UPDATE mangas SET publisher = ? WHERE id = ?').run('Tokyopop', annaSeries);
    db.prepare('UPDATE mangas SET publisher = ? WHERE id = ?').run('Tokyopop', benSeries);
    const res = await anna('POST', '/maintenance/fix', { check: 'normalize_publishers' });
    assert.equal(res.status, 200);
    assert.equal(res.body.changed, 1);
    assert.equal((await anna('GET', `/mangas/${annaSeries}`)).body.publisher, 'TOKYOPOP');
    assert.equal((await ben('GET', `/mangas/${benSeries}`)).body.publisher, 'Tokyopop', 'ben shelf is untouched by anna maintenance fix');
});

