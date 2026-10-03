const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let editor;
let visitor;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    editor = ctx.client();
    visitor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'vis', password: 'password123', role: 'visitor' })).status, 200);
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
    assert.equal((await visitor('POST', '/auth/login', { username: 'vis', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

const detail = async (client, id) => (await client('GET', `/mangas/${id}`)).body;

test('owners: Band mit Status Vorhanden gehört dem Anleger, Fehlt hat keine Besitzer', async () => {
    const id = (await editor('POST', '/mangas', { title: 'Owners A' })).body.id;
    assert.equal((await editor('POST', '/volumes', { manga_id: id, volume_number: '1' })).status, 200);
    assert.equal((await editor('POST', '/volumes', { manga_id: id, volume_number: '2', status: 'Fehlt' })).status, 200);
    const m = await detail(editor, id);
    const [v1, v2] = m.volumes;
    assert.deepEqual(v1.owners.map(o => o.username), ['ed']);
    assert.equal(v1.owned_by_me, true);
    assert.equal(v2.owners.length, 0);
    assert.equal(v2.owned_by_me, false);
});

test('owners: zweiter Besitzer, Entfernen des letzten setzt auf Fehlt', async () => {
    const id = (await editor('POST', '/mangas', { title: 'Owners B' })).body.id;
    await editor('POST', '/volumes', { manga_id: id, volume_number: '1' });
    const vol = (await detail(editor, id)).volumes[0];

    const adm = await admin('POST', `/volumes/${vol.id}/owners`, { owned: true });
    assert.equal(adm.status, 200);
    assert.deepEqual(adm.body.owners.map(o => o.username).sort(), ['admin', 'ed']);
    assert.equal(adm.body.status, 'Vorhanden');

    // ed gibt seinen Besitz auf: admin bleibt Besitzer, Band bleibt Vorhanden
    let res = await editor('POST', `/volumes/${vol.id}/owners`, { owned: false });
    assert.equal(res.body.status, 'Vorhanden');
    assert.equal(res.body.owned_by_me, false);

    // admin gibt auf: niemand besitzt ihn mehr
    res = await admin('POST', `/volumes/${vol.id}/owners`, { owned: false });
    assert.equal(res.body.status, 'Fehlt');
    assert.equal((await detail(editor, id)).owned_volumes, 0);

    // wieder besitzen setzt auf Vorhanden
    res = await editor('POST', `/volumes/${vol.id}/owners`, {});
    assert.equal(res.body.status, 'Vorhanden');
    assert.equal((await detail(editor, id)).owned_volumes, 1);
});

test('owners: Berechtigungen (Besucher 403, Editor nur für sich, Admin für andere)', async () => {
    const id = (await editor('POST', '/mangas', { title: 'Owners C' })).body.id;
    await editor('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt' });
    const vol = (await detail(editor, id)).volumes[0];
    assert.equal((await visitor('POST', `/volumes/${vol.id}/owners`, { owned: true })).status, 403);

    const users = (await admin('GET', '/users')).body;
    const adminId = users.find(u => u.username === 'admin').id;
    // user_id wird für Editoren ignoriert: der Besitz landet beim Editor selbst
    const res = await editor('POST', `/volumes/${vol.id}/owners`, { owned: true, user_id: adminId });
    assert.deepEqual(res.body.owners.map(o => o.username), ['ed']);
    // Admin darf für andere eintragen
    const visId = users.find(u => u.username === 'vis').id;
    const res2 = await admin('POST', `/volumes/${vol.id}/owners`, { owned: true, user_id: visId });
    assert.deepEqual(res2.body.owners.map(o => o.username).sort(), ['ed', 'vis']);
    assert.equal((await editor('POST', '/volumes/99999/owners', {})).status, 404);
});

test('owners: Status per PUT auf Fehlt entfernt alle Besitzer, zurück auf Vorhanden macht den Bearbeiter zum Besitzer', async () => {
    const id = (await editor('POST', '/mangas', { title: 'Owners D' })).body.id;
    await editor('POST', '/volumes', { manga_id: id, volume_number: '1' });
    const vol = (await detail(editor, id)).volumes[0];
    await admin('POST', `/volumes/${vol.id}/owners`, { owned: true });
    await editor('PUT', `/volumes/${vol.id}`, { status: 'Fehlt' });
    assert.equal((await detail(editor, id)).volumes[0].owners.length, 0);
    await admin('PUT', `/volumes/${vol.id}`, { status: 'Vorhanden' });
    assert.deepEqual((await detail(editor, id)).volumes[0].owners.map(o => o.username), ['admin']);
});

test('owners: Einkaufsliste zeigt mit include_others Bände, die nur andere besitzen', async () => {
    const id = (await editor('POST', '/mangas', { title: 'Owners E' })).body.id;
    await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 3 });
    const vols = (await detail(editor, id)).volumes;
    // admin gibt Band 1 ab, besitzt aber Band 2 zusätzlich -> sammelt die Reihe; Band 3 gehört nur ed
    await admin('POST', `/volumes/${vols[1].id}/owners`, { owned: true });

    const plain = (await admin('GET', '/shopping-list')).body;
    assert.equal(plain.others, undefined);

    const withOthers = (await admin('GET', '/shopping-list?include_others=1')).body;
    const mine = withOthers.others.filter(o => o.manga_id === id).map(o => o.volume_number).sort();
    assert.deepEqual(mine, ['1', '3']);
    assert.equal(withOthers.others[0].owned_by_others, 'ed');

    // Reihen, die der Aufrufer nicht sammelt, erscheinen nicht
    const other = (await visitor('GET', '/shopping-list?include_others=1')).body;
    assert.equal(other.others.filter(o => o.manga_id === id).length, 0);
});

test('owners: Löschen eines Benutzers übergibt seine Einzelbesitze an den Admin', async () => {
    assert.equal((await admin('POST', '/users', { username: 'tmp', password: 'password123', role: 'editor' })).status, 200);
    const tmp = ctx.client();
    await tmp('POST', '/auth/login', { username: 'tmp', password: 'password123' });
    const id = (await tmp('POST', '/mangas', { title: 'Owners F' })).body.id;
    await tmp('POST', '/volumes', { manga_id: id, volume_number: '1' });
    const tmpId = (await admin('GET', '/users')).body.find(u => u.username === 'tmp').id;
    assert.equal((await admin('DELETE', `/users/${tmpId}`)).status, 200);
    const v = (await detail(admin, id)).volumes[0];
    assert.deepEqual(v.owners.map(o => o.username), ['admin']);
    assert.equal(v.status, 'Vorhanden');
});

test('owners: CSV-Export enthält Besitzer, Import ordnet sie zu', async () => {
    const id = (await editor('POST', '/mangas', { title: 'Owners CSV' })).body.id;
    await editor('POST', '/volumes', { manga_id: id, volume_number: '1' });
    const vol = (await detail(editor, id)).volumes[0];
    await admin('POST', `/volumes/${vol.id}/owners`, { owned: true });

    const csvRes = await fetch(`${ctx.base}/export/csv`, { headers: { Cookie: admin.cookie } });
    const csv = await csvRes.text();
    const header = csv.split('\r\n')[0];
    assert.ok(header.endsWith(';Besitzer'));
    const line = csv.split('\r\n').find(l => l.startsWith('Owners CSV;'));
    assert.match(line, /(admin, ed|ed, admin)$/);

    const imp = await editor('POST', '/import/csv', {
        csv: 'Reihe;Bandnummer;Status;Besitzer\r\nImport Owners;1;Vorhanden;"admin, ed, niemand"\r\nImport Owners;2;Vorhanden;\r\nImport Owners;3;Fehlt;admin\r\n'
    });
    assert.equal(imp.status, 200);
    const list = (await editor('GET', '/mangas')).body;
    const mid = list.find(m => m.title === 'Import Owners').id;
    const vols = (await detail(editor, mid)).volumes;
    assert.deepEqual(vols[0].owners.map(o => o.username).sort(), ['admin', 'ed']);
    assert.deepEqual(vols[1].owners.map(o => o.username), ['ed']);
    assert.equal(vols[2].owners.length, 0);
});

test('owners: Statistik liefert Bände und Wert pro Besitzer', async () => {
    const id = (await editor('POST', '/mangas', { title: 'Owners Stats' })).body.id;
    await editor('POST', '/volumes', { manga_id: id, volume_number: '1', price: 8 });
    const vol = (await detail(editor, id)).volumes[0];
    await admin('POST', `/volumes/${vol.id}/owners`, { owned: true, price: 5 });
    const stats = (await admin('GET', '/stats')).body;
    const mine = stats.owner_stats.find(o => o.username === 'admin');
    const ed = stats.owner_stats.find(o => o.username === 'ed');
    assert.ok(mine.volume_count >= 1 && ed.volume_count >= 1);
    assert.ok(mine.shared_count >= 1);
    assert.ok(stats.owner_stats.every(o => typeof o.total_value === 'number'));
});
