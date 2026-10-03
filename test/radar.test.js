const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx, admin, editor, visitor;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client(); editor = ctx.client(); visitor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'vis', password: 'password123', role: 'visitor' })).status, 200);
    await editor('POST', '/auth/login', { username: 'ed', password: 'password123' });
    await visitor('POST', '/auth/login', { username: 'vis', password: 'password123' });
});
test.after(async () => { await ctx.close(); });

const importBody = (o = {}) => ({ title: 'Neue Reihe', volume_number: '1', publisher: 'carlsen manga', release_date: '2026-11-05', price: 7.5, ...o });

test('import: creates the series and the pre-ordered volume together; visitors may not import', async () => {
    assert.equal((await visitor('POST', '/manga-passion/import', importBody())).status, 403);
    const res = await editor('POST', '/manga-passion/import', importBody({ title: 'Neue Reihe (eBook)' }));
    assert.equal(res.status, 200);
    const manga = (await editor('GET', `/mangas/${res.body.manga_id}`)).body;
    assert.equal(manga.title, 'Neue Reihe');
    assert.equal(manga.publisher, 'Carlsen Manga');
    assert.equal(manga.volumes.length, 1);
    assert.equal(manga.volumes[0].status, 'Vorbestellt');
    assert.equal(manga.volumes[0].price, 7.5);
    assert.equal(manga.volumes[0].release_date, '2026-11-05');
});

test('import: the same volume again updates it instead of adding a duplicate (number and spelling independent)', async () => {
    const first = await editor('POST', '/manga-passion/import', importBody({ title: 'Doppelt Reihe', volume_number: '2' }));
    const again = await editor('POST', '/manga-passion/import', importBody({ manga_id: first.body.manga_id, volume_number: ' 2 ', price: 8, target_status: 'Erscheint bald' }));
    assert.equal(again.status, 200);
    assert.equal(again.body.volume_id, first.body.volume_id);
    const manga = (await editor('GET', `/mangas/${first.body.manga_id}`)).body;
    assert.equal(manga.volumes.length, 1);
    assert.equal(manga.volumes[0].status, 'Erscheint bald');
    assert.equal(manga.volumes[0].price, 8);
});

test('import: an owned volume is never put back to pre-ordered; a Schuber with the same number is a different entry', async () => {
    const made = await editor('POST', '/mangas', { title: 'Besitz Reihe' });
    const mangaId = made.body.id;
    await editor('POST', '/volumes', { manga_id: mangaId, volume_number: '5', status: 'Vorhanden' });
    await editor('POST', '/volumes', { manga_id: mangaId, volume_number: '6', status: 'Vorhanden', type: 'schuber' });

    const owned = await editor('POST', '/manga-passion/import', importBody({ manga_id: mangaId, volume_number: '5' }));
    assert.equal(owned.status, 200);
    assert.equal(owned.body.skipped_owned, true);
    assert.equal(owned.body.status, 'Vorhanden');

    const sameNumberAsSchuber = await editor('POST', '/manga-passion/import', importBody({ manga_id: mangaId, volume_number: '6' }));
    assert.equal(sameNumberAsSchuber.body.skipped_owned, false);

    const vols = (await editor('GET', `/mangas/${mangaId}`)).body.volumes;
    assert.equal(vols.find(v => v.volume_number === '5').status, 'Vorhanden');
    assert.equal(vols.filter(v => v.volume_number === '6').length, 2);
});

test('import: invalid input is rejected and creates nothing', async () => {
    const before = (await editor('GET', '/mangas')).body.length;
    const bad = async (override, status) => assert.equal((await editor('POST', '/manga-passion/import', importBody(override))).status, status, JSON.stringify(override));
    await bad({ target_status: 'Vorhanden' }, 400);
    await bad({ target_status: 'Quatsch' }, 400);
    await bad({ price: -1 }, 400);
    await bad({ price: 'teuer' }, 400);
    await bad({ release_date: 'morgen' }, 400);
    await bad({ title: '   ' }, 400);
    await bad({ title: undefined }, 400);
    await bad({ volume_number: 'x'.repeat(81) }, 400);
    await bad({ manga_id: 999999 }, 404);
    assert.equal((await editor('GET', '/mangas')).body.length, before);
});

