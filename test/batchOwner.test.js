// POST /api/volumes/batch with owner_user_id: whose copies the new owned volumes become ("Für wen?" in the dialog).
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
    ids.felix = (await admin('POST', '/users', { username: 'felix', password: 'password123', role: 'editor' })).body.user.id;
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

const ownersOf = async (client, mangaId) => {
    const detail = (await client('GET', `/mangas/${mangaId}`)).body;
    return Object.fromEntries(detail.volumes.map((v) => [v.volume_number, { status: v.status, owners: (v.copies || []).map((c) => c.owner_user_id) }]));
};

test('without owner_user_id the caller owns the new volumes (as before)', async () => {
    const { id } = (await editor('POST', '/mangas', { title: 'Wie bisher' })).body;
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 2 })).body.created, 2);
    const vols = await ownersOf(editor, id);
    assert.deepEqual(vols['1'], { status: 'Vorhanden', owners: [ids.ed] });
});

test('owner_user_id null: owned by nobody yet, a household copy that the first person to tick it claims', async () => {
    const { id } = (await editor('POST', '/mangas', { title: 'Noch niemand' })).body;
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 3, owner_user_id: null })).body.created, 3);
    let vols = await ownersOf(editor, id);
    assert.deepEqual(vols['2'], { status: 'Vorhanden', owners: [null] });
    const volId = (await editor('GET', `/mangas/${id}`)).body.volumes.find((v) => v.volume_number === '2').id;
    assert.equal((await editor('POST', `/volumes/${volId}/owners`, { owned: true })).status, 200);
    vols = await ownersOf(editor, id);
    assert.deepEqual(vols['2'].owners, [ids.ed], 'the household copy went to the editor');
});

test('owner_user_id of another member: admins only, and only members of the shelf', async () => {
    const { id } = (await admin('POST', '/mangas', { title: 'Für Felix' })).body;
    assert.equal((await admin('POST', '/volumes/batch', { manga_id: id, from: 1, to: 2, owner_user_id: ids.felix })).body.created, 2);
    assert.deepEqual((await ownersOf(admin, id))['1'].owners, [ids.felix]);

    const own = (await editor('POST', '/mangas', { title: 'Nicht für andere' })).body;
    const refused = await editor('POST', '/volumes/batch', { manga_id: own.id, from: 1, to: 2, owner_user_id: ids.felix });
    assert.equal(refused.status, 403);
    assert.equal((await editor('GET', `/mangas/${own.id}`)).body.volumes.length, 0, 'nothing was created');
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: own.id, from: 1, to: 1, owner_user_id: ids.ed })).status, 200, 'oneself is fine');

    const shelf = (await admin('POST', '/shelves', { name: 'Nur Admin' })).body;
    const lone = (await admin('POST', '/mangas', { title: 'Allein', shelf_id: shelf.id })).body;
    assert.equal((await admin('POST', '/volumes/batch', { manga_id: lone.id, from: 1, to: 1, owner_user_id: ids.felix })).status, 404, 'felix is no member there');
    assert.equal((await admin('POST', '/volumes/batch', { manga_id: lone.id, from: 1, to: 1, owner_user_id: 'x' })).status, 400);
});

test('missing volumes stay without copies whatever owner_user_id says', async () => {
    const { id } = (await admin('POST', '/mangas', { title: 'Fehlt' })).body;
    await admin('POST', '/volumes/batch', { manga_id: id, from: 1, to: 2, status: 'Fehlt', owner_user_id: ids.felix });
    assert.deepEqual((await ownersOf(admin, id))['1'], { status: 'Fehlt', owners: [] });
});

