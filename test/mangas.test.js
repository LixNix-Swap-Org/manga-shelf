const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let editor;
let db;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    editor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
    db = require('../db').db;
});

test.after(async () => { await ctx.close(); });

const detail = async (id) => (await editor('GET', `/mangas/${id}`)).body;
const listRow = async (id) => (await editor('GET', '/mangas')).body.find(m => m.id === id);
const createManga = async (body) => {
    const res = await editor('POST', '/mangas', body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id;
};
const addVolume = async (mangaId, volume_number, status = 'Vorhanden') => {
    const res = await editor('POST', '/volumes', { manga_id: mangaId, volume_number, status });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id;
};
const read = (volumeId) => editor('POST', `/volumes/${volumeId}/read`, { read: true });
const myStats = (m) => m.reader_stats.find(r => r.username === 'ed');
const volumeCount = (mangaId) => db.prepare('SELECT count(*) AS n FROM volumes WHERE manga_id = ?').get(mangaId).n;

// Manga Passion is faked; everything else (the test client itself) goes to the real fetch
function withFakeMangaPassion(handler) {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
        const u = String(url);
        if (u.startsWith(ctx.base)) return realFetch(url, opts);
        calls.push(u);
        return handler(u);
    };
    return { calls, restore: () => { global.fetch = realFetch; } };
}

test('reader stats: reads of volumes that are not owned do not count', async () => {
    const id = await createManga({ title: 'Leser Nicht Besessen' });
    await addVolume(id, '1');
    const v2 = await addVolume(id, '2', 'Fehlt');
    const v3 = await addVolume(id, '3', 'Fehlt');
    await read(v2);
    await read(v3);

    const stats = myStats(await detail(id));
    assert.deepEqual(
        { read_count: stats.read_count, total_owned: stats.total_owned, unread_count: stats.unread_count, percentage: stats.percentage },
        { read_count: 0, total_owned: 1, unread_count: 1, percentage: 0 }
    );
    assert.equal((await listRow(id)).read_volume_count, 0);
});

test('reader stats: giving up ownership keeps the read, but it stops counting until owned again', async () => {
    const id = await createManga({ title: 'Leser Verkauft' });
    const v1 = await addVolume(id, '1');
    const v2 = await addVolume(id, '2');
    await read(v1);
    await read(v2);
    assert.equal((await editor('POST', `/volumes/${v2}/owners`, { owned: false })).body.status, 'Fehlt');

    let m = await detail(id);
    let stats = myStats(m);
    assert.equal(stats.read_count, 1);
    assert.equal(stats.total_owned, 1);
    assert.equal(stats.unread_count, 0);
    assert.equal(stats.percentage, 100);
    assert.equal(m.volumes.find(v => v.id === v2).is_read, true, 'read history is kept');
    let row = await listRow(id);
    assert.equal(row.read_volume_count, 1);
    assert.equal(row.owned_volumes, 1);

    assert.equal((await editor('POST', `/volumes/${v2}/owners`, { owned: true })).body.status, 'Vorhanden');
    stats = myStats(await detail(id));
    assert.equal(stats.read_count, 2);
    assert.equal(stats.percentage, 100);
    row = await listRow(id);
    assert.equal(row.read_volume_count, 2);
});

test('reader stats: only an unowned read volume does not make the series look finished', async () => {
    const id = await createManga({ title: 'Leser Falscher Haken' });
    await addVolume(id, '1');
    const v2 = await addVolume(id, '2');
    await read(v2);
    await editor('POST', `/volumes/${v2}/owners`, { owned: false });
    const stats = myStats(await detail(id));
    assert.equal(stats.read_count, 0);
    assert.equal(stats.unread_count, 1);
    const row = await listRow(id);
    assert.ok(row.read_volume_count < row.owned_volumes);
});

test('POST /mangas: series status is checked against the known values', async () => {
    assert.equal((await editor('POST', '/mangas', { title: 'S1', status: { x: 1 } })).status, 400);
    assert.equal((await editor('POST', '/mangas', { title: 'S2', status: 'Quatsch' })).status, 400);
    const cancelled = await createManga({ title: 'S3', status: 'Abgebrochen' });
    assert.equal((await detail(cancelled)).status, 'Abgebrochen');
    const unknown = await createManga({ title: 'S4', status: 'Unbekannt' });
    assert.equal((await detail(unknown)).status, 'Laufend');
    const none = await createManga({ title: 'S5' });
    assert.equal((await detail(none)).status, 'Laufend');
});