test('releases: an incomplete month (later page failed) is not cached, an outage serves the last cached month', async () => {
    const realFetch = global.fetch;
    const member = (id) => ({ id, number: id, numberDisplay: String(id), date: '2026-10-09T00:00:00+00:00', price: 700, edition: { id: 1, title: 'Cache Reihe', publishers: [{ name: 'Carlsen Manga' }] } });
    let calls = 0;
    // only calls to Manga Passion are faked; the test client talks to the local server through the same fetch
    const fake = (impl) => { global.fetch = (url, opts) => (String(url).startsWith(ctx.base) ? realFetch(url, opts) : impl(url, opts)); };
    try {
        // page 1 is full (100 entries, 150 announced), page 2 fails
        fake(async (url) => {
            calls++;
            if (String(url).includes('page=2')) return { ok: false, status: 503, json: async () => ({}) };
            return { ok: true, status: 200, json: async () => ({ 'hydra:member': Array.from({ length: 100 }, (_, i) => member(i + 1)), 'hydra:totalItems': 150 }) };
        });
        const urls = [];
        const inner = global.fetch;
        global.fetch = (url, opts) => { urls.push(String(url)); return inner(url, opts); };
        const partial = await editor('GET', '/manga-passion/releases?year=2031&month=3');
        global.fetch = inner;
        assert.ok(urls.some(u => u.includes('order[date]=asc&order[id]=asc')), 'the id breaks ties so pages are stable');
        assert.equal(partial.status, 200);
        assert.equal(partial.body.total_items, 100);

        calls = 0;
        const again = await editor('GET', '/manga-passion/releases?year=2031&month=3');
        assert.ok(calls > 0, 'the partial answer was not served from the cache');
        assert.equal(again.body.total_items, 100);

        // complete answer gets cached
        fake(async () => ({ ok: true, status: 200, json: async () => ({ 'hydra:member': [member(1), member(2)], 'hydra:totalItems': 2 }) }));
        assert.equal((await editor('GET', '/manga-passion/releases?year=2031&month=4')).body.total_items, 2);

        // outage: no network, forced refresh -> last cached month, marked as stale
        fake(async () => { throw new Error('network down'); });
        const stale = await editor('GET', '/manga-passion/releases?year=2031&month=4&force_refresh=true');
        assert.equal(stale.status, 200);
        assert.equal(stale.body.total_items, 2);
        assert.equal(stale.body.stale, true);

        // outage and nothing cached: error
        assert.equal((await editor('GET', '/manga-passion/releases?year=2031&month=5')).status, 500);
        assert.equal((await editor('GET', '/manga-passion/releases?year=1999&month=5')).status, 400);
    } finally { global.fetch = realFetch; }
});

test('releases: an entry the API repeats is shown once', async () => {
    const realFetch = global.fetch;
    const member = (id) => ({ id, number: id, numberDisplay: String(id), date: '2026-10-09T00:00:00+00:00', price: 700, edition: { id: 1, title: 'Dupe Reihe', publishers: [{ name: 'Carlsen Manga' }] } });
    try {
        global.fetch = (url, opts) => (String(url).startsWith(ctx.base)
            ? realFetch(url, opts)
            : Promise.resolve({ ok: true, status: 200, json: async () => ({ 'hydra:member': [member(1), member(2), member(2), member(3)], 'hydra:totalItems': 4 }) }));
        const res = await editor('GET', '/manga-passion/releases?year=2032&month=1');
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.items.map(i => i.id), [1, 2, 3]);
    } finally { global.fetch = realFetch; }
});
