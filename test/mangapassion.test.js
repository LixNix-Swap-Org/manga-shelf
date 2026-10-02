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

test('getEditionDetailsAndVolumes: an upstream outage is not cached as an empty edition', async () => {
    const realFetch = global.fetch;
    const id = 5151;
    const key = `mp_edition_vols_${id}`;
    db.prepare('DELETE FROM manga_passion_cache WHERE cache_key = ?').run(key);
    try {
        global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
        const down = await mp.getEditionDetailsAndVolumes(id);
        assert.equal(down.incomplete, true);
        assert.equal(db.prepare('SELECT 1 FROM manga_passion_cache WHERE cache_key = ?').get(key), undefined);

        // back online: the next call must fetch again instead of serving the outage from the cache
        global.fetch = async (url) => ({
            ok: true, status: 200,
            json: async () => String(url).includes('/volumes')
                ? { 'hydra:member': [{ id: 1, number: 1, numberDisplay: '1', date: '2020-01-01T00:00:00+00:00', price: 700 }] }
                : { id, title: 'Online', numVolumes: 1, status: 1, publishers: [{ name: 'Carlsen Manga' }] }
        });
        const up = await mp.getEditionDetailsAndVolumes(id);
        assert.equal(up.incomplete, undefined);
        assert.equal(up.volumes.length, 1);
        assert.ok(db.prepare('SELECT 1 FROM manga_passion_cache WHERE cache_key = ?').get(key));
    } finally {
        global.fetch = realFetch;
    }
});

test('getEditionDetailsAndVolumes: during an outage the last cached data is served even when it is stale', async () => {
    const realFetch = global.fetch;
    const id = 5152;
    const key = `mp_edition_vols_${id}`;
    db.prepare(`INSERT INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, 0)
        ON CONFLICT(cache_key) DO UPDATE SET json_data = excluded.json_data, created_at = 0`)
        .run(key, JSON.stringify({ edition: { title: 'Alt', publisher: 'Carlsen Manga', total_volumes: 2, author: 'X' }, volumes: [ov('1'), ov('2')] }));
    try {
        global.fetch = async () => { throw new Error('network down'); };
        const res = await mp.getEditionDetailsAndVolumes(id);
        assert.equal(res.volumes.length, 2);
        assert.equal(res.incomplete, undefined);
    } finally {
        global.fetch = realFetch;
    }
});

test('reconcileMangaGaps: outage without any cached data reports "not reachable" instead of an empty gap list', async () => {
    const realFetch = global.fetch;
    const mangaId = Number(db.prepare('INSERT INTO mangas (title, publisher, total_volumes, manga_passion_id) VALUES (?, ?, ?, ?)')
        .run('Ausfallreihe', 'Carlsen Manga', 3, 5153).lastInsertRowid);
    try {
        global.fetch = async () => { throw new Error('network down'); };
        const res = await mp.reconcileMangaGaps(mangaId);
        assert.equal(res.success, false);
        assert.match(res.message, /nicht erreichbar/);
    } finally {
        global.fetch = realFetch;
    }
});

test('applyAutofillUpdates: a field edited after the snapshot keeps its new value', () => {
    const id = createManga('Autofillreihe', 2);
    addVolume(id, '1', 'Vorhanden');
    const uv = db.prepare('SELECT * FROM volumes WHERE manga_id = ?').get(id);
    // somebody edits the volume while the autofill is still downloading covers
    db.prepare('UPDATE volumes SET notes = ? WHERE id = ?').run('Handgepflegt', uv.id);

    const written = mp.applyAutofillUpdates([{
        uv,
        next: { release_date: '2021-02-03', release_year: 2021, pages: 200, price: 8, publisher: 'Carlsen Manga', cover_image: null, notes: 'Vom Autofill' }
    }]);

    const after = db.prepare('SELECT * FROM volumes WHERE id = ?').get(uv.id);
    assert.equal(written, 1);
    assert.equal(after.notes, 'Handgepflegt');
    assert.equal(after.release_date, '2021-02-03');
    assert.equal(after.pages, 200);
});

test('applyAutofillUpdates: a volume deleted meanwhile is skipped', () => {
    const id = createManga('Autofillreihe 2', 1);
    addVolume(id, '1', 'Vorhanden');
    const uv = db.prepare('SELECT * FROM volumes WHERE manga_id = ?').get(id);
    db.prepare('DELETE FROM volumes WHERE id = ?').run(uv.id);
    assert.equal(mp.applyAutofillUpdates([{ uv, next: { ...uv, pages: 5 } }]), 0);
});

const { findRegularVolume, isSchuberEntry } = require('../services/mangaPassion/classify');

test('findRegularVolume: exact label, then the number inside "Band 5" / "05"', () => {
    const vols = [ov('1'), ov('5'), ov('12', { num: 12 })];
    assert.equal(findRegularVolume(vols, '5').volume_number, '5');
    assert.equal(findRegularVolume(vols, 'Band 12').volume_number, '12');
    assert.equal(findRegularVolume(vols, '05').volume_number, '5');
    assert.equal(findRegularVolume(vols, '99'), null);
    assert.equal(findRegularVolume(vols, 'Special'), null);
});

