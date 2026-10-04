// Radar API: Manga Passion releases, calendar entries, shopping list and the calendar feed, with the upstream faked.
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

// Manga Passion is faked; the test client talks to the local server through the same fetch
function fakeMp(impl) {
    const realFetch = global.fetch;
    global.fetch = (url, opts) => (String(url).startsWith(ctx.base) ? realFetch(url, opts) : impl(String(url), opts));
    return () => { global.fetch = realFetch; };
}
const backdateCache = (key, ageMs) => require('../db').db.prepare('UPDATE manga_passion_cache SET created_at = ? WHERE cache_key = ?').run(Date.now() - ageMs, key);
const pad2 = (n) => String(n).padStart(2, '0');
// GET /manga-passion/releases accepts today - 5 .. today + 3
const Y = new Date().getFullYear();

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
    await bad({ release_date: '2026-13-01' }, 400);
    await bad({ release_date: '2026-00-10' }, 400);
    await bad({ release_date: '2026-99-99' }, 400);
    await bad({ release_date: '2026-02-31' }, 400);
    await bad({ release_date: '2026-13-45' }, 400);
    await bad({ release_date: ['2026-11-05'] }, 400);
    await bad({ title: { a: 1 } }, 400);
    await bad({ cover_image: { x: 1 } }, 400);
    await bad({ cover_image: 'javascript:alert(1)' }, 400);
    await bad({ cover_image: 'https://x.example/' + 'a'.repeat(2100) }, 400);
    await bad({ price: true }, 400);
    await bad({ volume_number: ['1'] }, 400);
    await bad({ volume_number: '' }, 400);
    await bad({ publisher: ['Carlsen'] }, 400);
    await bad({ type: 'sammelband' }, 400);
    await bad({ edition_id: 'abc' }, 400);
    await bad({ target_status: ['Vorbestellt'] }, 400);
    assert.equal((await editor('GET', '/mangas')).body.length, before);
    const monthOnly = await editor('POST', '/manga-passion/import', importBody({ title: 'Monat Reihe', release_date: '2026-12' }));
    assert.equal(monthOnly.status, 200);
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
        const partial = await editor('GET', `/manga-passion/releases?year=${Y - 1}&month=3`);
        global.fetch = inner;
        assert.ok(urls.some(u => u.includes('order[date]=asc&order[id]=asc')), 'the id breaks ties so pages are stable');
        assert.equal(partial.status, 200);
        assert.equal(partial.body.total_items, 100);

        calls = 0;
        const again = await editor('GET', `/manga-passion/releases?year=${Y - 1}&month=3`);
        assert.ok(calls > 0, 'the partial answer was not served from the cache');
        assert.equal(again.body.total_items, 100);

        // complete answer gets cached
        fake(async () => ({ ok: true, status: 200, json: async () => ({ 'hydra:member': [member(1), member(2)], 'hydra:totalItems': 2 }) }));
        assert.equal((await editor('GET', `/manga-passion/releases?year=${Y - 1}&month=4`)).body.total_items, 2);

        // a forced refresh right after a fetch is answered from the cache (cooldown)
        calls = 0;
        fake(async () => { calls++; throw new Error('network down'); });
        const cooled = await editor('GET', `/manga-passion/releases?year=${Y - 1}&month=4&force_refresh=true`);
        assert.equal(cooled.body.stale, false);
        assert.equal(calls, 0);

        // outage: no network, forced refresh after the cooldown -> last cached month, marked as stale
        backdateCache(`mp_releases_${Y - 1}_4`, 2 * 60 * 1000);
        const stale = await editor('GET', `/manga-passion/releases?year=${Y - 1}&month=4&force_refresh=true`);
        assert.equal(stale.status, 200);
        assert.equal(stale.body.total_items, 2);
        assert.equal(stale.body.stale, true);
        assert.equal(calls, 1);

        // outage and nothing cached: 503 with the specific message (never the generic 500), also while the failure is remembered
        for (let i = 0; i < 2; i++) {
            const down = await editor('GET', `/manga-passion/releases?year=${Y - 1}&month=5`);
            assert.equal(down.status, 503);
            assert.equal(down.body.error, 'Fehler beim Abrufen der Manga-Passion-Neuerscheinungen');
            assert.equal(down.body.code, 'MP_UNAVAILABLE');
        }
        assert.equal((await editor('GET', '/manga-passion/releases?year=1999&month=5')).status, 400);
    } finally { global.fetch = realFetch; }
});

test('releases: uncached months cost lookup budget, force_refresh only for editors, years only around today', async () => {
    const { lookupLimiter, USER_LOOKUPS_PER_MINUTE } = require('../middleware/userLimits');
    const { writeCache } = require('../services/mangaPassion/client');
    const { resetReleaseFetchState } = require('../services/mangaPassionReleases');
    lookupLimiter.reset();
    assert.equal((await admin('POST', '/users', { username: 'gast-kalender', password: 'password123', role: 'guest' })).status, 200);
    const guest = ctx.client();
    assert.equal((await guest('POST', '/auth/login', { username: 'gast-kalender', password: 'password123' })).status, 200);
    writeCache(`mp_releases_${Y - 4}_6`, [{ id: 1, title: 'Budget Reihe', volume_number: '1' }]);
    backdateCache(`mp_releases_${Y - 4}_6`, 2 * 60 * 1000);
    let calls = 0;
    const restore = fakeMp(async () => { calls++; throw new Error('offline'); });
    try {
        for (let i = 0; i < USER_LOOKUPS_PER_MINUTE + 5; i++) {
            const res = await guest('GET', `/manga-passion/releases?year=${Y - 4}&month=6&force_refresh=true`);
            assert.deepEqual([res.status, res.body.stale], [200, false], 'cached month, force_refresh ignored for guests');
        }
        assert.equal(calls, 0);

        const statuses = [];
        for (let i = 0; i <= USER_LOOKUPS_PER_MINUTE; i++) {
            statuses.push((await guest('GET', `/manga-passion/releases?year=${Y - 4}&month=7`)).status);
        }
        assert.deepEqual(statuses.slice(0, USER_LOOKUPS_PER_MINUTE).filter(s => s !== 503), []);
        assert.equal(statuses.at(-1), 429);
        assert.equal((await guest('GET', `/manga-passion/releases?year=${Y - 4}&month=6`)).status, 200, 'the cache still answers');

        const before = calls;
        const forced = await editor('GET', `/manga-passion/releases?year=${Y - 4}&month=6&force_refresh=true`);
        assert.deepEqual([forced.status, forced.body.stale], [200, true]);
        assert.ok(calls > before, 'editors may bypass the cache');

        for (const year of [Y - 6, Y + 4, 2100]) {
            assert.equal((await editor('GET', `/manga-passion/releases?year=${year}&month=1`)).status, 400, String(year));
        }
        assert.equal((await editor('GET', `/manga-passion/releases?year=${Y + 3}&month=12`)).status, 503);
    } finally {
        restore();
        resetReleaseFetchState();
        lookupLimiter.reset();
    }
});

test('releases: an entry the API repeats is shown once', async () => {
    const realFetch = global.fetch;
    const member = (id) => ({ id, number: id, numberDisplay: String(id), date: '2026-10-09T00:00:00+00:00', price: 700, edition: { id: 1, title: 'Dupe Reihe', publishers: [{ name: 'Carlsen Manga' }] } });
    try {
        global.fetch = (url, opts) => (String(url).startsWith(ctx.base)
            ? realFetch(url, opts)
            : Promise.resolve({ ok: true, status: 200, json: async () => ({ 'hydra:member': [member(1), member(2), member(2), member(3)], 'hydra:totalItems': 4 }) }));
        const res = await editor('GET', `/manga-passion/releases?year=${Y - 2}&month=1`);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.items.map(i => i.id), [1, 2, 3]);
    } finally { global.fetch = realFetch; }
});

