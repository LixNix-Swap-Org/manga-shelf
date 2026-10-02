const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated DB; the Manga Passion edition data is seeded into the cache so no network is needed.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-mp-test-'));
process.env.DATA_DIR = dataDir;

const { db, closeDb } = require('../db');
const mp = require('../mangaPassion');

const EDITION_ID = 4242;

function seedEdition(volumes, edition = { title: 'Testreihe', publisher: 'Carlsen Manga', total_volumes: volumes.length, author: 'X' }) {
    db.prepare(`
        INSERT INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET json_data = excluded.json_data, created_at = excluded.created_at
    `).run(`mp_edition_vols_${EDITION_ID}`, JSON.stringify({ edition, volumes }), Date.now());
}

function ov(volume_number, extra = {}) {
    return { id: Number(String(volume_number).replace(/\D/g, '')) || 900, num: parseFloat(volume_number) || 0, volume_number: String(volume_number), title: '', price: 8, is_released: true, ...extra };
}

function createManga(title, total) {
    return Number(db.prepare('INSERT INTO mangas (title, publisher, total_volumes, manga_passion_id) VALUES (?, ?, ?, ?)')
        .run(title, 'Carlsen Manga', total, EDITION_ID).lastInsertRowid);
}

function addVolume(mangaId, volume_number, status = 'Vorhanden', extra = {}) {
    db.prepare('INSERT INTO volumes (manga_id, volume_number, status, notes, type) VALUES (?, ?, ?, ?, ?)')
        .run(mangaId, volume_number, status, extra.notes || null, extra.type || 'volume');
}

test.after(() => {
    closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scoreEdition: exact title + publisher + volume count beats a spin-off', () => {
    const main = { title: 'One Piece', numVolumes: 108, publishers: [{ name: 'Carlsen Manga' }] };
    const guide = { title: 'One Piece Guide', numVolumes: 1, publishers: [{ name: 'Carlsen Manga' }] };
    assert.ok(mp.scoreEdition(main, 'One Piece', 'Carlsen', 108) > mp.scoreEdition(guide, 'One Piece', 'Carlsen', 108));
});

test('scoreEdition: spin-off penalty is skipped when the target asks for it', () => {
    const guide = { title: 'One Piece Guide', numVolumes: 1, publishers: [] };
    assert.ok(mp.scoreEdition(guide, 'One Piece Guide', '', null) > mp.scoreEdition(guide, 'One Piece', '', null));
});

test('matchSchuberVolume: returns null without schuber entries', () => {
    assert.equal(mp.matchSchuberVolume([ov('1'), ov('2')], 'Schuber 1'), null);
    assert.equal(mp.matchSchuberVolume([], 'Schuber 1'), null);
});

test('matchSchuberVolume: "Schuber 2" picks the second schuber, never volume 2', () => {
    const vols = [
        ov('1'), ov('2'),
        { ...ov('Special', { id: 9736 }), title: 'East Blue Leerschuber', specialType: 1, price: 12, customArrangement: 1 },
        { ...ov('Special', { id: 9737 }), title: 'Alabasta Leerschuber', specialType: 1, price: 12, customArrangement: 2 }
    ];
    const m = mp.matchSchuberVolume(vols, 'Schuber 2', 12, '');
    assert.equal(m.id, 9737);
});

test('matchSchuberVolume: prefers filled Sammelschuber when the price is above 25 EUR', () => {
    const vols = [
        { ...ov('Special', { id: 1 }), title: 'Leerschuber 1', specialType: 1, price: 12, customArrangement: 1 },
        { ...ov('Special', { id: 2 }), title: 'Sammelschuber 1', specialType: 1, price: 40, customArrangement: 1 }
    ];
    assert.equal(mp.matchSchuberVolume(vols, 'Schuber 1', 40, '').id, 2);
    assert.equal(mp.matchSchuberVolume(vols, 'Schuber 1', 12, '').id, 1);
});

