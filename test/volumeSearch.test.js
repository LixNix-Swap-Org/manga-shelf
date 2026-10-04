const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let editor;

test.before(async () => {
    ctx = await startTestServer();
    const admin = ctx.client();
    editor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

const isbn13 = (first12) => {
    const sum = [...first12].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
    return first12 + ((10 - (sum % 10)) % 10);
};

const addVolume = async (body) => {
    const res = await editor('POST', '/volumes', body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
};

test('volume_search: ISBNs, then named volumes, then notes, so the 4000 cap only ever cuts notes', async () => {
    const created = await editor('POST', '/mangas', { title: 'Lange Reihe' });
    const id = created.body.id;
    for (let n = 1; n <= 25; n++) {
        await addVolume({ manga_id: id, volume_number: String(n), notes: `Notiz ${n} ${'x'.repeat(300)}` });
    }
    await addVolume({ manga_id: id, volume_number: 'Artbook', type: 'special' });
    await addVolume({ manga_id: id, volume_number: 'Schuber 1', type: 'schuber' });
    const isbns = [isbn13('978355174001'), isbn13('978355174002')];
    for (const [i, isbn] of isbns.entries()) await addVolume({ manga_id: id, volume_number: String(26 + i), isbn });

    const row = (await editor('GET', '/mangas')).body.find(m => m.id === id);
    const search = row.volume_search;
    assert.equal(search.length, 4000);
    const lines = search.split('\n');
    assert.deepEqual(lines.slice(0, 4), [...isbns, 'Artbook', 'Schuber 1']);
    assert.ok(lines[4].startsWith('Notiz 1 '));
    assert.ok(lines.slice(4, -1).every(line => line.length === 200), 'every complete note is cut to 200 characters');
    assert.ok(lines.at(-1).startsWith('Notiz '), 'only a note is cut at the end');

    const snapshot = (await editor('GET', '/offline-snapshot')).body;
    assert.equal(snapshot.mangas.find(m => m.id === id).volume_search, search, 'the offline copy searches the same text');
});

test('volume_search: short series keep every entry in the same order', async () => {
    const id = (await editor('POST', '/mangas', { title: 'Kurze Reihe' })).body.id;
    await addVolume({ manga_id: id, volume_number: '1', notes: 'Signiert' });
    await addVolume({ manga_id: id, volume_number: 'Special 2', type: 'special' });
    const isbn = isbn13('978355174003');
    await addVolume({ manga_id: id, volume_number: '2', isbn, notes: 'Erstauflage' });
    const row = (await editor('GET', '/mangas')).body.find(m => m.id === id);
    assert.deepEqual(row.volume_search.split('\n'), [isbn, 'Special 2', 'Signiert', 'Erstauflage']);
});