test('Terminabgleich: verschobene Vorbestellung wird gemeldet, gleiche Monatsangabe nicht', async () => {
    const { writeCache } = require('../services/mangaPassion/client');
    const realFetch = global.fetch;
    global.fetch = (url, opts) => (String(url).startsWith(ctx.base) ? realFetch(url, opts) : Promise.reject(new Error('offline')));
    try {
        const ym = (offset) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset); return [d.getFullYear(), d.getMonth() + 1]; };
        const [y1, m1] = ym(1);
        const [y2, m2] = ym(2);
        const p2 = (n) => String(n).padStart(2, '0');
        const a = await editor('POST', '/mangas', { title: 'Verschiebe Reihe' });
        const mk = (n, date) => editor('POST', '/volumes', { manga_id: a.body.id, volume_number: n, status: 'Vorbestellt', release_date: date });
        const moved = (await mk('1', `${y1}-${p2(m1)}-10`)).body.id;
        await mk('2', `${y1}-${p2(m1)}`);
        const entry = (n, date) => ({ id: Number(n), title: 'Verschiebe Reihe', volume_number: n, publisher: 'X', date, is_digital: false });
        writeCache(`mp_releases_${y1}_${m1}`, [entry('2', `${y1}-${p2(m1)}-20`)]);
        writeCache(`mp_releases_${y2}_${m2}`, [entry('1', `${y2}-${p2(m2)}-02`)]);
        const res = await editor('GET', '/release-radar/changes');
        assert.equal(res.status, 200);
        const mine = res.body.changes.filter(c => c.manga_title === 'Verschiebe Reihe');
        assert.deepEqual(mine.map(c => [c.volume_id, c.stored_date, c.new_date]), [[moved, `${y1}-${p2(m1)}-10`, `${y2}-${p2(m2)}-02`]]);
    } finally {
        global.fetch = realFetch;
    }
});

test('monthsToCheck: from at most one month back to six months after the latest date, capped', () => {
    const { monthsToCheck } = require('../services/mangaPassionReleases');
    const ym = (list) => list.map(m => `${m.year}-${m.month}`);
    const now = new Date(2026, 9, 15);
    assert.deepEqual(monthsToCheck([], now), []);
    assert.deepEqual(monthsToCheck([{ release_date: 'bald' }, { release_date: '' }], now), []);
    assert.deepEqual(ym(monthsToCheck([{ release_date: '2026-11-05' }], now)), ['2026-10', '2026-11', '2026-12', '2027-1', '2027-2', '2027-3', '2027-4', '2027-5']);
    assert.deepEqual(monthsToCheck([{ release_date: '2026-12' }], now).slice(-1)[0], { year: 2027, month: 6 });
    // a recent past date starts the window one month back at most
    assert.deepEqual(ym(monthsToCheck([{ release_date: '2026-09-20' }, { release_date: '2026-10-01' }], now)).slice(0, 2), ['2026-9', '2026-10']);
    const far = monthsToCheck([{ release_date: '2099-01-01' }], now);
    assert.equal(far.length, 14);
    assert.deepEqual(far[0], { year: 2026, month: 10 });
});

test('monthsToCheck: one overdue pre-order never pushes the current and future months out of the window', () => {
    const { monthsToCheck } = require('../services/mangaPassionReleases');
    const ym = (list) => list.map(m => `${m.year}-${m.month}`);
    const now = new Date(2026, 9, 3);
    const win = ym(monthsToCheck([{ release_date: '2024-03-15' }, { release_date: '2026-12-01' }], now));
    for (const m of ['2026-10', '2026-11', '2026-12', '2027-1', '2027-6']) assert.ok(win.includes(m), m);
    assert.equal(win[0], '2026-9');
    assert.ok(win.length <= 14);
    const overdueOnly = ym(monthsToCheck([{ release_date: '2019-05-01' }], now));
    assert.deepEqual(overdueOnly, ['2026-9', '2026-10', '2026-11']);
});

test('Terminabgleich: a postponement by several months past the stored month is found', async () => {
    const { writeCache } = require('../services/mangaPassion/client');
    const { zonedToday } = require('../services/radar');
    const restore = fakeMp(async () => { throw new Error('offline'); });
    try {
        const t = zonedToday();
        const at = (offset) => { const d = new Date(t.getFullYear(), t.getMonth() + offset, 1); return [d.getFullYear(), d.getMonth() + 1]; };
        const [y1, m1] = at(1);
        const [y4, m4] = at(4);
        const a = await editor('POST', '/mangas', { title: 'Spaet Reihe' });
        const vol = (await editor('POST', '/volumes', { manga_id: a.body.id, volume_number: '3', status: 'Vorbestellt', release_date: `${y1}-${pad2(m1)}-05` })).body.id;
        writeCache(`mp_releases_${y4}_${m4}`, [{ id: 7003, title: 'Spaet Reihe', volume_number: '3', publisher: 'X', date: `${y4}-${pad2(m4)}-10`, is_digital: false }]);
        const res = await editor('GET', '/release-radar/changes');
        assert.equal(res.status, 200);
        const mine = res.body.changes.filter(c => c.volume_id === vol);
        assert.deepEqual(mine.map(c => c.new_date), [`${y4}-${pad2(m4)}-10`]);
        assert.equal(mine[0].type, 'volume');
    } finally { restore(); }
});

test('radar: items carry purchase_date, so "Geliefert" keeps a stored order date', async () => {
    const { zonedToday, monthKeyOf } = require('../services/radar');
    const t = zonedToday();
    const today = `${monthKeyOf(t)}-${pad2(t.getDate())}`;
    const m = await editor('POST', '/mangas', { title: 'Kaufdatum Reihe' });
    const kept = (await editor('POST', '/volumes', { manga_id: m.body.id, volume_number: '1', status: 'Vorbestellt', purchase_date: '2026-08-01' })).body.id;
    const fresh = (await editor('POST', '/volumes', { manga_id: m.body.id, volume_number: '2', status: 'Vorbestellt' })).body.id;

    const radar = (await editor('GET', '/release-radar')).body;
    const radarItems = radar.groups.flatMap(g => g.items);
    const item = radarItems.find(i => i.id === kept);
    assert.equal(item.purchase_date, '2026-08-01');
    const other = radarItems.find(i => i.id === fresh);
    assert.ok('purchase_date' in other);

    // what handleMarkDelivered sends
    for (const it of [item, other]) {
        assert.equal((await editor('PUT', `/volumes/${it.id}`, { status: 'Vorhanden', purchase_date: it.purchase_date || today })).status, 200);
    }
    const vols = (await editor('GET', `/mangas/${m.body.id}`)).body.volumes;
    const v1 = vols.find(v => v.id === kept);
    assert.equal(v1.purchase_date, '2026-08-01');
    assert.equal(v1.owners[0].purchase_date, '2026-08-01');
    assert.equal(vols.find(v => v.id === fresh).purchase_date, today);
});

test('radar: the month cutoff follows the app time zone (last month is gone, this month stays)', async () => {
    const { zonedToday } = require('../services/radar');
    const t = zonedToday();
    const prev = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    const m = await editor('POST', '/mangas', { title: 'Grenze Reihe' });
    const old = (await editor('POST', '/volumes', { manga_id: m.body.id, volume_number: '1', status: 'Fehlt', release_date: `${prev.getFullYear()}-${pad2(prev.getMonth() + 1)}-28` })).body.id;
    const cur = (await editor('POST', '/volumes', { manga_id: m.body.id, volume_number: '2', status: 'Fehlt', release_date: `${t.getFullYear()}-${pad2(t.getMonth() + 1)}` })).body.id;
    const radarItems = async () => (await editor('GET', '/release-radar')).body.groups.flatMap(g => g.items);
    const ids = (await radarItems()).map(i => i.id);
    assert.ok(!ids.includes(old));
    assert.ok(ids.includes(cur));
    const item = (await radarItems()).find(i => i.id === cur);
    assert.equal(item.countdown_label, 'Diesen Monat');
});

