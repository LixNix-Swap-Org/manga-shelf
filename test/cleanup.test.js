const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let visitor;
let db;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    visitor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'vis', password: 'password123', role: 'visitor' })).status, 200);
    assert.equal((await visitor('POST', '/auth/login', { username: 'vis', password: 'password123' })).status, 200);
    db = require('../db').db;
});

test.after(async () => { await ctx.close(); });

const checksOf = async (client = admin) => {
    const res = await client('GET', '/maintenance/quality');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return Object.fromEntries(res.body.checks.map(c => [c.id, c]));
};

test('quality report: counts and entries per check, trashed series stay out', async () => {
    const insertSeries = db.prepare('INSERT INTO mangas (title, publisher, author, cover_image, manga_passion_id, total_volumes) VALUES (?, ?, ?, ?, ?, ?)');
    const full = Number(insertSeries.run('Vollständig', 'Carlsen Manga', 'A', '/uploads/a.jpg', 1, 2).lastInsertRowid);
    const bare = Number(insertSeries.run('Kahl', 'Kleiner Verlag', null, null, null, null).lastInsertRowid);
    insertSeries.run('kahl ', 'Carlsen Verlag GmbH', 'B', '/uploads/b.jpg', 2, 1);
    const vol = db.prepare('INSERT INTO volumes (manga_id, volume_number, status, price, purchase_date, isbn, release_date) VALUES (?, ?, ?, ?, ?, ?, ?)');
    vol.run(full, '1', 'Vorhanden', 7, '2024-01-01', '9783551745811', null);
    vol.run(full, '2', 'Vorhanden', null, null, '9783551745812', null);
    vol.run(bare, '1', 'Vorbestellt', null, null, null, '2020-01-01');
    vol.run(bare, '2', 'Vorbestellt', null, null, null, '2099-01-01');
    vol.run(bare, '3', 'Gelesen', 5, '2024-01-01', '9783551745811', null);

    const c = await checksOf(visitor);
    assert.equal(c.duplicate_titles.count, 1);
    assert.deepEqual(c.duplicate_titles.items[0].series.map(s => s.publisher), ['Kleiner Verlag', 'Carlsen Verlag GmbH']);
    assert.deepEqual(c.series_without_cover.items.map(s => s.id), [bare]);
    assert.equal(c.series_without_mp_link.count, 1);
    assert.equal(c.series_without_author.count, 1);
    assert.equal(c.series_without_total.count, 1);
    assert.deepEqual(c.volumes_without_price.items.map(v => v.volume_number), ['2']);
    assert.equal(c.volumes_without_purchase_date.count, 1);
    assert.equal(c.volumes_without_isbn.count, 0);
    assert.deepEqual(c.invalid_isbns.items.map(v => v.isbn), ['9783551745812']);
    assert.deepEqual(c.overdue_preorders.items.map(v => [v.title, v.volume_number]), [['Kahl', '1']]);
    assert.equal(c.legacy_read_status.count, 1);
    assert.equal(c.legacy_read_status.fix, 'legacy_read');
    assert.deepEqual(c.publishers_outdated.items.map(p => [p.name, p.canonical]), [['Carlsen Verlag GmbH', 'Carlsen Manga']]);
    assert.deepEqual(c.publishers_unknown.items.map(p => p.name), ['Kleiner Verlag']);

    assert.equal((await admin('DELETE', `/mangas/${bare}`)).status, 200);
    const after = await checksOf();
    assert.equal(after.duplicate_titles.count, 0);
    assert.equal(after.overdue_preorders.count, 0);
    assert.equal(after.publishers_unknown.count, 0);
});

test('fixes: visitors may not run them; normalize_publishers and legacy_read change the rows', async () => {
    const m = Number(db.prepare("INSERT INTO mangas (title, publisher) VALUES ('Korrektur', 'Egmont Manga & Anime')").run().lastInsertRowid);
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, '1', 'Gelesen')").run(m);
    assert.equal((await visitor('POST', '/maintenance/fix', { check: 'normalize_publishers' })).status, 403);
    assert.equal((await admin('POST', '/maintenance/fix', { check: 'toString' })).status, 400);

    const pubs = await admin('POST', '/maintenance/fix', { check: 'normalize_publishers' });
    assert.equal(pubs.status, 200);
    assert.ok(pubs.body.changed >= 2);
    assert.equal(db.prepare('SELECT publisher FROM mangas WHERE id = ?').get(m).publisher, 'Egmont Manga');

    const legacy = await admin('POST', '/maintenance/fix', { check: 'legacy_read' });
    assert.equal(legacy.body.changed, 1);
    assert.equal(db.prepare('SELECT status FROM volumes WHERE manga_id = ?').get(m).status, 'Vorhanden');
    assert.equal((await checksOf()).legacy_read_status.count, 0);
});
