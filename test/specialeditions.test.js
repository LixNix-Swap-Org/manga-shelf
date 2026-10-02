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