test('import: volumes of a new series imported one after another land in one series', async () => {
    const one = await editor('POST', '/manga-passion/import', importBody({ title: 'Brandneu Reihe', volume_number: '1' }));
    const two = await editor('POST', '/manga-passion/import', importBody({ title: 'Brandneu Reihe', volume_number: '2' }));
    const three = await editor('POST', '/manga-passion/import', importBody({ title: ' brandneu reihe ', volume_number: '3' }));
    const ebook = await editor('POST', '/manga-passion/import', importBody({ title: 'Brandneu Reihe (eBook)', volume_number: '1', price: 9 }));
    assert.deepEqual([one, two, three, ebook].map(r => r.status), [200, 200, 200, 200]);
    assert.deepEqual([two, three, ebook].map(r => r.body.manga_id), [one.body.manga_id, one.body.manga_id, one.body.manga_id]);
    assert.deepEqual([one, two, three].map(r => r.body.series_created), [true, false, false]);
    assert.equal(ebook.body.volume_id, one.body.volume_id);
    const all = (await editor('GET', '/mangas')).body.filter(x => x.title.toLowerCase() === 'brandneu reihe');
    assert.equal(all.length, 1);
    assert.equal((await editor('GET', `/mangas/${one.body.manga_id}`)).body.volumes.length, 3);

    const spin = await editor('POST', '/manga-passion/import', importBody({ title: 'Brandneu Reihe: Spin-off', volume_number: '1' }));
    assert.notEqual(spin.body.manga_id, one.body.manga_id);
    assert.equal(spin.body.series_created, true);

    const alt = await editor('POST', '/mangas', { title: 'Shingeki no Kyojin', alt_title: 'Attack on Titan', publisher: 'Carlsen Manga' });
    const viaAlt = await editor('POST', '/manga-passion/import', importBody({ title: 'Attack on Titan', volume_number: '34', publisher: 'Panini', cover_image: '/uploads/anders.jpg' }));
    assert.equal(viaAlt.body.manga_id, alt.body.id);
    const series = (await editor('GET', `/mangas/${alt.body.id}`)).body;
    assert.equal(series.publisher, 'Carlsen Manga');
    assert.equal(series.cover_image ?? null, null);
});

test('import: a spin-off sent without manga_id never touches the main series volume', async () => {
    const main = await editor('POST', '/mangas', { title: 'Blue Lock' });
    const vol = (await editor('POST', '/volumes', { manga_id: main.body.id, volume_number: '3', status: 'Vorbestellt', release_date: '2026-11-05', price: 7 })).body.id;
    const res = await editor('POST', '/manga-passion/import', importBody({ title: 'Blue Lock – Episode Nagi', volume_number: '3', release_date: '2026-11-19', price: 9, target_status: 'Fehlt' }));
    assert.equal(res.status, 200);
    assert.notEqual(res.body.manga_id, main.body.id);
    const v = (await editor('GET', `/mangas/${main.body.id}`)).body.volumes.find(x => x.id === vol);
    assert.deepEqual([v.status, v.release_date, v.price], ['Vorbestellt', '2026-11-05', 7]);
});

test('import: numberless specials get their own rows and type; the same special again updates it', async () => {
    const m = await editor('POST', '/mangas', { title: 'Special Reihe' });
    const art = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: 'Artbook', type: 'special', volume_title: 'Artbook', price: 12, release_date: '2026-11-01' }));
    // an older client sends no type: a number without digits is still a special
    const fan = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: 'Fanbook', price: 25, release_date: '2026-12-01' }));
    const artAgain = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: 'artbook', type: 'special', price: 13 }));
    assert.notEqual(art.body.volume_id, fan.body.volume_id);
    assert.equal(artAgain.body.volume_id, art.body.volume_id);
    assert.equal(art.body.type, 'special');
    // a bare "Special" from an old calendar entry is never merged with another one
    const s1 = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: 'Special', price: 5 }));
    const s2 = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: 'Special', price: 6 }));
    assert.notEqual(s1.body.volume_id, s2.body.volume_id);
    const vols = (await editor('GET', `/mangas/${m.body.id}`)).body.volumes;
    assert.equal(vols.length, 4);
    assert.ok(vols.every(v => v.type === 'special'));
    assert.equal(vols.find(v => v.id === art.body.volume_id).price, 13);
    assert.equal(vols.find(v => v.id === art.body.volume_id).notes, 'Artbook');
    assert.equal(vols.find(v => v.id === fan.body.volume_id).price, 25);

    // a Collectors Edition with the number of a regular volume is its own entry
    await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: '5' }));
    const ce = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: '5', type: 'special_edition' }));
    assert.equal(ce.body.type, 'special_edition');
    assert.equal((await editor('GET', `/mangas/${m.body.id}`)).body.volumes.filter(v => v.volume_number === '5').length, 2);
});

test('import: the Manga Passion volume id dedupes, numeric 0 stays volume 0', async () => {
    const m = await editor('POST', '/mangas', { title: 'Nummer Reihe' });
    const a = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: '7', mp_volume_id: 4711 }));
    const b = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: ' 7 ', mp_volume_id: '4711', price: 9 }));
    assert.equal(b.body.volume_id, a.body.volume_id);
    const band = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: 'Band 7' }));
    assert.equal(band.body.volume_id, a.body.volume_id);
    const zero = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: 0 }));
    assert.equal(zero.status, 200);
    const vols = (await editor('GET', `/mangas/${m.body.id}`)).body.volumes;
    assert.deepEqual(vols.map(v => v.volume_number).sort(), ['0', '7']);
});

test('import: edition link and local covers', async () => {
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');
    const { uploadsDir } = require('../db');
    const remote = 'https://cdn.manga-passion.example/cover/123.jpg';
    const local = `mp-cov-${crypto.createHash('md5').update(remote).digest('hex').slice(0, 16)}.jpg`;
    fs.writeFileSync(path.join(uploadsDir, local), Buffer.alloc(600, 1));

    const res = await editor('POST', '/manga-passion/import', importBody({ title: 'Edition Reihe', edition_id: 321, cover_image: remote }));
    assert.equal(res.status, 200);
    const db = require('../db').db;
    const row = db.prepare('SELECT manga_passion_id, cover_image FROM mangas WHERE id = ?').get(res.body.manga_id);
    assert.deepEqual({ ...row }, { manga_passion_id: 321, cover_image: `/uploads/${local}` });
    assert.equal(db.prepare('SELECT cover_image FROM volumes WHERE id = ?').get(res.body.volume_id).cover_image, `/uploads/${local}`);

    // a reused series keeps its link
    const again = await editor('POST', '/manga-passion/import', importBody({ title: 'Edition Reihe', volume_number: '2', edition_id: 999 }));
    assert.equal(again.body.manga_id, res.body.manga_id);
    assert.equal(db.prepare('SELECT manga_passion_id FROM mangas WHERE id = ?').get(res.body.manga_id).manga_passion_id, 321);

    const kept = await editor('POST', '/manga-passion/import', importBody({ title: 'Upload Reihe', cover_image: '/uploads/abc.jpg' }));
    assert.equal(db.prepare('SELECT cover_image FROM mangas WHERE id = ?').get(kept.body.manga_id).cover_image, '/uploads/abc.jpg');
});