test('POST /mangas: non-text fields are rejected, not stored as [object Object]', async () => {
    assert.equal((await editor('POST', '/mangas', { title: 'T1', alt_title: { x: 1 } })).status, 400);
    assert.equal((await editor('POST', '/mangas', { title: 'T2', tags: ['a', 'b'] })).status, 400);
    assert.equal((await editor('POST', '/mangas', { title: 'T3', publisher: { name: 'x' } })).status, 400);
    assert.equal((await editor('POST', '/mangas', { title: 'T4', cover_image: 'x'.repeat(3000) })).status, 400);
    const id = await createManga({ title: 'T5', author: 'a'.repeat(1000), language: '', tags: '  ' });
    const m = await detail(id);
    assert.equal(m.author.length, 300);
    assert.equal(m.language, 'Deutsch');
    assert.equal(m.tags, null);
});

test('PUT /mangas/:id: wrong types are a 400 (not a 500) and limits match POST', async () => {
    const id = await createManga({ title: 'Put Validierung', author: 'Alt' });
    for (const body of [{ author: { a: 1 } }, { tags: ['a', 'b'] }, { description: ['x'] }, { status: { x: 1 } }, { status: 'Quatsch' }, { banner_image: 'x'.repeat(3000) }]) {
        const res = await editor('PUT', `/mangas/${id}`, body);
        assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await editor('PUT', `/mangas/${id}`, { alt_title: 'x'.repeat(90000), author: 'a'.repeat(10000) })).status, 200);
    const m = await detail(id);
    assert.equal(m.alt_title.length, 300);
    assert.equal(m.author.length, 300);
    assert.equal((await editor('PUT', `/mangas/${id}`, { status: 'Abgebrochen' })).status, 200);
    assert.equal((await detail(id)).status, 'Abgebrochen');
});

test('PUT /mangas/:id: a stored status from before the whitelist does not block other edits', async () => {
    const id = await createManga({ title: 'Altstatus' });
    db.prepare("UPDATE mangas SET status = 'Unbekannt' WHERE id = ?").run(id);
    const res = await editor('PUT', `/mangas/${id}`, { title: 'Altstatus neu', status: 'Unbekannt' });
    assert.equal(res.status, 200);
    const m = await detail(id);
    assert.equal(m.title, 'Altstatus neu');
    assert.equal(m.status, 'Unbekannt');
});

