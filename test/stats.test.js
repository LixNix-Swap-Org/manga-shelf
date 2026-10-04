// GET /stats: summary, spending buckets and completed series counts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let db;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    db = require('../db').db;
});

test.after(async () => { await ctx.close(); });

const getStats = async () => {
    const res = await admin('GET', '/stats');
    assert.equal(res.status, 200);
    return res.body;
};

async function newSeries(title, extra = {}) {
    const res = await admin('POST', '/mangas', { title, ...extra });
    assert.equal(res.status, 200);
    return res.body.id;
}

async function addVolume(mangaId, volume_number, extra = {}) {
    const res = await admin('POST', '/volumes', { manga_id: mangaId, volume_number, status: 'Vorhanden', ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id;
}

test('response carries summary and the lists once, without legacy duplicates', async () => {
    const id = await newSeries('Form Reihe', { publisher: 'Carlsen' });
    await addVolume(id, '1', { price: 7 });
    const body = await getStats();
    assert.deepEqual(Object.keys(body).sort(), ['currencies', 'languages', 'owner_publishers', 'owner_stats', 'publishers', 'spending', 'summary', 'top_series', 'user_reading_stats']);
    assert.deepEqual(body.owner_publishers, [], 'one user: no owner x publisher breakdown');
    assert.equal(typeof body.summary.total_series, 'number');
    assert.ok(body.summary.collection_start_date);
    const pub = body.publishers.find(p => p.publisher === 'Carlsen');
    assert.equal(pub.volume_count, 1);
    assert.ok(!('volumes_count' in pub));
    const reader = body.user_reading_stats[0];
    assert.ok('read_pct' in reader && 'username' in reader);
    assert.ok(!('percentage' in reader) && !('display_name' in reader));
});

test('spending: year-only purchase dates count in by_year, not in by_month or without_date', async () => {
    const before = (await getStats()).spending;
    const id = await newSeries('Jahreskauf');
    const yearOnly = await addVolume(id, '1', { price: 7 });
    await addVolume(id, '2', { price: 5, purchase_date: '2023-05' });
    const noDate = await addVolume(id, '3', { price: 3 });
    const empty = await addVolume(id, '4', { price: 2 });
    const ancient = await addVolume(id, '5', { price: 1 });
    await addVolume(id, '6', { price: 50, purchase_date: '2023-06-01', status: 'Fehlt' });
    // Legacy rows predate stricter input validation, so write them directly.
    db.prepare('UPDATE volumes SET purchase_date = ? WHERE id = ?').run(' 2023 ', yearOnly);
    db.prepare('UPDATE volumes SET purchase_date = ? WHERE id = ?').run('', empty);
    db.prepare('UPDATE volumes SET purchase_date = ? WHERE id = ?').run('0000-01-01', ancient);
    assert.equal(db.prepare('SELECT purchase_date FROM volumes WHERE id = ?').get(noDate).purchase_date, null);

    const sp = (await getStats()).spending;
    const y2023 = sp.by_year.find(r => r.year === 2023);
    const prev2023 = before.by_year.find(r => r.year === 2023) || { volumes: 0, total: 0 };
    assert.deepEqual({ volumes: y2023.volumes - prev2023.volumes, total: y2023.total - prev2023.total }, { volumes: 2, total: 12 });
    assert.ok(!sp.by_year.some(r => r.year === 0));
    assert.equal(sp.year_only.volumes - before.year_only.volumes, 1);
    assert.equal(sp.year_only.total - before.year_only.total, 7);
    assert.equal(sp.without_date.volumes - before.without_date.volumes, 3);
    assert.equal(sp.without_date.total - before.without_date.total, 6);

    const owned = (await getStats()).summary.total_owned_volumes;
    const byYearCount = sp.by_year.reduce((n, r) => n + r.volumes, 0);
    assert.equal(byYearCount + sp.without_date.volumes, owned, 'every owned volume is in exactly one bucket');
});

test('spending: one pass over the volumes gives the same buckets as separate filters', async () => {
    const { buildSpending } = require('../core/handlers/stats');
    const statements = [];
    const counting = { db: { prepare: (sql) => { statements.push(sql); return db.prepare(sql); } } };
    const now = new Date();
    const sp = buildSpending(counting, now);
    assert.equal(statements.length, 1, 'a single statement');
    assert.equal((statements[0].match(/FROM volumes/g) || []).length, 1, 'one scan of volumes');
    const owned = db.prepare("SELECT count(*) AS n, sum(COALESCE(price, 0)) AS t FROM volumes WHERE status = 'Vorhanden'").get();
    const years = sp.by_year.reduce((a, r) => ({ n: a.n + r.volumes, t: a.t + r.total }), { n: 0, t: 0 });
    assert.equal(years.n + sp.without_date.volumes, owned.n);
    assert.equal(Math.round((years.t + sp.without_date.total) * 100), Math.round(owned.t * 100));
    const yearOnly = db.prepare(`SELECT count(*) AS n FROM volumes WHERE status = 'Vorhanden' AND TRIM(purchase_date) GLOB '[0-9][0-9][0-9][0-9]*'
        AND SUBSTR(TRIM(purchase_date), 1, 4) >= '1900' AND NOT TRIM(purchase_date) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]*'`).get().n;
    assert.equal(sp.year_only.volumes, yearOnly);
    assert.deepEqual(sp.by_year.map(r => r.year), [...sp.by_year.map(r => r.year)].sort((a, b) => a - b));
    assert.equal(sp.by_month.length, 12);
});

test('spending: a full YYYY-MM date inside the last 12 months still lands in by_month', async () => {
    const id = await newSeries('Monatskauf');
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const before = (await getStats()).spending.by_month.at(-1);
    await addVolume(id, '1', { price: 4, purchase_date: `${month}-01` });
    const cur = (await getStats()).spending.by_month.at(-1);
    assert.equal(cur.month, month);
    assert.equal(cur.volumes - before.volumes, 1);
    assert.equal(cur.total - before.total, 4);
});

test('total_volumes_recorded counts the same volumes as total_possible_value', async () => {
    const before = (await getStats()).summary;
    const id = await newSeries('Wertreihe');
    await addVolume(id, '1', { price: 7 });
    await addVolume(id, '2', { price: 3, status: 'Fehlt' });
    await addVolume(id, '3', { price: 100, status: 'Vorbestellt' });
    await addVolume(id, '4', { price: 100, status: 'Bestellt' });
    const after = (await getStats()).summary;
    assert.equal(after.total_volumes_recorded - before.total_volumes_recorded, 4);
    assert.equal(Math.round((after.total_possible_value - before.total_possible_value) * 100) / 100, 210);
    const all = db.prepare('SELECT count(*) AS c, sum(COALESCE(price, 0)) AS v FROM volumes').get();
    assert.equal(after.total_volumes_recorded, all.c);
    assert.equal(after.total_possible_value, Math.round(all.v * 100) / 100);
});

test('completed_series: total_volumes > 0 and the distinct regular owned numbers reach it (spec A2)', async () => {
    let base = (await getStats()).summary.completed_series;
    const expectCompleted = async (delta, msg) => assert.equal((await getStats()).summary.completed_series, base + delta, msg);

    await newSeries('Leer und abgeschlossen', { status: 'Abgeschlossen' });
    await newSeries('Leer mit Null', { total_volumes: 0, status: 'Abgeschlossen' });
    await expectCompleted(0, 'an empty series is never complete, whatever its status');

    const finished = await newSeries('Fertig erschienen', { total_volumes: 20, status: 'Abgeschlossen' });
    await addVolume(finished, '1');
    await expectCompleted(0, 'publication status alone does not complete a series');

    const zero = await newSeries('Mit Band 0', { total_volumes: 10, status: 'Laufend' });
    for (let n = 0; n <= 9; n++) await addVolume(zero, String(n));
    await expectCompleted(0, 'volume 0 does not stand in for volume 10');
    await addVolume(zero, '10');
    await expectCompleted(1, 'volumes 0..10 against 10 complete the series');
    base += 1;

    const stale = await newSeries('Veraltete Gesamtzahl', { total_volumes: 3, status: 'Laufend' });
    for (const n of ['1', '2', '5']) await addVolume(stale, n);
    await expectCompleted(1, 'three distinct regular numbers reach a total of 3');
    base += 1;

    const dup = await newSeries('Doppelt', { total_volumes: 3, status: 'Laufend' });
    await addVolume(dup, '1');
    await addVolume(dup, '2');
    await addVolume(dup, '2', { type: 'special' });
    await addVolume(dup, 'Schuber 1', { type: 'schuber' });
    await addVolume(dup, '3', { status: 'Fehlt' });
    await expectCompleted(0, 'a special edition of #2, a schuber and a missing #3 do not count');

    const noTotal = await newSeries('Ohne Gesamtzahl', { status: 'Laufend' });
    await addVolume(noTotal, '1');
    await expectCompleted(0, 'without a stored total a series is never complete, even with only Band 1 owned');
    await addVolume(noTotal, '2');
    await expectCompleted(0, 'a gap-free 1..n without a total does not count either');
    assert.equal((await admin('PUT', `/mangas/${noTotal}`, { title: 'Ohne Gesamtzahl', total_volumes: 2 })).status, 200);
    await expectCompleted(1, 'storing the total completes it');
});

test('completed_series equals the series of GET /mangas with total_volumes > 0 && regular_owned >= total_volumes', async () => {
    const list = (await admin('GET', '/mangas')).body;
    const expected = list.filter(m => m.total_volumes > 0 && m.regular_owned >= m.total_volumes).length;
    assert.ok(expected >= 3);
    assert.equal((await getStats()).summary.completed_series, expected);
});

test('avg_price_per_volume ignores volumes without a price but keeps a price of 0', async () => {
    const id = await newSeries('Preisreihe');
    db.prepare("UPDATE volumes SET status = 'Fehlt' WHERE status = 'Vorhanden'").run();
    let s = (await getStats()).summary;
    assert.equal(s.total_owned_volumes, 0);
    assert.equal(s.avg_price_per_volume, 0);

    for (const n of ['1', '2']) await addVolume(id, n);
    s = (await getStats()).summary;
    assert.equal(s.avg_price_per_volume, 0, 'all unpriced gives 0, not NaN');
    assert.equal(s.priced_owned_volumes, 0);

    await addVolume(id, '3', { price: 20 });
    await addVolume(id, '4', { price: 30 });
    await addVolume(id, '5', { price: 30 });
    s = (await getStats()).summary;
    assert.equal(s.total_owned_volumes, 5);
    assert.equal(s.total_owned_value, 80);
    assert.equal(s.priced_owned_volumes, 3);
    assert.equal(s.avg_price_per_volume, 26.67);

    await addVolume(id, '6', { price: 0 });
    s = (await getStats()).summary;
    assert.equal(s.priced_owned_volumes, 4);
    assert.equal(s.avg_price_per_volume, 20);

    // a USD price is a price ("ohne Preis" = owned - priced), it just stays out of the euro average
    const usd = await newSeries('Preisreihe USD', { language: 'en', currency: 'USD' });
    await addVolume(usd, '1', { price: 100 });
    await addVolume(usd, '2');
    s = (await getStats()).summary;
    assert.deepEqual([s.total_owned_volumes, s.priced_owned_volumes, s.avg_price_per_volume, s.total_owned_value], [8, 5, 20, 80]);
});

test('PUT /stats/settings rejects missing, non-string, pre-1900 and future dates', async () => {
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: '2022-01-05' })).status, 200);
    const bad = [
        {},
        { collection_start_date: 0 },
        { collection_start_date: ['2020-01-01'] },
        { collection_start_date: { toString: 1 } },
        { collection_start_date: '0000-01-01' },
        { collection_start_date: '1899-12-31' },
        { collection_start_date: '2023-02-30' },
        { start_date: false }
    ];
    for (const body of bad) {
        assert.equal((await admin('PUT', '/stats/settings', body)).status, 400, JSON.stringify(body));
    }
    const inThreeDays = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: inThreeDays })).status, 400);
    assert.equal((await getStats()).summary.collection_start_date, '2022-01-05');

    const d = new Date();
    const localToday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: localToday })).status, 200);
    assert.equal((await admin('PUT', '/stats/settings', { start_date: '1900-01-01' })).status, 200);
    assert.equal((await getStats()).summary.collection_start_date, '1900-01-01');
});

