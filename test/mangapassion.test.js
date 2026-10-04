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

test('batchImportGaps: a Manga-Passion cover is stored as a local upload, an unreachable one keeps the remote URL', async () => {
    const crypto = require('crypto');
    const localUrl = 'https://cdn.manga-passion.de/covers/import-local.jpg';
    const hash = crypto.createHash('md5').update(localUrl).digest('hex').slice(0, 16);
    const uploads = path.join(dataDir, 'uploads');
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, `mp-cov-${hash}.jpg`), Buffer.alloc(800, 1));
    const failingUrl = 'https://127.0.0.1/covers/import-fail.jpg';
    seedEdition([ov('1'), ov('2', { cover_image: localUrl }), ov('3', { cover_image: failingUrl }), ov('4', { cover_image: localUrl })]);
    const id = createManga('Cover-Import', 4);
    addVolume(id, '1');
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status, type, cover_image) VALUES (?, '4', 'Fehlt', 'volume', '/uploads/own.jpg')").run(id);

    await mp.batchImportGaps(id, ['2', '3', '4'], 'Fehlt');
    const cover = (n) => db.prepare('SELECT cover_image FROM volumes WHERE manga_id = ? AND volume_number = ?').get(id, n).cover_image;
    assert.equal(cover('2'), `/uploads/mp-cov-${hash}.jpg`);
    assert.equal(cover('3'), failingUrl);
    assert.equal(cover('4'), '/uploads/own.jpg', 'an existing cover is kept');
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
        assert.match(res.message, /„Edition bestätigen“/);
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

const { titleKey, titleRelation, buildSearchQueries } = require('../services/mangaPassion/classify');

test('titleKey: apostrophes, dots and punctuation do not make two spellings differ', () => {
    assert.equal(titleKey("Hell's Paradise"), titleKey('Hells Paradise'));
    assert.equal(titleKey('ONE-PUNCH MAN'), titleKey('One Punch Man'));
    assert.equal(titleKey('Akame ga Kill!'), 'akame ga kill');
    assert.equal(titleKey("Komi can't communicate"), titleKey('Komi can´t communicate'));
});

test('titleRelation: exact / candidate-longer / target-longer / fuzzy', () => {
    assert.equal(titleRelation('Eyeshield 21', 'Eyeshield21'), 'exact');
    assert.equal(titleRelation('Pochi & Kuro', 'Pochi&Kuro'), 'exact');
    assert.equal(titleRelation('Mashle: Magic and Muscles', 'Mashle'), 'candidate-longer');
    assert.equal(titleRelation('Dragon Ball', 'Dragon Ball max'), 'target-longer');
    assert.equal(titleRelation('Magilumiere Inc.', 'Dandadan'), 'fuzzy');
});

test('buildSearchQueries: other spellings for hyphens, apostrophes and glued numbers, rare words as fallback', () => {
    const one = buildSearchQueries('One Punch Man');
    assert.ok(one.variants.includes('One-Punch Man') && one.variants.includes('One-Punch-Man'));
    assert.ok(buildSearchQueries('Hells Paradise').variants.includes("Hell's Paradise"));
    assert.ok(buildSearchQueries('Eyeshield21').variants.includes('Eyeshield 21'));
    assert.ok(one.primary.includes('One Punch Man'));
    assert.deepEqual(buildSearchQueries('Berserk Deluxe').words, ['berserk']); // "deluxe" is a stop word
    assert.deepEqual(buildSearchQueries('   ').primary, []);
});

test('scoreEdition: a similar title is needed before publisher and volume count add anything', () => {
    const unrelated = { title: 'Dada Adventure', numVolumes: 5, publishers: [{ name: 'Altraverse' }] };
    assert.ok(mp.scoreEdition(unrelated, 'JoJo Bizarre Adventure Part 1', 'Altraverse', 5) < 20);
    const punctuation = { title: "Hell's Paradise", numVolumes: 13, publishers: [{ name: 'KAZÉ Manga' }] };
    assert.ok(mp.scoreEdition(punctuation, 'Hells Paradise', 'Kazé Manga', 13) >= 100);
});

