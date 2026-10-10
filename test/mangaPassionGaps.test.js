const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated DB; edition data is seeded into the Manga Passion cache and the network is stubbed to fail.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-gaps-test-'));
process.env.DATA_DIR = dataDir;

const { db, closeDb } = require('../db');
const { reconcileMangaGaps, batchImportGaps, syncMangaWithEdition, GAP_IMPORT_STATUSES } = require('../services/mangaPassion/gaps');

const realFetch = global.fetch;
test.before(() => { global.fetch = async () => { throw new Error('offline in tests'); }; });
test.after(() => {
    global.fetch = realFetch;
    closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

let nextEdition = 7000;
function seedEdition(volumes, edition = {}) {
    const id = nextEdition++;
    const data = { edition: { id, title: 'Testreihe', publisher: 'Carlsen Manga', total_volumes: volumes.length, author: 'X', ...edition }, volumes };
    db.prepare('INSERT INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, ?)')
        .run(`mp_edition_vols_${id}`, JSON.stringify(data), Date.now());
    return id;
}
function seedCache(id, data) {
    db.prepare('INSERT INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, ?)')
        .run(`mp_edition_vols_${id}`, JSON.stringify(data), Date.now());
}
const ov = (volume_number, extra = {}) => ({ id: Math.floor(Math.random() * 1e9), num: parseFloat(volume_number) || 0, volume_number: String(volume_number), title: '', price: 8, is_released: true, ...extra });
const createManga = (editionId = null, total = null) => Number(db.prepare('INSERT INTO mangas (title, publisher, total_volumes, manga_passion_id) VALUES (?, ?, ?, ?)')
    .run('Reihe', 'Carlsen Manga', total, editionId).lastInsertRowid);
const addVolume = (mangaId, volume_number, type = 'volume', notes = null, status = 'Vorhanden') =>
    db.prepare('INSERT INTO volumes (manga_id, volume_number, status, notes, type) VALUES (?, ?, ?, ?, ?)').run(mangaId, volume_number, status, notes, type);
const linkOf = (id) => db.prepare('SELECT manga_passion_id AS v FROM mangas WHERE id = ?').get(id).v;
const gapNames = (res) => res.gaps.map(g => `${g.type}:${g.volume_number}`);

test('link_confirmed: an explicitly requested edition is only confirmed when it is the linked one', async () => {
    const edition = seedEdition([ov('1')]);
    const other = seedEdition([ov('1')]);

    const unlinked = createManga();
    let res = await reconcileMangaGaps(unlinked, { edition_id: edition });
    assert.equal(res.matched, true);
    assert.equal(res.link_confirmed, false);
    assert.equal(linkOf(unlinked), null);

    const linked = createManga(edition);
    res = await reconcileMangaGaps(linked, { edition_id: edition });
    assert.equal(res.link_confirmed, true);
    res = await reconcileMangaGaps(linked, { edition_id: String(edition) });
    assert.equal(res.link_confirmed, true);

    res = await reconcileMangaGaps(linked, { edition_id: other });
    assert.equal(res.link_confirmed, false);
    assert.equal(linkOf(linked), edition);
});

test('gaps: notes of a Collectors Edition do not cover the regular volume with that title', async () => {
    const edition = seedEdition([ov('1', { title: 'Romance Dawn' }), ov('2', { title: 'Wolf' })]);
    const id = createManga(edition);
    addVolume(id, '1', 'special_edition', 'Romance Dawn');
    addVolume(id, '2');
    const res = await reconcileMangaGaps(id);
    assert.deepEqual(gapNames(res), ['volume:1']);
});

test('gaps: Schuber saga names only match Schuber, and Leer- and Sammelschuber stay apart', async () => {
    const edition = seedEdition([
        ov('1'),
        { ...ov('Special'), title: 'East Blue Leerschuber', specialType: 1 },
        { ...ov('Special'), title: 'Alabasta Leerschuber', specialType: 1 },
        { ...ov('Special'), title: 'Skypia Sammelschuber', specialType: 1 }
    ]);
    const id = createManga(edition);
    addVolume(id, '1', 'volume', 'East Blue');
    addVolume(id, 'Schuber 2', 'schuber', 'Alabasta Sammelschuber');
    addVolume(id, 'Schuber 3', 'schuber', 'Skypia');
    const res = await reconcileMangaGaps(id);
    assert.deepEqual(gapNames(res), ['schuber:East Blue Leerschuber', 'schuber:Alabasta Leerschuber']);

    const owner = createManga(edition);
    addVolume(owner, '1');
    addVolume(owner, 'Schuber 1', 'schuber', 'East Blue Leerschuber');
    addVolume(owner, 'Schuber 2', 'schuber', 'Alabasta');
    addVolume(owner, 'Schuber 3', 'schuber', 'Skypia Sammelschuber');
    assert.deepEqual(gapNames(await reconcileMangaGaps(owner)), []);
});

test('gaps: notes lookup prefers the owned entry over a missing one with the same notes', async () => {
    const edition = seedEdition([ov('1'), { ...ov('Special'), title: 'Wano Leerschuber', specialType: 1 }]);
    const id = createManga(edition);
    addVolume(id, '1');
    addVolume(id, 'Schuber A', 'schuber', 'Wano Leerschuber', 'Vorhanden');
    addVolume(id, 'Schuber B', 'schuber', 'Wano Leerschuber', 'Fehlt');
    assert.deepEqual(gapNames(await reconcileMangaGaps(id)), []);
});

test('gaps: a range-numbered Schuber is never a gap, a range volume only while a constituent is missing', async () => {
    const edition = seedEdition([ov('1'), ov('2'), { ...ov('1-2'), title: 'Schuber Bände 1-2', specialType: 1 }, ov('3-4')]);
    const id = createManga(edition);
    const res = await reconcileMangaGaps(id);
    assert.deepEqual(gapNames(res), ['volume:1', 'volume:2', 'volume:3-4']);
});

test('gaps: the answer carries only the fields the client uses', async () => {
    const edition = seedEdition([ov('1'), ov('2')]);
    const id = createManga(edition);
    addVolume(id, '1');
    const res = await reconcileMangaGaps(id);
    assert.deepEqual(Object.keys(res).sort(), ['candidate_editions', 'discrepancy', 'edition', 'gaps', 'incomplete', 'link_confirmed', 'matched', 'stale', 'success', 'total_official_volumes']);
});

test('total_official_volumes: counts the listed regular volumes when the edition has no total', async () => {
    const edition = seedEdition([ov('1'), ov('2'), { ...ov('Special'), title: 'East Blue Leerschuber', specialType: 1 }], { total_volumes: null });
    const id = createManga(edition, 5);
    const res = await reconcileMangaGaps(id);
    assert.equal(res.total_official_volumes, 2);
    assert.equal(res.discrepancy, null, 'a count of listed volumes never suggests a new total');

    const announced = seedEdition([ov('1'), ov('2')], { total_volumes: 3 });
    const other = createManga(announced, 5);
    const res2 = await reconcileMangaGaps(other);
    assert.equal(res2.total_official_volumes, 3);
    assert.equal(res2.discrepancy.official_total, 3);
});

test('total_official_volumes: no discrepancy from a partial volume list without an edition', async () => {
    const id = nextEdition++;
    seedCache(id, { edition: null, volumes: [ov('1')], incomplete: true });
    // the cache only serves entries with edition data; without it the stale copy is read after the failed fetch
    const manga = createManga(id, 10);
    const res = await reconcileMangaGaps(manga);
    assert.equal(res.total_official_volumes, 1);
    assert.equal(res.discrepancy, null);
});

test('batchImportGaps: labels are typed like official entries when Manga Passion data is missing', async () => {
    const id = createManga();
    addVolume(id, '5');
    const res = await batchImportGaps(id, ['5 (Variant Edition)', 'East Blue Box', '3 (Limited Edition)', 'Alabasta Leerschuber', '4', 'Special', '26 (Abenteuer auf der Insel des Gottes)']);
    assert.equal(res.skipped_owned_count, 0);
    const rows = db.prepare("SELECT volume_number, type FROM volumes WHERE manga_id = ? AND status = 'Fehlt' ORDER BY id").all(id);
    assert.deepEqual(rows.map(r => `${r.type}:${r.volume_number}`), [
        'special_edition:5', 'schuber:East Blue Box', 'special_edition:3', 'schuber:Alabasta Leerschuber', 'volume:4', 'special:Special', 'volume:26'
    ]);
});

test('batchImportGaps: refuses statuses outside the import list and leaves no volume behind', async () => {
    assert.deepEqual(GAP_IMPORT_STATUSES, ['Vorbestellt', 'Fehlt', 'Erscheint bald', 'Bestellt']);
    const id = createManga();
    for (const status of ['Vorhanden', 'Gelesen', 'Quatsch', { x: 1 }]) {
        await assert.rejects(() => batchImportGaps(id, ['1'], status), (err) => err.status === 400);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM volumes WHERE manga_id = ?').get(id).n, 0);
    await assert.rejects(() => batchImportGaps(999999, ['1']), (err) => err.status === 404);
});

test('batchImportGaps: invalid or empty entries are skipped, never stored', async () => {
    const id = createManga();
    const res = await batchImportGaps(id, [null, {}, '', '   ', '(nur Titel)', 'x'.repeat(81), 7]);
    assert.equal(res.imported_count, 1);
    assert.equal(res.skipped_invalid_count, 6);
    assert.deepEqual(db.prepare('SELECT volume_number FROM volumes WHERE manga_id = ?').all(id).map(r => r.volume_number), ['7']);
});

test('batchImportGaps: imported_ids lists exactly the rows it created, not updated or skipped ones', async () => {
    const id = createManga();
    addVolume(id, '1');
    const listed = Number(addVolume(id, '2', 'volume', null, 'Fehlt').lastInsertRowid);
    const res = await batchImportGaps(id, ['1', '2', '3', '4', '3', '']);
    const created = db.prepare("SELECT id FROM volumes WHERE manga_id = ? AND volume_number IN ('3', '4') ORDER BY id").all(id).map(r => r.id);
    assert.deepEqual(res.imported_ids, created);
    assert.equal(res.imported_count, 2);
    assert.equal(res.updated_count, 1);
    assert.ok(!res.imported_ids.includes(listed));
    const none = await batchImportGaps(id, ['1']);
    assert.deepEqual([none.imported_ids, none.imported_count], [[], 0]);
});

test('batchImportGaps: an unreleased official volume is imported as Erscheint bald instead of Fehlt', async () => {
    const edition = seedEdition([
        ov('1', { release_date: '2020-01-01' }),
        ov('2', { release_date: '2999-12-31', is_released: false }),
        ov('3', { release_date: null, is_released: false }),
        ov('4', { release_date: null, is_released: false })
    ]);
    const id = createManga(edition);
    addVolume(id, '3', 'volume', null, 'Fehlt');
    const res = await batchImportGaps(id, ['1', '2', '3']);
    assert.deepEqual([res.imported_count, res.updated_count, res.total_processed], [2, 1, 3]);
    const statusOf = () => Object.fromEntries(db.prepare('SELECT volume_number, status FROM volumes WHERE manga_id = ?').all(id).map(r => [r.volume_number, r.status]));
    assert.deepEqual(statusOf(), { 1: 'Fehlt', 2: 'Erscheint bald', 3: 'Erscheint bald' });
    await batchImportGaps(id, ['4'], 'Vorbestellt');
    assert.equal(statusOf()['4'], 'Vorbestellt');
});

test('syncMangaWithEdition: unknown edition is 404, an outage 503, an edition without volume list still syncs', async () => {
    const id = createManga();
    const missing = nextEdition++;
    seedCache(missing, { notFound: true, edition: null, volumes: [] });
    await assert.rejects(() => syncMangaWithEdition(id, missing), (err) => err.status === 404);

    await assert.rejects(() => syncMangaWithEdition(id, nextEdition++), (err) => err.status === 503);
    await assert.rejects(() => syncMangaWithEdition(999999, missing), (err) => err.status === 404);
    assert.equal(linkOf(id), null);

    const noVolumes = nextEdition++;
    seedCache(noVolumes, { notFound: true, edition: { id: noVolumes, title: 'Ohne Bände', total_volumes: 4, status: 'Laufend', publisher: 'Carlsen Manga' }, volumes: [] });
    const updated = await syncMangaWithEdition(id, noVolumes, { update_total_volumes: true });
    assert.equal(updated.manga_passion_id, noVolumes);
    assert.equal(updated.total_volumes, 4);
});

test('gaps: the saga fallback only applies to Schuber, a "Boxer" title is a regular volume', async () => {
    const edition = seedEdition([ov('3'), ov('7', { title: 'Der Boxer aus Alabasta' })]);
    const id = createManga(edition);
    addVolume(id, '3', 'volume', 'Alabasta Arc');
    const res = await reconcileMangaGaps(id);
    assert.deepEqual(gapNames(res), ['volume:7']);
});

test('reconcileMangaGaps: an unreachable search is reported as an outage and stores nothing', async () => {
    const id = Number(db.prepare('INSERT INTO mangas (title, publisher) VALUES (?, ?)').run('Unerreichbar Reihe', 'Carlsen Manga').lastInsertRowid);
    const res = await reconcileMangaGaps(id, { persist: false });
    assert.equal(res.success, false);
    assert.equal(res.unavailable, true);
    assert.match(res.message, /nicht erreichbar/);
    assert.equal(linkOf(id), null);
});