test('import: a client-supplied cover is stored under its detected type without metadata and counts against the image budget', async (t) => {
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');
    const { uploadsDir } = require('../db');
    const safeFetch = require('../utils/safeFetch');
    const { remoteImageLimiter, USER_LOOKUPS_PER_MINUTE } = require('../middleware/userLimits');
    const seg = (marker, payload) => {
        const head = Buffer.from([0xff, marker, 0, 0]);
        head.writeUInt16BE(payload.length + 2, 2);
        return Buffer.concat([head, payload]);
    };
    const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0MM\0*\0\0\0\x08\0\0', 'latin1'), Buffer.from('GPS-SECRET-52.5200N-13.4050E')])),
        seg(0xdb, Buffer.alloc(600, 1)),
        seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
        Buffer.from([0x12, 0x34, 0xff, 0xd9])
    ]);
    let downloads = 0;
    t.mock.method(safeFetch, 'fetchRemoteImage', async () => { downloads++; return { buffer: jpeg, ext: '.jpg', contentType: 'image/jpeg' }; });
    remoteImageLimiter.reset();
    t.after(() => remoteImageLimiter.reset());

    const remote = 'https://images.example.org/photo.png';
    const res = await editor('POST', '/manga-passion/import', importBody({ title: 'Exif Reihe', cover_image: remote }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const name = `mp-cov-${crypto.createHash('md5').update(remote).digest('hex').slice(0, 16)}.jpg`;
    const db = require('../db').db;
    assert.equal(db.prepare('SELECT cover_image FROM volumes WHERE id = ?').get(res.body.volume_id).cover_image, `/uploads/${name}`);
    const stored = fs.readFileSync(path.join(uploadsDir, name));
    assert.deepEqual([...stored.subarray(0, 2)], [0xff, 0xd8]);
    assert.ok(!stored.includes('GPS-SECRET'), 'metadata is stripped');
    assert.equal(fs.existsSync(path.join(uploadsDir, name.replace(/\.jpg$/, '.png'))), false, 'the extension follows the bytes, not the URL');

    for (let i = 1; i < USER_LOOKUPS_PER_MINUTE; i++) {
        const r = await editor('POST', '/manga-passion/import', importBody({ title: 'Exif Reihe', volume_number: String(100 + i), cover_image: `https://images.example.org/p${i}.jpg` }));
        assert.equal(r.status, 200, String(i));
    }
    const limited = await editor('POST', '/manga-passion/import', importBody({ title: 'Exif Reihe', volume_number: '200', cover_image: 'https://images.example.org/zu-viel.jpg' }));
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /Bild-Downloads/);
    const before = downloads;
    const reused = await editor('POST', '/manga-passion/import', importBody({ title: 'Exif Reihe', volume_number: '201', cover_image: remote }));
    assert.equal(reused.status, 200, 'a stored cover needs no download and no budget');
    assert.equal(downloads, before);
});

test('releases: the calendar matches type + number and counts print entries of my series separately', async () => {
    const { writeCache } = require('../services/mangaPassion/client');
    const m = await editor('POST', '/mangas', { title: 'Spy x Family' });
    const se = (await editor('POST', '/volumes', { manga_id: m.body.id, volume_number: '5', type: 'special_edition', status: 'Vorhanden' })).body.id;
    const reg = (await editor('POST', '/volumes', { manga_id: m.body.id, volume_number: '5', type: 'volume', status: 'Vorbestellt' })).body.id;
    const entry = (id, title, extra = {}) => ({ id, edition_id: 50, title, raw_title: title, volume_number: '5', publisher: 'Carlsen Manga', date: '2033-02-10', is_digital: false, ...extra });
    writeCache(`mp_releases_${Y - 3}_2`, [
        entry(1, 'Spy x Family'),
        entry(2, 'Spy x Family', { raw_title: 'Spy x Family (eBook)', is_digital: true, edition_id: 51 }),
        entry(3, 'Spy x Family – Collectors Edition', { edition_id: 52 })
    ]);
    const res = await editor('GET', `/manga-passion/releases?year=${Y - 3}&month=2`);
    assert.equal(res.status, 200);
    const [regular, , collectors] = res.body.items;
    assert.deepEqual([regular.user_volume_id, regular.user_volume_status], [reg, 'Vorbestellt']);
    assert.deepEqual([collectors.user_volume_id, collectors.type], [se, 'special_edition']);
    assert.equal(res.body.user_series_count, 3);
    assert.equal(res.body.user_series_print_count, 2);
    assert.equal(res.body.truncated, false);
});

test('releases: a month with more than 500 entries is loaded in full; beyond the hard cap it is flagged, not cached', async () => {
    const member = (id) => ({ id, number: id, numberDisplay: String(id), date: '2034-01-09T00:00:00+00:00', edition: { id: 1, title: 'Viel Reihe' } });
    const pageOf = (url, total) => {
        const page = Number(new URL(url).searchParams.get('page'));
        const count = Math.max(0, Math.min(100, total - (page - 1) * 100));
        return { ok: true, status: 200, json: async () => ({ 'hydra:member': Array.from({ length: count }, (_, i) => member((page - 1) * 100 + i + 1)), 'hydra:totalItems': total }) };
    };
    let calls = 0;
    let restore = fakeMp(async (url) => { calls++; return pageOf(url, 640); });
    try {
        const full = await editor('GET', `/manga-passion/releases?year=${Y - 4}&month=1`);
        assert.equal(full.body.total_items, 640);
        assert.equal(calls, 7);
        calls = 0;
        assert.equal((await editor('GET', `/manga-passion/releases?year=${Y - 4}&month=1`)).body.total_items, 640);
        assert.equal(calls, 0);
    } finally { restore(); }

    calls = 0;
    restore = fakeMp(async (url) => { calls++; return pageOf(url, 2500); });
    try {
        const capped = await editor('GET', `/manga-passion/releases?year=${Y - 4}&month=2`);
        assert.equal(capped.body.total_items, 2000);
        assert.equal(capped.body.truncated, true);
        assert.equal(calls, 20);
        await editor('GET', `/manga-passion/releases?year=${Y - 4}&month=2`);
        assert.ok(calls > 20, 'a truncated month is not served from the cache');
    } finally { restore(); }
});

test('releases: a failed month is not asked again for a while; stale data is served without waiting', async () => {
    const { getMonthlyReleases, resetReleaseFetchState } = require('../services/mangaPassionReleases');
    const { writeCache } = require('../services/mangaPassion/client');
    resetReleaseFetchState();
    let calls = 0;
    const restore = fakeMp(async () => { calls++; throw new Error('down'); });
    try {
        await assert.rejects(getMonthlyReleases(2041, 1));
        assert.equal(calls, 1);
        await assert.rejects(getMonthlyReleases(2041, 1));
        await assert.rejects(getMonthlyReleases(2041, 1, true));
        assert.equal(calls, 1);

        writeCache('mp_releases_2041_2', [{ id: 1, title: 'Alt', volume_number: '1' }]);
        backdateCache('mp_releases_2041_2', 13 * 60 * 60 * 1000);
        assert.equal((await getMonthlyReleases(2041, 2)).stale, true);
        assert.equal(calls, 2);
        const again = await getMonthlyReleases(2041, 2);
        assert.deepEqual([again.stale, again.items.length, calls], [true, 1, 2]);
    } finally { restore(); resetReleaseFetchState(); }
});

test('releases: concurrent requests for one month share a fetch', async () => {
    const { getMonthlyReleases, resetReleaseFetchState } = require('../services/mangaPassionReleases');
    let calls = 0;
    const restore = fakeMp(async () => {
        calls++;
        await new Promise(r => setTimeout(r, 30));
        return { ok: true, status: 200, json: async () => ({ 'hydra:member': [{ id: 1, number: 1, edition: { id: 1, title: 'Zusammen' } }], 'hydra:totalItems': 1 }) };
    });
    try {
        const [a, b] = await Promise.all([getMonthlyReleases(2044, 1), getMonthlyReleases(2044, 1)]);
        assert.equal(calls, 1);
        assert.deepEqual([a.items.length, b.items.length], [1, 1]);
    } finally { restore(); resetReleaseFetchState(); }
});

