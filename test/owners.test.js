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
    // Editoren ändern nur den eigenen Besitz: eine fremde user_id ist 403
    assert.equal((await editor('POST', `/volumes/${vol.id}/owners`, { owned: true, user_id: adminId })).status, 403);
    const res = await editor('POST', `/volumes/${vol.id}/owners`, { owned: true });
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
    // Editoren dürfen per CSV nur sich selbst als Besitzer eintragen; fremde Namen werden ignoriert
    assert.deepEqual(vols[0].owners.map(o => o.username).sort(), ['ed']);
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

const seedVolume = (mangaId, number, status) => {
    const { db } = require('../db');
    return Number(db.prepare('INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, ?, ?)').run(mangaId, number, status).lastInsertRowid);
};

test('owners: Altstatus Gelesen wird beim Speichern zu Vorhanden mit Besitzer und Lese-Eintrag', async () => {
    const id = (await editor('POST', '/mangas', { title: 'Owners Gelesen Alt' })).body.id;
    const volId = seedVolume(id, '1', 'Gelesen');
    assert.equal((await editor('PUT', `/volumes/${volId}`, { notes: 'egal' })).status, 200);
    const m = await detail(editor, id);
    assert.equal(m.volumes[0].status, 'Vorhanden');
    assert.deepEqual(m.volumes[0].owners.map(o => o.username), ['ed']);
    assert.equal(m.volumes[0].is_read, true);
    assert.equal(m.owned_volumes, 1);
});

test('owners: Status Gelesen per PUT löscht keine Besitzer', async () => {
    const id = (await editor('POST', '/mangas', { title: 'Owners Gelesen PUT' })).body.id;
    await editor('POST', '/volumes', { manga_id: id, volume_number: '1', price: 7 });
    const vol = (await detail(editor, id)).volumes[0];
    await admin('POST', `/volumes/${vol.id}/owners`, { owned: true });
    const res = await editor('PUT', `/volumes/${vol.id}`, { status: 'Gelesen' });
    assert.ok(res.status === 200 || res.status === 400, `unexpected status ${res.status}`);
    const m = await detail(editor, id);
    assert.equal(m.volumes[0].status, 'Vorhanden');
    assert.deepEqual(m.volumes[0].owners.map(o => o.username).sort(), ['admin', 'ed']);
    assert.equal(m.owned_volumes, 1);
});

test('owners: migrateLegacyReadStatus stellt Altdaten um und zählt neu', async () => {
    const { db } = require('../db');
    const { migrateLegacyReadStatus, syncStatusWithOwners, normalizeVolumeStatus } = require('../utils/owners');
    const id = (await editor('POST', '/mangas', { title: 'Owners Gelesen Migration' })).body.id;
    const orphan = seedVolume(id, '1', 'Gelesen');
    const owned = seedVolume(id, '2', 'Gelesen');
    const missing = seedVolume(id, '3', 'Fehlt');
    const edId = (await admin('GET', '/users')).body.find(u => u.username === 'ed').id;
    db.prepare('INSERT INTO volume_owners (volume_id, user_id) VALUES (?, ?)').run(owned, edId);

    assert.equal(migrateLegacyReadStatus(db), 2);
    const m = await detail(admin, id);
    const byId = Object.fromEntries(m.volumes.map(v => [v.id, v]));
    assert.equal(byId[orphan].status, 'Vorhanden');
    assert.deepEqual(byId[orphan].owners.map(o => o.username), ['admin']);
    assert.equal(byId[orphan].is_read, true);
    assert.deepEqual(byId[owned].owners.map(o => o.username), ['ed']);
    assert.deepEqual(byId[owned].read_by, [edId]);
    assert.equal(byId[missing].status, 'Fehlt');
    assert.equal(m.owned_volumes, 2);
    assert.equal(migrateLegacyReadStatus(db), 0);

    const ownerless = seedVolume(id, '4', 'Gelesen');
    const adminId = (await admin('GET', '/users')).body.find(u => u.username === 'admin').id;
    assert.equal(syncStatusWithOwners(db, ownerless), 'Vorhanden');
    assert.deepEqual(db.prepare('SELECT user_id FROM volume_owners WHERE volume_id = ?').all(ownerless).map(r => r.user_id), [adminId]);
    assert.deepEqual(db.prepare('SELECT user_id FROM volume_reads WHERE volume_id = ?').all(ownerless).map(r => r.user_id), [adminId]);
    assert.equal(normalizeVolumeStatus(' gelesen '), 'Vorhanden');
    assert.equal(normalizeVolumeStatus('Bestellt'), 'Bestellt');
});