test('PUT /stats/settings with null or an empty date removes the setting: the start is derived again', async () => {
    const { derivedStartDate } = require('../core/handlers/stats');
    const stored = () => db.prepare("SELECT value FROM app_settings WHERE key = 'collection_start_date'").get()?.value ?? null;
    for (const body of [{ collection_start_date: null }, { collection_start_date: '' }, { start_date: '   ' }, { collection_start_date: null, start_date: '2020-01-01' }]) {
        assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: '2022-01-05' })).status, 200);
        assert.equal(stored(), '2022-01-05');
        const res = await admin('PUT', '/stats/settings', body);
        assert.deepEqual([res.status, res.body.success], [200, true], JSON.stringify(body));
        assert.equal(stored(), null, JSON.stringify(body));
        assert.equal((await getStats()).summary.collection_start_date, derivedStartDate({ db }, new Date()));
    }
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: '2022-01-05' })).status, 200);
});

test('a stored start date that is invalid or before 1900 falls back to the derived date', async () => {
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('collection_start_date', '0000-01-01')").run();
    const s = (await getStats()).summary;
    const { derivedStartDate } = require('../core/handlers/stats');
    assert.equal(s.collection_start_date, derivedStartDate({ db }, new Date()));
    assert.notEqual(s.collection_start_date, '2021-04-09');
    assert.ok(s.collection_days < 365 * 200);
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: '2022-01-05' })).status, 200);
});

