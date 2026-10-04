// Trash: soft delete, restore, bulk undo and purge of series and volumes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let editor;
let visitor;
let db;
let editorId;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    editor = ctx.client();
    visitor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    const ed = await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' });
    editorId = ed.body.user.id;
    assert.equal((await admin('POST', '/users', { username: 'vis', password: 'password123', role: 'visitor' })).status, 200);
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
    assert.equal((await visitor('POST', '/auth/login', { username: 'vis', password: 'password123' })).status, 200);
    db = require('../db').db;
});

test.after(async () => { await ctx.close(); });

async function series(title, extra = {}) {
    const res = await editor('POST', '/mangas', { title, publisher: 'Carlsen Manga', ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id;
}

async function volume(mangaId, number, extra = {}) {
    const res = await editor('POST', '/volumes', { manga_id: mangaId, volume_number: number, status: 'Vorhanden', price: 7, ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id;
}

async function csvText() {
    const res = await fetch(`${ctx.base}/export/csv`, { headers: { Cookie: editor.cookie } });
    assert.equal(res.status, 200);
    return res.text();
}

const trashItems = async () => (await editor('GET', '/trash')).body.items;

/** Every place a series can show up for a client, as one comparable picture. */
async function visible(title) {
    const list = (await editor('GET', '/mangas')).body.filter(m => m.title === title);
    const stats = (await editor('GET', '/stats')).body;
    const shop = (await editor('GET', '/shopping-list')).body;
    const shopItems = (shop.items || shop.groups?.flatMap(g => g.items) || []).filter(i => i.manga_title === title || i.title === title);
    const radar = (await editor('GET', '/release-radar')).body;
    const radarItems = radar.groups.flatMap(g => g.items).filter(i => i.manga_title === title || i.title === title);
    const snapshot = (await editor('GET', '/offline-snapshot')).body;
    const snapshotHits = snapshot.mangas.filter(m => m.title === title).length + Object.values(snapshot.details).filter(d => d.title === title).length;
    const csv = await csvText();
    return {
        list: list.length,
        stats_series: stats.summary.total_series,
        stats_owned: stats.summary.total_owned_volumes,
        shop: shopItems.length,
        radar: radarItems.length,
        snapshot: snapshotHits,
        csv: csv.includes(title)
    };
}

test('a deleted series is invisible everywhere and comes back with ids, owners and reads', async () => {
    const id = await series('Papierkorb Reihe');
    const v1 = await volume(id, '1', { purchase_date: '2024-01-02' });
    const v2 = await volume(id, '2');
    await volume(id, '3', { status: 'Fehlt' });
    await volume(id, '4', { status: 'Vorbestellt', release_date: '2099-05-01' });
    assert.equal((await editor('POST', `/volumes/${v1}/read`, { read: true })).status, 200);
    assert.equal((await admin('POST', `/volumes/${v2}/owners`, { user_id: 1, owned: true })).status, 200);
    const before = await visible('Papierkorb Reihe');
    const detailBefore = (await editor('GET', `/mangas/${id}`)).body;
    assert.deepEqual([before.list, before.shop, before.radar, before.snapshot, before.csv], [1, 1, 1, 2, true]);

    const res = await editor('DELETE', `/mangas/${id}`);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.trash_id, 'number');
    const after = await visible('Papierkorb Reihe');
    assert.deepEqual(
        { ...after, stats_series: before.stats_series - after.stats_series, stats_owned: before.stats_owned - after.stats_owned },
        { list: 0, stats_series: 1, stats_owned: 2, shop: 0, radar: 0, snapshot: 0, csv: false });
    assert.equal((await editor('GET', `/mangas/${id}`)).status, 404);
    assert.equal(db.prepare('SELECT count(*) AS n FROM volumes WHERE manga_id = ?').get(id).n, 0);

    const entry = (await trashItems()).find(t => t.id === res.body.trash_id);
    assert.equal(entry.kind, 'manga');
    assert.equal(entry.title, 'Papierkorb Reihe');
    assert.equal(entry.volume_count, 4);
    assert.equal(entry.owned_count, 2);
    assert.equal(entry.deleted_by_name, 'ed');
    assert.equal(entry.restorable, true);
    assert.match(entry.purge_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await visitor('GET', '/trash')).status, 200);
    assert.equal((await visitor('POST', `/trash/${entry.id}/restore`)).status, 403);

    const restored = await editor('POST', `/trash/${entry.id}/restore`);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(restored.body, { success: true, kind: 'manga', id, manga_id: id, title: 'Papierkorb Reihe' });
    const detailAfter = (await editor('GET', `/mangas/${id}`)).body;
    assert.deepEqual(detailAfter, detailBefore);
    assert.deepEqual(await visible('Papierkorb Reihe'), before);
    assert.equal(db.prepare('SELECT owned_volumes FROM mangas WHERE id = ?').get(id).owned_volumes, 2);
    assert.equal((await trashItems()).some(t => t.id === entry.id), false);
    assert.equal((await editor('POST', `/trash/${entry.id}/restore`)).status, 404);
});

test('a deleted volume waits for its series; a taken number blocks the restore', async () => {
    const id = await series('Band Papierkorb');
    await volume(id, '1');
    const v2 = await volume(id, '2');
    const del = await editor('DELETE', `/volumes/${v2}`);
    assert.equal(del.status, 200);
    const volEntry = (await trashItems()).find(t => t.id === del.body.trash_id);
    assert.deepEqual([volEntry.kind, volEntry.volume_number, volEntry.title, volEntry.restorable], ['volume', '2', 'Band Papierkorb', true]);
    assert.equal((await editor('GET', `/mangas/${id}`)).body.volumes.length, 1);

    const seriesDel = await editor('DELETE', `/mangas/${id}`);
    const listed = (await trashItems()).find(t => t.id === volEntry.id);
    assert.deepEqual([listed.restorable, listed.series_in_trash], [false, true]);
    const blocked = await editor('POST', `/trash/${volEntry.id}/restore`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'TRASH_SERIES_MISSING');
    assert.equal(blocked.body.series_in_trash, true);
    assert.match(blocked.body.error, /zuerst die Reihe/);

    assert.equal((await editor('POST', `/trash/${seriesDel.body.trash_id}/restore`)).status, 200);
    assert.equal((await editor('POST', `/trash/${volEntry.id}/restore`)).status, 200);
    assert.deepEqual((await editor('GET', `/mangas/${id}`)).body.volumes.map(v => [v.id, v.volume_number]).sort(), [[v2, '2'], [v2 - 1, '1']].sort());

    const again = await editor('DELETE', `/volumes/${v2}`);
    await volume(id, '2');
    const dup = await editor('POST', `/trash/${again.body.trash_id}/restore`);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'VOLUME_DUPLICATE');
    assert.equal(dup.body.existing_id > v2, true);
    assert.equal((await editor('DELETE', `/trash/${again.body.trash_id}`)).status, 200);
    assert.equal((await editor('DELETE', `/trash/${again.body.trash_id}`)).status, 404);
});

test('bulk delete fills the trash; the bulk undo takes the entries out again', async () => {
    const id = await series('Bulk Papierkorb');
    const ids = [await volume(id, '1'), await volume(id, '2')];
    const res = await editor('POST', '/volumes/bulk', { ids, delete: true });
    assert.equal(res.status, 200);
    const refs = (await trashItems()).filter(t => t.kind === 'volume' && ids.includes(t.ref_id));
    assert.equal(refs.length, 2);
    assert.equal((await editor('POST', '/volumes/bulk', { revert: res.body.undo_token })).status, 200);
    assert.equal((await trashItems()).filter(t => t.kind === 'volume' && ids.includes(t.ref_id)).length, 0);
    assert.equal((await editor('GET', `/mangas/${id}`)).body.volumes.length, 2);
});

test('owners and reads of a user deleted meanwhile stay out; the linked anime is linked again', async () => {
    const extra = await admin('POST', '/users', { username: 'weg', password: 'password123', role: 'editor' });
    const goneId = extra.body.user.id;
    const id = await series('Verwaiste Besitzer');
    const v1 = await volume(id, '1');
    assert.equal((await admin('POST', `/volumes/${v1}/owners`, { user_id: goneId, owned: true })).status, 200);
    assert.equal((await admin('POST', `/volumes/${v1}/read`, { user_id: goneId, read: true })).status, 200);
    const animeId = Number(db.prepare("INSERT INTO animes (title, manga_id) VALUES ('Verwaister Anime', ?)").run(id).lastInsertRowid);

    const del = await editor('DELETE', `/mangas/${id}`);
    assert.equal(db.prepare('SELECT manga_id FROM animes WHERE id = ?').get(animeId).manga_id, null);
    assert.equal((await admin('DELETE', `/users/${goneId}`)).status, 200);
    assert.equal((await editor('POST', `/trash/${del.body.trash_id}/restore`)).status, 200);
    const owners = db.prepare('SELECT user_id FROM volume_owners WHERE volume_id = ? ORDER BY user_id').all(v1).map(r => r.user_id);
    assert.deepEqual(owners, [editorId]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM volume_reads WHERE volume_id = ?').get(v1).n, 0);
    assert.equal(db.prepare('SELECT manga_id FROM animes WHERE id = ?').get(animeId).manga_id, id);
});

test('entries older than 30 days are purged by the scheduler; only admins empty the trash', async () => {
    const { purgeTrashIfDue } = require('../services/scheduler');
    const old = (await editor('DELETE', `/mangas/${await series('Alt im Papierkorb')}`)).body.trash_id;
    const fresh = (await editor('DELETE', `/mangas/${await series('Frisch im Papierkorb')}`)).body.trash_id;
    db.prepare("UPDATE trash SET deleted_at = '2026-01-01 10:00:00' WHERE id = ?").run(old);
    db.prepare("UPDATE trash SET deleted_at = '2026-01-20 10:00:00' WHERE id = ?").run(fresh);
    assert.equal(purgeTrashIfDue(new Date('2026-02-05T12:00:00Z')), 1);
    const ids = (await trashItems()).map(t => t.id);
    assert.equal(ids.includes(old), false);
    assert.equal(ids.includes(fresh), true);

    assert.equal((await editor('DELETE', '/trash')).status, 403);
    const emptied = await admin('DELETE', '/trash');
    assert.equal(emptied.status, 200);
    assert.ok(emptied.body.removed >= 1);
    assert.deepEqual(await trashItems(), []);
    assert.equal((await editor('POST', '/trash/abc/restore')).status, 400);
});

test('scheduler: an anime refresh run is a tracked job and stops once a shutdown begins', async (t) => {
    const gateway = require('../core/anime/gateway');
    const lifecycle = require('../services/lifecycle');
    const { runAnimeRefreshIfDue } = require('../services/scheduler');
    let release;
    let stopCheck = null;
    t.mock.method(gateway, 'refreshDue', (ctx, options) => {
        stopCheck = options.shouldStop;
        return new Promise((resolve) => { release = () => resolve({ due: 0, updated: 0, missing: 0, stopped: false }); });
    });
    const run = runAnimeRefreshIfDue(new Date('2026-10-04T02:10:00Z'), { hour: 3, timeZone: 'UTC' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(lifecycle.runningJobs(), ['Anime-Aktualisierung']);
    assert.equal(stopCheck(), false);
    t.mock.method(lifecycle, 'isShuttingDown', () => true);
    assert.equal(stopCheck(), true, 'the next group is not started after a shutdown began');
    release();
    await run;
    assert.deepEqual(lifecycle.runningJobs(), []);
});

test('a restored owned volume whose owners were all deleted meanwhile is missing, or goes to the restoring admin', async () => {
    const kim = await admin('POST', '/users', { username: 'kim', password: 'password123', role: 'editor' });
    const kimClient = ctx.client();
    assert.equal((await kimClient('POST', '/auth/login', { username: 'kim', password: 'password123' })).status, 200);
    const created = await kimClient('POST', '/mangas', { title: 'Verlassene Bände', publisher: 'Carlsen Manga' });
    const id = created.body.id;
    const add = async (n) => (await kimClient('POST', '/volumes', { manga_id: id, volume_number: n, status: 'Vorhanden', price: 9, purchase_date: '2024-03-04' })).body.id;
    const v1 = await add('1');
    const v2 = await add('2');
    const t1 = (await kimClient('DELETE', `/volumes/${v1}`)).body.trash_id;
    const t2 = (await kimClient('DELETE', `/volumes/${v2}`)).body.trash_id;
    assert.equal((await admin('DELETE', `/users/${kim.body.user.id}`)).status, 200);

    assert.equal((await editor('POST', `/trash/${t1}/restore`)).status, 200);
    const missing = (await editor('GET', `/mangas/${id}`)).body.volumes.find(v => v.id === v1);
    assert.equal(missing.status, 'Fehlt');
    assert.deepEqual(missing.owners, []);
    assert.equal(missing.purchase_date, null);

    assert.equal((await admin('POST', `/trash/${t2}/restore`)).status, 200);
    const handed = (await admin('GET', `/mangas/${id}`)).body.volumes.find(v => v.id === v2);
    assert.equal(handed.status, 'Vorhanden');
    assert.deepEqual(handed.owners.map(o => [o.username, o.price, o.purchase_date]), [['admin', 9, '2024-03-04']]);
    assert.equal(db.prepare('SELECT owned_volumes FROM mangas WHERE id = ?').get(id).owned_volumes, 1);
});

test('a restore never claims an id above the table sequence', async () => {
    const id = await series('Fremde IDs');
    const v1 = await volume(id, '1');
    const volTrash = (await editor('DELETE', `/volumes/${v1}`)).body.trash_id;
    const seq = (table) => db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table).seq;
    const bumpId = (trashId, mutate) => {
        const payload = JSON.parse(db.prepare('SELECT payload FROM trash WHERE id = ?').get(trashId).payload);
        mutate(payload);
        db.prepare('UPDATE trash SET payload = ? WHERE id = ?').run(JSON.stringify(payload), trashId);
    };
    const farVolume = seq('volumes') + 100;
    bumpId(volTrash, (p) => {
        p.volume.id = farVolume;
        for (const row of [...(p.owners || []), ...(p.reads || [])]) row.volume_id = farVolume;
    });
    const refused = await editor('POST', `/trash/${volTrash}/restore`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'TRASH_INVALID');

    const v2 = await volume(id, '2');
    const seriesTrash = (await editor('DELETE', `/mangas/${id}`)).body.trash_id;
    const farManga = seq('mangas') + 100;
    bumpId(seriesTrash, (p) => { p.manga.id = farManga; });
    assert.equal((await editor('POST', `/trash/${seriesTrash}/restore`)).body.code, 'TRASH_INVALID');
    bumpId(seriesTrash, (p) => {
        p.manga.id = id;
        const v = p.volumes.find(x => x.id === v2);
        v.id = farVolume + 1;
    });
    assert.equal((await editor('POST', `/trash/${seriesTrash}/restore`)).status, 200);
    assert.equal(db.prepare('SELECT count(*) AS n FROM volumes WHERE manga_id = ?').get(id).n, 0, 'the foreign volume id stays out');
    assert.ok(seq('volumes') < farVolume, 'the sequence is not pushed up');
    assert.ok(seq('mangas') < farManga);
});