test('Terminabgleich: months are fetched with bounded parallelism inside one time budget', async () => {
    const { fetchMonthsForCheck, resetReleaseFetchState } = require('../services/mangaPassionReleases');
    let inFlightNow = 0;
    let maxInFlight = 0;
    let calls = 0;
    // a hanging Manga Passion that only gives up when the request is aborted
    const restore = fakeMp((url, opts) => new Promise((resolve, reject) => {
        calls++;
        maxInFlight = Math.max(maxInFlight, ++inFlightNow);
        opts?.signal?.addEventListener('abort', () => { inFlightNow--; reject(new Error('aborted')); }, { once: true });
    }));
    try {
        const months = Array.from({ length: 8 }, (_, i) => ({ year: 2042, month: i + 1 }));
        const started = Date.now();
        const results = await fetchMonthsForCheck(months, { concurrency: 3, budgetMs: 200 });
        assert.ok(Date.now() - started < 2000);
        assert.equal(results.length, 8);
        assert.ok(results.every(r => r.error));
        assert.deepEqual(results.map(r => r.month), [1, 2, 3, 4, 5, 6, 7, 8]);
        assert.equal(maxInFlight, 3);
        assert.equal(calls, 3);
    } finally { restore(); resetReleaseFetchState(); }
});

test('Terminabgleich: during an outage a second check makes no Manga Passion calls', async () => {
    const { resetReleaseFetchState } = require('../services/mangaPassionReleases');
    resetReleaseFetchState();
    let calls = 0;
    const restore = fakeMp(async () => { calls++; throw new Error('down'); });
    try {
        const first = await editor('GET', '/release-radar/changes');
        assert.equal(first.status, 200);
        assert.ok(calls > 0);
        const before = calls;
        const second = await editor('GET', '/release-radar/changes');
        assert.equal(calls, before);
        assert.equal(second.body.months_failed, first.body.months_failed);
    } finally { restore(); resetReleaseFetchState(); }
});

test('editions: an unreachable Manga Passion answers 503 instead of an empty list', async () => {
    const restore = fakeMp(async () => { throw new TypeError('fetch failed'); });
    try {
        const res = await editor('GET', '/manga-passion/editions?title=Nirgends%20Reihe');
        assert.equal(res.status, 503);
        assert.equal((await editor('GET', '/manga-passion/editions')).status, 400);
    } finally { restore(); }
});

test('import: an ordered volume is never put back to "Fehlt"; "Erscheint bald" may move on', async () => {
    const m = await editor('POST', '/mangas', { title: 'Bestell Reihe' });
    const add = async (n, status) => (await editor('POST', '/volumes', { manga_id: m.body.id, volume_number: n, status })).body.id;
    const ordered = await add('1', 'Bestellt');
    const preordered = await add('2', 'Vorbestellt');
    const soon = await add('3', 'Erscheint bald');
    const statusOf = async (id) => (await editor('GET', `/mangas/${m.body.id}`)).body.volumes.find(v => v.id === id).status;

    for (const [n, id, stored] of [['1', ordered, 'Bestellt'], ['2', preordered, 'Vorbestellt']]) {
        const res = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: n, target_status: 'Fehlt' }));
        assert.equal(res.status, 200);
        assert.equal(res.body.skipped_ordered, true);
        assert.equal(res.body.status, stored);
        assert.equal(await statusOf(id), stored);
    }
    const reorder = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: '1', target_status: 'Vorbestellt' }));
    assert.equal(reorder.body.skipped_ordered, false);
    assert.equal(await statusOf(ordered), 'Vorbestellt');

    const missing = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: '3', target_status: 'Fehlt' }));
    assert.equal(missing.body.skipped_ordered, false);
    assert.equal(await statusOf(soon), 'Fehlt');
    assert.equal((await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: '3', target_status: 'Vorbestellt' }))).body.status, 'Vorbestellt');
});

test('import: an old client body for a Collectors Edition never overwrites the regular volume', async () => {
    const m = await editor('POST', '/mangas', { title: 'Frieren Alt' });
    const regular = (await editor('POST', '/volumes', { manga_id: m.body.id, volume_number: '5', status: 'Fehlt', price: 7.5, release_date: '2023-05-01' })).body.id;
    // the body the calendar sent before it knew about types
    const res = await editor('POST', '/manga-passion/import', {
        manga_id: m.body.id, title: 'Frieren Alt – Collectors Edition', volume_number: '5', publisher: 'Egmont',
        release_date: '2026-12', price: 24.99, target_status: 'Vorbestellt'
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.type, 'special_edition');
    assert.notEqual(res.body.volume_id, regular);
    const vols = (await editor('GET', `/mangas/${m.body.id}`)).body.volumes;
    const v = vols.find(x => x.id === regular);
    assert.deepEqual([v.status, v.price, v.release_date], ['Fehlt', 7.5, '2023-05-01']);
    assert.equal(vols.find(x => x.id === res.body.volume_id).type, 'special_edition');
});

test('import: a spin-off sent with the main series id goes to its own series', async () => {
    const main = await editor('POST', '/mangas', { title: 'Kaiju Reihe' });
    const vol = (await editor('POST', '/volumes', { manga_id: main.body.id, volume_number: '2', status: 'Vorbestellt', price: 7 })).body.id;
    const res = await editor('POST', '/manga-passion/import', importBody({
        manga_id: main.body.id, title: 'Kaiju Reihe – Side Story', volume_number: '2', price: 12, target_status: 'Fehlt'
    }));
    assert.equal(res.status, 200);
    assert.notEqual(res.body.manga_id, main.body.id);
    assert.equal(res.body.series_created, true);
    const v = (await editor('GET', `/mangas/${main.body.id}`)).body.volumes.find(x => x.id === vol);
    assert.deepEqual([v.status, v.price], ['Vorbestellt', 7]);
    // a Collectors Edition of the same series stays in it
    const ce = await editor('POST', '/manga-passion/import', importBody({ manga_id: main.body.id, title: 'Kaiju Reihe – Collectors Edition', volume_number: '2' }));
    assert.equal(ce.body.manga_id, main.body.id);
    assert.equal(ce.body.type, 'special_edition');
});

test('import: a row linked to the Manga Passion volume but of another type is not overwritten', async () => {
    const m = await editor('POST', '/mangas', { title: 'Typ Link Reihe' });
    const first = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: '4', mp_volume_id: 5150, type: 'special_edition', price: 20 }));
    const second = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: '4', mp_volume_id: 5150, type: 'volume', price: 7 }));
    assert.notEqual(second.body.volume_id, first.body.volume_id);
    const vols = (await editor('GET', `/mangas/${m.body.id}`)).body.volumes;
    assert.equal(vols.find(v => v.id === first.body.volume_id).price, 20);
});

test('calendar match after a CE and a regular import of the same Manga Passion volume: each type finds its own row', async () => {
    const { buildMatcher } = require('../services/mangaPassionReleases');
    const { db } = require('../db');
    const m = await editor('POST', '/mangas', { title: 'Kaiju Repro' });
    const base = { manga_id: m.body.id, title: 'Kaiju Repro', volume_number: '4', mp_volume_id: 5151, edition_id: 1 };
    const ce = await editor('POST', '/manga-passion/import', importBody({ ...base, type: 'special_edition', target_status: 'Vorbestellt' }));
    const regular = await editor('POST', '/manga-passion/import', importBody({ ...base, type: 'volume', target_status: 'Fehlt' }));
    assert.notEqual(regular.body.volume_id, ce.body.volume_id);
    const mangas = db.prepare('SELECT * FROM mangas').all();
    const vols = db.prepare('SELECT * FROM volumes WHERE manga_id = ?').all(m.body.id);
    const [entry, ceEntry] = buildMatcher(mangas, vols).enrich([
        { id: 5151, edition_id: 1, title: 'Kaiju Repro', volume_number: '4', type: 'volume', date: '2026-11-05', is_digital: false },
        { id: 5151, edition_id: 1, title: 'Kaiju Repro – Collectors Edition', volume_number: '4', date: '2026-11-05', is_digital: false }
    ]);
    assert.deepEqual([entry.user_volume_id, entry.user_volume_status], [regular.body.volume_id, 'Fehlt']);
    assert.deepEqual([ceEntry.user_volume_id, ceEntry.match_kind], [ce.body.volume_id, 'volume_id']);
});