test('reconcileMangaGaps: only missing official volumes show up as gaps', async () => {
    seedEdition([ov('1'), ov('2'), ov('3'), ov('4')]);
    const id = createManga('Gap-Test', 4);
    addVolume(id, '1');
    addVolume(id, '2', 'Fehlt');

    const res = await mp.reconcileMangaGaps(id);
    assert.equal(res.success, true);
    assert.deepEqual(res.gaps.map(g => g.volume_number), ['2', '3', '4']);
    assert.equal(res.gaps.find(g => g.volume_number === '2').in_collection, true);
    assert.equal(res.gaps.find(g => g.volume_number === '3').in_collection, false);
    assert.equal(res.discrepancy, null);
});

test('reconcileMangaGaps: German edition shorter than the AniList total yields a discrepancy, not phantom gaps', async () => {
    seedEdition([ov('1'), ov('2'), ov('3')]);
    const id = createManga('Doppelband-Test', 6);
    for (const n of ['1', '2', '3']) addVolume(id, n);

    const res = await mp.reconcileMangaGaps(id);
    assert.equal(res.gaps.length, 0);
    assert.equal(res.discrepancy.has_discrepancy, true);
    assert.equal(res.discrepancy.db_total, 6);
    assert.equal(res.discrepancy.official_total, 3);
});

test('reconcileMangaGaps: owned schuber matched via saga name is not reported as gap', async () => {
    seedEdition([
        ov('1'),
        { ...ov('Special', { id: 9736 }), title: 'East Blue Leerschuber', specialType: 1 }
    ]);
    const id = createManga('Schuber-Test', 1);
    addVolume(id, '1');
    addVolume(id, 'Schuber 1', 'Vorhanden', { notes: 'East Blue', type: 'schuber' });

    const res = await mp.reconcileMangaGaps(id);
    assert.equal(res.gaps.length, 0);
});

test('reconcileMangaGaps: missing schuber gets its real title and type', async () => {
    seedEdition([
        ov('1'),
        { ...ov('Special', { id: 9738 }), title: 'Fischmenscheninsel Leerschuber', specialType: 1 }
    ]);
    const id = createManga('Schuber-Gap-Test', 1);
    addVolume(id, '1');

    const res = await mp.reconcileMangaGaps(id);
    assert.equal(res.gaps.length, 1);
    assert.equal(res.gaps[0].type, 'schuber');
    assert.equal(res.gaps[0].volume_number, 'Fischmenscheninsel Leerschuber');
});

test('reconcileMangaGaps: range volume is skipped when all constituents are owned', async () => {
    seedEdition([ov('1'), ov('21-23'), ov('24-26')]);
    const id = createManga('Range-Test', 3);
    addVolume(id, '1');
    for (const n of ['21', '22', '23']) addVolume(id, n);

    const res = await mp.reconcileMangaGaps(id);
    assert.deepEqual(res.gaps.map(g => g.volume_number), ['24-26']);
});

test('reconcileMangaGaps: unknown manga throws', async () => {
    await assert.rejects(() => mp.reconcileMangaGaps(999999), /nicht gefunden/);
});

test('batchImportGaps: inserts missing volumes as Fehlt with official price and detected type', async () => {
    seedEdition([
        ov('1'), ov('2', { price: 9.5 }),
        { ...ov('Special', { id: 9739 }), title: 'Alabasta Leerschuber', specialType: 1, price: 12 }
    ]);
    const id = createManga('Import-Test', 2);
    addVolume(id, '1');

    await mp.batchImportGaps(id, ['2', 'Alabasta Leerschuber'], 'Fehlt');
    const rows = db.prepare('SELECT volume_number, status, price, type FROM volumes WHERE manga_id = ? ORDER BY id').all(id);
    const two = rows.find(r => r.volume_number === '2');
    assert.equal(two.status, 'Fehlt');
    assert.equal(two.price, 9.5);
    assert.equal(two.type, 'volume');
    const box = rows.find(r => /Alabasta/.test(r.volume_number));
    assert.ok(box, 'schuber row was created');
    assert.equal(box.type, 'schuber');
    assert.equal(rows.length, 3);
});

test('batchImportGaps: importing twice does not create duplicates', async () => {
    seedEdition([ov('1'), ov('2')]);
    const id = createManga('Dup-Test', 2);
    addVolume(id, '1');
    await mp.batchImportGaps(id, ['2']);
    await mp.batchImportGaps(id, ['2']);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM volumes WHERE manga_id = ?').get(id).c, 2);
});
