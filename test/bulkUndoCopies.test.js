// Undo of a bulk status change (POST /volumes/bulk { revert }): the household's copy comes back with its own price,
// date, condition and lending, not as a fresh stand-in with the volume's values.
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

const copiesOf = (volumeId) => db.prepare(`SELECT id, owner_user_id, purchase_price, purchase_date, condition, lent_to_user_id, lent_to_name, lent_at
    FROM volume_copies WHERE volume_id = ? ORDER BY id`).all(volumeId);

async function ownedVolume(title) {
    const series = (await admin('POST', '/mangas', { title })).body.id;
    const res = await admin('POST', '/volumes', { manga_id: series, volume_number: '1', status: 'Vorhanden', price: 7 });
    assert.equal(res.status, 200);
    return db.prepare('SELECT id FROM volumes WHERE manga_id = ?').get(series).id;
}

test('bulk "Fehlt" and undo: the household copy keeps its price, date, condition and lending', async () => {
    const id = await ownedVolume('Haushaltsreihe');
    db.prepare(`UPDATE volume_copies SET owner_user_id = NULL, purchase_price = 9.5, purchase_date = '2026-03-01', condition = 'Gut',
        lent_to_name = 'Tom', lent_at = '2026-11-01' WHERE volume_id = ?`).run(id);
    const before = copiesOf(id);
    assert.equal(before.length, 1);

    const res = await admin('POST', '/volumes/bulk', { ids: [id], set: { status: 'Fehlt' } });
    assert.equal(res.status, 200);
    assert.deepEqual(copiesOf(id), [], 'leaving "Vorhanden" removes the copies');

    const undo = await admin('POST', '/volumes/bulk', { revert: res.body.undo_token });
    assert.equal(undo.status, 200);
    assert.deepEqual(copiesOf(id), before, 'the same copy, with the same id, comes back');
    assert.equal(db.prepare('SELECT status FROM volumes WHERE id = ?').get(id).status, 'Vorhanden');
});

test('bulk "Vorhanden" on a missing volume and undo: no household copy is left behind', async () => {
    const series = (await admin('POST', '/mangas', { title: 'Fehlreihe' })).body.id;
    assert.equal((await admin('POST', '/volumes', { manga_id: series, volume_number: '1', status: 'Fehlt' })).status, 200);
    const id = db.prepare('SELECT id FROM volumes WHERE manga_id = ?').get(series).id;
    const res = await admin('POST', '/volumes/bulk', { ids: [id], set: { status: 'Vorhanden' } });
    assert.equal(res.status, 200);
    assert.equal(copiesOf(id).length, 1);
    assert.equal((await admin('POST', '/volumes/bulk', { revert: res.body.undo_token })).status, 200);
    assert.deepEqual(copiesOf(id), []);
    assert.equal(db.prepare('SELECT status FROM volumes WHERE id = ?').get(id).status, 'Fehlt');
});

test('undo of a field edit puts the household copy back even when somebody claimed it meanwhile', async () => {
    const id = await ownedVolume('Wechselreihe');
    db.prepare("UPDATE volume_copies SET owner_user_id = NULL, condition = 'Gut' WHERE volume_id = ?").run(id);
    const before = copiesOf(id);
    const res = await admin('POST', '/volumes/bulk', { ids: [id], set: { price: 12 } });
    assert.equal(res.status, 200);
    assert.equal((await admin('POST', `/volumes/${id}/owners`, { owned: true })).status, 200);
    assert.ok(copiesOf(id).every((c) => c.owner_user_id !== null), 'the claim replaced the household copy');
    // the undo restores the owners as they were at the bulk edit: nobody personally, the household copy as it was
    assert.equal((await admin('POST', '/volumes/bulk', { revert: res.body.undo_token })).status, 200);
    assert.deepEqual(copiesOf(id).map(({ id: _id, ...c }) => c), before.map(({ id: _id, ...c }) => c));
    assert.equal(db.prepare('SELECT price FROM volumes WHERE id = ?').get(id).price, 7);
});