test('import: re-importing a special whose Manga Passion id sits on a row of another type does not add a row each time', async () => {
    const m = await editor('POST', '/mangas', { title: 'Special Wiederholt' });
    await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: '3', mp_volume_id: 7771, type: 'volume' }));
    const ids = [];
    for (let i = 0; i < 3; i++) {
        const res = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: 'Special', mp_volume_id: 7771, type: 'special', volume_title: 'Artbook' }));
        assert.equal(res.status, 200);
        ids.push(res.body.volume_id);
    }
    assert.equal(new Set(ids).size, 1);
    const other = await editor('POST', '/manga-passion/import', importBody({ manga_id: m.body.id, volume_number: 'Special', mp_volume_id: 7771, type: 'special', volume_title: 'Fanbook' }));
    assert.notEqual(other.body.volume_id, ids[0], 'another special (other title) is still its own row');
    const vols = (await editor('GET', `/mangas/${m.body.id}`)).body.volumes;
    assert.equal(vols.filter(v => v.type === 'special').length, 2);
});

test('Terminabgleich: stale cached months are skipped, never suggested as the new date', async () => {
    const { writeCache } = require('../services/mangaPassion/client');
    const { resetReleaseFetchState } = require('../services/mangaPassionReleases');
    const { zonedToday } = require('../services/radar');
    resetReleaseFetchState();
    const restore = fakeMp(async () => { throw new Error('offline'); });
    try {
        const t = zonedToday();
        const at = (offset) => { const d = new Date(t.getFullYear(), t.getMonth() + offset, 1); return [d.getFullYear(), d.getMonth() + 1]; };
        const [y1, m1] = at(1);
        const [y2, m2] = at(2);
        const a = await editor('POST', '/mangas', { title: 'Veraltet Reihe' });
        const vol = (await editor('POST', '/volumes', { manga_id: a.body.id, volume_number: '1', status: 'Vorbestellt', release_date: `${y2}-${pad2(m2)}-10` })).body.id;
        // a month cached long ago still lists the old date
        writeCache(`mp_releases_${y1}_${m1}`, [{ id: 7101, title: 'Veraltet Reihe', volume_number: '1', publisher: 'X', date: `${y1}-${pad2(m1)}-05`, is_digital: false }]);
        backdateCache(`mp_releases_${y1}_${m1}`, 13 * 60 * 60 * 1000);
        const res = await editor('GET', '/release-radar/changes');
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.changes.filter(c => c.volume_id === vol), []);
        assert.ok(res.body.months_failed >= 2);
    } finally { restore(); resetReleaseFetchState(); }
});

test('import: "Bd. 4" is regular volume 4 and matches an existing "4"; a Schuber keeps its label', async () => {
    const first = await editor('POST', '/manga-passion/import', importBody({ title: 'Kanon Reihe', volume_number: '4' }));
    const again = await editor('POST', '/manga-passion/import', importBody({ manga_id: first.body.manga_id, volume_number: 'Bd. 4', type: 'volume' }));
    assert.equal(again.body.volume_id, first.body.volume_id);
    const box = await editor('POST', '/manga-passion/import', importBody({ manga_id: first.body.manga_id, volume_number: 'Band 4', type: 'schuber' }));
    assert.notEqual(box.body.volume_id, first.body.volume_id);
    const numbers = (await editor('GET', `/mangas/${first.body.manga_id}`)).body.volumes.map(v => v.volume_number).sort();
    assert.deepEqual(numbers, ['4', 'Band 4']);
});

test('shopping list and radar order volumes by number ("Band 3" as 3, 12.5 between 12 and 13, labels last)', async () => {
    const { db } = require('../db');
    const m = Number(db.prepare("INSERT INTO mangas (title, publisher) VALUES ('Ordnung Reihe', 'Ordnungsverlag')").run().lastInsertRowid);
    for (const [n, type] of [['13', 'volume'], ['Schuber 1', 'schuber'], ['12.5', 'volume'], ['Band 3', 'volume'], ['12', 'volume'],
        ['Fanbook', 'special'], ['2', 'special_edition'], ['Collectors Edition', 'special_edition']]) {
        db.prepare("INSERT INTO volumes (manga_id, volume_number, type, status, release_date) VALUES (?, ?, ?, 'Fehlt', NULL)").run(m, n, type);
    }
    const shop = (await editor('GET', '/shopping-list')).body;
    const items = (shop.items || shop.groups?.flatMap(g => g.items) || []).filter(i => i.manga_id === m);
    assert.deepEqual(items.map(i => i.volume_number), ['2', 'Band 3', '12', '12.5', '13', 'Collectors Edition', 'Schuber 1', 'Fanbook']);

    db.prepare("UPDATE volumes SET status = 'Vorbestellt', release_date = '2099-01-01' WHERE manga_id = ?").run(m);
    const radar = (await editor('GET', '/release-radar')).body;
    const radarItems = radar.groups.flatMap(g => g.items).filter(i => i.manga_id === m);
    assert.deepEqual(radarItems.map(i => i.volume_number), ['2', 'Band 3', '12', '12.5', '13', 'Collectors Edition', 'Fanbook', 'Schuber 1']);
});

test('radar: zonedToday follows APP_TIMEZONE through utils/config.js; an unknown zone means the server day', () => {
    const { zonedToday } = require('../services/radar');
    const saved = process.env.APP_TIMEZONE;
    const now = new Date();
    const day = (d) => [d.getFullYear(), d.getMonth(), d.getDate()];
    try {
        // UTC+14 and UTC-11 are always on different calendar days
        process.env.APP_TIMEZONE = 'Pacific/Kiritimati';
        assert.deepEqual(day(zonedToday(now)), day(zonedToday(now, 'Pacific/Kiritimati')));
        process.env.APP_TIMEZONE = 'Pacific/Pago_Pago';
        assert.deepEqual(day(zonedToday(now)), day(zonedToday(now, 'Pacific/Pago_Pago')));
        assert.notDeepEqual(day(zonedToday(now)), day(zonedToday(now, 'Pacific/Kiritimati')));
        process.env.APP_TIMEZONE = 'Nirgendwo/Stadt';
        assert.deepEqual(day(zonedToday(now)), day(now));
    } finally {
        if (saved === undefined) delete process.env.APP_TIMEZONE;
        else process.env.APP_TIMEZONE = saved;
    }
});

test('radar: GET /release-radar sends the volumes only inside groups', async () => {
    const res = await editor('GET', '/release-radar');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.groups));
    assert.equal(res.body.items, undefined);
});

