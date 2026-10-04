// Editions in other languages over HTTP: default language, CSV columns, money per currency, Manga Passion gating, trash.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
const realFetch = global.fetch;

const pad = (n) => String(n).padStart(2, '0');
const nextMonth = () => {
    const d = new Date();
    const m = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
};

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
});

test.after(async () => {
    global.fetch = realFetch;
    await ctx.close();
});

const wipe = () => {
    const { db } = require('../db');
    db.exec('DELETE FROM volumes; DELETE FROM mangas; DELETE FROM trash;');
};
const newSeries = async (title, extra = {}) => {
    const res = await admin('POST', '/mangas', { title, ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id;
};
const newVolume = async (mangaId, volumeNumber, extra = {}) => {
    const res = await admin('POST', '/volumes', { manga_id: mangaId, volume_number: volumeNumber, ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id;
};
const exportCsv = async () => (await fetch(ctx.base + '/export/csv', { headers: { Cookie: admin.cookie } })).text();

test('a new series takes the language of the caller\'s default; names, codes and tags are stored as codes', async () => {
    wipe();
    assert.equal((await admin('PUT', '/auth/profile', { default_language: 'en' })).status, 200);
    try {
        const plain = await newSeries('Ohne Sprache');
        const csv = await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer\nCSV ohne Sprache;1\n' });
        assert.equal(csv.status, 200);
        const list = (await admin('GET', '/mangas')).body;
        assert.deepEqual(list.map(m => [m.title, m.language]), [['CSV ohne Sprache', 'en'], ['Ohne Sprache', 'en']]);
        assert.equal((await admin('PUT', `/mangas/${plain}`, { language: '' })).status, 200);
        assert.equal((await admin('GET', `/mangas/${plain}`)).body.language, 'en', "'' falls back to the default language");
    } finally {
        await admin('PUT', '/auth/profile', { default_language: 'de' });
    }
    const tagged = await newSeries('Mit Tag', { language: 'pt-BR' });
    const named = await newSeries('Mit Name', { language: 'Englisch', region: 'gb' });
    const detail = async (id) => (await admin('GET', `/mangas/${id}`)).body;
    assert.deepEqual([(await detail(tagged)).language, (await detail(tagged)).region], ['pt', 'BR']);
    assert.deepEqual([(await detail(named)).language, (await detail(named)).region], ['en', 'GB'], 'a sent region wins over the tag');
    assert.equal((await admin('PUT', `/mangas/${named}`, { region: null })).status, 200);
    assert.equal((await detail(named)).region, null);
});

test('CSV: Sprache exports codes, Region/Währung/Werk follow it, Bandsprache sits before the last two; a round trip keeps them', async () => {
    wipe();
    const de = await newSeries('Rundlauf', { language: 'de', publisher: 'Carlsen Manga' });
    const en = (await admin('POST', `/mangas/${de}/editions`, { language: 'en-US', currency: 'USD', publisher: 'Viz Media' })).body.id;
    await newVolume(de, '1', { price: 7, language: 'ja' });
    await newVolume(en, '1', { price: 9.99, status: 'Fehlt' });

    const csv = await exportCsv();
    const lines = csv.split('\r\n');
    assert.ok(lines[0].includes(';Sprache;Region;Währung;Werk;Tags;'), lines[0]);
    assert.ok(lines[0].endsWith(';Bandsprache;Gelesen von;Besitzer'));
    const { parseCsv } = require('../core/csvExchange');
    const header = parseCsv(lines[0])[0];
    const rows = parseCsv(csv).slice(1);
    const col = (row, name) => row[header.indexOf(name)];
    const enRow = rows.find(r => col(r, 'Reihenverlag') === 'Viz Media');
    assert.deepEqual(['Sprache', 'Region', 'Währung', 'Bandsprache'].map(n => col(enRow, n)), ['en', 'US', 'USD', '']);
    const deRow = rows.find(r => col(r, 'Reihenverlag') === 'Carlsen Manga');
    assert.deepEqual(['Sprache', 'Währung', 'Bandsprache'].map(n => col(deRow, n)), ['de', 'EUR', 'ja']);
    assert.match(col(enRow, 'Werk'), /^manual:[0-9a-f]{24}$/);
    assert.equal(col(deRow, 'Werk'), col(enRow, 'Werk'));

    const { db } = require('../db');
    // manual keys are fresh after an import; what has to survive is the grouping
    const snapshot = () => ({
        series: db.prepare('SELECT title, publisher, language, region, currency, work_key IS NOT NULL AS grouped FROM mangas ORDER BY publisher').all().map(r => ({ ...r })),
        volumes: db.prepare('SELECT m.publisher, v.volume_number, v.language, v.price FROM volumes v JOIN mangas m ON m.id = v.manga_id ORDER BY m.publisher').all().map(r => ({ ...r }))
    });
    const before = snapshot();
    wipe();
    const res = (await admin('POST', '/import/csv', { csv })).body;
    assert.deepEqual([res.errors, res.warnings, res.created_series, res.created_volumes], [[], [], 2, 2]);
    assert.deepEqual(snapshot(), before);
    const list = (await admin('GET', '/mangas')).body;
    const imported = list.find(m => m.language === 'de');
    assert.deepEqual((await admin('GET', `/mangas/${imported.id}`)).body.editions.map(e => e.language), ['en'], 'the work key links them again');
});

test('CSV import: language names and codes, header aliases, invalid edition cells are warnings', async () => {
    wipe();
    const csv = [
        'Reihe;Bandnummer;Language;Currency;Work;Volume Language',
        'Name;1;Englisch;usd;anilist:5;Japanisch',
        'Code;1;EN;;;',
        'Tag;1;fr-CA;;;',
        'Unbekannt;1;Klingonisch;EURO;kitsu:9;Vulkanisch'
    ].join('\n');
    const res = (await admin('POST', '/import/csv', { csv })).body;
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings.map(w => [w.line, w.message]), [
        [5, 'Ungültiger Wert „Klingonisch“ in „Sprache“ (Sprachcode wie de, en oder ja) wird ignoriert'],
        [5, 'Ungültiger Wert „EURO“ in „Währung“ (drei Buchstaben, z. B. EUR) wird ignoriert'],
        [5, 'Ungültiger Wert „kitsu:9“ in „Werk“ wird ignoriert'],
        [5, 'Ungültiger Wert „Vulkanisch“ in „Bandsprache“ wird ignoriert']
    ]);
    const { db } = require('../db');
    const rows = db.prepare(`SELECT m.title, m.language, m.region, m.currency, m.work_key, v.language AS volume_language
        FROM mangas m JOIN volumes v ON v.manga_id = m.id ORDER BY m.title`).all().map(r => Object.values(r));
    assert.deepEqual(rows, [
        ['Code', 'en', null, 'EUR', null, null],
        ['Name', 'en', null, 'USD', 'anilist:5', 'ja'],
        ['Tag', 'fr', 'CA', 'EUR', null, null],
        ['Unbekannt', 'de', null, 'EUR', null, null]
    ]);
});

test('money totals count euro only; other currencies are listed apart; stats per language and currency', async () => {
    wipe();
    const eur = await newSeries('Euro Reihe', { publisher: 'Carlsen' });
    const usd = await newSeries('Dollar Reihe', { language: 'en', currency: 'USD', publisher: 'Viz Media' });
    await newVolume(eur, '1', { price: 10, status: 'Vorhanden' });
    await newVolume(eur, '2', { price: 6, status: 'Fehlt' });
    await newVolume(eur, '3', { price: 8, status: 'Vorbestellt', release_date: `${nextMonth()}-10` });
    await newVolume(usd, '1', { price: 20, status: 'Vorhanden' });
    await newVolume(usd, '2', { price: 15, status: 'Fehlt' });
    await newVolume(usd, '3', { price: 9.99, status: 'Vorbestellt', release_date: `${nextMonth()}-12`, language: 'ja' });

    const stats = (await admin('GET', '/stats')).body;
    assert.deepEqual([stats.summary.total_owned_value, stats.summary.total_missing_value, stats.summary.total_possible_value], [10, 6, 24]);
    assert.equal(stats.summary.total_owned_volumes, 2, 'counts stay over every edition');
    assert.equal(stats.summary.avg_price_per_volume, 10);
    assert.deepEqual(stats.top_series.map(s => s.title), ['Euro Reihe']);
    assert.equal(stats.publishers.find(p => p.publisher === 'Viz Media').total_value, 0);
    assert.deepEqual(stats.currencies, [
        { currency: 'EUR', series: 1, owned_volumes: 1, owned_value: 10, missing_value: 6 },
        { currency: 'USD', series: 1, owned_volumes: 1, owned_value: 20, missing_value: 15 }
    ]);
    assert.deepEqual(stats.languages, [
        { language: 'de', series: 1, volumes: 3, owned_volumes: 1 },
        { language: 'en', series: 1, volumes: 2, owned_volumes: 1 },
        { language: 'ja', series: 0, volumes: 1, owned_volumes: 0 }
    ]);

    const shopping = (await admin('GET', '/shopping-list')).body;
    assert.deepEqual([shopping.total_cost, shopping.other_currencies], [6, [{ currency: 'USD', count: 1, total: 15 }]]);
    assert.equal(shopping.publishers.find(p => p.publisher === 'Viz Media').total_price, 0);
    const radar = (await admin('GET', '/release-radar')).body;
    assert.deepEqual([radar.total_budget, radar.preordered_budget, radar.other_currencies], [8, 8, [{ currency: 'USD', count: 1, total: 9.99 }]]);
    const item = radar.groups.flatMap(g => g.items).find(i => i.manga_id === usd);
    assert.deepEqual([item.language, item.currency], ['ja', 'USD'], 'the volume language wins');

    const feed = (await admin('POST', '/radar/feed-token')).body;
    const ics = await (await fetch(ctx.root + feed.path)).text();
    assert.match(ics, /Preis: 9\\,99 USD/);
    assert.match(ics, /Preis: 8\\,00 €/);
});

test('Manga Passion: lookup only for German, gateway hits carry the work key, the calendar ignores other editions', async (t) => {
    wipe();
    const mangaPassion = require('../core/mangaPassion/client');
    const original = mangaPassion.searchMangaPassionForLookup;
    const asked = [];
    mangaPassion.searchMangaPassionForLookup = async (c, term) => { asked.push(term); return [{ id: 'mp_1', source: 'manga_passion', title: term }]; };
    const anilist = { data: { Page: { media: [{ id: 30002, idMal: 2, title: { romaji: 'Berserk', english: 'Berserk' }, status: 'FINISHED' }] } } };
    global.fetch = (url, opts) => {
        if (String(url).startsWith(ctx.base)) return realFetch(url, opts);
        if (String(url).startsWith('https://graphql.anilist.co')) return Promise.resolve(new Response(JSON.stringify(anilist), { headers: { 'Content-Type': 'application/json' } }));
        return Promise.reject(new Error('no network in tests: ' + url));
    };
    t.after(() => {
        mangaPassion.searchMangaPassionForLookup = original;
        global.fetch = realFetch;
    });

    const english = await admin('GET', '/lookup/manga?q=Berserk&language=en');
    assert.equal(english.status, 200, JSON.stringify(english.body));
    assert.deepEqual(asked, [], 'no Manga Passion call for an English edition');
    const hit = english.body.find(h => h.source === 'anilist');
    assert.equal(hit.work_key, 'anilist:30002');
    const german = await admin('GET', '/lookup/manga?q=Berserk%20DE');
    assert.deepEqual(asked, ['Berserk DE'], 'German is the default');
    assert.equal(german.body[0].source, 'manga_passion');

    const de = await newSeries('Kalender Reihe');
    const en = await newSeries('Kalender Reihe EN', { language: 'en' });
    await newVolume(de, '1');
    await newVolume(en, '1');
    const mixed = await newVolume(de, '2', { language: 'en' });
    const { createCtx } = require('../db');
    const { loadUserMangas, loadUserVolumes } = require('../core/handlers/radar');
    const c = createCtx();
    assert.deepEqual(loadUserMangas(c).map(m => m.id), [de]);
    assert.ok(!loadUserVolumes(c).some(v => v.manga_id === en || v.id === mixed));
});

test('restoring a series trashed before migration 27 normalises its language', async () => {
    wipe();
    const id = await newSeries('Alter Papierkorb', { language: 'ja' });
    const trashId = (await admin('DELETE', `/mangas/${id}`)).body.trash_id;
    const { db } = require('../db');
    const row = db.prepare('SELECT payload FROM trash WHERE id = ?').get(trashId);
    const payload = JSON.parse(row.payload);
    for (const key of ['region', 'work_key', 'currency']) delete payload.manga[key];
    payload.manga.language = 'en-AU';
    db.prepare('UPDATE trash SET payload = ? WHERE id = ?').run(JSON.stringify(payload), trashId);
    assert.equal((await admin('POST', `/trash/${trashId}/restore`)).status, 200);
    const restored = (await admin('GET', `/mangas/${id}`)).body;
    assert.deepEqual([restored.language, restored.region, restored.currency, restored.work_key], ['en', 'AU', 'EUR', null]);
});

const MANUAL_KEY = /^manual:[0-9a-f]{24}$/;
const seriesRows = () => require('../db').db.prepare(`SELECT m.id, m.title, m.language, m.currency, m.work_key,
    (SELECT GROUP_CONCAT(v.volume_number || '=' || COALESCE(printf('%g', v.price), ''), ',') FROM (SELECT * FROM volumes WHERE manga_id = m.id ORDER BY volume_number) v) AS volumes
    FROM mangas m ORDER BY m.id`).all().map(r => ({ ...r }));

test('CSV round trip keeps two same-title editions apart; a file without "Sprache" matches as before', async () => {
    wipe();
    const de = await newSeries('Kaiju', { publisher: 'Carlsen Manga' });
    const en = (await admin('POST', `/mangas/${de}/editions`, { language: 'en', region: 'US', currency: 'USD' })).body.id;
    for (const n of ['1', '2']) await newVolume(de, n, { price: 7 });
    for (const n of ['1', '2', '3']) await newVolume(en, n, { price: 11 });
    const csv = await exportCsv();

    wipe();
    const res = (await admin('POST', '/import/csv', { csv })).body;
    assert.deepEqual([res.created_series, res.created_volumes, res.skipped_existing, res.errors, res.warnings], [2, 5, 0, [], []]);
    const rows = seriesRows();
    assert.deepEqual(rows.map(r => [r.title, r.language, r.currency, r.volumes]), [
        ['Kaiju', 'de', 'EUR', '1=7,2=7'],
        ['Kaiju', 'en', 'USD', '1=11,2=11,3=11']
    ]);
    assert.ok(MANUAL_KEY.test(rows[0].work_key) && rows[0].work_key === rows[1].work_key, 'still one work');

    const again = (await admin('POST', '/import/csv', { csv })).body;
    assert.deepEqual([again.created_series, again.created_volumes, again.skipped_existing], [0, 0, 5], 'each row finds its own edition');

    const legacy = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Preis\nKaiju;4;8\n' })).body;
    assert.deepEqual([legacy.created_series, legacy.created_volumes], [0, 1]);
    assert.equal(seriesRows()[0].volumes, '1=7,2=7,4=8', 'without "Sprache" the lowest id wins, as before');
});

test('CSV import: every manual key of the file gets a fresh one; groups inside the file survive, AniList keys stay', async () => {
    wipe();
    const local = await newSeries('Lokal');
    const localEn = (await admin('POST', `/mangas/${local}/editions`, { language: 'en' })).body;
    const csv = [
        'Reihe;Bandnummer;Sprache;Werk',
        `Fremd A;1;de;${localEn.work_key}`,
        `Fremd B;1;en;${localEn.work_key}`,
        'Fremd C;1;ja;manual:1',
        'Fremd D;1;fr;anilist:42'
    ].join('\n');
    const res = (await admin('POST', '/import/csv', { csv })).body;
    assert.deepEqual([res.created_series, res.errors, res.warnings], [4, [], []]);
    const keys = Object.fromEntries(seriesRows().map(r => [r.title, r.work_key]));
    assert.equal(keys['Lokal'], localEn.work_key);
    assert.ok(MANUAL_KEY.test(keys['Fremd A']) && keys['Fremd A'] === keys['Fremd B'], 'the pair of the file stays a pair');
    assert.notEqual(keys['Fremd A'], localEn.work_key, 'never joins the local group');
    assert.ok(MANUAL_KEY.test(keys['Fremd C']) && keys['Fremd C'] !== keys['Fremd A']);
    assert.equal(keys['Fremd D'], 'anilist:42');
    assert.deepEqual((await admin('GET', `/mangas/${local}`)).body.editions.map(e => e.id), [localEn.id]);
});

test('language codes outside ISO 639-1 are unknown everywhere; Türkçe is Turkish', async () => {
    wipe();
    for (const [method, url, body] of [
        ['POST', '/mangas', { title: 'Unbekannt', language: 'xx' }],
        ['PUT', '/auth/profile', { default_language: 'zz' }]
    ]) {
        const res = await admin(method, url, body);
        assert.deepEqual([res.status, res.body.code], [400, 'LANGUAGE_INVALID'], url);
    }
    const id = await newSeries('Türkisch', { language: 'Türkçe' });
    assert.equal((await admin('GET', `/mangas/${id}`)).body.language, 'tr');
    const vol = await admin('POST', '/volumes', { manga_id: id, volume_number: '1', language: 'qq' });
    assert.deepEqual([vol.status, vol.body.code], [400, 'LANGUAGE_INVALID']);
    const csv = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Sprache\nZett;1;zz\n' })).body;
    assert.deepEqual(csv.warnings.map(w => w.message), ['Ungültiger Wert „zz“ in „Sprache“ (Sprachcode wie de, en oder ja) wird ignoriert']);
});

test('a Manga Passion id is only kept for German series', async () => {
    wipe();
    const en = await newSeries('Englisch mit MP', { language: 'en', manga_passion_id: 123 });
    const detail = async (id) => (await admin('GET', `/mangas/${id}`)).body;
    assert.equal((await detail(en)).manga_passion_id, null);
    assert.equal((await admin('PUT', `/mangas/${en}`, { manga_passion_id: 124 })).status, 200);
    assert.equal((await detail(en)).manga_passion_id, null);
    const de = await newSeries('Deutsch mit MP', { manga_passion_id: 125 });
    assert.equal((await detail(de)).manga_passion_id, 125);
    assert.equal((await admin('PUT', `/mangas/${de}`, { language: 'ja' })).status, 200);
    assert.equal((await detail(de)).manga_passion_id, null, 'leaving German drops the link');
});

test('Manga Passion per volume: a volume in another language is never looked up, filled, counted or imported over', async (t) => {
    wipe();
    const editionId = 990301;
    const calls = [];
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    global.fetch = async (url, opts) => {
        const u = String(url);
        if (u.startsWith(ctx.base)) return realFetch(url, opts);
        calls.push(u);
        if (u.includes(`/editions/${editionId}/volumes`)) {
            return json({ 'hydra:member': ['1', '2'].map(n => ({ id: editionId * 10 + Number(n), number: Number(n), numberDisplay: n, price: 700, date: '2020-01-01' })) });
        }
        if (u.endsWith(`/editions/${editionId}`)) return json({ id: editionId, title: 'Gemischt', numVolumes: 2, status: 1, publishers: [{ name: 'Carlsen Manga' }] });
        return json({}, 404);
    };
    t.after(() => { global.fetch = realFetch; });

    const id = await newSeries('Gemischt', { publisher: 'Carlsen Manga', manga_passion_id: editionId });
    const english = await newVolume(id, '1', { status: 'Fehlt', language: 'en' });
    const german = await newVolume(id, '2', { status: 'Fehlt' });

    const lookup = await admin('GET', `/volumes/lookup?manga_id=${id}&volume_number=1`);
    assert.deepEqual([lookup.status, lookup.body.code], [409, 'MP_LANGUAGE']);
    assert.deepEqual(calls, [], 'no request to Manga Passion');

    const gaps = (await admin('GET', `/mangas/${id}/gaps`)).body;
    assert.deepEqual(gaps.gaps.map(g => [g.volume_number, g.user_volume_id]), [['1', null], ['2', german]], 'the English volume 1 covers no German number');

    const filled = (await admin('POST', `/mangas/${id}/autofill-volumes`, {})).body;
    assert.equal(filled.updated_count, 1, JSON.stringify(filled));
    const imported = (await admin('POST', `/mangas/${id}/batch-import-gaps`, { volume_numbers: ['1'] })).body;
    assert.deepEqual([imported.imported_count, imported.updated_count], [0, 0]);

    const volumes = (await admin('GET', `/mangas/${id}`)).body.volumes;
    const byId = (vid) => volumes.find(v => v.id === vid);
    assert.equal(volumes.length, 2, 'no second volume 1 next to the English one');
    assert.deepEqual([byId(english).price, byId(english).manga_passion_volume_id, byId(english).language], [null, null, 'en']);
    assert.equal(byId(german).price, 7);
});

test('trash restore rejoins a work only while a live series still carries its key', async () => {
    wipe();
    const keyOf = async (id) => (await admin('GET', `/mangas/${id}`)).body.work_key;
    const x = await newSeries('Rück X');
    const kept = (await admin('POST', `/mangas/${x}/editions`, { language: 'en' })).body;
    const keptTrash = (await admin('DELETE', `/mangas/${kept.id}`)).body.trash_id;
    assert.equal((await admin('POST', `/trash/${keptTrash}/restore`)).status, 200);
    assert.equal(await keyOf(kept.id), kept.work_key, 'the partner still carries it');

    const gone = (await admin('POST', `/mangas/${x}/editions`, { language: 'fr' })).body;
    const goneTrash = (await admin('DELETE', `/mangas/${gone.id}`)).body.trash_id;
    const y = await newSeries('Rück Y', { work_key: 'anilist:77' });
    assert.equal((await admin('PUT', `/mangas/${x}/work`, { link_to: y })).body.work_key, 'anilist:77');
    assert.equal((await admin('POST', `/trash/${goneTrash}/restore`)).status, 200);
    assert.equal(await keyOf(gone.id), null, 'the group was re-keyed meanwhile');
    assert.deepEqual((await admin('GET', `/mangas/${x}`)).body.editions.map(e => e.id).sort(), [kept.id, y].sort());
});
