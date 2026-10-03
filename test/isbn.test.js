const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIsbn, isbn13CheckDigit } = require('../utils/isbn');
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

test('ISBN lookup: invalid input is rejected before any catalogue is asked', async () => {
    assert.equal((await admin('GET', '/lookup/isbn')).status, 400);
    assert.equal((await admin('GET', '/lookup/isbn?isbn=123')).status, 400);
    const badCheckDigit = await admin('GET', '/lookup/isbn?isbn=9783551745812');
    assert.equal(badCheckDigit.status, 400);
    assert.match(badCheckDigit.body.error, /Prüfziffer/);
    assert.equal((await admin('GET', '/lookup/isbn?isbn=4901234567894')).status, 400);
    // a repeated parameter is read as one string (no 500)
    assert.equal((await admin('GET', '/lookup/isbn?isbn=1234&isbn=5678')).status, 400);
});

test('ISBN lookup: an ISBN stored on a volume is recognised from the collection alone (no catalogue, works offline)', async () => {
    const mangaId = (await admin('POST', '/mangas', { title: 'Bekannte Reihe' })).body.id;
    const unique = '978408820053' + isbn13CheckDigit('978408820053'); // an ISBN no other test uses
    const hyphenated = `${unique.slice(0, 3)}-${unique.slice(3, 4)}-${unique.slice(4, 6)}-${unique.slice(6, 12)}-${unique.slice(12)}`;
    await admin('POST', '/volumes', { manga_id: mangaId, volume_number: '7', status: 'Vorhanden', isbn: hyphenated });
    // other spellings of the same ISBN find it, too
    for (const isbn of [unique, hyphenated]) {
        const res = await admin('GET', '/lookup/isbn?isbn=' + encodeURIComponent(isbn));
        assert.equal(res.status, 200, isbn);
        assert.equal(res.body.found, true);
        assert.equal(res.body.match_reason, 'isbn');
        assert.equal(res.body.matched_manga.id, mangaId);
        assert.equal(res.body.matched_volume.volume_number, '7');
        assert.equal(res.body.matched_volume.status, 'Vorhanden');
        assert.equal(res.body.book.title, 'Bekannte Reihe');
    }
});