test('owners: Besitz-Umschalten auf einem Altstatus-Gelesen-Band stellt erst um, dann gilt die Änderung', async () => {
    const { db } = require('../db');
    const id = (await editor('POST', '/mangas', { title: 'Owners Gelesen Toggle' })).body.id;
    const edId = (await admin('GET', '/users')).body.find(u => u.username === 'ed').id;
    const claimed = seedVolume(id, '1', 'Gelesen');
    const released = seedVolume(id, '2', 'Gelesen');
    const shared = seedVolume(id, '3', 'Gelesen');
    db.prepare('INSERT INTO volume_owners (volume_id, user_id) VALUES (?, ?)').run(shared, edId);
    const reads = (volId) => db.prepare('SELECT user_id FROM volume_reads WHERE volume_id = ? ORDER BY user_id').all(volId).map(r => r.user_id);

    let res = await editor('POST', `/volumes/${claimed}/owners`, { owned: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'Vorhanden');
    assert.deepEqual(res.body.owners.map(o => o.username), ['ed']);
    assert.deepEqual(reads(claimed), [edId]);

    // ownerless: the remover is the fallback owner of the conversion, keeps the read entry, and nobody owns it then
    res = await editor('POST', `/volumes/${released}/owners`, { owned: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'Fehlt');
    assert.deepEqual(res.body.owners, []);
    assert.deepEqual(reads(released), [edId]);

    res = await admin('POST', `/volumes/${shared}/owners`, { owned: true });
    assert.equal(res.body.status, 'Vorhanden');
    assert.deepEqual(res.body.owners.map(o => o.username).sort(), ['admin', 'ed']);
    assert.deepEqual(reads(shared), [edId]);

    const m = await detail(admin, id);
    assert.deepEqual(m.volumes.map(v => v.status), ['Vorhanden', 'Fehlt', 'Vorhanden']);
    assert.equal(m.owned_volumes, 2);
});

test('owners: der einzige Besitzer eines Altstatus-Gelesen-Bands gibt ihn ab, behält den Lese-Eintrag', async () => {
    const { db } = require('../db');
    const id = (await editor('POST', '/mangas', { title: 'Owners Gelesen Remove' })).body.id;
    const edId = (await admin('GET', '/users')).body.find(u => u.username === 'ed').id;
    const vol = seedVolume(id, '1', 'Gelesen');
    db.prepare('INSERT INTO volume_owners (volume_id, user_id) VALUES (?, ?)').run(vol, edId);

    const res = await editor('POST', `/volumes/${vol}/owners`, { owned: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'Fehlt');
    assert.deepEqual(res.body.owners, []);
    assert.deepEqual(db.prepare('SELECT user_id FROM volume_reads WHERE volume_id = ?').all(vol).map(r => r.user_id), [edId]);
});

test('owners: Kauf mit Datum auf einem herrenlosen Altstatus-Gelesen-Band speichert das Datum des Käufers', async () => {
    const { db } = require('../db');
    const id = (await editor('POST', '/mangas', { title: 'Owners Gelesen Buy' })).body.id;
    const vol = seedVolume(id, '1', 'Gelesen');
    const res = await editor('POST', `/volumes/${vol}/owners`, { owned: true, purchase_date: '2026-10-01', price: 7.5 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.owners.map(o => [o.username, o.purchase_date, o.price]), [['ed', '2026-10-01', 7.5]]);
    assert.equal(db.prepare('SELECT status FROM volumes WHERE id = ?').get(vol).status, 'Vorhanden');
});

test('owners: zwei Käufe desselben Bands (Schnellkauf und nachgereichter Offline-Kauf) behalten beide Daten', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Owners Race' })).body.id;
    await admin('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt' });
    const vol = (await detail(admin, id)).volumes[0];

    let res = await admin('POST', `/volumes/${vol.id}/owners`, { owned: true, purchase_date: '2026-10-01' });
    assert.equal(res.status, 200);
    res = await editor('POST', `/volumes/${vol.id}/owners`, { owned: true, purchase_date: '2026-10-02' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'Vorhanden');
    const dates = Object.fromEntries(res.body.owners.map(o => [o.username, o.purchase_date]));
    assert.deepEqual(dates, { admin: '2026-10-01', ed: '2026-10-02' });

    // replayed again (the first answer was lost): nothing changes
    res = await editor('POST', `/volumes/${vol.id}/owners`, { owned: true, purchase_date: '2026-10-03' });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.fromEntries(res.body.owners.map(o => [o.username, o.purchase_date])), dates);
    const after = (await detail(admin, id)).volumes[0];
    assert.equal(after.purchase_date, '2026-10-01', 'the first purchase fills the volume date, later ones keep it');
});

test('owners: ein Kauf über die Besitz-Route füllt volumes.purchase_date für Statistik, CSV und Formular', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Owners Kaufdatum' })).body.id;
    const add = async (number, extra = {}) =>
        (await admin('POST', '/volumes', { manga_id: id, volume_number: number, status: 'Fehlt', price: 7.5, ...extra })).body.id;
    const bought = await add('1');
    const dated = await add('2', { purchase_date: '1998-01-01' });
    const yearCount = async () => (await admin('GET', '/stats')).body.spending.by_year.find(y => y.year === 1999)?.volumes || 0;
    const before = await yearCount();

    assert.equal((await admin('POST', `/volumes/${bought}/owners`, { owned: true, purchase_date: '1999-05-06' })).status, 200);
    assert.equal((await admin('POST', `/volumes/${dated}/owners`, { owned: true, purchase_date: '1999-07-08' })).status, 200);
    assert.equal((await editor('POST', `/volumes/${bought}/owners`, { owned: true, purchase_date: '1999-09-09' })).status, 200);

    const byId = Object.fromEntries((await detail(admin, id)).volumes.map(v => [v.id, v]));
    assert.equal(byId[bought].purchase_date, '1999-05-06');
    assert.equal(byId[dated].purchase_date, '1998-01-01', 'an existing volume date is never overwritten');
    assert.deepEqual(byId[dated].owners.map(o => o.purchase_date), ['1999-07-08']);
    assert.equal(await yearCount(), before + 1);

    const csv = await (await fetch(`${ctx.base}/export/csv`, { headers: { Cookie: admin.cookie } })).text();
    const row = csv.split(/\r?\n/).find(line => line.startsWith('Owners Kaufdatum;') && line.includes(';1;Vorhanden;'));
    assert.ok(row && row.includes('1999-05-06'), row);
});

test('owners: Abgeben des letzten Besitzes löscht das Kaufdatum, ein neuer Kauf zählt im neuen Monat', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Owners Rueckgabe' })).body.id;
    const vid = (await admin('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt', price: 10 })).body.id;
    const monthKey = (back) => {
        const d = new Date();
        d.setDate(15);
        d.setMonth(d.getMonth() - back);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };
    const oldMonth = monthKey(3);
    const newMonth = monthKey(0);
    const monthCount = async (month) => (await admin('GET', '/stats')).body.spending.by_month.find(m => m.month === month)?.volumes || 0;
    const volume = async () => (await detail(admin, id)).volumes.find(v => v.id === vid);
    const before = { old: await monthCount(oldMonth), new: await monthCount(newMonth) };

    assert.equal((await admin('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: `${oldMonth}-05` })).status, 200);
    assert.equal((await volume()).purchase_date, `${oldMonth}-05`);
    let res = await admin('POST', `/volumes/${vid}/owners`, { owned: false });
    assert.equal(res.body.status, 'Fehlt');
    assert.equal((await volume()).purchase_date, null);

    // detail toggle without a date: no stale date is copied into the new owner row
    res = await admin('POST', `/volumes/${vid}/owners`, { owned: true });
    assert.deepEqual(res.body.owners.map(o => o.purchase_date), [null]);
    await admin('POST', `/volumes/${vid}/owners`, { owned: false });

    res = await admin('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: `${newMonth}-01` });
    assert.equal(res.body.status, 'Vorhanden');
    assert.deepEqual(res.body.owners.map(o => o.purchase_date), [`${newMonth}-01`]);
    assert.equal((await volume()).purchase_date, `${newMonth}-01`);
    assert.equal(await monthCount(oldMonth), before.old);
    assert.equal(await monthCount(newMonth), before.new + 1);
});

test('owners: ein weiterer Besitzer, der abgibt, lässt das Kaufdatum des Bands stehen', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Owners Teilabgabe' })).body.id;
    const vid = (await admin('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt' })).body.id;
    await admin('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: '2024-04-04' });
    await editor('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: '2024-06-06' });
    const res = await editor('POST', `/volumes/${vid}/owners`, { owned: false });
    assert.equal(res.body.status, 'Vorhanden');
    assert.equal((await detail(admin, id)).volumes[0].purchase_date, '2024-04-04');
});

test('owners: gibt der Erstkäufer ab, gilt das früheste Datum der verbleibenden Besitzer', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Owners Erstkaeufer' })).body.id;
    const vid = (await admin('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt' })).body.id;
    await admin('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: '2024-04-04' });
    await editor('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: '2024-06-06' });
    const res = await admin('POST', `/volumes/${vid}/owners`, { owned: false });
    assert.equal(res.body.status, 'Vorhanden');
    assert.equal(res.body.previous_purchase_date, '2024-04-04');
    assert.equal(res.body.removed_owner.purchase_date, '2024-04-04');
    assert.equal((await detail(admin, id)).volumes[0].purchase_date, '2024-06-06');

    // undo: re-own with the removed row and the earlier volume date
    const undo = await admin('POST', `/volumes/${vid}/owners`, {
        owned: true, purchase_date: res.body.removed_owner.purchase_date, previous_purchase_date: res.body.previous_purchase_date
    });
    assert.equal(undo.status, 200);
    assert.equal((await detail(admin, id)).volumes[0].purchase_date, '2024-04-04');
});

test('owners: Abgeben und Rückgängig behält Kaufdatum und Preis des Besitzers', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Owners Undo' })).body.id;
    const vid = (await admin('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt', price: 8 })).body.id;
    await admin('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: '2025-01-05', price: 6.5 });
    const off = await admin('POST', `/volumes/${vid}/owners`, { owned: false });
    assert.equal(off.body.status, 'Fehlt');
    assert.deepEqual(
        [off.body.removed_owner.purchase_date, off.body.removed_owner.price, off.body.previous_purchase_date],
        ['2025-01-05', 6.5, '2025-01-05']
    );
    const { purchase_date, price } = off.body.removed_owner;
    const on = await admin('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date, price, previous_purchase_date: off.body.previous_purchase_date });
    assert.equal(on.body.status, 'Vorhanden');
    assert.equal(on.body.removed_owner, null);
    assert.deepEqual(on.body.owners.map(o => [o.purchase_date, o.price]), [['2025-01-05', 6.5]]);
    assert.equal((await detail(admin, id)).volumes[0].purchase_date, '2025-01-05');
});

test('owners: Rückgängig eines Kaufs stellt das vorherige Datum des Bands wieder her', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Owners Kauf Undo' })).body.id;
    const vid = (await admin('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt', purchase_date: '1998-01-01' })).body.id;
    const buy = await admin('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: '2026-01-01' });
    assert.equal(buy.body.previous_purchase_date, '1998-01-01');

    assert.equal((await admin('POST', `/volumes/${vid}/owners`, { owned: false, previous_purchase_date: 'gestern' })).status, 400);
    assert.equal((await detail(admin, id)).volumes[0].status, 'Vorhanden', 'a rejected undo changes nothing');

    const undo = await admin('POST', `/volumes/${vid}/owners`, { owned: false, previous_purchase_date: buy.body.previous_purchase_date });
    assert.equal(undo.body.status, 'Fehlt');
    assert.equal((await detail(admin, id)).volumes[0].purchase_date, '1998-01-01');

    // without the field the last owner leaving clears the date, as before
    await admin('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: '2026-01-01' });
    await admin('POST', `/volumes/${vid}/owners`, { owned: false });
    assert.equal((await detail(admin, id)).volumes[0].purchase_date, null);
});

test('owners: die Antwort nennt das gespeicherte Kaufdatum nach der Änderung', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Owners Antwortdatum' })).body.id;
    const vid = (await admin('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt' })).body.id;
    const buy = await admin('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: '2024-04-04' });
    assert.equal(buy.body.purchase_date, '2024-04-04');
    await editor('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: '2024-06-06' });
    const leave = await admin('POST', `/volumes/${vid}/owners`, { owned: false });
    assert.equal(leave.body.purchase_date, '2024-06-06');
    assert.equal(leave.body.previous_purchase_date, '2024-04-04');
    const last = await editor('POST', `/volumes/${vid}/owners`, { owned: false });
    assert.equal(last.body.status, 'Fehlt');
    assert.equal(last.body.purchase_date, null);
});

test('owners: Löschen eines Mitbesitzers setzt das Kaufdatum auf das früheste der verbleibenden Besitzer', async () => {
    assert.equal((await admin('POST', '/users', { username: 'tmp2', password: 'password123', role: 'editor' })).status, 200);
    const tmp = ctx.client();
    await tmp('POST', '/auth/login', { username: 'tmp2', password: 'password123' });
    const id = (await admin('POST', '/mangas', { title: 'Owners Mitbesitzer weg' })).body.id;
    const vid = (await admin('POST', '/volumes', { manga_id: id, volume_number: '1', status: 'Fehlt' })).body.id;
    await tmp('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: '2023-03-03' });
    await editor('POST', `/volumes/${vid}/owners`, { owned: true, purchase_date: '2024-06-06' });
    assert.equal((await detail(admin, id)).volumes[0].purchase_date, '2023-03-03');
    const tmpId = (await admin('GET', '/users')).body.find(u => u.username === 'tmp2').id;
    assert.equal((await admin('DELETE', `/users/${tmpId}`)).status, 200);
    const v = (await detail(admin, id)).volumes[0];
    assert.deepEqual(v.owners.map(o => o.username), ['ed']);
    assert.equal(v.purchase_date, '2024-06-06');
});