test('shopping-list: wished_series lists wished series without an owned volume, by priority then title', async () => {
    const low = (await editor('POST', '/mangas', { title: 'Wunsch Beta', publisher: 'carlsen manga', wish_priority: 1, total_volumes: 8 })).body.id;
    const high = (await editor('POST', '/mangas', { title: 'Wunsch Alpha', wish_priority: 3 })).body.id;
    const same = (await editor('POST', '/mangas', { title: 'wunsch aaa', wish_priority: 1 })).body.id;
    const owned = (await editor('POST', '/mangas', { title: 'Wunsch Besitz', wish_priority: 3 })).body.id;
    await editor('POST', '/volumes', { manga_id: low, volume_number: '1', status: 'Fehlt', price: 7.5 });
    await editor('POST', '/volumes', { manga_id: low, volume_number: '2', status: 'Fehlt', price: 7.5 });
    await editor('POST', '/volumes', { manga_id: low, volume_number: '3', status: 'Vorbestellt', price: 9 });
    await editor('POST', '/volumes', { manga_id: owned, volume_number: '1', status: 'Vorhanden' });

    for (const query of ['', '?include_others=1']) {
        const body = (await editor('GET', `/shopping-list${query}`)).body;
        const wished = body.wished_series.filter(s => [low, high, same, owned].includes(s.id));
        assert.deepEqual(wished.map(s => s.id), [high, same, low]);
        const beta = wished.find(s => s.id === low);
        assert.deepEqual(
            [beta.publisher, beta.wish_priority, beta.total_volumes, beta.known_missing_count, beta.known_missing_cost],
            ['Carlsen Manga', 1, 8, 2, 15]
        );
        assert.equal(body.total_wished_series, body.wished_series.length);
        assert.ok(body.publishers.find(p => p.publisher === 'Carlsen Manga').wished_count >= 1);
    }
    await editor('PUT', `/mangas/${high}`, { wish_priority: null });
    assert.ok(!(await editor('GET', '/shopping-list')).body.wished_series.some(s => s.id === high));
});

test('releases: a calendar entry of a wished series carries user_manga_wished', async () => {
    const { writeCache } = require('../services/mangaPassion/client');
    const wished = (await editor('POST', '/mangas', { title: 'Kalender Wunsch', wish_priority: 2 })).body.id;
    const shelf = (await editor('POST', '/mangas', { title: 'Kalender Regal', wish_priority: 2 })).body.id;
    await editor('POST', '/volumes', { manga_id: shelf, volume_number: '1', status: 'Vorhanden' });
    const entry = (id, title) => ({ id, edition_id: 900 + id, title, raw_title: title, volume_number: '2', publisher: 'Carlsen Manga', date: '2035-03-10', is_digital: false });
    writeCache(`mp_releases_${Y - 2}_3`, [entry(1, 'Kalender Wunsch'), entry(2, 'Kalender Regal'), entry(3, 'Fremd')]);
    const items = (await editor('GET', `/manga-passion/releases?year=${Y - 2}&month=3`)).body.items;
    assert.deepEqual(items.map(i => [i.user_manga_id, i.user_manga_wished]), [[wished, true], [shelf, false], [null, false]]);
});

test('collecting: paused and dropped series leave the shopping list; a dropped one keeps only ordered radar volumes', async () => {
    const make = async (title, collecting) => (await editor('POST', '/mangas', { title, collecting })).body.id;
    const vol = async (manga_id, volume_number, status, extra = {}) =>
        (await editor('POST', '/volumes', { manga_id, volume_number, status, price: 10, ...extra })).body.id;
    const active = await make('Sammeln Aktiv', 'aktiv');
    const paused = await make('Sammeln Pause', 'pausiert');
    const dropped = await make('Sammeln Ende', 'abgebrochen');
    const ids = {};
    for (const [key, id] of Object.entries({ active, paused, dropped })) {
        ids[`${key}Missing`] = await vol(id, '1', 'Fehlt');
        ids[`${key}Ordered`] = await vol(id, '2', 'Vorbestellt', { release_date: '2040-05-01' });
        ids[`${key}Soon`] = await vol(id, '3', 'Erscheint bald', { release_date: '2040-06-01' });
        ids[`${key}Future`] = await vol(id, '4', 'Fehlt', { release_date: '2040-07-01' });
    }

    const shop = (await editor('GET', '/shopping-list')).body;
    const shopIds = shop.items.map(i => i.id);
    assert.ok(shopIds.includes(ids.activeMissing) && shopIds.includes(ids.activeFuture));
    for (const id of [ids.pausedMissing, ids.pausedFuture, ids.droppedMissing, ids.droppedFuture]) assert.ok(!shopIds.includes(id), String(id));
    const summary = (await editor('GET', '/dashboard-summary')).body;
    assert.equal(summary.total_missing, shop.total_missing);

    const radar = (await editor('GET', '/release-radar')).body;
    const radarIds = radar.groups.flatMap(g => g.items.map(i => i.id));
    for (const id of [ids.activeOrdered, ids.activeSoon, ids.activeFuture, ids.pausedOrdered, ids.pausedSoon, ids.pausedFuture, ids.droppedOrdered]) {
        assert.ok(radarIds.includes(id), String(id));
    }
    assert.ok(!radarIds.includes(ids.droppedSoon) && !radarIds.includes(ids.droppedFuture));
    assert.equal(summary.total_releases, radar.total_releases);
    assert.equal(summary.preordered_count, radar.preordered_count);
});

test('releases: a calendar entry of a dropped series carries user_manga_collecting', async () => {
    const { writeCache } = require('../services/mangaPassion/client');
    const dropped = (await editor('POST', '/mangas', { title: 'Kalender Abgebrochen', collecting: 'abgebrochen' })).body.id;
    const active = (await editor('POST', '/mangas', { title: 'Kalender Aktiv' })).body.id;
    const entry = (id, title) => ({ id, edition_id: 950 + id, title, raw_title: title, volume_number: '3', publisher: 'Carlsen Manga', date: '2036-04-10', is_digital: false });
    writeCache(`mp_releases_${Y - 3}_4`, [entry(1, 'Kalender Abgebrochen'), entry(2, 'Kalender Aktiv'), entry(3, 'Fremd Reihe')]);
    const items = (await editor('GET', `/manga-passion/releases?year=${Y - 3}&month=4`)).body.items;
    assert.deepEqual(items.map(i => [i.user_manga_id, i.user_manga_collecting]), [[dropped, 'abgebrochen'], [active, 'aktiv'], [null, null]]);
});

test('import: a new series takes author and tags of the cached edition; the edition link finds the series first', async () => {
    const { writeCache } = require('../services/mangaPassion/client');
    const db = require('../db').db;
    writeCache('mp_edition_info_4711', { edition: { id: 4711, title: 'Autor Reihe', author: 'Tatsuya Endo', tags: 'Action, Comedy' } });
    const res = await editor('POST', '/manga-passion/import', importBody({ title: 'Autor Reihe', edition_id: 4711 }));
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT author, tags, manga_passion_id FROM mangas WHERE id = ?').get(res.body.manga_id);
    assert.deepEqual({ ...row }, { author: 'Tatsuya Endo', tags: 'Action, Comedy', manga_passion_id: 4711 });

    // the calendar title differs from the stored one: the edition link still finds the series
    const renamed = await editor('POST', '/manga-passion/import', importBody({ title: 'Autor Reihe (Neuauflage)', volume_number: '2', edition_id: 4711 }));
    assert.equal(renamed.body.manga_id, res.body.manga_id);
    assert.equal(renamed.body.series_created, false);

    // no cached edition: nothing is guessed
    const plain = await editor('POST', '/manga-passion/import', importBody({ title: 'Ohne Cache Reihe', edition_id: 4712 }));
    assert.deepEqual({ ...db.prepare('SELECT author, tags FROM mangas WHERE id = ?').get(plain.body.manga_id) }, { author: null, tags: null });
});

test('import: by title an unlinked series comes before one linked to another edition', async () => {
    const linked = (await editor('POST', '/mangas', { title: 'Gleicher Titel', manga_passion_id: 5001 })).body.id;
    const unlinked = (await editor('POST', '/mangas', { title: 'Gleicher Titel' })).body.id;
    const res = await editor('POST', '/manga-passion/import', importBody({ title: 'Gleicher Titel', edition_id: 5002 }));
    assert.equal(res.body.manga_id, unlinked);
    const own = await editor('POST', '/manga-passion/import', importBody({ title: 'Gleicher Titel', volume_number: '3', edition_id: 5001 }));
    assert.equal(own.body.manga_id, linked);
});

