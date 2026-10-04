const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { startTestServer } = require('./helpers');
const publishers = require('../core/lib/publishers');
const { applySchema } = require('../core/schema');

let ctx;
let admin;
let editor;
let db;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    editor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
    db = require('../db').db;
});

test.after(async () => {
    await ctx.close();
    publishers.setPublisherAliases(new Map(Object.entries(publishers.PUBLISHER_ALIAS_SEED)));
});

test('normalizePublisher: stored aliases first, legal suffixes only as a fallback, merged canonical names follow once', () => {
    const { resolvePublisher, PUBLISHER_ALIAS_SEED } = publishers;
    const seed = new Map(Object.entries(PUBLISHER_ALIAS_SEED));
    assert.equal(resolvePublisher('TOKYOPOP GmbH', new Map()), 'TOKYOPOP');
    assert.equal(resolvePublisher('Manga Cult GmbH & Co. KG', new Map()), 'Manga Cult');
    assert.equal(resolvePublisher('Manga Tag', new Map()), 'Manga Tag', 'a word ending in "ag" is no legal form');
    assert.equal(resolvePublisher('Kleinverlag GmbH', new Map()), 'Kleinverlag GmbH', 'unknown names keep their suffix');
    assert.equal(resolvePublisher('Carlsen Verlag GmbH', seed), 'Carlsen Manga');
    assert.equal(resolvePublisher('Egmont Manga & Anime', seed), 'Egmont Manga');
    assert.equal(resolvePublisher('Carlsen Manga!', seed), 'Carlsen Manga');
    const merged = new Map([['panini verlags gmbh', 'Panini']]);
    assert.equal(resolvePublisher('Panini Manga', merged), 'Panini');
    assert.equal(resolvePublisher('Panini', merged), 'Panini');
    assert.equal(resolvePublisher('  ', merged), null);
});

test('migration 22 seeds the measured spellings and rewrites stored rows', () => {
    const conn = new DatabaseSync(':memory:');
    applySchema(conn);
    conn.prepare("INSERT INTO mangas (title, publisher) VALUES ('Alt', 'Egmont Manga & Anime')").run();
    conn.prepare("INSERT INTO volumes (manga_id, volume_number, publisher) VALUES (1, '1', 'Carlsen Verlag GmbH')").run();
    conn.exec('DROP TABLE publisher_aliases; DELETE FROM schema_migrations WHERE version = 22;');
    applySchema(conn);
    assert.equal(conn.prepare('SELECT publisher FROM mangas').get().publisher, 'Egmont Manga');
    assert.equal(conn.prepare('SELECT publisher FROM volumes').get().publisher, 'Carlsen Manga');
    assert.equal(conn.prepare("SELECT canonical FROM publisher_aliases WHERE alias = 'ema'").get().canonical, 'Egmont Manga');
    conn.close();
});

test('GET /publishers counts every spelling; merge rewrites series and volumes and remembers the alias', async () => {
    const insert = db.prepare('INSERT INTO mangas (title, publisher) VALUES (?, ?)');
    const a = Number(insert.run('Verlag A', 'Kazé').lastInsertRowid);
    const b = Number(insert.run('Verlag B', 'Crunchyroll Manga').lastInsertRowid);
    db.prepare("INSERT INTO volumes (manga_id, volume_number, publisher) VALUES (?, '1', 'Kazé')").run(b);

    const listed = (await editor('GET', '/publishers')).body;
    const kaze = listed.publishers.find(p => p.name === 'Kazé');
    assert.deepEqual([kaze.series_count, kaze.volume_count, kaze.known], [1, 1, false]);
    assert.ok(listed.aliases.some(x => x.alias === 'ema'));

    assert.equal((await editor('POST', '/publishers/merge', { from: 'Kazé', to: 'Crunchyroll' })).status, 403);
    assert.equal((await admin('POST', '/publishers/merge', { from: [], to: 'X' })).status, 400);
    assert.equal((await admin('POST', '/publishers/merge', { from: 'Kazé', to: '' })).status, 400);
    assert.equal((await admin('POST', '/publishers/merge', { from: 'Kazé', to: 'x'.repeat(301) })).status, 400);

    const res = await admin('POST', '/publishers/merge', { from: ['Kazé', 'Crunchyroll Manga'], to: 'Crunchyroll' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.updated_series, res.body.updated_volumes], [2, 1]);
    assert.deepEqual(db.prepare('SELECT publisher FROM mangas WHERE id IN (?, ?) ORDER BY id').all(a, b).map(r => r.publisher), ['Crunchyroll', 'Crunchyroll']);
    assert.equal(db.prepare('SELECT publisher FROM volumes WHERE manga_id = ?').get(b).publisher, 'Crunchyroll');

    const created = await editor('POST', '/mangas', { title: 'Neu mit Alias', publisher: 'kazé' });
    assert.equal((await editor('GET', `/mangas/${created.body.id}`)).body.publisher, 'Crunchyroll');

    // merging the canonical name on: earlier aliases follow
    assert.equal((await admin('POST', '/publishers/merge', { from: 'Crunchyroll', to: 'Crunchyroll Manga' })).status, 200);
    const aliases = Object.fromEntries((await editor('GET', '/publishers')).body.aliases.map(x => [x.alias, x.canonical]));
    assert.equal(aliases['kazé'], 'Crunchyroll Manga');
    assert.equal(aliases.crunchyroll, 'Crunchyroll Manga');
    assert.equal(aliases['crunchyroll manga'], undefined, 'the target is canonical and no alias of itself');
    assert.equal(publishers.normalizePublisher('Kazé'), 'Crunchyroll Manga');

    assert.equal((await editor('DELETE', '/publishers/aliases/kaz%C3%A9')).status, 403);
    assert.equal((await admin('DELETE', '/publishers/aliases/kaz%C3%A9')).status, 200);
    assert.equal((await admin('DELETE', '/publishers/aliases/kaz%C3%A9')).status, 404);
    assert.equal(publishers.normalizePublisher('Kazé'), 'Kazé');
});

test('a rename is a merge into a new name; differently cased rows of the target are aligned', async () => {
    const insert = db.prepare('INSERT INTO mangas (title, publisher) VALUES (?, ?)');
    insert.run('Umbenennen 1', 'Hayabusa');
    insert.run('Umbenennen 2', 'hayabusa');
    const res = await admin('POST', '/publishers/merge', { from: 'Hayabusa', to: 'Hayabusa (Carlsen)' });
    assert.equal(res.status, 200);
    assert.deepEqual(db.prepare("SELECT DISTINCT publisher FROM mangas WHERE title LIKE 'Umbenennen%'").all().map(r => r.publisher), ['Hayabusa (Carlsen)']);
    assert.equal(res.body.updated_series, 2);
});