test('isConfidentMatch: a series title with extra words is not linked to the plain series', () => {
    assert.equal(isConfidentMatch([{ score: 145, title_relation: 'target-longer' }, { score: 85 }]), false);
    assert.equal(isConfidentMatch([{ score: 145, title_relation: 'candidate-longer' }, { score: 85 }]), true);
    assert.equal(isConfidentMatch([{ score: 200, title_relation: 'fuzzy' }]), false);
});

test('searchMangaPassionEditions: finds "One Punch Man" via the hyphenated spelling the API needs', async () => {
    const realFetch = global.fetch;
    const asked = [];
    try {
        global.fetch = async (url) => {
            const q = decodeURIComponent(String(url).split('title=')[1].split('&')[0]);
            asked.push(q);
            const hit = q === 'One-Punch Man';
            return { ok: true, status: 200, json: async () => ({ 'hydra:member': hit ? [{ id: 7001, title: 'ONE-PUNCH MAN', numVolumes: 32, status: 1, publishers: [{ name: 'KAZÉ Manga' }] }] : [] }) };
        };
        const res = await mp.searchMangaPassionEditions('One Punch Man', 'Kazé Manga', 30);
        assert.equal(res.recommended?.id, 7001);
        assert.ok(asked.includes('One Punch Man') && asked.includes('One-Punch Man'));
    } finally { global.fetch = realFetch; }
});

test('searchMangaPassionEditions: a hopeless title yields no recommendation instead of a random edition', async () => {
    const realFetch = global.fetch;
    try {
        global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ 'hydra:member': [{ id: 7002, title: 'Ganz Etwas Anderes', numVolumes: 5, status: 1, publishers: [{ name: 'Carlsen Manga' }] }] }) });
        const res = await mp.searchMangaPassionEditions('Zzyzx Qwerty', 'Carlsen Manga', 5);
        assert.equal(res.recommended, null);
    } finally { global.fetch = realFetch; }
});

const { classifyOfficialVolume, findOfficialVolume, matchSchuberVolume } = require('../services/mangaPassion/classify');

test('classifyOfficialVolume: structured fields decide, title words only as whole words', () => {
    const cases = [
        [{ volume_number: '12', title: 'Der Boxer', type: 0, specialType: null }, 'volume'],
        [{ volume_number: '4', title: 'Expedition ins Nichts', type: 0, specialType: null }, 'volume'],
        [{ volume_number: '7', title: 'Extra Large', type: 0, specialType: null }, 'volume'],
        [{ volume_number: '5', title: 'Collectors Edition', type: 3, specialType: 0 }, 'special_edition'],
        [{ volume_number: '1', title: 'Water 7 Set', type: 3, specialType: 1 }, 'schuber'],
        [{ volume_number: 'Special', title: 'Winter Edition', type: 0 }, 'special'],
        // fixtures and old caches without type: anchored title heuristics
        [{ volume_number: '12', title: 'Der Boxer' }, 'volume'],
        [{ volume_number: '3', title: 'Jukebox' }, 'volume'],
        [{ volume_number: '4', title: 'Expedition ins Nichts' }, 'volume'],
        [{ volume_number: '5', title: 'Extraklasse' }, 'volume'],
        [{ volume_number: '6', title: 'Extraterrestrisch' }, 'volume'],
        [{ volume_number: 'Special', title: 'East Blue Leerschuber' }, 'schuber'],
        [{ volume_number: 'Special', title: 'Sammelschuber 1' }, 'schuber'],
        [{ volume_number: 'Special', title: 'Box Set 1' }, 'schuber'],
        [{ volume_number: '1', title: 'Slipcase' }, 'schuber'],
        [{ volume_number: '5', title: 'Collectors Edition', specialType: 0 }, 'special_edition'],
        [{ volume_number: '5', title: "Collector's Edition", specialType: null }, 'special_edition'],
        [{ volume_number: '14', title: 'Limited Edition' }, 'special_edition'],
        [{ volume_number: 'Special', title: 'Guidebook' }, 'special'],
        [{ volume_number: '5', title: '' }, 'volume']
    ];
    for (const [v, want] of cases) assert.equal(classifyOfficialVolume(v), want, JSON.stringify(v));
});

