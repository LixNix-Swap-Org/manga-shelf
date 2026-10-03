const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// Pure radar helpers live in the frontend (ESM, frontend/package.json has "type": "module").
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'utils', 'radarHelpers.js')).href);

const mpItems = [
    { id: 1, title: 'Berserk', volume_number: '1', publisher: 'Panini', date: '2026-10-02', is_digital: false, in_collection: true },
    { id: 2, title: 'Berserk (E-Book)', volume_number: '1', publisher: 'Panini', date: '2026-10-02', is_digital: true, in_collection: true },
    { id: 3, title: 'One Piece', volume_number: '112', publisher: 'Carlsen', date: '2026-10-09', is_digital: false, in_collection: false },
    { id: 4, title: 'Akira', volume_number: '3', publisher: 'Carlsen', date: null, is_digital: false, in_collection: false }
];

test('filterMpItems: print only, my series, publisher and text filters', async () => {
    const { filterMpItems } = await load();
    const base = { mpPrintOnly: false, mpMySeriesOnly: false, mpPublisherFilter: 'ALL', mpSearch: '' };
    const ids = (o) => filterMpItems(mpItems, { ...base, ...o }).map(i => i.id);
    assert.deepEqual(ids({}), [1, 2, 3, 4]);
    assert.deepEqual(ids({ mpPrintOnly: true }), [1, 3, 4]);
    assert.deepEqual(ids({ mpMySeriesOnly: true }), [1, 2]);
    assert.deepEqual(ids({ mpPublisherFilter: 'carlsen' }), [3, 4]);
    assert.deepEqual(ids({ mpSearch: 'BERSERK' }), [1, 2]);
    assert.deepEqual(ids({ mpSearch: '112' }), [3]);
    assert.deepEqual(ids({ mpSearch: 'panini', mpPrintOnly: true }), [1]);
});

test('groupMpItemsByDate: sorted days with German labels, undated entries in their own group', async () => {
    const { groupMpItemsByDate } = await load();
    const groups = groupMpItemsByDate(mpItems);
    assert.deepEqual(groups.map(g => g.dateKey), ['2026-10-02', '2026-10-09', 'Ohne Datum']);
    assert.equal(groups[0].dateLabel, 'Freitag, 02. Oktober 2026');
    assert.equal(groups[2].dateLabel, 'Erscheinungsdatum unbestätigt');
    assert.deepEqual(groups[0].items.map(i => i.id), [1, 2]);
    assert.deepEqual(groupMpItemsByDate([]), []);
});

test('filterRadarItems: publisher, status and text (title, volume number, publisher)', async () => {
    const { filterRadarItems } = await load();
    const items = [
        { id: 1, manga_title: 'Berserk', volume_number: '41', effective_publisher: 'Panini', status: 'Vorbestellt' },
        { id: 2, manga_title: 'One Piece', volume_number: '112', effective_publisher: 'Carlsen', status: 'Erscheint bald' }
    ];
    const base = { radarPublisherFilter: 'ALL', radarStatusFilter: 'ALL', radarSearch: '' };
    const ids = (o) => filterRadarItems(items, { ...base, ...o }).map(i => i.id);
    assert.deepEqual(ids({}), [1, 2]);
    assert.deepEqual(ids({ radarPublisherFilter: 'carlsen' }), [2]);
    assert.deepEqual(ids({ radarStatusFilter: 'Vorbestellt' }), [1]);
    assert.deepEqual(ids({ radarSearch: 'one p' }), [2]);
    assert.deepEqual(ids({ radarSearch: '41' }), [1]);
    assert.deepEqual(ids({ radarSearch: 'panini' }), [1]);
    assert.deepEqual(ids({ radarSearch: 'nichts' }), []);
});