// ----- calendar feed (GET /radar/feed.ics with the per-user token from /radar/feed-token) -----

const isoIn = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const fetchFeed = (query) => fetch(`${ctx.base}/radar/feed.ics${query}`);

test('feed token: none at first, created on demand, the feed lists dated pre-orders and announced volumes', async () => {
    const reader = ctx.client();
    await reader('POST', '/auth/login', { username: 'vis', password: 'password123' });
    const none = await reader('GET', '/radar/feed-token');
    assert.equal(none.status, 200);
    assert.equal(none.body.active, false);
    assert.equal((await ctx.client()('GET', '/radar/feed-token')).status, 401);

    const mangaId = (await editor('POST', '/mangas', { title: 'Kalender; Reihe, mit Komma', publisher: 'Carlsen Manga' })).body.id;
    const add = (o) => editor('POST', '/volumes', { manga_id: mangaId, ...o });
    await add({ volume_number: '1', status: 'Vorbestellt', release_date: isoIn(10), price: 7.5, isbn: '9783551000011' });
    await add({ volume_number: '2', status: 'Fehlt', release_date: isoIn(40) });
    await add({ volume_number: '3', status: 'Vorbestellt', release_date: isoIn(70).slice(0, 7) });
    await add({ volume_number: '4', status: 'Vorhanden', release_date: isoIn(5) });
    await add({ volume_number: '5', status: 'Bestellt', release_date: isoIn(-60) });

    const made = await reader('POST', '/radar/feed-token');
    assert.equal(made.status, 200);
    assert.equal(made.body.active, true);
    assert.match(made.body.path, /^\/api\/radar\/feed\.ics\?token=[A-Za-z0-9_-]{43}$/);
    assert.ok(made.body.url.endsWith(made.body.path));
    const token = new URL(made.body.url).searchParams.get('token');
    assert.ok(!reader.cookie.includes(token), 'not the session token');
    assert.equal((await reader('GET', '/radar/feed-token')).body.path, made.body.path, 'the address can be shown again');

    const stored = require('../db').db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'calendar_feed:%'").all();
    assert.equal(stored.length, 1);
    assert.ok(!stored[0].value.includes(token) && !stored[0].key.includes(token), 'only the hash and a sealed copy are stored');

    const res = await fetchFeed(`?token=${token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/calendar/);
    const text = await res.text();
    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.match(text, /SUMMARY:Kalender\\; Reihe\\, mit Komma – Band 1\r\n/);
    assert.match(text, new RegExp(`DTSTART;VALUE=DATE:${isoIn(10).replace(/-/g, '')}`));
    assert.match(text, /Preis: 7\\,50 €/);
    assert.match(text, /SUMMARY:Kalender\\; Reihe\\, mit Komma – Band 2\r\n/);
    assert.ok(!/Komma – Band [345]\r\n/.test(text), 'month-only, owned and long-past volumes stay out');
    assert.match(text, /UID:volume-\d+@[\w-]+\.manga-shelf/);
    assert.ok(require('../db').db.prepare("SELECT value FROM app_settings WHERE key LIKE 'calendar_feed:%'").get().value.includes('"last_used_at":1'));
});

test('feed token: wrong, missing or session tokens get 404; a new token revokes the old one; DELETE ends it', async () => {
    const own = ctx.client();
    await own('POST', '/auth/login', { username: 'ed', password: 'password123' });
    const first = new URL((await own('POST', '/radar/feed-token')).body.url).searchParams.get('token');
    assert.equal((await fetchFeed(`?token=${first}`)).status, 200);

    assert.equal((await fetchFeed('')).status, 404);
    assert.equal((await fetchFeed('?token=kurz')).status, 404);
    assert.equal((await fetchFeed(`?token=${'A'.repeat(43)}`)).status, 404);
    const session = decodeURIComponent(own.cookie.split('=')[1]);
    assert.equal((await fetchFeed(`?token=${encodeURIComponent(session)}`)).status, 404);
    assert.equal((await fetchFeed(`?token=${first}&token=${first}`)).status, 200, 'a repeated key reads the first value');

    const second = new URL((await own('POST', '/radar/feed-token')).body.url).searchParams.get('token');
    assert.notEqual(second, first);
    assert.equal((await fetchFeed(`?token=${first}`)).status, 404);
    assert.equal((await fetchFeed(`?token=${second}`)).status, 200);

    const removed = await own('DELETE', '/radar/feed-token');
    assert.deepEqual(removed.body, { success: true, removed: 1 });
    assert.equal((await fetchFeed(`?token=${second}`)).status, 404);
    assert.equal((await own('GET', '/radar/feed-token')).body.active, false);
});

test('feed token: a deleted user\'s feed stops working', async () => {
    assert.equal((await admin('POST', '/users', { username: 'kalender', password: 'password123', role: 'editor' })).status, 200);
    const gone = ctx.client();
    await gone('POST', '/auth/login', { username: 'kalender', password: 'password123' });
    const token = new URL((await gone('POST', '/radar/feed-token')).body.url).searchParams.get('token');
    assert.equal((await fetchFeed(`?token=${token}`)).status, 200);
    const id = (await admin('GET', '/users')).body.find(u => u.username === 'kalender').id;
    assert.equal((await admin('DELETE', `/users/${id}`)).status, 200);
    assert.equal((await fetchFeed(`?token=${token}`)).status, 404);
});

test('feed token: a password change, an admin password reset and "Alle Sitzungen beenden" revoke feed addresses', async () => {
    const login = async (username) => {
        assert.equal((await admin('POST', '/users', { username, password: 'password123', role: 'editor' })).status, 200);
        const client = ctx.client();
        assert.equal((await client('POST', '/auth/login', { username, password: 'password123' })).status, 200);
        const token = new URL((await client('POST', '/radar/feed-token')).body.url).searchParams.get('token');
        assert.equal((await fetchFeed(`?token=${token}`)).status, 200);
        return { client, token };
    };
    const kim = await login('kim-feed');
    const other = await login('lea-feed');
    assert.equal((await kim.client('PUT', '/auth/password', { current_password: 'password123', new_password: 'password456' })).status, 200);
    assert.equal((await fetchFeed(`?token=${kim.token}`)).status, 404, 'own password change');
    assert.equal((await fetchFeed(`?token=${other.token}`)).status, 200, 'other users keep theirs');
    assert.equal((await kim.client('GET', '/radar/feed-token')).body.active, false);

    const leaId = (await admin('GET', '/users')).body.find(u => u.username === 'lea-feed').id;
    assert.equal((await admin('PUT', `/users/${leaId}`, { role: 'editor' })).status, 200);
    assert.equal((await fetchFeed(`?token=${other.token}`)).status, 200, 'a role change alone keeps it');
    assert.equal((await admin('PUT', `/users/${leaId}`, { password: 'password789' })).status, 200);
    assert.equal((await fetchFeed(`?token=${other.token}`)).status, 404, 'admin password reset');

    const third = await login('max-feed');
    const adminFeed = new URL((await admin('POST', '/radar/feed-token')).body.url).searchParams.get('token');
    assert.equal((await admin('POST', '/system/sessions/end-all')).status, 200);
    assert.equal((await fetchFeed(`?token=${third.token}`)).status, 404, 'end-all');
    assert.equal((await fetchFeed(`?token=${adminFeed}`)).status, 404);
    await editor('POST', '/auth/login', { username: 'ed', password: 'password123' });
    await visitor('POST', '/auth/login', { username: 'vis', password: 'password123' });
});
