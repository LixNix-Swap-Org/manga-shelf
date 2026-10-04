const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// Special editions (Collectors / Limited Edition, Schuber) share the number of the regular volume.
// Isolated DB; Manga Passion edition data is seeded into its cache, so no network is needed.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-se-test-'));
process.env.DATA_DIR = dataDir;

const { db, closeDb } = require('../db');
const mp = require('../mangaPassion');
const { inferVolumeType, volumeNumberOf } = require('../utils/volumeType');

const EDITION_ID = 777;

const ov = (volume_number, extra = {}) => ({
    id: Number(String(volume_number).replace(/\D/g, '')) || 900, num: parseFloat(volume_number) || 0,
    volume_number: String(volume_number), title: '', price: 8, is_released: true, ...extra
});
const ce = (n, id) => ov(String(n), { id, title: 'Collectors Edition', specialType: 0, price: 32 });
const box = (n, id, title = 'Schuber') => ov(String(n), { id, title, specialType: 1, price: 15 });

function seed(volumes) {
    db.prepare(`
        INSERT INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET json_data = excluded.json_data, created_at = excluded.created_at
    `).run(`mp_edition_vols_${EDITION_ID}`, JSON.stringify({
        edition: { title: 'Testreihe', publisher: 'Altraverse', total_volumes: volumes.length, author: 'X' }, volumes
    }), Date.now());
}
const newManga = (title) => Number(db.prepare('INSERT INTO mangas (title, publisher, total_volumes, manga_passion_id) VALUES (?, ?, ?, ?)')
    .run(title, 'Altraverse', 5, EDITION_ID).lastInsertRowid);
const addVol = (mangaId, number, type, status = 'Vorhanden', notes = null) =>
    db.prepare('INSERT INTO volumes (manga_id, volume_number, type, status, notes) VALUES (?, ?, ?, ?, ?)').run(mangaId, number, type, status, notes);
const rows = (mangaId) => db.prepare('SELECT volume_number, type, status, price, release_date, notes FROM volumes WHERE manga_id = ? ORDER BY id').all(mangaId);

test.after(() => { closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('volumeType helpers: type from keywords, trailing number', () => {
    assert.equal(inferVolumeType({ volume_number: '5', type: 'special_edition' }), 'special_edition');
    assert.equal(inferVolumeType({ volume_number: 'Schuber 8' }), 'schuber');
    assert.equal(inferVolumeType({ volume_number: '14', notes: 'Limited Edition' }), 'special_edition');
    assert.equal(volumeNumberOf({ volume_number: 'Schuber 8' }), 8);
    assert.equal(volumeNumberOf({ volume_number: '5' }), 5);
    assert.equal(volumeNumberOf({ volume_number: '1-5' }), null);
    assert.equal(volumeNumberOf({ volume_number: 'Vollschuber 1-5' }), null);
});

test('the backend and frontend type inference agree', async () => {
    const front = await import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'utils', 'volumeHelpers.js')).href);
    const samples = [
        { volume_number: '1' }, { volume_number: 'Schuber 3' }, { volume_number: 'Special Edition 2' },
        { volume_number: '14', notes: 'Limited Edition' }, { volume_number: 'Sonderband' }, { volume_number: '7', type: 'schuber' },
        { volume_number: 'Fanbook', type: 'special' }, { volume_number: 'Extra 1' }
    ];
    for (const s of samples) assert.equal(inferVolumeType(s), front.inferVolumeType(s), JSON.stringify(s));
    for (const s of [{ volume_number: '5' }, { volume_number: 'Schuber 8' }, { volume_number: '1-5' }, { volume_number: 'Special' }]) {
        assert.equal(volumeNumberOf(s), front.volumeNumberOf(s), JSON.stringify(s));
    }
});

test('reconcile: owning Band 5 does not hide the missing Collectors Edition 5', async () => {
    seed([ov('4'), ov('5'), ce(5, 105), ov('6'), ce(6, 106)]);
    const id = newManga('Gap CE');
    for (const n of ['4', '5', '6']) addVol(id, n, 'volume');

    const res = await mp.reconcileMangaGaps(id);
    assert.deepEqual(res.gaps.map(g => `${g.volume_number}|${g.type}`).sort(), ['5|special_edition', '6|special_edition']);

    // owning Collectors Edition 5 closes exactly that gap
    addVol(id, '5', 'special_edition', 'Vorhanden', 'Collectors Edition');
    const after = await mp.reconcileMangaGaps(id);
    assert.deepEqual(after.gaps.map(g => `${g.volume_number}|${g.type}`), ['6|special_edition']);
});