test('isSchuberEntry and classifyOfficialVolume agree on every entry', () => {
    const entries = [
        { title: 'Slipcase', volume_number: '1' }, { type: 3, title: 'Water 7 Set', volume_number: '2' },
        { type: 3, specialType: 0, title: 'Box Collectors Edition', volume_number: '2' }, { title: 'Boxer 1', volume_number: '1' },
        { volume_number: 'Schuber 2' }, { specialType: 1, volume_number: '3' }, { title: 'Die Box', type: 0, volume_number: '9' },
        { title: 'East Blue Leerschuber', volume_number: 'Special', type: 0 }, { title: 'Band 5', volume_number: '5' }
    ];
    for (const v of entries) {
        assert.equal(classifyOfficialVolume(v) === 'schuber', isSchuberEntry(v), JSON.stringify(v));
        if (findRegularVolume([v], v.volume_number)) assert.equal(matchSchuberVolume([v], v.volume_number), null, JSON.stringify(v));
    }
});

test('findRegularVolume: a chapter title with "Box" / "Edition" in it is still the regular volume', () => {
    const boxer = { volume_number: '12', num: 12, title: 'Der Boxer' };
    assert.equal(findRegularVolume([boxer], '12'), boxer);
    assert.equal(isSchuberEntry(boxer), false);
    const extra = { volume_number: '7', num: 7, title: 'Extra Large', type: 0, specialType: null };
    assert.equal(findRegularVolume([extra], '7'), extra);
});

test('findRegularVolume: never returns the Collectors Edition of the same number, whatever the order', () => {
    const ceFirst = { id: 10, volume_number: '5', num: 5, title: 'Collectors Edition', specialType: 2, price: 20 };
    const regular = { id: 11, volume_number: '5', num: 5, price: 7 };
    assert.equal(findRegularVolume([ceFirst, regular], '5').id, 11);
    assert.equal(findRegularVolume([regular, ceFirst], '5').id, 11);
    assert.equal(findRegularVolume([ceFirst, regular], 'Band 5').id, 11);
    assert.equal(findRegularVolume([{ id: 12, volume_number: '6', num: 6, title: 'Limited Edition', specialType: null }], '6'), null);
    assert.equal(findRegularVolume([{ type: 3, volume_number: '2', num: 2, specialType: 1 }, { id: 2, volume_number: '2', num: 2 }], '2').id, 2);
});

test('findOfficialVolume: a special edition is matched by its number, never another number or the regular volume', () => {
    const vols = [
        ov('1'), ov('7'),
        ov('1', { id: 101, title: 'Collectors Edition', type: 3, specialType: 0, num: 1 }),
        ov('7', { id: 107, title: 'Collectors Edition', type: 3, specialType: 0, num: 7 }),
        ov('7', { id: 117, title: 'Limited Edition', type: 3, specialType: 0, num: 7, price: 20 })
    ];
    assert.equal(findOfficialVolume(vols, '7', 'special_edition').id, 107);
    assert.equal(findOfficialVolume(vols, '7', 'special_edition', { notes: 'Limited Edition' }).id, 117);
    assert.equal(findOfficialVolume(vols, 'Limited Edition 7', 'special_edition').id, 117);
    assert.equal(findOfficialVolume(vols, '7', 'special_edition', { price: 19 }).id, 117);
    assert.equal(findOfficialVolume(vols, '5', 'special_edition'), null);
    assert.equal(findOfficialVolume(vols, '1', 'special_edition').id, 101);
});

