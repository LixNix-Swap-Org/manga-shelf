// "Weiteres Exemplar" (migration 56): a person may own several copies of a volume; volume_owners still lists people.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let editor;
const ids = {};

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    editor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    ids.admin = (await admin('GET', '/auth/me')).body.user?.id ?? 1;
    ids.ed = (await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).body.user.id;
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

const volumeOf = async (client, mangaId, number = '1') =>
    (await client('GET', `/mangas/${mangaId}`)).body.volumes.find((v) => v.volume_number === number);

async function ownedVolume(title) {
    const { id } = (await editor('POST', '/mangas', { title })).body;
    assert.equal((await editor('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt', price: 7 })).status, 200);
    const vol = await volumeOf(editor, id);
    assert.equal((await editor('POST', `/volumes/${vol.id}/owners`, { owned: true })).status, 200);
    return { mangaId: id, volumeId: vol.id };
}

test('a second copy of the same person: listed as a copy, the person counted once', async () => {
    const { mangaId, volumeId } = await ownedVolume('Doppelt');
    const added = await editor('POST', `/volumes/${volumeId}/copies`, { condition: 'Gut', price: 9.5 });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.copies.length, 2);
    assert.deepEqual(added.body.copies.map((c) => c.owner_user_id), [ids.ed, ids.ed]);
    assert.equal(added.body.copy.price, 9.5);

    const vol = await volumeOf(editor, mangaId);
    assert.equal(vol.copies.length, 2);
    assert.deepEqual(vol.owners.map((o) => o.user_id), [ids.ed], 'the owner chips show people');
    const detail = (await editor('GET', `/mangas/${mangaId}`)).body;
    assert.equal(detail.reader_stats.find((r) => r.user_id === ids.ed).own_owned, 1);

    // the second copy can be lent out on its own
    const second = added.body.copy.id;
    const lent = await editor('PUT', `/volumes/${volumeId}/copies/${second}`, { lent: { name: 'Mia' } });
    assert.equal(lent.status, 200);
    assert.deepEqual(lent.body.copies.map((c) => c.lent_to), [null, 'Mia']);
});

test('the first copy needs ownership, a stranger cannot add one, and there is a limit', async () => {
    const { id } = (await editor('POST', '/mangas', { title: 'Noch nicht' })).body;
    await editor('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt' });
    const vol = await volumeOf(editor, id);
    const refused = await editor('POST', `/volumes/${vol.id}/copies`, {});
    assert.deepEqual([refused.status, refused.body.code], [409, 'COPY_NOT_OWNED']);

    const { volumeId } = await ownedVolume('Viele Exemplare');
    for (let i = 2; i <= 5; i++) assert.equal((await editor('POST', `/volumes/${volumeId}/copies`, {})).status, 200, String(i));
    const sixth = await editor('POST', `/volumes/${volumeId}/copies`, {});
    assert.deepEqual([sixth.status, sixth.body.code], [409, 'COPY_LIMIT']);
});

test('removing one copy keeps the others; the last one goes through ownership', async () => {
    const { mangaId, volumeId } = await ownedVolume('Weg damit');
    const two = (await editor('POST', `/volumes/${volumeId}/copies`, {})).body.copies;
    const removed = await editor('DELETE', `/volumes/${volumeId}/copies/${two[0].id}`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.copies.map((c) => c.id), [two[1].id]);
    const vol = await volumeOf(editor, mangaId);
    assert.deepEqual([vol.status, vol.owners.map((o) => o.user_id)], ['Vorhanden', [ids.ed]]);
    const last = await editor('DELETE', `/volumes/${volumeId}/copies/${two[1].id}`);
    assert.deepEqual([last.status, last.body.code], [409, 'LAST_COPY']);
    // ownership off removes every copy of the person
    assert.equal((await editor('POST', `/volumes/${volumeId}/owners`, { owned: false })).status, 200);
    assert.equal((await volumeOf(editor, mangaId)).copies.length, 0);
});

test('trash and restore bring the second copy back', async () => {
    const { mangaId, volumeId } = await ownedVolume('Papierkorb');
    await editor('POST', `/volumes/${volumeId}/copies`, { condition: 'Neu' });
    assert.equal((await editor('DELETE', `/volumes/${volumeId}`)).status, 200);
    const trash = (await admin('GET', '/trash')).body;
    const entry = (trash.items || trash.entries || trash).find((e) => e.kind === 'volume' && e.ref_id === volumeId);
    assert.ok(entry, 'the volume is in the trash');
    assert.equal((await admin('POST', `/trash/${entry.id}/restore`)).status, 200);
    const vol = await volumeOf(editor, mangaId);
    assert.equal(vol.copies.length, 2);
    assert.deepEqual(vol.copies.map((c) => c.condition).slice(1), ['Neu']);
});

test('a bulk status change and its undo keep the second copy', async () => {
    const { mangaId, volumeId } = await ownedVolume('Rückgängig');
    await editor('POST', `/volumes/${volumeId}/copies`, {});
    const bulk = await editor('POST', '/volumes/bulk', { ids: [volumeId], set: { status: 'Fehlt' } });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    assert.equal((await volumeOf(editor, mangaId)).copies.length, 0);
    const undo = await editor('POST', '/volumes/bulk', { revert: bulk.body.undo_token });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    const vol = await volumeOf(editor, mangaId);
    assert.deepEqual([vol.status, vol.copies.length], ['Vorhanden', 2]);
});

test('undo of "Besitze ich" off brings every copy of the person back', async () => {
    const { mangaId, volumeId } = await ownedVolume('Alle zurück');
    const added = (await editor('POST', `/volumes/${volumeId}/copies`, { condition: 'Neu', price: 12 })).body;
    await editor('PUT', `/volumes/${volumeId}/copies/${added.copy.id}`, { lent: { name: 'Mia', at: '2026-10-01' } });
    const off = await editor('POST', `/volumes/${volumeId}/owners`, { owned: false });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body.removed_extra_copies.map((c) => [c.price, c.condition, c.lent_to_name]), [[12, 'Neu', 'Mia']]);
    const undo = await editor('POST', `/volumes/${volumeId}/owners`, {
        owned: true, price: off.body.removed_owner.price, extra_copies: off.body.removed_extra_copies
    });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    const vol = await volumeOf(editor, mangaId);
    assert.deepEqual(vol.copies.map((c) => [c.owner_user_id, c.condition, c.lent_to]), [[ids.ed, null, null], [ids.ed, 'Neu', 'Mia']]);
    const bad = await editor('POST', `/volumes/${volumeId}/owners`, { owned: false, extra_copies: 'x' });
    assert.equal(bad.status, 400);
});

test('a second copy counts toward the person\'s value in the statistics, not their volume count', async () => {
    const mine = async () => (await editor('GET', '/stats')).body.owner_stats.find((o) => o.user_id === ids.ed);
    const { volumeId } = await ownedVolume('Statistik-Doppel');
    const before = await mine();
    assert.equal((await editor('POST', `/volumes/${volumeId}/copies`, {})).status, 200);
    const after = await mine();
    assert.equal(after.volume_count, before.volume_count);
    assert.equal(after.extra_copies, before.extra_copies + 1);
    assert.equal(after.total_value, before.total_value + 7, 'the extra copy counts with the list price');
});