test('reconcile: a numbered Schuber is matched by its number, a missing regular volume is not hidden by a Schuber', async () => {
    seed([ov('7'), box(8, 108), box(9, 109)]);
    const id = newManga('Gap Schuber');
    addVol(id, 'Schuber 8', 'schuber');            // owns the Schuber of volume 8, but no Band 7 / Band 8
    const res = await mp.reconcileMangaGaps(id);
    assert.deepEqual(res.gaps.map(g => `${g.volume_number}|${g.type}`).sort(), ['7|volume', '9|schuber']);
});

test('importing gaps by UI label stores the clean number with price, date and cover', async () => {
    seed([
        ov('1', { title: 'Romance Dawn', release_date: '2001-01-31', cover_image: null }),
        ov('2', { title: 'Wolf im Schafspelz', release_date: '2001-03-31' })
    ]);
    const id = newManga('Label Import');
    const result = await mp.batchImportGaps(id, ['1 (Romance Dawn)', '2 (Wolf im Schafspelz)'], 'Fehlt', EDITION_ID);
    assert.equal(result.imported_count, 2);
    const stored = rows(id);
    assert.deepEqual(stored.map(r => r.volume_number), ['1', '2']);   // not "1 (Romance Dawn)"
    assert.deepEqual(stored.map(r => r.release_date), ['2001-01-31', '2001-03-31']);
    assert.ok(stored.every(r => r.price === 8 && r.type === 'volume' && r.status === 'Fehlt'));
});

test('importing a Collectors Edition next to an owned regular volume adds it instead of touching the volume', async () => {
    seed([ov('14'), ce(14, 114)]);
    const id = newManga('Import CE');
    addVol(id, '14', 'volume', 'Vorhanden');
    const result = await mp.batchImportGaps(id, ['14 (Collectors Edition)'], 'Fehlt', EDITION_ID);
    assert.equal(result.imported_count, 1);
    assert.deepEqual(rows(id).map(r => `${r.volume_number}|${r.type}|${r.status}|${r.price}`),
        ['14|volume|Vorhanden|null', '14|special_edition|Fehlt|32']);
});

test('a bare number imports the regular volume, and an owned entry is never overwritten', async () => {
    seed([ov('3'), ce(3, 103)]);
    const id = newManga('Import bare');
    addVol(id, '3', 'volume', 'Vorhanden');
    const result = await mp.batchImportGaps(id, ['3'], 'Fehlt', EDITION_ID);
    assert.equal(result.skipped_owned_count, 1);
    assert.equal(result.imported_count, 0);
    assert.deepEqual(rows(id).map(r => `${r.volume_number}|${r.type}|${r.status}`), ['3|volume|Vorhanden']);
});

test('importing the same gap twice in one request creates it once', async () => {
    seed([ov('9')]);
    const id = newManga('Import twice');
    const result = await mp.batchImportGaps(id, ['9', '9'], 'Fehlt', EDITION_ID);
    assert.equal(result.imported_count, 1);
    assert.equal(rows(id).length, 1);
});

// --- display helpers (frontend) ---
const front = () => import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'utils', 'volumeHelpers.js')).href);

test('getEditionLabel: names the kind of special edition from the notes', async () => {
    const { getEditionLabel } = await front();
    assert.deepEqual(getEditionLabel({ volume_number: '5', notes: 'Collectors Edition' }), { label: 'Collectors Edition', short: 'COLL' });
    assert.deepEqual(getEditionLabel({ volume_number: '1', notes: "Collector's Edition mit Poster" }), { label: 'Collectors Edition', short: 'COLL' });
    assert.deepEqual(getEditionLabel({ volume_number: '20', notes: 'Limited Edition' }), { label: 'Limited Edition', short: 'LTD' });
    assert.deepEqual(getEditionLabel({ volume_number: 'Band 3 Special Edition' }), { label: 'Special Edition', short: 'SE' });
    assert.deepEqual(getEditionLabel({ volume_number: '4', notes: 'Variant Cover' }), { label: 'Variant', short: 'VAR' });
    assert.deepEqual(getEditionLabel({ volume_number: '2', notes: 'Erstauflage mit Postkarte' }), { label: 'Special Edition', short: 'SE' });
});

