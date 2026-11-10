// Catalog stage c3 (core/lib/catalogMaintenance.js): entries nothing shows or marks any more go; marks keep theirs, a
// restore from the trash and a bulk undo relink their rows after the purge, and the console figures add up.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryCore } = require('./harness');
const maintenance = require('../../core/lib/catalogMaintenance');

const count = (conn, table) => conn.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const entryOf = (conn, mangaId) => conn.prepare('SELECT catalog_series_id AS id FROM mangas WHERE id = ?').get(mangaId).id;

async function setup() {
    const core = createMemoryCore();
    const admin = core.client('admin');
    const newSeries = async (title, extra = {}) => {
        const res = await admin('POST', '/mangas', { title, ...extra });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.id;
    };
    const newVolume = async (mangaId, number, extra = {}) => {
        const res = await admin('POST', '/volumes', { manga_id: mangaId, volume_number: number, ...extra });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.id;
    };
    return { core, admin, newSeries, newVolume, purge: () => maintenance.purgeOrphans(core.ctx) };
}

test('a deleted series takes its catalog entry along, also from the trash; marks keep theirs and a restore relinks', async () => {
    const { core, admin, newSeries, newVolume, purge } = await setup();
    const keep = await newSeries('Wartung Bleibt', { description: 'Text Bleibt' });
    await newVolume(keep, '1');
    const gone = await newSeries('Wartung Weg', { description: 'Text der gelöschten Reihe' });
    await newVolume(gone, '1');
    await newVolume(gone, '2');
    const marked = await newSeries('Wartung Gelesen');
    const markedVol = await newVolume(marked, '1', { status: 'Vorhanden' });
    assert.equal((await admin('POST', `/volumes/${markedVol}/read`, { read: true })).status, 200);
    const goneEntry = entryOf(core.conn, gone);
    const markedEntry = entryOf(core.conn, marked);

    assert.deepEqual(purge(), { volumes: 0, series: 0 }, 'nothing to do while every entry has its row');
    const trashed = (await admin('DELETE', `/mangas/${gone}`)).body.trash_id;
    assert.equal((await admin('DELETE', `/mangas/${marked}`)).status, 200);
    assert.equal(maintenance.stats(core.conn).orphanSeries, 1);

    // the series without marks goes with its volumes, the one with a reading mark stays with the marked volume
    assert.deepEqual(purge(), { volumes: 2, series: 1 });
    assert.equal(core.conn.prepare('SELECT 1 AS hit FROM catalog_series WHERE id = ?').get(goneEntry), undefined);
    assert.ok(core.conn.prepare('SELECT 1 AS hit FROM catalog_series WHERE id = ?').get(markedEntry));
    assert.equal(core.conn.prepare('SELECT count(*) AS n FROM catalog_volumes WHERE series_id = ?').get(markedEntry).n, 1);
    assert.deepEqual(purge(), { volumes: 0, series: 0 });

    // the trash restore relinks to a new entry that holds the restored values, and nothing of the purged one is left
    assert.equal((await admin('POST', `/trash/${trashed}/restore`)).status, 200);
    const back = (await admin('GET', `/mangas/${gone}`)).body;
    assert.deepEqual([back.description, back.volumes.length, back.catalog.local_fields], ['Text der gelöschten Reihe', 2, []]);
    assert.notEqual(entryOf(core.conn, gone), goneEntry);
    assert.equal(core.conn.prepare('SELECT count(*) AS n FROM volumes WHERE manga_id = ? AND catalog_volume_id IS NULL').get(gone).n, 0);

    // the same edition added again finds its marks on the kept entry
    const again = await newSeries('Wartung Gelesen');
    const againVol = await newVolume(again, '1', { status: 'Vorhanden' });
    assert.equal(entryOf(core.conn, again), markedEntry);
    assert.equal((await admin('GET', `/mangas/${again}`)).body.volumes.find(v => v.id === againVol).is_read, true);
    assert.equal(count(core.conn, 'catalog_series'), 3);
    assert.equal(entryOf(core.conn, keep) !== null, true);
    await core.close();
});

test('a catalog volume a renumbered row left behind goes, a bulk undo relinks the deleted volumes', async () => {
    const { core, admin, newSeries, newVolume, purge } = await setup();
    const id = await newSeries('Wartung Bände');
    const first = await newVolume(id, '1');
    const second = await newVolume(id, '2');
    assert.equal((await admin('PUT', `/volumes/${first}`, { volume_number: '10' })).status, 200);
    assert.deepEqual(purge(), { volumes: 1, series: 0 }, 'the catalog volume of the old number');

    const bulk = await admin('POST', '/volumes/bulk', { ids: [first, second], delete: true });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    assert.deepEqual(purge(), { volumes: 2, series: 0 }, 'the series row still links its entry');
    const undo = await admin('POST', '/volumes/bulk', { revert: bulk.body.undo_token });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.deepEqual(undo.body.restored.sort(), [first, second].sort());
    const linked = core.conn.prepare('SELECT count(*) AS n FROM volumes v JOIN catalog_volumes c ON c.id = v.catalog_volume_id WHERE v.manga_id = ?').get(id).n;
    assert.equal(linked, 2);
    await core.close();
});

test('chapter progress keeps a webtoon entry; the merge log loses the rows of what went', async () => {
    const { core, admin, newSeries, purge } = await setup();
    const webtoon = await newSeries('Wartung Webtoon', { format: 'webtoon' });
    assert.equal((await admin('PUT', `/mangas/${webtoon}/chapters`, { chapters_read: 12 })).status, 200);
    const plain = await newSeries('Wartung Protokoll');
    const plainEntry = entryOf(core.conn, plain);
    core.run("INSERT INTO catalog_merge_log (kind, catalog_id, old_ids, detail) VALUES ('series_field', ?, '[]', 'Testzeile')", plainEntry);
    assert.deepEqual(maintenance.stats(core.conn).log.map(r => ({ ...r })), [{ kind: 'series_field', n: 1 }]);
    assert.equal(maintenance.mergeLog(core.conn, 5)[0].detail, 'Testzeile');
    await admin('DELETE', `/mangas/${webtoon}`);
    await admin('DELETE', `/mangas/${plain}`);
    assert.deepEqual(purge(), { volumes: 0, series: 1 });
    assert.equal(count(core.conn, 'catalog_merge_log'), 0);
    const figures = maintenance.stats(core.conn);
    assert.deepEqual([figures.series, figures.orphanSeries, figures.orphanVolumes], [1, 0, 0]);
    await core.close();
});