test('without a stored start date the collection starts at the earliest purchase or entry, never a fixed date', async () => {
    const { derivedStartDate } = require('../core/handlers/stats');
    const stored = db.prepare("SELECT value FROM app_settings WHERE key = 'collection_start_date'").get();
    const backup = db.prepare('SELECT id, purchase_date FROM volumes').all();
    const at = (y, m, d) => new Date(y, m - 1, d, 12);
    try {
        db.prepare("DELETE FROM app_settings WHERE key = 'collection_start_date'").run();
        db.prepare('UPDATE volumes SET purchase_date = NULL').run();
        const added = db.prepare('SELECT MIN(d) AS d FROM (SELECT SUBSTR(MIN(created_at), 1, 10) AS d FROM volumes UNION ALL SELECT SUBSTR(MIN(created_at), 1, 10) FROM mangas)').get().d;
        assert.equal((await getStats()).summary.collection_start_date, added, 'only entries: the first one counts');

        const id = await newSeries('Startdatum Reihe');
        const vol = await addVolume(id, '1', { price: 10 });
        db.prepare("UPDATE volumes SET purchase_date = '2019' WHERE id = ?").run(vol);
        assert.equal(derivedStartDate({ db }, at(2026, 10, 4)), '2019-01-01', 'a year starts on January 1st');
        db.prepare("UPDATE volumes SET purchase_date = '2018-06' WHERE id = ?").run(vol);
        assert.equal(derivedStartDate({ db }, at(2026, 10, 4)), '2018-06-01');
        db.prepare("UPDATE volumes SET purchase_date = ' 2017-03-15 ' WHERE id = ?").run(vol);
        const s = (await getStats()).summary;
        assert.equal(s.collection_start_date, '2017-03-15');
        assert.ok(s.collection_days > 365 * 8);
        db.prepare("UPDATE volumes SET purchase_date = '1850-01-01' WHERE id = ?").run(vol);
        assert.notEqual(derivedStartDate({ db }, at(2026, 10, 4)), '1850-01-01', 'dates before 1900 are ignored');

        const empty = { db: { prepare: () => ({ get: () => ({ purchased: null, volume_added: null, series_added: null }) }) } };
        assert.equal(derivedStartDate(empty, at(2026, 10, 4)), '2026-10-04', 'nothing collected yet: today');
        const future = { db: { prepare: () => ({ get: () => ({ purchased: '2030-01-01', volume_added: null, series_added: null }) }) } };
        assert.equal(derivedStartDate(future, at(2026, 10, 4)), '2026-10-04', 'never after today');
    } finally {
        for (const row of backup) db.prepare('UPDATE volumes SET purchase_date = ? WHERE id = ?').run(row.purchase_date, row.id);
        if (stored) db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('collection_start_date', ?)").run(stored.value);
    }
});