test('total_volumes: invalid values are a 400 and keep the stored total; empty clears it; POST and PUT agree', async () => {
    const id = await createManga({ title: 'Gesamtzahl', total_volumes: 20 });
    for (const bad of [6000, -1, 'abc', '12abc', 12.5, { n: 1 }]) {
        assert.equal((await editor('PUT', `/mangas/${id}`, { total_volumes: bad })).status, 400, JSON.stringify(bad));
        assert.equal((await detail(id)).total_volumes, 20);
        assert.equal((await editor('POST', '/mangas', { title: 'Gesamt falsch', total_volumes: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await editor('PUT', `/mangas/${id}`, {})).status, 200);
    assert.equal((await detail(id)).total_volumes, 20);
    assert.equal((await editor('PUT', `/mangas/${id}`, { total_volumes: '25' })).status, 200);
    assert.equal((await detail(id)).total_volumes, 25);
    assert.equal((await editor('PUT', `/mangas/${id}`, { total_volumes: '' })).status, 200);
    assert.equal((await detail(id)).total_volumes, null);
    await editor('PUT', `/mangas/${id}`, { total_volumes: 7 });
    assert.equal((await editor('PUT', `/mangas/${id}`, { total_volumes: null })).status, 200);
    assert.equal((await detail(id)).total_volumes, null);

    await editor('PUT', `/mangas/${id}`, { total_volumes: 7 });
    assert.equal((await editor('PUT', `/mangas/${id}`, { total_volumes: 0 })).status, 200);
    assert.equal((await detail(id)).total_volumes, null);
    const zero = await createManga({ title: 'Gesamt null', total_volumes: 0 });
    assert.equal((await detail(zero)).total_volumes, null);
});

test('owned_volumes is derived: PUT ignores it and a stale stored counter is not shown', async () => {
    const id = await createManga({ title: 'Besitzzaehler' });
    await addVolume(id, '1');
    for (const value of [999, -5]) {
        assert.equal((await editor('PUT', `/mangas/${id}`, { owned_volumes: value })).status, 200);
        assert.equal((await detail(id)).owned_volumes, 1);
        assert.equal((await listRow(id)).owned_volumes, 1);
    }
    db.prepare('UPDATE mangas SET owned_volumes = 0 WHERE id = ?').run(id);
    assert.equal((await detail(id)).owned_volumes, 1);
    assert.equal((await listRow(id)).owned_volumes, 1);
});

test('manga_passion_id: PUT without the field keeps the link, an invalid id is a 400, null unlinks', async () => {
    const id = await createManga({ title: 'Verknuepfung' });
    db.prepare('UPDATE mangas SET manga_passion_id = 777 WHERE id = ?').run(id);
    assert.equal((await editor('PUT', `/mangas/${id}`, { title: 'Verknuepfung 2' })).status, 200);
    assert.equal((await detail(id)).manga_passion_id, 777);
    assert.equal((await editor('PUT', `/mangas/${id}`, { manga_passion_id: 'abc' })).status, 400);
    assert.equal((await editor('PUT', `/mangas/${id}`, { manga_passion_id: -3 })).status, 400);
    assert.equal((await detail(id)).manga_passion_id, 777);
    assert.equal((await editor('PUT', `/mangas/${id}`, { manga_passion_id: '778' })).status, 200);
    assert.equal((await detail(id)).manga_passion_id, 778);
    assert.equal((await editor('PUT', `/mangas/${id}`, { manga_passion_id: null })).status, 200);
    assert.equal((await detail(id)).manga_passion_id, null);
    assert.equal((await editor('POST', '/mangas', { title: 'MP falsch', manga_passion_id: 'mp_1' })).status, 400);
});

test('GET /mangas leaves out description and edition data; the detail keeps the description only', async () => {
    const id = await createManga({ title: 'Schlanke Liste', description: 'Lange Beschreibung' });
    await addVolume(id, '1');
    db.prepare('UPDATE mangas SET manga_passion_edition_data = ? WHERE id = ?').run(JSON.stringify({ description: 'x' }), id);

    const row = await listRow(id);
    assert.equal('description' in row, false);
    assert.equal('manga_passion_edition_data' in row, false);
    for (const key of ['title', 'cover_image', 'owned_volumes', 'volume_count', 'read_volume_count', 'regular_owned', 'max_regular_number', 'total_value', 'manga_passion_id', 'status', 'total_volumes']) {
        assert.ok(key in row, key);
    }
    const m = await detail(id);
    assert.equal(m.description, 'Lange Beschreibung');
    assert.equal('manga_passion_edition_data' in m, false);
});

test('batch-import-gaps: target_status must be an import status', async () => {
    const id = await createManga({ title: 'Luecken Status' });
    for (const target_status of ['Vorhanden', 'Gelesen', 'Quatsch', { a: 1 }, 5]) {
        const res = await editor('POST', `/mangas/${id}/batch-import-gaps`, { volume_numbers: ['2', '3'], target_status });
        assert.equal(res.status, 400, JSON.stringify(target_status));
    }
    assert.equal(volumeCount(id), 0);

    const ok = await editor('POST', `/mangas/${id}/batch-import-gaps`, { volume_numbers: ['2'], target_status: 'Bestellt' });
    assert.equal(ok.status, 200);
    const plain = await editor('POST', `/mangas/${id}/batch-import-gaps`, { volume_numbers: ['3'] });
    assert.equal(plain.status, 200);
    const m = await detail(id);
    assert.deepEqual(m.volumes.map(v => [v.volume_number, v.status, v.owners.length]), [['2', 'Bestellt', 0], ['3', 'Fehlt', 0]]);
    assert.equal(m.owned_volumes, 0);
});

test('batch-import-gaps: an existing Fehlt volume is not promoted to an ownerless Vorhanden', async () => {
    const id = await createManga({ title: 'Luecken Fehlt' });
    await addVolume(id, '1', 'Fehlt');
    assert.equal((await editor('POST', `/mangas/${id}/batch-import-gaps`, { volume_numbers: ['1'], target_status: 'Vorhanden' })).status, 400);
    assert.equal((await detail(id)).volumes[0].status, 'Fehlt');
    const orphans = db.prepare(`SELECT count(*) AS n FROM volumes v WHERE v.status = 'Vorhanden'
        AND NOT EXISTS (SELECT 1 FROM volume_owners vo WHERE vo.volume_id = v.id)`).get().n;
    assert.equal(orphans, 0);
});

test('batch-import-gaps: volume_numbers entries and count are validated', async () => {
    const id = await createManga({ title: 'Luecken Eintraege' });
    const post = (body) => editor('POST', `/mangas/${id}/batch-import-gaps`, body);
    assert.equal((await post({ volume_numbers: [null, {}, '', '   '] })).status, 400);
    assert.equal((await post({ volume_numbers: [null, '3'] })).status, 400);
    assert.equal((await post({ volume_numbers: [true] })).status, 400);
    assert.equal((await post({ volume_numbers: ['x'.repeat(201)] })).status, 400);
    assert.equal((await post({ volume_numbers: Array.from({ length: 501 }, (_, i) => String(i + 1)) })).status, 400);
    assert.equal((await post({ volume_numbers: ['4'], edition_id: 'abc' })).status, 400);
    assert.equal((await post({ volume_numbers: ['4'], edition_id: -2 })).status, 400);
    assert.equal(volumeCount(id), 0);

    const res = await post({ volume_numbers: [' 4 ', 5, '6 (Titel des Bandes)', 'x'.repeat(81)] });
    assert.equal(res.status, 200);
    assert.equal(res.body.imported_count, 3);
    assert.equal(res.body.skipped_invalid_count, 1);
    assert.deepEqual((await detail(id)).volumes.map(v => v.volume_number), ['4', '5', '6']);
});

test('GET /mangas/:id/gaps: a malformed edition_id is a 400', async () => {
    const id = await createManga({ title: 'Luecken Abfrage' });
    const fake = withFakeMangaPassion(() => { throw new Error('no network'); });
    try {
        for (const q of ['abc', '12abc', '-5', '1.5']) {
            assert.equal((await editor('GET', `/mangas/${id}/gaps?edition_id=${q}`)).status, 400, q);
        }
        assert.equal(fake.calls.length, 0);
    } finally { fake.restore(); }
});

test('sync-edition: edition_id must be a positive integer; nothing is fetched otherwise', async () => {
    const id = await createManga({ title: 'Sync Validierung' });
    const fake = withFakeMangaPassion(() => { throw new Error('no network'); });
    try {
        for (const edition_id of ['abc', -5, 1.5, 0, '77/', { a: 1 }]) {
            assert.equal((await editor('POST', `/mangas/${id}/sync-edition`, { edition_id })).status, 400, JSON.stringify(edition_id));
        }
        assert.equal((await editor('POST', `/mangas/${id}/sync-edition`, {})).status, 400);
        assert.equal(fake.calls.length, 0);
        assert.equal((await detail(id)).manga_passion_id, null);
    } finally { fake.restore(); }
});

test('sync-edition: unknown edition is a 404, an unreachable Manga Passion a 503', async () => {
    const id = await createManga({ title: 'Sync Fehler' });
    let fake = withFakeMangaPassion(() => ({ ok: false, status: 404, json: async () => ({}) }));
    try {
        const res = await editor('POST', `/mangas/${id}/sync-edition`, { edition_id: 880001 });
        assert.equal(res.status, 404);
        assert.match(res.body.error, /Edition/);
    } finally { fake.restore(); }

    fake = withFakeMangaPassion(() => { throw new Error('ECONNREFUSED'); });
    try {
        const res = await editor('POST', `/mangas/${id}/sync-edition`, { edition_id: 880002 });
        assert.equal(res.status, 503);
        const cached = db.prepare("SELECT json_data FROM manga_passion_cache WHERE cache_key = 'mp_edition_vols_880002'").get();
        assert.equal(cached, undefined, 'an outage is not cached as not found');
    } finally { fake.restore(); }
    assert.equal((await detail(id)).manga_passion_id, null);
});

test('sync-edition: a digit string is stored as a number and the flags are parsed strictly', async () => {
    const id = await createManga({ title: 'Sync Flags', total_volumes: 9, status: 'Pausiert' });
    db.prepare(`INSERT INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, ?)`)
        .run('mp_edition_vols_880003', JSON.stringify({
            edition: { id: 880003, title: 'Sync Flags', publisher: 'Carlsen Manga', total_volumes: 12, status: 'Abgeschlossen', author: 'X' },
            volumes: []
        }), Date.now());
    const res = await editor('POST', `/mangas/${id}/sync-edition`, { edition_id: '880003', update_total_volumes: 'false', update_status: 'false' });
    assert.equal(res.status, 200);
    let m = await detail(id);
    assert.equal(m.manga_passion_id, 880003);
    assert.equal(m.total_volumes, 9);
    assert.equal(m.status, 'Pausiert');

    assert.equal((await editor('POST', `/mangas/${id}/sync-edition`, { edition_id: 880003, update_status: true })).status, 200);
    m = await detail(id);
    assert.equal(m.total_volumes, 12);
    assert.equal(m.status, 'Abgeschlossen');
});

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const editionApi = (editionId, title) => (u) => {
    if (u.includes('/editions?title=')) {
        return json({ 'hydra:member': [{ id: editionId, title, numVolumes: 3, status: 1, publishers: [{ name: 'Carlsen Manga' }] }] });
    }
    if (u.includes(`/editions/${editionId}/volumes`)) return json({ 'hydra:member': [{ id: editionId * 10 + 1, number: 1, numberDisplay: '1', price: 700, date: '2020-01-01' }] });
    if (u.endsWith(`/editions/${editionId}`)) return json({ id: editionId, title, numVolumes: 3, status: 1, publishers: [{ name: 'Carlsen Manga' }] });
    return json({}, 404);
};

test('progress: volume 0 is an extra like in the stats; duplicates are not extras', async () => {
    const id = await createManga({ title: 'Null Reihe', total_volumes: 10 });
    for (let n = 0; n <= 9; n++) await addVolume(id, String(n));
    let row = await listRow(id);
    assert.deepEqual([row.regular_owned, row.max_regular_number, row.extras_owned, row.owned_volumes], [9, 9, 1, 10]);
    const stats = (await editor('GET', '/stats')).body.summary;
    assert.equal(typeof stats.completed_series, 'number');

    const dup = await createManga({ title: 'Doppel Fortschritt', total_volumes: 5 });
    for (let n = 1; n <= 5; n++) await addVolume(dup, String(n));
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status, type) VALUES (?, 'Band 5', 'Vorhanden', 'volume')").run(dup);
    await addVolume(dup, 'Schuber 1');
    row = await listRow(dup);
    assert.deepEqual([row.regular_owned, row.max_regular_number, row.extras_owned], [5, 5, 1]);
});

test('PUT /mangas/:id: an unchanged legacy cover longer than 2048 characters does not block other edits', async () => {
    const id = await createManga({ title: 'Altes Cover' });
    const longCover = 'data:image/png;base64,' + 'A'.repeat(5000);
    db.prepare('UPDATE mangas SET cover_image = ? WHERE id = ?').run(longCover, id);
    const form = await detail(id);
    const res = await editor('PUT', `/mangas/${id}`, { ...form, author: 'Neu' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await detail(id);
    assert.equal(after.author, 'Neu');
    assert.equal(after.cover_image, longCover);
    const changed = await editor('PUT', `/mangas/${id}`, { cover_image: longCover + 'B' });
    assert.equal(changed.status, 400);
});

test('GET /mangas/:id/gaps: read-only roles never store the found edition; an outage is reported as such', async () => {
    const visitor = ctx.client();
    assert.equal((await admin('POST', '/users', { username: 'gapvis', password: 'password123', role: 'visitor' })).status, 200);
    assert.equal((await visitor('POST', '/auth/login', { username: 'gapvis', password: 'password123' })).status, 200);
    const id = await createManga({ title: 'Lesend Reihe', publisher: 'Carlsen Manga', total_volumes: 3 });
    let fake = withFakeMangaPassion(editionApi(880101, 'Lesend Reihe'));
    try {
        const seen = await visitor('GET', `/mangas/${id}/gaps`);
        assert.equal(seen.status, 200);
        assert.equal(seen.body.matched, true);
        assert.equal((await detail(id)).manga_passion_id, null);
        const edited = await editor('GET', `/mangas/${id}/gaps`);
        assert.equal(edited.body.link_confirmed, true);
        assert.equal((await detail(id)).manga_passion_id, 880101);
    } finally { fake.restore(); }

    const offline = await createManga({ title: 'Ausfall Reihe Unverknuepft' });
    fake = withFakeMangaPassion(() => { throw new TypeError('fetch failed'); });
    try {
        const res = await editor('GET', `/mangas/${offline}/gaps`);
        assert.equal(res.status, 200);
        assert.equal(res.body.success, false);
        assert.equal(res.body.unavailable, true);
        assert.match(res.body.message, /nicht erreichbar/);
    } finally { fake.restore(); }
});

test('batch-import-gaps: an edition that is not the stored link needs confirm_edition', async () => {
    const id = await createManga({ title: 'Bestaetigung Reihe' });
    const fake = withFakeMangaPassion(editionApi(880201, 'Bestaetigung Reihe'));
    try {
        const guessed = await editor('POST', `/mangas/${id}/batch-import-gaps`, { volume_numbers: ['1'], edition_id: 880201 });
        assert.equal(guessed.status, 409);
        assert.equal(guessed.body.needs_confirmation, true);
        assert.equal(volumeCount(id), 0);

        assert.equal((await editor('POST', `/mangas/${id}/sync-edition`, { edition_id: 880201 })).status, 200);
        const linked = await editor('POST', `/mangas/${id}/batch-import-gaps`, { volume_numbers: ['1'], edition_id: 880201 });
        assert.equal(linked.status, 200);
        assert.equal(linked.body.imported_count, 1);

        const other = await createManga({ title: 'Bestaetigung Zwei' });
        const confirmed = await editor('POST', `/mangas/${other}/batch-import-gaps`, { volume_numbers: ['1'], edition_id: 880201, confirm_edition: true });
        assert.equal(confirmed.status, 200);
        assert.equal((await detail(other)).volumes[0].price, 7);
    } finally { fake.restore(); }
});

test('batch-import-gaps: a legacy "Band 2" counts as the owned regular volume 2', async () => {
    const id = await createManga({ title: 'Band Prefix Reihe' });
    const vid = await addVolume(id, '2');
    db.prepare("UPDATE volumes SET volume_number = 'Band 2' WHERE id = ?").run(vid);
    const res = await editor('POST', `/mangas/${id}/batch-import-gaps`, { volume_numbers: ['2', '3'] });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.imported_count, res.body.skipped_owned_count], [1, 1]);
    assert.equal(volumeCount(id), 2);
});

test('autofill-volumes: a malformed edition_id is a 400', async () => {
    const id = await createManga({ title: 'Autofill Validierung' });
    const fake = withFakeMangaPassion(() => { throw new Error('no network'); });
    try {
        for (const edition_id of ['abc', '12abc', -1, 1.5]) {
            assert.equal((await editor('POST', `/mangas/${id}/autofill-volumes`, { edition_id })).status, 400, JSON.stringify(edition_id));
        }
        assert.equal(fake.calls.length, 0);
    } finally { fake.restore(); }
});

test('mangas.owned_volumes (kept by triggers) never disagrees with the live count of the API', async () => {
    const stored = (id) => db.prepare('SELECT owned_volumes FROM mangas WHERE id = ?').get(id).owned_volumes;
    const check = async (id) => {
        assert.equal(stored(id), (await listRow(id)).owned_volumes);
        assert.equal(stored(id), (await detail(id)).owned_volumes);
    };
    const id = await createManga({ title: 'Zähler Trigger' });
    await check(id);
    assert.equal((await editor('POST', '/volumes/batch', { manga_id: id, from: 1, to: 5, status: 'Vorhanden' })).status, 200);
    await check(id);
    const vols = (await detail(id)).volumes;
    assert.equal((await editor('PUT', `/volumes/${vols[0].id}`, { ...vols[0], status: 'Fehlt' })).status, 200);
    await check(id);
    assert.equal((await editor('POST', `/volumes/${vols[1].id}/owners`, { owned: false })).status, 200);
    await check(id);
    assert.equal((await editor('DELETE', `/volumes/${vols[2].id}`)).status, 200);
    await check(id);
    await addVolume(id, '9', 'Fehlt');
    await addVolume(id, 'Schuber 1');
    await check(id);
    assert.equal(stored(id), 3);
});

test('GET /mangas: volume_search holds ISBNs, notes and named volumes, never plain numbers', async () => {
    const id = await createManga({ title: 'Suchfeld' });
    const res = await editor('POST', '/volumes', { manga_id: id, volume_number: '1', isbn: '9783551000001', notes: 'Signiert auf der Messe' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await addVolume(id, '2');
    await addVolume(id, '2.5');
    await addVolume(id, 'Artbook');
    const isbn = db.prepare('SELECT isbn FROM volumes WHERE manga_id = ? AND volume_number = ?').get(id, '1').isbn;
    const lines = (await listRow(id)).volume_search.split('\n');
    assert.deepEqual(lines.sort(), [isbn, 'Artbook', 'Signiert auf der Messe'].sort());

    const empty = await createManga({ title: 'Suchfeld leer' });
    assert.equal((await listRow(empty)).volume_search, null);
    await addVolume(empty, '3');
    assert.equal((await listRow(empty)).volume_search, null, 'only numeric volumes: nothing to search');
});