test('getVolumeDisplayTitle: edition name for special editions, no duplicated "Schuber"', async () => {
    const { getVolumeDisplayTitle, getSpecialEditionNumber } = await front();
    assert.equal(getVolumeDisplayTitle({ type: 'special_edition', volume_number: '5', notes: 'Collectors Edition' }), 'Band 5 (Collectors Edition)');
    assert.equal(getVolumeDisplayTitle({ type: 'special_edition', volume_number: '14' }), 'Band 14 (Special Edition)');
    assert.equal(getVolumeDisplayTitle({ type: 'special_edition', volume_number: 'Limited Edition 14' }), 'Band 14 (Limited Edition)');
    assert.equal(getVolumeDisplayTitle({ type: 'schuber', volume_number: 'Vollschuber 1-5' }), 'Vollschuber 1-5');
    assert.equal(getVolumeDisplayTitle({ type: 'schuber', volume_number: 'Schuber 2' }), 'Schuber 2');
    assert.equal(getVolumeDisplayTitle({ type: 'schuber', volume_number: '8' }), 'Schuber 8');
    assert.equal(getVolumeDisplayTitle({ type: 'schuber', volume_number: '15', notes: ' Sammelschuber' }), 'Sammelschuber 15');
    assert.equal(getVolumeDisplayTitle({ type: 'schuber', volume_number: '3', notes: 'Schuber' }), 'Schuber 3');
    assert.equal(getVolumeDisplayTitle({ type: 'schuber', volume_number: '4', notes: 'Erstauflage mit Postkarte' }), 'Schuber 4');
    assert.equal(getSpecialEditionNumber({ volume_number: 'Band 5 Limited Edition' }), '5');
});

test('isGapCovered: type and number decide, generic edition titles never match by name', async () => {
    const { isGapCovered } = await front();
    const owned = [{ volume_number: '5', type: 'volume' }, { volume_number: 'Schuber 8', type: 'schuber' }, { volume_number: '8', type: 'special_edition', notes: 'Collectors Edition' }];
    assert.equal(isGapCovered({ volume_number: '5', type: 'volume' }, owned), true);
    assert.equal(isGapCovered({ volume_number: '5', type: 'special_edition', title: 'Collectors Edition' }, owned), false);
    assert.equal(isGapCovered({ volume_number: '8', type: 'special_edition', title: 'Collectors Edition' }, owned), true);
    assert.equal(isGapCovered({ volume_number: '11', type: 'special_edition', title: 'Collectors Edition' }, owned), false);
    assert.equal(isGapCovered({ volume_number: '8', type: 'schuber', title: 'Schuber' }, owned), true);
    assert.equal(isGapCovered({ volume_number: '16', type: 'schuber', title: 'Schuber' }, owned), false);
    assert.equal(isGapCovered({ volume_number: '1-5', type: 'schuber', title: 'Vollschuber' }, owned), true);   // ranges never count as gaps
});

test('a Leerschuber is not hidden by regular volume "1" just because its title mentions "Bände 1-5"', async () => {
    seed([
        ov('1'),
        { ...ov('Special', { id: 301 }), title: 'Leerschuber für die Bände 1-5', specialType: 1, price: 10 },
        { ...ov('Special', { id: 302 }), title: 'Leerschuber für die Bände 6-10', specialType: 1, price: 10 }
    ]);
    const id = newManga('Leerschuber');
    addVol(id, '1', 'volume');
    addVol(id, 'Leerschuber 6-10', 'schuber', 'Vorhanden', 'Leerschuber für die Bände 6-10');
    const res = await mp.reconcileMangaGaps(id);
    assert.deepEqual(res.gaps.map(g => g.title), ['Leerschuber für die Bände 1-5']);
});

test('isGapCovered: a bare number never matches a title, like with like only', async () => {
    const { isGapCovered } = await front();
    const owned = [{ volume_number: '1', type: 'volume' }];
    assert.equal(isGapCovered({ volume_number: 'Leerschuber für die Bände 1-5', type: 'schuber', title: 'Leerschuber für die Bände 1-5' }, owned), false);
    const named = [{ volume_number: 'Leerschuber 6-10', type: 'schuber', notes: 'Leerschuber für die Bände 6-10' }];
    assert.equal(isGapCovered({ volume_number: 'Leerschuber für die Bände 6-10', type: 'schuber', title: 'Leerschuber für die Bände 6-10' }, named), true);
});

