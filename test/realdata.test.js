const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePublisher } = require('../utils/publishers');
const { startTestServer } = require('./helpers');

// Regressions found with real Manga Passion data (publisher spelling, radar contents).
let ctx;
let admin;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

test('normalizePublisher: Manga Passion spellings map to the canonical names', () => {
    assert.equal(normalizePublisher('Carlsen Manga!'), 'Carlsen Manga');
    assert.equal(normalizePublisher('carlsen manga!'), 'Carlsen Manga');
    assert.equal(normalizePublisher('Carlsen Manga'), 'Carlsen Manga');
    assert.equal(normalizePublisher('Panini Manga'), 'Panini Verlags GmbH');
    assert.equal(normalizePublisher('Egmont Manga'), 'Egmont Manga');
    assert.equal(normalizePublisher('Planet Manga'), 'Planet Manga');
    assert.equal(normalizePublisher('  '), null);
    assert.equal(normalizePublisher(null), null);
});

test('release radar lists upcoming and pre-ordered volumes, not missing back-catalogue volumes', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Radar Reihe', publisher: 'Carlsen Manga!' })).body.id;
    const nextYear = new Date().getFullYear() + 1;
    const add = (volume_number, status, release_date) =>
        admin('POST', '/volumes', { manga_id: id, volume_number, status, release_date });
    assert.equal((await add('1', 'Fehlt', '2005-09-30')).status, 200);            // old, missing -> shopping list only
    assert.equal((await add('2', 'Fehlt', `${nextYear}-03-15`)).status, 200);     // upcoming, not pre-ordered yet
    assert.equal((await add('3', 'Vorbestellt', `${nextYear}-04-01`)).status, 200);
    assert.equal((await add('4', 'Vorbestellt', '2020-01-01')).status, 200);      // overdue pre-order stays visible
    assert.equal((await add('5', 'Vorhanden', `${nextYear}-05-01`)).status, 200); // owned never listed

    const radar = (await admin('GET', '/release-radar')).body;
    assert.deepEqual(radar.groups.flatMap(g => g.items).map(i => i.volume_number).sort(), ['2', '3', '4']);
    assert.equal(radar.items, undefined, 'the flat list duplicated groups[].items');
    assert.equal(radar.preordered_count, 2);

    const shopping = (await admin('GET', '/shopping-list')).body;
    assert.deepEqual(shopping.items.map(i => i.volume_number).sort(), ['1', '2']);

    // a series created with the Manga Passion spelling is stored under the canonical publisher
    assert.equal((await admin('GET', `/mangas/${id}`)).body.publisher, 'Carlsen Manga');
});

test('migration v4 normalizes publisher names that were stored before the fix', () => {
    const { db, initDb } = require('../db');
    db.prepare("INSERT INTO mangas (title, publisher) VALUES ('Alt A', 'Carlsen Manga!'), ('Alt B', 'Panini Manga'), ('Alt C', 'Planet Manga')").run();
    db.prepare("INSERT INTO volumes (manga_id, volume_number, publisher) SELECT id, '1', 'Carlsen Manga!' FROM mangas WHERE title = 'Alt A'").run();
    db.prepare('DELETE FROM schema_migrations WHERE version = 4').run();
    initDb(); // re-runs pending migrations

    const pub = (title) => db.prepare('SELECT publisher FROM mangas WHERE title = ?').get(title).publisher;
    assert.equal(pub('Alt A'), 'Carlsen Manga');
    assert.equal(pub('Alt B'), 'Panini Verlags GmbH');
    assert.equal(pub('Alt C'), 'Planet Manga');
    assert.equal(db.prepare("SELECT publisher FROM volumes WHERE volume_number = '1' AND manga_id = (SELECT id FROM mangas WHERE title = 'Alt A')").get().publisher, 'Carlsen Manga');
    assert.ok(db.prepare('SELECT version FROM schema_migrations WHERE version = 4').get());
});

