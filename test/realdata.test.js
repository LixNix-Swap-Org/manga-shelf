const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePublisher } = require('../utils/publishers');
const { startTestServer } = require('./helpers');

// Findings from testing with real Manga Passion data (publisher spelling, radar contents).
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
    assert.deepEqual(radar.items.map(i => i.volume_number).sort(), ['2', '3', '4']);
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