test('migration v6 renames volumes imported under their UI label to the clean number', () => {
    const { initDb } = require('../db');
    const id = newManga('Altlast');
    addVol(id, '4 (Wolf im Schafspelz)', 'volume', 'Fehlt');
    addVol(id, '5 (Wem schlägt jetzt die Stunde?)', 'volume', 'Fehlt');
    addVol(id, '6', 'volume', 'Vorhanden');
    addVol(id, '6 (Doppelt)', 'volume', 'Fehlt');          // clean 6 exists -> left alone
    addVol(id, '7 (Collectors Edition)', 'special_edition', 'Fehlt'); // other types are untouched
    db.prepare('DELETE FROM schema_migrations WHERE version = 6').run();
    initDb();
    assert.deepEqual(rows(id).map(r => `${r.volume_number}|${r.type}`),
        ['4|volume', '5|volume', '6|volume', '6 (Doppelt)|volume', '7 (Collectors Edition)|special_edition']);
    assert.equal(rows(id)[0].notes, 'Wolf im Schafspelz');
});

test('cleanOfficialDate: the 2999-12-31 "not announced yet" placeholder is no release date', () => {
    assert.equal(mp.cleanOfficialDate('2999-12-31'), null);
    assert.equal(mp.cleanOfficialDate('2999-12-31T00:00:00+00:00'), null);
    assert.equal(mp.cleanOfficialDate('2026-03-03T00:00:00+00:00'), '2026-03-03');
    assert.equal(mp.cleanOfficialDate('2099-12-31'), '2099-12-31');
    assert.equal(mp.cleanOfficialDate(null), null);
    assert.equal(mp.cleanOfficialDate(''), null);
    assert.equal(mp.cleanOfficialDate('kein datum'), null);
});

const notFoundFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
async function offline(fn) {
    const realFetch = global.fetch;
    global.fetch = notFoundFetch;
    try { return await fn(); } finally { global.fetch = realFetch; }
}
const ceAt = (n, id, extra = {}) => ({ ...ce(n, id), ...extra });

test('lookup of Collectors Edition 10 returns CE 10, not the first CE of the edition', () => offline(async () => {
    seed([ov('1'), ov('10'), ceAt(1, 12, { price: 25 }), ceAt(10, 101, { price: 35, release_date: '2023-03-03' })]);
    const id = newManga('Lookup CE');
    const hit = await mp.lookupVolumeMetadata(id, '10', { type: 'special_edition' });
    assert.equal(hit.data.mp_volume_id, 101);
    assert.equal(hit.data.price, 35);
    assert.equal((await mp.lookupVolumeMetadata(id, '5', { type: 'special_edition' })).matched, false);
    assert.equal((await mp.lookupVolumeMetadata(id, '10 (Collectors Edition)', { type: 'special_edition' })).data.mp_volume_id, 101);
    assert.equal((await mp.lookupVolumeMetadata(id, '10 Collectors Edition')).data.mp_volume_id, 101);
    assert.equal((await mp.lookupVolumeMetadata(id, 'Limited Edition 10')).data.mp_volume_id, 101);
    assert.equal((await mp.lookupVolumeMetadata(id, '10', { type: 'volume' })).data.mp_volume_id, 10);
}));

test('autofill fills each volume from the entry of its own type', () => offline(async () => {
    const reg5 = ov('5', { id: 5, num: 5, price: 7.5, pages: 190, release_date: '2020-05-01' });
    const ce5 = ceAt(5, 105, { price: 30, pages: 210, release_date: '2022-02-02' });
    seed([ce5, reg5, ov('1', { id: 1, num: 1, price: 6, release_date: '2019-01-01' })]);
    const id = newManga('Autofill Typen');
    addVol(id, '5', 'special_edition', 'Vorhanden', 'Collectors Edition');
    addVol(id, '5', 'volume');
    addVol(id, 'Special 1', 'special');
    addVol(id, '7', 'special_edition');

    await mp.autofillMangaVolumes(id, { overwrite: true });
    const got = db.prepare('SELECT volume_number, type, price, pages, release_date FROM volumes WHERE manga_id = ? ORDER BY id').all(id)
        .map(r => `${r.volume_number}|${r.type}|${r.price}|${r.pages}|${r.release_date}`);
    assert.deepEqual(got, [
        '5|special_edition|30|210|2022-02-02',
        '5|volume|7.5|190|2020-05-01',
        'Special 1|special|null|null|null',
        '7|special_edition|null|null|null'
    ]);
    const second = await mp.autofillMangaVolumes(id, { overwrite: true });
    assert.equal(second.updated_count, 0, 'a correctly filled CE stays unchanged');
}));

