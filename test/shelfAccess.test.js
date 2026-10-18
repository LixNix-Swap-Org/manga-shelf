// Shelf access rules across endpoints: body ids, role caps and account role changes, the trash across shelves, bulk
// undo, statistics, marks for others, account deletion, CSV import, shelf filters, the move preview and mark counts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

const PW = 'password123';
let ctx;
let admin;
let adminId;
let db;
let home;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: PW })).status, 200);
    adminId = (await admin('GET', '/auth/me')).body.user.id;
    home = (await admin('GET', '/shelves')).body.shelves[0].id;
    db = require('../db').db;
});

test.after(async () => { await ctx.close(); });

test.beforeEach(() => require('../middleware/rateLimit').resetRateLimits());

async function account(username, role = 'editor', extra = { shelf_mode: 'personal' }) {
    const res = await admin('POST', '/users', { username, password: PW, role, ...extra, ...(role === 'admin' ? { current_password: PW } : {}) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const client = ctx.client();
    assert.equal((await client('POST', '/auth/login', { username, password: PW })).status, 200, username);
    client.id = res.body.user.id;
    return client;
}

const ownShelf = async (client) => (await client('GET', '/shelves')).body.shelves.find(s => s.role === 'owner');
const roleIn = async (client, shelfId) => (await client('GET', '/shelves')).body.shelves.find(s => s.id === shelfId)?.role ?? null;

async function series(client, title, extra = {}) {
    const res = await client('POST', '/mangas', { title, ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id;
}

async function volume(client, mangaId, number, extra = {}) {
    const res = await client('POST', '/volumes', { manga_id: mangaId, volume_number: number, status: 'Fehlt', ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id;
}

const ownersOf = (volumeId) => db.prepare('SELECT user_id FROM volume_owners WHERE volume_id = ? ORDER BY user_id').all(volumeId).map(r => r.user_id);
const readersOf = (volumeId) => db.prepare('SELECT user_id FROM volume_reads WHERE volume_id = ? ORDER BY user_id').all(volumeId).map(r => r.user_id);

test('POST /volumes and /volumes/batch take manga_id as a plain id only: "1e1" and friends never reach another series', async () => {
    const ben = await account('a1_ben');
    const anna = await account('a1_anna');
    const victim = await series(ben, 'A1 Fremd');
    // anna owns the series whose id Number("<victim>e1") names, while parseInt reads the victim's id
    let decoy = await series(anna, 'A1 Lockvogel');
    while (decoy < victim * 10) decoy = await series(anna, `A1 Lockvogel ${decoy}`);
    assert.equal(decoy, victim * 10);

    for (const bad of [`${victim}e1`, '0x1', ` ${decoy}`, `${decoy}.0`, `${decoy} `, 1.5, -decoy, '']) {
        const one = await anna('POST', '/volumes', { manga_id: bad, volume_number: '99', notes: 'planted' });
        assert.equal(one.status, 400, `POST /volumes ${JSON.stringify(bad)}`);
        const batch = await anna('POST', '/volumes/batch', { manga_id: bad, from: 1, to: 3 });
        assert.equal(batch.status, 400, `POST /volumes/batch ${JSON.stringify(bad)}`);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM volumes WHERE manga_id IN (?, ?)').get(victim, decoy).n, 0, 'nothing was written');
    assert.equal((await anna('POST', '/volumes', { manga_id: victim, volume_number: '1' })).status, 404);
    assert.equal((await anna('POST', '/volumes/batch', { manga_id: String(victim), from: 1, to: 2 })).status, 404);
    assert.equal((await anna('POST', '/volumes', { manga_id: String(decoy), volume_number: '1' })).status, 200);
    assert.equal((await anna('POST', '/volumes/batch', { manga_id: decoy, from: 2, to: 3 })).body.created, 2);
});

test('a visitor stored as owner counts for no owner check; the members list shows it as viewer', async () => {
    const olga = await account('a3_olga');
    const vis = await account('a3_vis', 'visitor', {});
    const shelf = await ownShelf(olga);
    db.prepare("INSERT INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, 'owner')").run(shelf.id, vis.id);
    const members = (await olga('GET', `/shelves/${shelf.id}`)).body.members;
    const visRow = members.find(m => m.user_id === vis.id);
    assert.deepEqual([visRow.role, visRow.app_role], ['viewer', 'visitor']);
    assert.equal((await olga('PUT', `/shelves/${shelf.id}/members/${olga.id}`, { role: 'editor' })).status, 409);
    assert.equal((await olga('DELETE', `/shelves/${shelf.id}/members/${olga.id}`)).status, 409);
    assert.equal((await vis('DELETE', `/shelves/${shelf.id}/members/${vis.id}`)).status, 200, 'the visitor can leave');
});

test('account role changes follow into the shelves', async () => {
    // admin -> editor: the owner role goes wherever another owner remains and stays where the account owns alone
    const boss = await account('a3_boss', 'admin', {});
    const helper = await account('a3_helper');
    assert.equal(await roleIn(boss, home), 'editor', 'a new admin is not owner of the household shelf');
    db.prepare("UPDATE shelf_members SET role = 'owner' WHERE shelf_id = ? AND user_id = ?").run(home, boss.id);
    const shared = (await boss('POST', '/shelves', { name: 'Boss geteilt' })).body.id;
    const alone = (await boss('POST', '/shelves', { name: 'Boss allein' })).body.id;
    assert.equal((await boss('POST', `/shelves/${shared}/members`, { user_id: helper.id, role: 'owner' })).status, 201);
    assert.equal((await admin('PUT', `/users/${boss.id}`, { role: 'editor' })).status, 200);
    assert.equal(await roleIn(boss, home), 'editor');
    assert.equal(await roleIn(boss, shared), 'editor');
    assert.equal(await roleIn(boss, alone), 'owner');
    assert.equal((await boss('DELETE', `/shelves/${home}/members/${adminId}`)).status, 403, 'the former admin cannot remove the admin');

    // visitor -> editor: the household shelf opens for writing
    const vic = await account('a3_vic', 'visitor', {});
    assert.equal(await roleIn(vic, home), 'viewer');
    const homeSeries = await series(admin, 'A3 Haushalt');
    assert.equal((await vic('PUT', `/mangas/${homeSeries}`, { title: 'A3 Haushalt' })).status, 403);
    assert.equal((await admin('PUT', `/users/${vic.id}`, { role: 'editor' })).status, 200);
    assert.equal(await roleIn(vic, home), 'editor');
    assert.equal((await vic('PUT', `/mangas/${homeSeries}`, { title: 'A3 Haushalt' })).status, 200);

    // editor -> visitor: refused while a shelf would lose its last owner, then every membership becomes viewer
    const ed = await account('a3_ed');
    const edShelf = await ownShelf(ed);
    const refused = await admin('PUT', `/users/${ed.id}`, { role: 'visitor' });
    assert.deepEqual([refused.status, refused.body.code], [409, 'SHELF_LAST_OWNER']);
    assert.match(refused.body.error, /Sammlung von a3_ed/);
    assert.equal((await admin('GET', '/users')).body.find(u => u.id === ed.id).role, 'editor', 'nothing changed');
    assert.equal((await ed('POST', `/shelves/${edShelf.id}/members`, { user_id: helper.id, role: 'owner' })).status, 201);
    assert.equal((await admin('PUT', `/users/${ed.id}`, { role: 'visitor' })).status, 200);
    assert.deepEqual(db.prepare('SELECT DISTINCT role FROM shelf_members WHERE user_id = ?').all(ed.id).map(r => r.role), ['viewer']);
});

test('deleting a shelf deletes its trash; nobody else sees or restores what was in it', async () => {
    const carl = await account('a4_carl', 'editor', {});
    const secret = (await admin('POST', '/shelves', { name: 'A4 Geheim' })).body.id;
    const id = await series(admin, 'A4 Geheime Reihe', { shelf_id: secret });
    await volume(admin, id, '1', { notes: 'privat' });
    const trashId = (await admin('DELETE', `/mangas/${id}`)).body.trash_id;
    assert.equal((await admin('DELETE', `/shelves/${secret}`)).status, 200);
    assert.equal(db.prepare('SELECT count(*) AS n FROM trash WHERE id = ?').get(trashId).n, 0);
    assert.equal((await carl('GET', '/trash')).body.items.some(i => i.title === 'A4 Geheime Reihe'), false);
    assert.equal((await carl('POST', `/trash/${trashId}/restore`)).status, 404);
});

test('a restored series goes back into its own shelf, also for an entry written before shelves existed', async () => {
    const dirk = await account('a4_dirk', 'editor', {});
    const dirkShelf = (await dirk('POST', '/shelves', { name: 'Dirk privat' })).body.id;
    const id = await series(admin, 'A4 Altbestand');
    const vol = await volume(admin, id, '1', { status: 'Vorhanden' });
    const trashId = (await admin('DELETE', `/mangas/${id}`)).body.trash_id;
    // a 3.3.x entry: the payload has no shelf, the migration gave the row shelf 1
    db.prepare("UPDATE trash SET payload = json_remove(payload, '$.manga.shelf_id') WHERE id = ?").run(trashId);
    assert.equal((await dirk('POST', `/trash/${trashId}/restore`)).status, 200);
    assert.equal(db.prepare('SELECT shelf_id FROM mangas WHERE id = ?').get(id).shelf_id, home, 'not into Dirk privat');
    assert.notEqual(home, dirkShelf);
    assert.deepEqual(ownersOf(vol), [adminId]);
    assert.equal((await admin('GET', `/mangas/${id}`)).status, 200);
});

test('a volume restore needs editor rights where its series is now, and marks come back for members only', async () => {
    const anna = await account('a4_anna');
    const carl = await account('a4_karl');
    const shelfA = (await ownShelf(anna)).id;
    const shelfB = (await anna('POST', '/shelves', { name: 'Anna B' })).body.id;
    await anna('POST', `/shelves/${shelfA}/members`, { user_id: carl.id, role: 'editor' });
    const id = await series(anna, 'A4 Wanderreihe', { shelf_id: shelfA });
    const vol = await volume(anna, id, '1');
    const trashId = (await carl('DELETE', `/volumes/${vol}`)).body.trash_id;
    assert.equal((await anna('PUT', `/mangas/${id}/shelf`, { shelf_id: shelfB })).status, 200);
    assert.equal((await carl('POST', `/trash/${trashId}/restore`)).status, 404, 'the entry moved along with its series');
    db.prepare('UPDATE trash SET shelf_id = ? WHERE id = ?').run(shelfA, trashId);
    const refused = await carl('POST', `/trash/${trashId}/restore`);
    assert.deepEqual([refused.status, refused.body.code], [409, 'SHELF_UNAVAILABLE']);
    assert.equal(db.prepare('SELECT count(*) AS n FROM volumes WHERE id = ?').get(vol).n, 0);

    // carl owns and has read a volume, the series goes to the trash, carl leaves; the restore leaves his marks out
    const other = await series(anna, 'A4 Markenreihe', { shelf_id: shelfA });
    const marked = await volume(anna, other, '1');
    assert.equal((await carl('POST', `/volumes/${marked}/owners`, { owned: true })).status, 200);
    assert.equal((await carl('POST', `/volumes/${marked}/read`, { read: true })).status, 200);
    const seriesTrash = (await anna('DELETE', `/mangas/${other}`)).body.trash_id;
    assert.equal((await anna('DELETE', `/shelves/${shelfA}/members/${carl.id}`)).status, 200);
    assert.equal((await anna('POST', `/trash/${seriesTrash}/restore`)).status, 200);
    assert.deepEqual(ownersOf(marked), []);
    assert.deepEqual(readersOf(marked), []);
    assert.equal(db.prepare('SELECT status FROM volumes WHERE id = ?').get(marked).status, 'Fehlt');
});

test('emptying the trash covers the shelves the caller owns and every shelf an admin edits as a member', async () => {
    const second = await account('a4_second', 'admin', {});
    const stranger = await account('a4_stranger', 'admin');
    assert.equal(await roleIn(second, home), 'editor');
    assert.equal(await roleIn(stranger, home), null);
    const trashId = (await admin('DELETE', `/mangas/${await series(admin, 'A4 Leeren')}`)).body.trash_id;
    const inTrash = () => db.prepare('SELECT count(*) AS n FROM trash WHERE id = ?').get(trashId).n === 1;

    assert.equal((await stranger('DELETE', `/trash?shelf_id=${home}`)).status, 404);
    assert.equal((await stranger('DELETE', '/trash')).status, 200);
    assert.equal(inTrash(), true, 'an admin outside the household shelf empties nothing there');

    const emptied = await second('DELETE', `/trash?shelf_id=${home}`);
    assert.equal(emptied.status, 200);
    assert.ok(emptied.body.removed >= 1);
    assert.equal(inTrash(), false, 'an admin member who is not owner empties it');

    const viewedId = (await admin('DELETE', `/mangas/${await series(admin, 'A4 Nur lesen')}`)).body.trash_id;
    assert.equal((await admin('PUT', `/shelves/${home}/members/${second.id}`, { role: 'viewer' })).status, 200);
    assert.equal((await second('DELETE', `/trash?shelf_id=${home}`)).status, 403, 'not as a viewer of the shelf');
    assert.equal(db.prepare('SELECT count(*) AS n FROM trash WHERE id = ?').get(viewedId).n, 1);
});

test('a trash row written without a shelf takes the shelf of its series (trigger), else shelf 1', async () => {
    const eva = await account('a4_eva');
    const shelf = (await ownShelf(eva)).id;
    const id = await series(eva, 'A4 Trigger');
    const insert = db.prepare("INSERT INTO trash (kind, ref_id, manga_id, title, payload) VALUES ('volume', 999999, ?, 'x', '{}')");
    const withSeries = Number(insert.run(id).lastInsertRowid);
    const orphan = Number(insert.run(987654).lastInsertRowid);
    assert.equal(db.prepare('SELECT shelf_id FROM trash WHERE id = ?').get(withSeries).shelf_id, shelf);
    assert.equal(db.prepare('SELECT shelf_id FROM trash WHERE id = ?').get(orphan).shelf_id, 1);
    db.prepare('DELETE FROM trash WHERE id IN (?, ?)').run(withSeries, orphan);
});

test('a bulk undo writes only where the caller may still edit: not after a removal, not after a move', async () => {
    const anna = await account('a5_anna');
    const ben = await account('a5_ben');
    const shelfA = (await ownShelf(anna)).id;
    const shelfB = (await anna('POST', '/shelves', { name: 'A5 Archiv' })).body.id;
    await anna('POST', `/shelves/${shelfA}/members`, { user_id: ben.id, role: 'editor' });
    const id = await series(anna, 'A5 Reihe', { shelf_id: shelfA });
    const vol = await volume(anna, id, '1');
    const condition = () => db.prepare('SELECT condition FROM volumes WHERE id = ?').get(vol).condition;

    const first = (await ben('POST', '/volumes/bulk', { ids: [vol], set: { condition: 'Gut' } })).body.undo_token;
    assert.equal(condition(), 'Gut');
    assert.equal((await anna('DELETE', `/shelves/${shelfA}/members/${ben.id}`)).status, 200);
    const afterRemoval = await ben('POST', '/volumes/bulk', { revert: first });
    assert.equal(afterRemoval.status, 200);
    assert.deepEqual([afterRemoval.body.restored, afterRemoval.body.not_found], [[], [vol]]);
    assert.equal(condition(), 'Gut', 'unchanged');

    await anna('POST', `/shelves/${shelfA}/members`, { user_id: ben.id, role: 'editor' });
    const second = (await ben('POST', '/volumes/bulk', { ids: [vol], set: { condition: 'Neu' } })).body.undo_token;
    assert.equal((await anna('PUT', `/mangas/${id}/shelf`, { shelf_id: shelfB })).status, 200);
    const afterMove = await ben('POST', '/volumes/bulk', { revert: second });
    assert.deepEqual([afterMove.body.restored, afterMove.body.not_found], [[], [vol]]);
    assert.equal(condition(), 'Neu');
});

test('a shelf viewer marks own reads in bulk (and undoes that), but changes nothing else', async () => {
    const anna = await account('a7_anna');
    const carl = await account('a7_carl');
    const shelf = (await ownShelf(anna)).id;
    await anna('POST', `/shelves/${shelf}/members`, { user_id: carl.id, role: 'viewer' });
    const id = await series(anna, 'A7 Lesereihe');
    const vol = await volume(anna, id, '1', { status: 'Vorhanden' });
    const read = await carl('POST', '/volumes/bulk', { ids: [vol], read: { read: true } });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(readersOf(vol), [carl.id]);
    assert.equal((await carl('POST', '/volumes/bulk', { ids: [vol], set: { condition: 'Gut' } })).status, 404);
    assert.equal((await carl('POST', '/volumes/bulk', { ids: [vol], owners: { add: [carl.id] } })).status, 404);
    const undo = await carl('POST', '/volumes/bulk', { revert: read.body.undo_token });
    assert.deepEqual(undo.body.restored, [vol]);
    assert.deepEqual(readersOf(vol), []);
    assert.deepEqual(ownersOf(vol), [anna.id], 'the undo of a read leaves the owners alone');
});

test('a volume lookup by a shelf viewer links no edition to the series', async () => {
    const anna = await account('a7_mp_anna');
    const carl = await account('a7_mp_carl');
    await anna('POST', `/shelves/${(await ownShelf(anna)).id}/members`, { user_id: carl.id, role: 'viewer' });
    const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
    const realFetch = global.fetch;
    const api = (editionId, title) => (u) => {
        if (u.includes('/editions?title=')) return json({ 'hydra:member': [{ id: editionId, title, numVolumes: 3, status: 1, publishers: [{ name: 'Carlsen Manga' }] }] });
        if (u.includes(`/editions/${editionId}/volumes`)) return json({ 'hydra:member': [{ id: editionId * 10 + 1, number: 1, numberDisplay: '1', price: 700, date: '2020-01-01' }] });
        if (u.endsWith(`/editions/${editionId}`)) return json({ id: editionId, title, numVolumes: 3, status: 1, publishers: [{ name: 'Carlsen Manga' }] });
        return json({}, 404);
    };
    let answer = null;
    global.fetch = async (url, opts) => (String(url).startsWith(ctx.base) ? realFetch(url, opts) : answer(String(url)));
    try {
        const viewed = await series(anna, 'Viewer Lookup', { publisher: 'Carlsen Manga' });
        answer = api(771001, 'Viewer Lookup');
        const byViewer = await carl('GET', `/volumes/lookup?manga_id=${viewed}&volume_number=1`);
        assert.equal(byViewer.status, 200, JSON.stringify(byViewer.body));
        assert.equal(db.prepare('SELECT manga_passion_id FROM mangas WHERE id = ?').get(viewed).manga_passion_id, null);

        const edited = await series(anna, 'Editor Lookup', { publisher: 'Carlsen Manga' });
        answer = api(771002, 'Editor Lookup');
        assert.equal((await anna('GET', `/volumes/lookup?manga_id=${edited}&volume_number=1`)).status, 200);
        assert.equal(db.prepare('SELECT manga_passion_id FROM mangas WHERE id = ?').get(edited).manga_passion_id, 771002, 'an editor still links it');
    } finally {
        global.fetch = realFetch;
    }
});

test('statistics name only the accounts of the requested shelves; reading stats count only their reads', async () => {
    const gast = await account('a6_gast', 'guest', {});
    assert.equal((await gast('DELETE', `/shelves/${home}/members/${gast.id}`)).status, 200, 'alone in the shelf it gets on leaving');
    const stats = (await gast('GET', '/stats')).body;
    assert.deepEqual(stats.user_reading_stats.map(u => u.username), ['a6_gast']);
    assert.deepEqual(stats.owner_stats.map(u => u.username), ['a6_gast']);
    assert.deepEqual(stats.owner_publishers, []);

    const ute = await account('a6_ute', 'editor', {});
    const own = (await ute('POST', '/shelves', { name: 'Ute privat' })).body.id;
    const homeVol = await volume(admin, await series(admin, 'A6 Haushalt'), '1', { status: 'Vorhanden' });
    const ownVol = await volume(ute, await series(ute, 'A6 Ute', { shelf_id: own }), '1', { status: 'Vorhanden' });
    for (const v of [homeVol, ownVol]) db.prepare('INSERT INTO volume_reads (volume_id, user_id, read_at) VALUES (?, ?, NULL)').run(v, ute.id);
    assert.equal((await ute('GET', '/stats/reading')).body.unknown_date, 2);
    assert.equal((await ute('GET', `/stats/reading?shelf_id=${own}`)).body.unknown_date, 1);
    const ownStats = (await ute('GET', `/stats?shelf_id=${own}`)).body;
    assert.deepEqual(ownStats.user_reading_stats.map(u => u.username), ['a6_ute']);
    assert.ok((await ute('GET', '/stats')).body.user_reading_stats.some(u => u.username === 'admin'), 'household members show up');

    assert.equal((await gast('GET', `/stats/reading?user_id=${ute.id}`)).status, 404, 'no shared shelf');
    assert.equal((await ute('GET', `/stats/reading?user_id=${adminId}`)).status, 200, 'household neighbours');
});

test('marks for somebody else need a member of that shelf; user stats need a shared shelf', async () => {
    const anna = await account('a8_anna');
    const hans = await account('a8_hans', 'editor', {});
    const id = await series(admin, 'A8 Haushalt');
    const vol = await volume(admin, id, '1', { status: 'Vorhanden' });
    assert.equal((await admin('POST', `/volumes/${vol}/owners`, { user_id: anna.id, owned: true })).status, 404);
    assert.equal((await admin('POST', `/volumes/${vol}/read`, { user_id: anna.id, read: true })).status, 404);
    assert.equal((await admin('POST', '/volumes/batch-read', { manga_id: id, up_to_volume: 1, user_id: anna.id })).status, 404);
    assert.equal((await admin('POST', '/volumes/bulk', { ids: [vol], owners: { add: [anna.id] } })).status, 404);
    assert.equal((await admin('POST', '/volumes/bulk', { ids: [vol], read: { user_id: anna.id, read: true } })).status, 404);
    assert.deepEqual(ownersOf(vol), [adminId]);
    assert.deepEqual(readersOf(vol), []);
    assert.equal((await admin('POST', `/volumes/${vol}/owners`, { user_id: hans.id, owned: true })).status, 200, 'a member works');
    assert.equal((await admin('POST', '/volumes/bulk', { ids: [vol], read: { user_id: hans.id, read: true } })).status, 200);

    assert.equal((await anna('GET', `/users/${hans.id}/stats`)).status, 404);
    assert.equal((await hans('GET', `/users/${adminId}/stats`)).status, 200);
    assert.equal((await admin('GET', `/users/${anna.id}/stats`)).status, 200);
    assert.equal((await anna('GET', `/users/${anna.id}/stats`)).status, 200);
});

test('deleting an account gives its volumes to a member of their shelf, not to the deleting admin', async () => {
    const dana = await account('a9_dana');
    const erik = await account('a9_erik');
    const danaShelf = (await ownShelf(dana)).id;
    await dana('POST', `/shelves/${danaShelf}/members`, { user_id: erik.id, role: 'owner' });
    const vol = await volume(dana, await series(dana, 'A9 Geteilt'), '1', { status: 'Vorhanden', price: 9 });
    assert.equal((await admin('DELETE', `/users/${dana.id}`)).status, 200);
    assert.deepEqual(ownersOf(vol), [erik.id]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM shelf_members WHERE shelf_id = ? AND user_id = ?').get(danaShelf, adminId).n, 0);

    // the last owner that can act goes (a visitor stored as owner does not count): an editor member takes the shelf
    // over, the admin stays out
    const fritz = await account('a9_fritz');
    const gina = await account('a9_gina');
    const vera = await account('a9_vera', 'visitor', {});
    const fritzShelf = (await ownShelf(fritz)).id;
    await fritz('POST', `/shelves/${fritzShelf}/members`, { user_id: gina.id, role: 'viewer' });
    db.prepare("INSERT INTO shelf_members (shelf_id, user_id, role, added_at) VALUES (?, ?, 'owner', '2000-01-01 00:00:00')").run(fritzShelf, vera.id);
    const fritzVol = await volume(fritz, await series(fritz, 'A9 Erbe'), '1', { status: 'Vorhanden' });
    assert.equal((await admin('DELETE', `/users/${fritz.id}`)).status, 200);
    assert.equal(await roleIn(gina, fritzShelf), 'owner');
    assert.equal(db.prepare('SELECT owner_user_id FROM shelves WHERE id = ?').get(fritzShelf).owner_user_id, gina.id);
    assert.deepEqual(ownersOf(fritzVol), [gina.id]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM shelf_members WHERE shelf_id = ? AND user_id = ?').get(fritzShelf, adminId).n, 0);
});

test('a CSV import names owners and readers of the target shelf only', async () => {
    await account('a10_olaf');
    const hilde = await account('a10_hilde', 'editor', {});
    const csv = 'Reihe;Band;Status;Besitzer;Gelesen von\nA10 Import;1;Vorhanden;a10_olaf;a10_olaf\nA10 Import;2;Vorhanden;a10_olaf|a10_hilde;a10_hilde\n';
    const res = await admin('POST', '/import/csv', { csv });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const messages = res.body.warnings.map(w => w.message);
    assert.ok(messages.includes('Besitzer „a10_olaf“ gehört nicht zu diesem Regal (ignoriert)'), JSON.stringify(messages));
    assert.ok(messages.includes('Leser „a10_olaf“ gehört nicht zu diesem Regal (ignoriert)'), JSON.stringify(messages));
    const [first, second] = db.prepare("SELECT v.id FROM volumes v JOIN mangas m ON m.id = v.manga_id WHERE m.title = 'A10 Import' ORDER BY v.volume_number").all().map(r => r.id);
    assert.deepEqual([ownersOf(first), readersOf(first)], [[adminId], []]);
    assert.deepEqual([ownersOf(second), readersOf(second)], [[hilde.id], [hilde.id]], 'a household member resolves');
});

test('volume-search and the offline snapshot take ?shelf_id; a foreign shelf answers 404', async () => {
    const lena = await account('a10_lena');
    const otto = await account('a10_otto');
    const own = (await ownShelf(lena)).id;
    const second = (await lena('POST', '/shelves', { name: 'Lena zwei' })).body.id;
    const first = await series(lena, 'A10 Eins', { shelf_id: own });
    const other = await series(lena, 'A10 Zwei', { shelf_id: second });
    // a series has a search row once it has volumes
    await volume(lena, first, '1', { isbn: '9783551757210' });
    await volume(lena, other, '1');
    assert.equal((await otto('GET', `/mangas/volume-search?shelf_id=${own}`)).status, 404);
    assert.equal((await otto('GET', `/offline-snapshot?shelf_id=${own}`)).status, 404);
    assert.equal((await lena('GET', '/mangas/volume-search?shelf_id=1e0')).status, 404);
    const search = (await lena('GET', `/mangas/volume-search?shelf_id=${own}`)).body;
    assert.deepEqual(search.map(m => m.id), [first]);
    const snapshot = (await lena('GET', `/offline-snapshot?shelf_id=${second}`)).body;
    assert.deepEqual(snapshot.mangas.map(m => m.id), [other]);
    assert.deepEqual(Object.keys(snapshot.details).map(Number), [other]);
    assert.equal((await lena('GET', '/offline-snapshot')).body.mangas.length, 2);
});

test('the move preview names whose marks a move deletes; the shelf detail counts each member\'s marks', async () => {
    const anna = await account('a12_anna');
    const ben = await account('a12_ben');
    const shelfA = (await ownShelf(anna)).id;
    const shelfB = (await anna('POST', '/shelves', { name: 'A12 Ziel' })).body.id;
    await anna('POST', `/shelves/${shelfA}/members`, { user_id: ben.id, role: 'editor' });
    const id = await series(anna, 'A12 Umzug', { shelf_id: shelfA });
    const v1 = await volume(anna, id, '1', { status: 'Vorhanden' });
    const v2 = await volume(anna, id, '2');
    assert.equal((await ben('POST', `/volumes/${v2}/owners`, { owned: true })).status, 200);
    assert.equal((await ben('POST', `/volumes/${v1}/read`, { read: true })).status, 200);
    assert.equal((await ben('POST', `/volumes/${v2}/read`, { read: true })).status, 200);

    const members = (await anna('GET', `/shelves/${shelfA}`)).body.members;
    assert.deepEqual(members.map(m => [m.username, m.role, m.app_role, m.marks]), [
        ['a12_anna', 'owner', 'editor', { owned: 1, read: 0 }],
        ['a12_ben', 'editor', 'editor', { owned: 1, read: 2 }]
    ]);

    const preview = await anna('GET', `/mangas/${id}/shelf-move?shelf_id=${shelfB}`);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.affected, [{ user_id: ben.id, username: 'a12_ben', owned: 1, read: 2 }]);
    assert.deepEqual((await anna('GET', `/mangas/${id}/shelf-move?shelf_id=${shelfA}`)).body.affected, []);
    assert.equal((await ben('GET', `/mangas/${id}/shelf-move?shelf_id=${shelfB}`)).status, 403, 'an editor of the source cannot move it');
    assert.equal((await anna('GET', `/mangas/${id}/shelf-move?shelf_id=${home}`)).status, 404, 'a target the owner is not in');
    assert.equal((await anna('GET', `/mangas/${id}/shelf-move?shelf_id=abc`)).status, 400);
    assert.equal((await admin('GET', `/mangas/${id}/shelf-move?shelf_id=${shelfB}`)).status, 404);
    assert.deepEqual(ownersOf(v2), [ben.id], 'the preview changes nothing');

    assert.equal((await anna('PUT', `/mangas/${id}/shelf`, { shelf_id: shelfB })).status, 200);
    assert.deepEqual([ownersOf(v2), readersOf(v1), readersOf(v2)], [[], [], []]);
});