test('findOfficialVolume: a Special is matched by name, never by a digit', () => {
    const vols = [ov('1'), ov('Special', { id: 950, title: 'Fanbook', type: 0 })];
    assert.equal(findOfficialVolume(vols, 'Fanbook', 'special').id, 950);
    assert.equal(findOfficialVolume(vols, 'Special 1', 'special'), null);
});

test('matchSchuberVolume: a Schuber number without an official Schuber gives null', () => {
    const vols = [
        { ...ov('Special', { id: 1 }), title: 'East Blue Leerschuber', specialType: 1, price: 12 },
        { ...ov('Special', { id: 2 }), title: 'Alabasta Leerschuber', specialType: 1, price: 12 }
    ];
    assert.equal(matchSchuberVolume(vols, 'Schuber 7', 12, ''), null);
    assert.equal(matchSchuberVolume(vols, 'Schuber 0', 12, ''), null);
    assert.equal(matchSchuberVolume(vols, 'Schuber', 12, '').id, 1);
});

test('matchSchuberVolume: falls back to the other kind of Schuber before giving up', () => {
    const vols = [
        { ...ov('Special', { id: 1 }), title: 'Leerschuber A', specialType: 1, price: 12, release_date: '2020-01-01' },
        { ...ov('Special', { id: 2 }), title: 'Leerschuber B', specialType: 1, price: 12, release_date: '2020-02-01' },
        { ...ov('Special', { id: 11 }), title: 'Sammelschuber 1', specialType: 1, price: 40 },
        { ...ov('Special', { id: 12 }), title: 'Sammelschuber 2', specialType: 1, price: 40 },
        { ...ov('Special', { id: 13 }), title: 'Sammelschuber 3', specialType: 1, price: 40 }
    ];
    assert.equal(matchSchuberVolume(vols, 'Schuber 3', null, '').id, 13);
    assert.equal(matchSchuberVolume(vols, 'Schuber 2', null, '').id, 2);
});

test('scoreEdition: a companion book is not penalised on its own exact title, only when the target lacks the word', () => {
    const base = { numVolumes: 5, publishers: [] };
    const self = (title) => mp.scoreEdition({ ...base, title }, title, '', 5);
    assert.equal(self('Arifureta Spin-off'), self('Arifureta Guide'));
    assert.equal(self('Naruto Kochbuch'), self('Naruto Abcdefg'));
    assert.equal(self('Naruto Artworks'), self('Naruto Abcdefgh'));
    assert.ok(mp.scoreEdition({ ...base, title: 'Arifureta Spin-off' }, 'Arifureta', '', 5) + 20 <= self('Arifureta'));
    // a Guide target does not exempt a Kochbuch candidate
    const kochbuch = { ...base, title: 'Naruto Guide Kochbuch' };
    assert.equal(mp.scoreEdition(kochbuch, 'Naruto Guide', '', 5) - mp.scoreEdition({ ...base, title: 'Naruto Guide Abcdefg' }, 'Naruto Guide', '', 5), -40);
    // "Romance" is no "Roman"
    const romance = { ...base, title: 'Romance Dawn' };
    assert.equal(mp.scoreEdition(romance, 'One Piece', '', 5), mp.scoreEdition({ ...base, title: 'Abcdefg Dawn' }, 'One Piece', '', 5));
});

function seedEditionAs(editionId, volumes, edition) {
    db.prepare(`
        INSERT INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET json_data = excluded.json_data, created_at = excluded.created_at
    `).run(`mp_edition_vols_${editionId}`, JSON.stringify({ edition, volumes }), Date.now());
}
const offlineFetch = async () => { throw new Error('network down'); };