test('shopping list tells special editions and schuber apart from regular volumes', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Einkauf Typen' })).body.id;
    for (const [n, type] of [['11', 'volume'], ['11', 'special_edition'], ['Leerschuber 1-5', 'schuber']]) {
        assert.equal((await admin('POST', '/volumes', { manga_id: id, volume_number: n, type, status: 'Fehlt' })).status, 200);
    }
    const items = (await admin('GET', '/shopping-list')).body.items.filter(i => i.manga_id === id);
    assert.deepEqual(items.map(i => `${i.volume_number}|${i.type}`).sort(), ['11|special_edition', '11|volume', 'Leerschuber 1-5|schuber']);
});

test('list rows carry regular/extra counts; progress and completion count regular volumes only', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Fortschritt Reihe', total_volumes: 3, status: 'Laufend' })).body.id;
    assert.equal((await admin('POST', '/volumes/batch', { manga_id: id, from: 1, to: 4, status: 'Vorhanden' })).status, 200); // 4 > stale total 3
    for (const [n, type] of [['Schuber 1', 'schuber'], ['Extra 1', 'special']]) {
        assert.equal((await admin('POST', '/volumes', { manga_id: id, volume_number: n, type, status: 'Vorhanden' })).status, 200);
    }
    const row = (await admin('GET', '/mangas')).body.find(m => m.id === id);
    assert.equal(row.owned_volumes, 6);
    assert.equal(row.regular_owned, 4);
    assert.equal(row.max_regular_number, 4);

    const { getSeriesProgress } = await import(require('url').pathToFileURL(require('path').join(__dirname, '..', 'frontend', 'src', 'utils', 'volumeHelpers.js')).href);
    assert.deepEqual(getSeriesProgress(row), { owned: 4, total: 4, extras: 2, pct: 100 });
});

test('a series is not "completed" because schuber and extras raise the owned count', async () => {
    const before = (await admin('GET', '/stats')).body.summary.completed_series;
    const id = (await admin('POST', '/mangas', { title: 'Nicht komplett', total_volumes: 3, status: 'Laufend' })).body.id;
    assert.equal((await admin('POST', '/volumes/batch', { manga_id: id, from: 1, to: 1, status: 'Vorhanden' })).status, 200);
    for (const n of ['Schuber 1', 'Schuber 2']) {
        assert.equal((await admin('POST', '/volumes', { manga_id: id, volume_number: n, type: 'schuber', status: 'Vorhanden' })).status, 200);
    }
    assert.equal((await admin('GET', '/stats')).body.summary.completed_series, before); // 3 owned entries, but only 1 of 3 volumes
    assert.equal((await admin('POST', '/volumes/batch', { manga_id: id, from: 2, to: 3, status: 'Vorhanden' })).status, 200);
    assert.equal((await admin('GET', '/stats')).body.summary.completed_series, before + 1);
});

test('the same type and number cannot be added twice, but a special edition of the same number can', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Doppelt' })).body.id;
    const add = (volume_number, type) => admin('POST', '/volumes', { manga_id: id, volume_number, type });
    assert.equal((await add('6', 'volume')).status, 200);
    const again = await add('6', 'volume');
    assert.equal(again.status, 409);
    assert.match(again.body.error, /Band 6 existiert bereits/);
    assert.ok(again.body.existing_id);
    assert.equal((await add(' 6 ', 'volume')).status, 409);                       // whitespace does not make it a new volume
    assert.equal((await add('6', 'special_edition')).status, 200);                // Collectors Edition 6 next to Band 6
    assert.equal((await add('Schuber 1', 'schuber')).status, 200);
    assert.equal((await add('schuber 1', 'schuber')).status, 409);               // case-insensitive
    assert.equal((await admin('GET', `/mangas/${id}`)).body.volumes.length, 3);
});

