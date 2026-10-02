const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIsbn } = require('../utils/isbn');
const { startTestServer } = require('./helpers');

test('normalizeIsbn: hyphens, spaces and ISBN-10 all become the same ISBN-13', () => {
    assert.equal(normalizeIsbn('978-3-551-74581-1'), '9783551745811');
    assert.equal(normalizeIsbn(' 9783551745811 '), '9783551745811');
    assert.equal(normalizeIsbn('978 3 551 74581 1'), '9783551745811');
    assert.equal(normalizeIsbn('3-551-74581-1'), '9783551745811');          // ISBN-10 -> 13
    assert.equal(normalizeIsbn('3551745811'), '9783551745811');
    assert.equal(normalizeIsbn('0-306-40615-2'), '9780306406157');          // ISBN-10 with check digit 2
    assert.equal(normalizeIsbn('080442957x'), '9780804429573');             // lowercase X check digit
});

test('normalizeIsbn: empty input is null, odd input is kept without separators', () => {
    assert.equal(normalizeIsbn(null), null);
    assert.equal(normalizeIsbn(undefined), null);
    assert.equal(normalizeIsbn('   '), null);
    assert.equal(normalizeIsbn('12-34'), '1234');
    assert.equal(normalizeIsbn('abc'), 'ABC');
});

let ctx;
let admin;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

test('volumes store the canonical ISBN no matter how it was typed', async () => {
    const mangaId = (await admin('POST', '/mangas', { title: 'ISBN Reihe' })).body.id;
    const created = await admin('POST', '/volumes', { manga_id: mangaId, volume_number: '1', isbn: '978-3-551-74581-1' });
    assert.equal(created.status, 200);
    const read = async () => (await admin('GET', `/mangas/${mangaId}`)).body.volumes[0];
    assert.equal((await read()).isbn, '9783551745811');

    assert.equal((await admin('PUT', `/volumes/${(await read()).id}`, { isbn: '3-551-74582-X' })).status, 200);
    assert.equal((await read()).isbn, '9783551745828');

    assert.equal((await admin('PUT', `/volumes/${(await read()).id}`, { isbn: '' })).status, 200);
    assert.equal((await read()).isbn, null);
});

test('migration v5 rewrites existing hyphenated and ISBN-10 values', () => {
    const { db, initDb } = require('../db');
    const mangaId = Number(db.prepare("INSERT INTO mangas (title) VALUES ('Alt ISBN')").run().lastInsertRowid);
    const add = (n, isbn) => db.prepare('INSERT INTO volumes (manga_id, volume_number, isbn) VALUES (?, ?, ?)').run(mangaId, n, isbn);
    add('1', '978-3-551-74581-1');
    add('2', '9783-7704-2847-2');   // odd grouping as delivered by Manga Passion
    add('3', '3551745811');
    add('4', '9783899213225');       // already canonical
    db.prepare('DELETE FROM schema_migrations WHERE version = 5').run();
    initDb();
    const isbns = db.prepare('SELECT isbn FROM volumes WHERE manga_id = ? ORDER BY CAST(volume_number AS INTEGER)').all(mangaId).map(r => r.isbn);
    assert.deepEqual(isbns, ['9783551745811', '9783770428472', '9783551745811', '9783899213225']);
});
