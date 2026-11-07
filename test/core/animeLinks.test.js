// The series link of an anime on its work and per shelf (migration 45, core/lib/animeLinks.js): the edge cases the core
// scenario "anime linked to the work" does not walk through, on the in-memory core.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryCore } = require('./harness');

async function setup() {
    const core = createMemoryCore();
    const admin = core.client('admin');
    const ed = core.client('ed');
    const shelf = async (api, name) => {
        const res = await api('POST', '/shelves', { name });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return res.body.id;
    };
    const series = async (api, title, extra = {}) => {
        const res = await api('POST', '/mangas', { title, ...extra });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.id;
    };
    const anime = async (api, title, mangaId) => {
        const res = await api('POST', '/anime', { title, episodes: 12, manga_id: mangaId });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        return res.body.id;
    };
    const linkOf = async (api, id) => (await api('GET', `/anime/${id}`)).body.manga_id;
    return { core, admin, ed, shelf, series, anime, linkOf };
}

test('a pin moves with its series to another shelf, so the shelf that holds the edition now shows the link', async () => {
    const { core, admin, ed, shelf, series, anime, linkOf } = await setup();
    try {
        const edShelf = await shelf(ed, 'Eds Regal');
        const first = await shelf(admin, 'Erstes');
        const second = await shelf(admin, 'Zweites');
        const edEdition = await series(ed, 'Werk A', { work_key: 'anilist:7001', shelf_id: edShelf });
        const id = await anime(ed, 'Anime A', edEdition);
        // the admin pins a series of another work in a shelf of their own: the link for everyone stays with ed's work
        const own = await series(admin, 'Eigene Reihe', { shelf_id: first });
        assert.equal((await admin('PUT', `/anime/${id}`, { manga_id: own })).status, 200);
        assert.equal(await linkOf(admin, id), own);
        assert.equal(await linkOf(ed, id), edEdition);

        const moved = await admin('PUT', `/mangas/${own}/shelf`, { shelf_id: second });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        assert.equal(await linkOf(admin, id), own, 'the pin followed the series');
        const pins = core.conn.prepare("SELECT scope_shelf_id FROM anime_work_links WHERE anime_id = ? AND origin = 'manual' AND manga_id = ?").all(id, own);
        assert.deepEqual(pins.map(p => p.scope_shelf_id), [second]);
        assert.equal(await linkOf(ed, id), edEdition);
    } finally {
        await core.close();
    }
});

test('unlinking hides the link in every editable shelf that shows it and leaves the other shelf its own', async () => {
    const { core, admin, ed, shelf, series, anime, linkOf } = await setup();
    try {
        const edShelf = await shelf(ed, 'Eds Regal');
        const first = await shelf(admin, 'Erstes');
        const second = await shelf(admin, 'Zweites');
        const edEdition = await series(ed, 'Werk B', { work_key: 'anilist:7002', shelf_id: edShelf });
        await series(admin, 'Werk B Eins', { work_key: 'anilist:7002', shelf_id: first });
        await series(admin, 'Werk B Zwei', { work_key: 'anilist:7002', shelf_id: second });
        const id = await anime(ed, 'Anime B', edEdition);
        assert.ok(await linkOf(admin, id), 'the admin sees an own edition');

        assert.equal((await admin('PUT', `/anime/${id}`, { manga_id: null })).status, 200);
        assert.equal(await linkOf(admin, id), null, 'hidden in both of the caller\'s shelves');
        assert.equal(await linkOf(ed, id), edEdition);
        const hidden = core.conn.prepare("SELECT scope_shelf_id FROM anime_work_links WHERE anime_id = ? AND hidden = 1 ORDER BY scope_shelf_id").all(id);
        assert.deepEqual(hidden.map(h => h.scope_shelf_id), [first, second]);
        assert.ok(core.conn.prepare('SELECT work_id FROM animes WHERE id = ?').get(id).work_id, 'the link for everyone stays: ed still holds an edition');
    } finally {
        await core.close();
    }
});

test('a link shown only in a shelf the caller merely reads is not theirs to undo (404), linking there needs editor rights', async () => {
    const { core, admin, ed, shelf, series, anime, linkOf } = await setup();
    try {
        const edShelf = await shelf(ed, 'Eds Regal');
        assert.equal((await ed('POST', `/shelves/${edShelf}/members`, { username: 'admin', role: 'viewer' })).status, 201);
        const edEdition = await series(ed, 'Werk C', { shelf_id: edShelf });
        const id = await anime(ed, 'Anime C', edEdition);
        assert.equal(await linkOf(admin, id), edEdition, 'a reader of the shelf sees its link');

        const refused = await admin('PUT', `/anime/${id}`, { manga_id: null });
        assert.equal(refused.status, 404, JSON.stringify(refused.body));
        assert.equal((await admin('PUT', `/anime/${id}`, { manga_id: edEdition })).status, 403, 'a reader cannot pin in that shelf');
        assert.equal(await linkOf(ed, id), edEdition);
    } finally {
        await core.close();
    }
});

test('the pinned edition goes into the trash: its shelf shows another edition of the work, the restore brings the pin back', async () => {
    const { core, admin, shelf, series, anime, linkOf } = await setup();
    try {
        const own = await shelf(admin, 'Eigenes');
        const de = await series(admin, 'Werk D', { work_key: 'anilist:7004', shelf_id: own, language: 'de' });
        const en = await series(admin, 'Werk D EN', { work_key: 'anilist:7004', shelf_id: own, language: 'en' });
        const id = await anime(admin, 'Anime D', en);
        assert.equal(await linkOf(admin, id), en, 'the pinned edition wins over the default language');

        const trashed = await admin('DELETE', `/mangas/${en}`);
        assert.equal(trashed.status, 200);
        assert.equal(await linkOf(admin, id), de, 'the edition of the pinned work in that shelf');
        assert.equal((await admin('POST', `/trash/${trashed.body.trash_id}/restore`)).status, 200);
        // the pin lost its series (ON DELETE SET NULL); both editions are the shelf's again, the default language first
        assert.equal(await linkOf(admin, id), de);
        assert.equal((await admin('PUT', `/anime/${id}`, { manga_id: en })).status, 200);
        assert.equal(await linkOf(admin, id), en);
    } finally {
        await core.close();
    }
});