test('reader_stats count each person\'s own copies and what they read of them ("4 von deinen 8")', async () => {
    const { id } = (await admin('POST', '/mangas', { title: 'Eigene Bände' })).body;
    await admin('POST', '/volumes/batch', { manga_id: id, from: 1, to: 3 });
    await admin('POST', '/volumes/batch', { manga_id: id, from: 4, to: 5, owner_user_id: ids.felix });
    const vols = (await admin('GET', `/mangas/${id}`)).body.volumes;
    const v = (n) => vols.find((x) => x.volume_number === String(n)).id;
    await admin('POST', `/volumes/${v(1)}/read`, { read: true });
    await admin('POST', `/volumes/${v(4)}/read`, { read: true });
    const stats = (await admin('GET', `/mangas/${id}`)).body.reader_stats;
    const me = stats.find((r) => r.username === 'admin');
    const felix = stats.find((r) => r.user_id === ids.felix);
    assert.deepEqual([me.read_count, me.total_owned, me.own_read, me.own_owned], [2, 5, 1, 3]);
    assert.deepEqual([felix.own_read, felix.own_owned], [0, 2]);
});

test('the series list names every owner with the number of volumes they own (owner row of the collection card)', async () => {
    const { id } = (await editor('POST', '/mangas', { title: 'Wer hat wie viele' })).body;
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 3 })).body.created, 3);
    const volId = (await admin('GET', `/mangas/${id}`)).body.volumes.find((v) => v.volume_number === '1').id;
    assert.equal((await admin('POST', `/volumes/${volId}/owners`, { owned: true })).status, 200);
    const row = (await admin('GET', '/mangas')).body.find((m) => m.id === id);
    const owners = Object.fromEntries(row.owners.split('\n').map((line) => { const [, name, count] = line.split('\t'); return [name, Number(count)]; }));
    assert.deepEqual(owners, { admin: 1, ed: 3 });
});

test('POST /volumes (single volume and gap fill) accepts owner_user_id like /volumes/batch', async () => {
    const { id } = (await admin('POST', '/mangas', { title: 'Einzelband Für wen' })).body;
    assert.equal((await admin('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Vorhanden', owner_user_id: ids.felix })).status, 200);
    assert.equal((await admin('POST', '/volumes', { manga_id: id, volume_number: '2', status: 'Vorhanden', owner_user_id: null })).status, 200);
    const vols = await ownersOf(admin, id);
    assert.deepEqual(vols['1'], { status: 'Vorhanden', owners: [ids.felix] });
    assert.deepEqual(vols['2'], { status: 'Vorhanden', owners: [null] });

    const refused = await editor('POST', '/volumes', { manga_id: id, volume_number: '3', status: 'Vorhanden', owner_user_id: ids.felix });
    assert.equal(refused.status, 403);
    assert.equal((await admin('GET', `/mangas/${id}`)).body.volumes.length, 2);
});

test('PUT /volumes/:id accepts owner_user_id when setting status to Vorhanden (household copy or admin target)', async () => {
    const { id } = (await admin('POST', '/mangas', { title: 'Shopping PUT Owner' })).body;
    await admin('POST', '/volumes/batch', { manga_id: id, from: 1, to: 2, status: 'Fehlt' });
    const vols = (await admin('GET', `/mangas/${id}`)).body.volumes;
    const v1 = vols.find((v) => v.volume_number === '1').id;
    const v2 = vols.find((v) => v.volume_number === '2').id;

    assert.equal((await editor('PUT', `/volumes/${v1}`, { status: 'Vorhanden', owner_user_id: ids.felix })).status, 403);
    assert.equal((await editor('PUT', `/volumes/${v1}`, { status: 'Vorhanden', owner_user_id: null })).status, 200);
    assert.equal((await admin('PUT', `/volumes/${v2}`, { status: 'Vorhanden', owner_user_id: ids.felix })).status, 200);

    const after = await ownersOf(admin, id);
    assert.deepEqual(after['1'], { status: 'Vorhanden', owners: [null] });
    assert.deepEqual(after['2'], { status: 'Vorhanden', owners: [ids.felix] });
});

test('GET /shelves includes non-read-only members in people and excludes visitors', async () => {
    await admin('POST', '/users', { username: 'besucher', password: 'password123', role: 'visitor' });
    const shelves = (await admin('GET', '/shelves')).body.shelves;
    const names = shelves[0].people.map((p) => p.username);
    assert.ok(names.includes('admin'));
    assert.ok(names.includes('ed'));
    assert.ok(names.includes('felix'));
    assert.ok(!names.includes('besucher'));
});