test('migration v7 removes the 2999-12-31 placeholder release date', () => {
    const { db, initDb } = require('../db');
    const mangaId = Number(db.prepare("INSERT INTO mangas (title) VALUES ('Platzhalter')").run().lastInsertRowid);
    const add = (n, date) => db.prepare('INSERT INTO volumes (manga_id, volume_number, status, release_date) VALUES (?, ?, ?, ?)').run(mangaId, n, 'Fehlt', date);
    add('1', '2999-12-31'); add('2', '2027-02-02'); add('3', '2026-10'); add('4', null);
    db.prepare('DELETE FROM schema_migrations WHERE version = 7').run();
    initDb();
    const dates = db.prepare('SELECT release_date FROM volumes WHERE manga_id = ? ORDER BY CAST(volume_number AS INTEGER)').all(mangaId).map(r => r.release_date);
    assert.deepEqual(dates, [null, '2027-02-02', '2026-10', null]);
});

test('"Band 14" counts as regular volume 14; "Starter 1" is an extra; migration v8 cleans the prefix', () => {
    const { db, initDb } = require('../db');
    const mangaId = Number(db.prepare("INSERT INTO mangas (title, total_volumes) VALUES ('Praefix', 14)").run().lastInsertRowid);
    const add = (n) => db.prepare("INSERT INTO volumes (manga_id, volume_number, status, type) VALUES (?, ?, 'Vorhanden', 'volume')").run(mangaId, n);
    add('13'); add('Band 14'); add('Starter 1'); add('Band 13');
    db.prepare('DELETE FROM schema_migrations WHERE version = 8').run();
    initDb();
    const nums = db.prepare('SELECT volume_number FROM volumes WHERE manga_id = ? ORDER BY id').all(mangaId).map(r => r.volume_number);
    assert.deepEqual(nums, ['13', '14', 'Starter 1', 'Band 13']);   // "Band 13" stays: a clean 13 already exists
});

test('list counts: numbered regular volumes only, even when stored as "Band N"', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Zaehlung', total_volumes: 3 })).body.id;
    for (const [n, type] of [['1', 'volume'], ['Band 2', 'volume'], ['Starter 1', 'volume'], ['Schuber 1', 'schuber']]) {
        assert.equal((await admin('POST', '/volumes', { manga_id: id, volume_number: n, type })).status, 200);
    }
    const row = (await admin('GET', '/mangas')).body.find(m => m.id === id);
    assert.equal(row.owned_volumes, 4);
    assert.equal(row.regular_owned, 2);
    assert.equal(row.max_regular_number, 2);
});

test('a duplicate entry does not raise the progress of a series', async () => {
    const { db } = require('../db');
    const id = (await admin('POST', '/mangas', { title: 'Doppelte zaehlen nicht', total_volumes: 5 })).body.id;
    assert.equal((await admin('POST', '/volumes/batch', { manga_id: id, from: 1, to: 3, status: 'Vorhanden' })).status, 200);
    // pre-existing duplicate (created before the server refused them)
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status, type) VALUES (?, '3', 'Vorhanden', 'volume')").run(id);
    const row = (await admin('GET', '/mangas')).body.find(m => m.id === id);
    assert.equal(row.volume_count, 4);
    assert.equal(row.regular_owned, 3);
});

test('static headers: index.html, sw.js and manifest.json are revalidated, hashed assets are not touched', () => {
    const { setStaticHeaders } = require('../utils/staticHeaders');
    const headersFor = (file) => { const h = {}; setStaticHeaders({ setHeader: (k, v) => { h[k] = v; } }, file); return h; };
    for (const file of ['C:\\app\\frontend\\dist\\index.html', '/app/frontend/dist/index.html', '/app/dist/sw.js', '/app/dist/manifest.json']) {
        assert.deepEqual(headersFor(file), { 'Cache-Control': 'no-cache' }, file);
    }
    for (const file of ['/app/dist/assets/index-abc123.js', '/app/dist/assets/Dashboard-x.js', '/app/dist/favicon.svg', '/app/dist/assets/notindex.html.js']) {
        assert.deepEqual(headersFor(file), {}, file);
    }
});