test('a fresh database stores no start date', () => {
    const { DatabaseSync } = require('node:sqlite');
    const conn = new DatabaseSync(':memory:');
    require('../core/schema').applySchema(conn);
    assert.equal(conn.prepare("SELECT value FROM app_settings WHERE key = 'collection_start_date'").get(), undefined);
    conn.close();
});

test('completed_series reads number_sort: "Band 2" is volume 2, half volumes and duplicates do not count', async () => {
    const base = (await getStats()).summary.completed_series;
    const prefixed = await newSeries('Mit Band-Präfix', { total_volumes: 3 });
    for (const n of ['1', '3']) await addVolume(prefixed, n);
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status, type) VALUES (?, 'Band 2', 'Vorhanden', 'volume')").run(prefixed);
    await addVolume(prefixed, '2.5');
    assert.equal((await getStats()).summary.completed_series, base + 1);

    const half = await newSeries('Halbbände', { total_volumes: 3 });
    for (const n of ['1', '2', '2.5', '3.0']) await addVolume(half, n);
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status, type) VALUES (?, '02', 'Vorhanden', 'volume')").run(half);
    assert.equal((await getStats()).summary.completed_series, base + 1, '"3.0" is not volume 3 and "02" duplicates 2');
});

test('top_series: equal values are ordered by volume count, then title', async () => {
    db.exec('DELETE FROM mangas');
    const ids = {};
    for (const [title, prices] of [['beta', [10, 10]], ['Alpha', [10, 10]], ['Gamma', [20]], ['delta', [5, 5, 5, 5]]]) {
        ids[title] = await newSeries(title);
        for (const [i, price] of prices.entries()) await addVolume(ids[title], String(i + 1), { price });
    }
    const top = (await getStats()).top_series.map(s => s.title);
    assert.deepEqual(top, ['delta', 'Alpha', 'beta', 'Gamma']);
});