test('autofillMangaVolumes: an outage without cached data says "nicht erreichbar", a 404 edition says "nicht gefunden"', async () => {
    const realFetch = global.fetch;
    try {
        global.fetch = offlineFetch;
        const down = Number(db.prepare('INSERT INTO mangas (title, publisher, total_volumes, manga_passion_id) VALUES (?, ?, ?, ?)')
            .run('Autofill Ausfall', 'Carlsen Manga', 2, 5161).lastInsertRowid);
        addVolume(down, '1');
        const res = await mp.autofillMangaVolumes(down);
        assert.equal(res.success, false);
        assert.match(res.message, /nicht erreichbar/);
        assert.equal(res.updated_count, 0);
        assert.equal(db.prepare('SELECT release_date FROM volumes WHERE manga_id = ?').get(down).release_date, null);

        global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
        const gone = Number(db.prepare('INSERT INTO mangas (title, publisher, total_volumes, manga_passion_id) VALUES (?, ?, ?, ?)')
            .run('Autofill 404', 'Carlsen Manga', 2, 5162).lastInsertRowid);
        const res404 = await mp.autofillMangaVolumes(gone);
        assert.equal(res404.success, false);
        assert.match(res404.message, /nicht gefunden/);
    } finally { global.fetch = realFetch; }
});

test('autofillMangaVolumes: the "Unbekannt" edition publisher never replaces the series publisher', async () => {
    const realFetch = global.fetch;
    try {
        global.fetch = offlineFetch;
        seedEditionAs(5163, [ov('1', { release_date: '2020-01-01' }), ov('2', { release_date: '2020-02-01' }), ov('3')],
            { title: 'Ohne Verlag', publisher: 'Unbekannt', total_volumes: 3, author: null });
        const id = Number(db.prepare('INSERT INTO mangas (title, publisher, total_volumes, manga_passion_id) VALUES (?, ?, ?, ?)')
            .run('Ohne Verlag', 'Carlsen Manga', 3, 5163).lastInsertRowid);
        addVolume(id, '1');
        addVolume(id, '2');
        addVolume(id, '3');
        db.prepare("UPDATE volumes SET publisher = 'Unbekannt' WHERE manga_id = ? AND volume_number = '2'").run(id);
        db.prepare("UPDATE volumes SET publisher = 'Egmont Manga' WHERE manga_id = ? AND volume_number = '3'").run(id);

        const res = await mp.autofillMangaVolumes(id, { overwrite: true });
        assert.equal(res.success, true);
        const pubs = Object.fromEntries(db.prepare('SELECT volume_number, publisher FROM volumes WHERE manga_id = ?').all(id).map(r => [r.volume_number, r.publisher]));
        assert.deepEqual(pubs, { 1: 'Carlsen Manga', 2: 'Carlsen Manga', 3: 'Egmont Manga' });

        const again = await mp.autofillMangaVolumes(id, { overwrite: true });
        assert.equal(again.updated_count, 0, 'unchanged rows are not counted as updates');

        const lookup = await mp.lookupVolumeMetadata(id, '1');
        assert.equal(lookup.matched, true);
        assert.equal(lookup.data.publisher, 'Carlsen Manga');
    } finally { global.fetch = realFetch; }
});

test('autofillMangaVolumes: a Schuber number the edition does not have stays untouched', async () => {
    const realFetch = global.fetch;
    try {
        global.fetch = offlineFetch;
        seedEdition([
            ov('1'),
            { ...ov('Special', { id: 9801 }), title: 'East Blue Leerschuber', specialType: 1, price: 12, release_date: '2020-01-01' },
            { ...ov('Special', { id: 9802 }), title: 'Alabasta Leerschuber', specialType: 1, price: 12, release_date: '2020-02-01' }
        ]);
        const id = createManga('Schuber-Autofill', 1);
        addVolume(id, 'Schuber 5', 'Vorhanden', { type: 'schuber' });
        await mp.autofillMangaVolumes(id);
        const row = db.prepare('SELECT notes, price, release_date, cover_image FROM volumes WHERE manga_id = ?').get(id);
        assert.deepEqual({ ...row }, { notes: null, price: null, release_date: null, cover_image: null });
    } finally { global.fetch = realFetch; }
});