test('findRegularVolume: a Schuber with the same number is never returned for a regular volume', () => {
    const vols = [ov('1', { specialType: 1, title: 'East Blue Leerschuber' }), ov('1', { id: 7 })];
    assert.equal(findRegularVolume(vols, '1').id, 7);
    assert.equal(isSchuberEntry(vols[0]), true);
    assert.equal(isSchuberEntry(vols[1]), false);
    assert.equal(findRegularVolume([vols[0]], '1'), null);
});

const { isConfidentMatch } = require('../services/mangaPassion/classify');

test('isConfidentMatch: needs a high score and a clear lead over the runner-up', () => {
    assert.equal(isConfidentMatch([]), false);
    assert.equal(isConfidentMatch(undefined), false);
    assert.equal(isConfidentMatch([{ score: 215 }]), true);
    assert.equal(isConfidentMatch([{ score: 119 }]), false);          // too low (e.g. title differs)
    assert.equal(isConfidentMatch([{ score: 185 }, { score: 115 }]), true);
    assert.equal(isConfidentMatch([{ score: 154 }, { score: 150 }]), false); // spin-off almost as good
    assert.equal(isConfidentMatch([{ score: 150 }, { score: 150 }]), false); // tie
    assert.equal(isConfidentMatch([{ score: 140 }, { score: 120 }]), true);  // exactly the minimum lead
});

// Fake Manga Passion API: search results by title, details/volumes by edition id
function fakeApi({ searchResults, editionVolumes = 3 }) {
    return async (url) => {
        const u = String(url);
        const json = (body) => ({ ok: true, status: 200, json: async () => body });
        if (u.includes('/editions?title=')) return json({ 'hydra:member': searchResults });
        const vols = u.match(/\/editions\/(\d+)\/volumes/);
        if (vols) {
            return json({ 'hydra:member': Array.from({ length: editionVolumes }, (_, i) => ({ id: Number(vols[1]) * 10 + i, number: i + 1, numberDisplay: String(i + 1), price: 700, date: '2020-01-01T00:00:00+00:00' })) });
        }
        const ed = u.match(/\/editions\/(\d+)$/);
        if (ed) return json({ id: Number(ed[1]), title: 'Edition ' + ed[1], numVolumes: editionVolumes, status: 1, publishers: [{ name: 'Carlsen Manga' }] });
        return { ok: false, status: 404, json: async () => ({}) };
    };
}
const linkOf = (id) => db.prepare('SELECT manga_passion_id AS v FROM mangas WHERE id = ?').get(id).v;
function createUnlinkedManga(title, total) {
    return Number(db.prepare('INSERT INTO mangas (title, publisher, total_volumes) VALUES (?, ?, ?)').run(title, 'Carlsen Manga', total).lastInsertRowid);
}

test('reconcileMangaGaps: an unambiguous search result is linked and reported as confirmed', async () => {
    const realFetch = global.fetch;
    try {
        global.fetch = fakeApi({ searchResults: [{ id: 6001, title: 'Eindeutige Reihe', numVolumes: 3, status: 1, publishers: [{ name: 'Carlsen Manga' }] }] });
        const id = createUnlinkedManga('Eindeutige Reihe', 3);
        const res = await mp.reconcileMangaGaps(id);
        assert.equal(res.success, true);
        assert.equal(res.link_confirmed, true);
        assert.equal(linkOf(id), 6001);
    } finally { global.fetch = realFetch; }
});

test('reconcileMangaGaps: an ambiguous search result is used for the answer but NOT stored', async () => {
    const realFetch = global.fetch;
    try {
        const twin = (id) => ({ id, title: 'Zwillingsreihe', numVolumes: 3, status: 1, publishers: [{ name: 'Carlsen Manga' }] });
        global.fetch = fakeApi({ searchResults: [twin(6002), twin(6003)] });
        const id = createUnlinkedManga('Zwillingsreihe', 3);
        const res = await mp.reconcileMangaGaps(id);
        assert.equal(res.success, true);
        assert.equal(res.matched, true);
        assert.equal(res.link_confirmed, false);
        assert.equal(linkOf(id), null);
        assert.ok(res.candidate_editions.length >= 2, 'alternatives are offered so the user can pick');
    } finally { global.fetch = realFetch; }
});

test('autofillMangaVolumes: refuses to write into every volume from an unconfirmed edition', async () => {
    const realFetch = global.fetch;
    try {
        const twin = (id) => ({ id, title: 'Zwillingsreihe Zwei', numVolumes: 3, status: 1, publishers: [{ name: 'Carlsen Manga' }] });
        global.fetch = fakeApi({ searchResults: [twin(6004), twin(6005)] });
        const id = createUnlinkedManga('Zwillingsreihe Zwei', 3);
        addVolume(id, '1', 'Vorhanden');
        const res = await mp.autofillMangaVolumes(id);
        assert.equal(res.success, false);
        assert.equal(res.needs_confirmation, true);
        assert.equal(res.updated_count, 0);
        assert.equal(linkOf(id), null);
        assert.equal(db.prepare('SELECT release_date FROM volumes WHERE manga_id = ?').get(id).release_date, null);
    } finally { global.fetch = realFetch; }
});

test('reconcileMangaGaps: an already linked edition is always confirmed', async () => {
    seedEdition([ov('1'), ov('2')]);
    const id = createManga('Verknuepfte Reihe', 2);
    const res = await mp.reconcileMangaGaps(id);
    assert.equal(res.link_confirmed, true);
});