test('top_series: ten most valuable series with value still missing, average of priced volumes, unpriced count', async () => {
    db.exec('DELETE FROM mangas');
    for (let i = 1; i <= 11; i++) {
        const id = await newSeries(`Reihe ${String(i).padStart(2, '0')}`);
        await addVolume(id, '1', { price: i });
    }
    const free = await newSeries('Gratis');
    await addVolume(free, '1', { price: 0 });
    const mixed = await newSeries('Gemischt', { publisher: 'Carlsen' });
    await addVolume(mixed, '1', { price: 20 });
    await addVolume(mixed, '2', { price: 10 });
    await addVolume(mixed, '3');
    await addVolume(mixed, '4', { price: 8, status: 'Fehlt' });
    await addVolume(mixed, '5', { price: 100, status: 'Vorbestellt' });

    const top = (await getStats()).top_series;
    assert.equal(top.length, 10);
    assert.ok(!top.some(s => s.title === 'Gratis'), 'a series without value is no top series');
    assert.deepEqual(top.slice(0, 3).map(s => s.title), ['Gemischt', 'Reihe 11', 'Reihe 10']);
    const g = top[0];
    assert.deepEqual(
        [g.owned_volumes, g.owned_value, g.total_value, g.missing_value, g.avg_price, g.unpriced],
        [3, 30, 30, 8, 15, 1]
    );
});

test('publishers: one pass gives value, priced count, average price and what is missing', async () => {
    db.exec('DELETE FROM mangas');
    const a = await newSeries('Verlag A', { publisher: 'Egmont Manga' });
    await addVolume(a, '1', { price: 9, publisher: 'Tokyopop' });
    await addVolume(a, '2');
    await addVolume(a, '3', { price: 12 });
    await addVolume(a, '4', { price: 7, status: 'Fehlt' });
    await addVolume(a, '5', { status: 'Fehlt' });
    const gaps = await newSeries('Nur Lücken', { publisher: 'Hayabusa' });
    await addVolume(gaps, '1', { price: 5, status: 'Fehlt' });

    const { publishers, summary } = await getStats();
    const egmont = publishers.find(p => p.publisher === 'Egmont Manga');
    assert.deepEqual(
        [egmont.volume_count, egmont.series_count, egmont.total_value, egmont.priced_count, egmont.avg_price, egmont.missing_count, egmont.missing_value],
        [2, 1, 12, 1, 12, 2, 7]
    );
    const tokyopop = publishers.find(p => p.publisher === 'TOKYOPOP');
    assert.deepEqual([tokyopop.volume_count, tokyopop.avg_price, tokyopop.missing_count], [1, 9, 0]);
    assert.ok(!publishers.some(p => p.publisher === 'Hayabusa'), 'publishers list owned volumes only');
    assert.equal(publishers.reduce((n, p) => n + p.value_percentage, 0), 100);
    assert.equal(summary.total_owned_value, 21);
});