test('autofill uses the stored Manga Passion link when it still fits the volume', () => offline(async () => {
    seed([ov('3', { id: 3, num: 3, price: 7 }), ceAt(3, 103, { price: 30 }), ceAt(3, 203, { title: 'Limited Edition', price: 45 })]);
    const id = newManga('Autofill Link');
    const volId = Number(addVol(id, '3', 'special_edition').lastInsertRowid);
    db.prepare('UPDATE volumes SET manga_passion_volume_id = 203 WHERE id = ?').run(volId);
    await mp.autofillMangaVolumes(id);
    assert.equal(db.prepare('SELECT price FROM volumes WHERE id = ?').get(volId).price, 45);
}));

test('reconcile and import: a regular volume titled "Der Boxer" is a volume, not a Schuber', async () => {
    seed([ov('11'), ov('12', { title: 'Der Boxer', num: 12 }), ov('13', { title: 'Expedition ins Nichts', num: 13 })]);
    const id = newManga('Boxer');
    for (const n of ['11', '12', '13']) addVol(id, n, 'volume');
    const res = await mp.reconcileMangaGaps(id);
    assert.deepEqual(res.gaps, []);
    const result = await mp.batchImportGaps(id, ['12'], 'Fehlt', EDITION_ID);
    assert.equal(result.skipped_owned_count, 1);
    assert.equal(rows(id).length, 3);
});

test('reconcile: an owned Sonderband named "... Edition" is not reported as a gap', async () => {
    seed([ov('1'), ov('Special', { id: 950, title: 'Winter Edition', type: 0 })]);
    const id = newManga('Sonderband');
    addVol(id, '1', 'volume');
    addVol(id, 'Winter Edition', 'special');
    const res = await mp.reconcileMangaGaps(id);
    assert.deepEqual(res.gaps, []);
});

test('cleanOfficialDate: a month-only release stays month-only, malformed dates are no dates', () => {
    const { cleanOfficialDate, isOfficialReleased } = require('../services/mangaPassion/classify');
    assert.equal(cleanOfficialDate({ year: 2026, month: 11, day: null, date: '2026-11-30T00:00:00+00:00' }), '2026-11');
    assert.equal(cleanOfficialDate({ year: 2001, month: 1, day: null, date: '2001-01-31T00:00:00+00:00' }), '2001-01');
    assert.equal(cleanOfficialDate({ year: 2026, month: 3, day: 3, date: '2026-03-03T00:00:00+00:00' }), '2026-03-03');
    assert.equal(cleanOfficialDate({ date: '2026-03-03T00:00:00+00:00' }), '2026-03-03');
    assert.equal(cleanOfficialDate({ year: 2999, month: 12, day: null, date: '2999-12-31T00:00:00+00:00' }), null);
    assert.equal(cleanOfficialDate({ date: null }), null);
    for (const bad of ['31.12.2026', '2026', '0000-00-00', '2026-13-01', '2026-02-30', '1850-01-01']) {
        assert.equal(cleanOfficialDate(bad), null, bad);
    }
    assert.equal(cleanOfficialDate('2026-11'), '2026-11');

    // month-only: released once the month is over
    assert.equal(isOfficialReleased('2026-11', new Date('2026-11-15T12:00:00Z')), false);
    assert.equal(isOfficialReleased('2026-11', new Date('2026-12-01T00:00:00Z')), true);
    assert.equal(isOfficialReleased('2026-11-14', new Date('2026-11-15T00:00:00Z')), true);
    assert.equal(isOfficialReleased(null), false);
});

test('lookup by Manga Passion volume id keeps a month-only date month-only', async () => {
    const realFetch = global.fetch;
    try {
        global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 1242, number: 5, numberDisplay: '5', year: 2001, month: 1, day: null, date: '2001-01-31T00:00:00+00:00' }) });
        const res = await mp.lookupVolumeMetadata(null, '5', { mp_volume_id: '1242' });
        assert.equal(res.data.release_date, '2001-01');
        assert.equal(res.data.release_year, 2001);
    } finally { global.fetch = realFetch; }
});
