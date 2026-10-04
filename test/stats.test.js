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
    assert.deepEqual(Object.keys(body).sort(), ['owner_stats', 'publishers', 'spending', 'summary', 'top_series', 'user_reading_stats']);
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

test('completed_series: only a fully collected run of regular volumes counts', async () => {
    let base = (await getStats()).summary.completed_series;
    const expectCompleted = async (delta, msg) => assert.equal((await getStats()).summary.completed_series, base + delta, msg);

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
    for (const n of ['1', '2', '3', '5']) await addVolume(stale, n);
    await expectCompleted(0, 'an owned #5 raises the target to 5, #4 is missing');
    await addVolume(stale, '4');
    await expectCompleted(1, 'volumes 1..5 complete it');
    base += 1;

    const dup = await newSeries('Doppelt', { total_volumes: 3, status: 'Laufend' });
    await addVolume(dup, '1');
    await addVolume(dup, '2');
    await addVolume(dup, '2', { type: 'special' });
    await addVolume(dup, 'Schuber 1', { type: 'schuber' });
    await expectCompleted(0, 'a special edition of #2 and a schuber do not replace #3');

    const noTotal = await newSeries('Ohne Gesamtzahl', { status: 'Laufend' });
    await addVolume(noTotal, '1');
    await addVolume(noTotal, '2');
    await expectCompleted(1, 'without a stored total the highest owned number is the target');
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
});

test('PUT /stats/settings rejects missing, empty, non-string, pre-1900 and future dates', async () => {
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: '2022-01-05' })).status, 200);
    const bad = [
        {},
        { collection_start_date: '' },
        { collection_start_date: '   ' },
        { collection_start_date: 0 },
        { collection_start_date: ['2020-01-01'] },
        { collection_start_date: { toString: 1 } },
        { collection_start_date: '0000-01-01' },
        { collection_start_date: '1899-12-31' },
        { collection_start_date: '2023-02-30' },
        { collection_start_date: '', start_date: '2020-01-01' }
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

test('a stored start date that is invalid or before 1900 falls back to the default', async () => {
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('collection_start_date', '0000-01-01')").run();
    const s = (await getStats()).summary;
    assert.equal(s.collection_start_date, '2021-04-09');
    assert.ok(s.collection_days < 365 * 200);
    assert.equal((await admin('PUT', '/stats/settings', { collection_start_date: '2022-01-05' })).status, 200);
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