test('wished series: count and known cost; owner value per user uses the list price, owner x publisher with two users', async () => {
    db.exec('DELETE FROM mangas');
    const before = (await getStats()).summary;
    assert.deepEqual([before.wished_series, before.wished_known_cost], [0, 0]);
    const wish = await newSeries('Wunsch', { wish_priority: 2 });
    await addVolume(wish, '1', { price: 7.5, status: 'Fehlt' });
    await addVolume(wish, '2', { price: 7.5, status: 'Vorbestellt' });
    await newSeries('Wunsch leer', { wish_priority: 0 });
    const ownedWish = await newSeries('Wunsch gekauft', { wish_priority: 3, publisher: 'Carlsen' });
    const vol = await addVolume(ownedWish, '1', { price: 8 });

    let { summary, owner_publishers: ownerPublishers } = await getStats();
    assert.deepEqual([summary.wished_series, summary.wished_known_cost], [2, 7.5]);
    assert.deepEqual(ownerPublishers, []);

    assert.equal((await admin('POST', '/users', { username: 'zweit', password: 'password123', role: 'editor' })).status, 200);
    const zweit = db.prepare("SELECT id FROM users WHERE username = 'zweit'").get().id;
    assert.equal((await admin('POST', `/volumes/${vol}/owners`, { owned: true, user_id: zweit, price: 5 })).status, 200);
    let ownerStats;
    ({ owner_stats: ownerStats, owner_publishers: ownerPublishers } = await getStats());
    assert.deepEqual(ownerStats.map(o => [o.username, o.volume_count, o.total_value, o.shared_count]), [['admin', 1, 8, 1], ['zweit', 1, 8, 1]],
        'shared volumes count fully for each owner, at the list price');
    assert.deepEqual(ownerPublishers.map(o => [o.username, o.publisher, o.volume_count, o.total_value]),
        [['admin', 'Carlsen', 1, 8], ['zweit', 'Carlsen', 1, 8]]);
});

const monthKey = (offset) => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 15);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

test('reading over time: reads per month, backlog curve, years, streaks and the "Weiterlesen" list', async () => {
    db.exec('DELETE FROM mangas');
    const me = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    const a = await newSeries('Lesereihe A');
    const b = await newSeries('Lesereihe B');
    const aIds = [];
    for (const n of ['1', '2', '3', '4']) aIds.push(await addVolume(a, n, { pages: 200, purchase_date: `${monthKey(3)}-01` }));
    const b1 = await addVolume(b, '1', { pages: 100 });
    const b2 = await addVolume(b, '2', { pages: 100 });
    await addVolume(a, '5', { status: 'Fehlt' });
    const setRead = (volumeId, month) => db.prepare('INSERT OR REPLACE INTO volume_reads (volume_id, user_id, read_at) VALUES (?, ?, ?)')
        .run(volumeId, me, month ? `${month}-10 12:00:00` : null);
    setRead(aIds[0], monthKey(2));
    setRead(aIds[1], monthKey(1));
    setRead(b1, monthKey(0));
    setRead(b2, null);

    const res = await admin('GET', '/stats/reading');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = res.body;
    assert.equal(r.user.username, 'admin');
    assert.equal(r.by_month.length, 24);
    assert.equal(r.by_month.at(-1).month, monthKey(0));
    const month = (key) => r.by_month.find(m => m.month === key);
    assert.deepEqual(month(monthKey(2)), { month: monthKey(2), volumes: 1, pages: 200, series: 1 });
    assert.deepEqual(month(monthKey(0)), { month: monthKey(0), volumes: 1, pages: 100, series: 1 });
    assert.equal(r.unknown_date, 1);

    // owned: 2 undated (B) from the start, 4 bought three months ago; reads: the undated one from the start
    const backlog = (key) => r.backlog_by_month.find(m => m.month === key);
    assert.deepEqual(backlog(monthKey(4)), { month: monthKey(4), owned: 2, read: 1, backlog: 1 });
    assert.deepEqual(backlog(monthKey(3)), { month: monthKey(3), owned: 6, read: 1, backlog: 5 });
    assert.deepEqual(backlog(monthKey(0)), { month: monthKey(0), owned: 6, read: 4, backlog: 2 });

    assert.equal(r.streak.longest, 3);
    assert.equal(r.streak.current, 3);
    assert.equal(r.this_year.year, new Date().getFullYear());

    assert.deepEqual(r.continue_reading.map(c => [c.title, c.next_volume.volume_number, c.unread_after]), [['Lesereihe A', '3', 2]],
        'B is read up to its last owned volume; the missing A 5 does not count');

    assert.equal((await admin('GET', '/stats/reading?user_id=999')).status, 404);
    assert.equal((await admin('GET', '/stats/reading?user_id=abc')).status, 400);
});

test('readingStreaks: gaps end a run; the current run counts up to last month', () => {
    const { readingStreaks } = require('../core/handlers/stats');
    assert.deepEqual(readingStreaks(['2025-11', '2025-12', '2026-01', '2026-03'], '2026-04'), { longest: 3, longest_end: '2026-01', current: 1 });
    assert.deepEqual(readingStreaks(['2025-01'], '2026-04'), { longest: 1, longest_end: '2025-01', current: 0 });
    assert.deepEqual(readingStreaks([], '2026-04'), { longest: 0, longest_end: null, current: 0 });
});
