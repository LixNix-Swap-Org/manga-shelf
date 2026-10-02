const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// Pure dashboard helpers live in the frontend (ESM, frontend/package.json has "type": "module").
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'utils', 'collectionHelpers.js')).href);

const series = [
    { id: 1, title: 'Berserk', publisher: 'carlsen manga', status: 'Laufend', owned_volumes: 10, read_volume_count: 10, total_value: 80 },
    { id: 2, title: 'Akira', publisher: 'Carlsen Manga', status: 'Abgeschlossen', owned_volumes: 6, read_volume_count: 2, total_value: 60.5, author: 'Otomo' },
    { id: 3, title: 'One Piece', alt_title: 'Wan Pīsu', publisher: 'Panini', status: 'Laufend', owned_volumes: 0, volume_count: 0, total_value: 0 },
    { id: 4, title: 'Dragon Ball', publisher: null, status: 'Pausiert', owned_volumes: 4, read_volume_count: 0, total_value: 40 }
];

test('formatGermanDate: weekday, day, German month name; passes through unusual input', async () => {
    const { formatGermanDate } = await load();
    assert.equal(formatGermanDate('2026-10-02'), 'Freitag, 02. Oktober 2026');
    assert.equal(formatGermanDate('2026-10'), '2026-10');
    assert.equal(formatGermanDate(''), '');
});

test('getStatusBadge: one colour set per status, sky for everything else', async () => {
    const { getStatusBadge } = await load();
    assert.match(getStatusBadge('Abgeschlossen'), /emerald/);
    assert.match(getStatusBadge('Pausiert'), /amber/);
    assert.match(getStatusBadge('Geplant'), /purple/);
    assert.match(getStatusBadge('Laufend'), /sky/);
    assert.match(getStatusBadge(undefined), /sky/);
});

test('getMangaProgress: share of read volumes, 0 without volumes, capped at 100', async () => {
    const { getMangaProgress } = await load();
    assert.equal(getMangaProgress(series[0]), 100);
    assert.equal(getMangaProgress(series[1]), 33);
    assert.equal(getMangaProgress(series[2]), 0);
    assert.equal(getMangaProgress({ owned_volumes: 2, read_volume_count: 5 }), 100);
});

test('getAvailablePublishers: canonical names, deduplicated, sorted, empty ones skipped', async () => {
    const { getAvailablePublishers } = await load();
    assert.deepEqual(getAvailablePublishers(series), ['Carlsen Manga', 'Panini Verlags GmbH']);
});

test('getFilterCounts: status chips and read / unread counts', async () => {
    const { getFilterCounts } = await load();
    const c = getFilterCounts(series);
    assert.equal(c.ALL, 4);
    assert.equal(c.Laufend, 2);
    assert.equal(c.Abgeschlossen, 1);
    assert.equal(c.Pausiert, 1);
    assert.equal(c.UNREAD, 2);   // Akira, Dragon Ball
    assert.equal(c.READ_ALL, 1); // Berserk
});

test('filterAndSortMangas: search over title / alt title / author / publisher, filters and sort orders', async () => {
    const { filterAndSortMangas } = await load();
    const base = { search: '', statusFilter: 'ALL', publisherFilter: 'ALL', sortBy: 'title_asc' };
    const titles = (opts) => filterAndSortMangas(series, { ...base, ...opts }).map(m => m.title);
    assert.deepEqual(titles({}), ['Akira', 'Berserk', 'Dragon Ball', 'One Piece']);
    assert.deepEqual(titles({ search: 'otomo' }), ['Akira']);
    assert.deepEqual(titles({ search: 'wan p' }), ['One Piece']);
    assert.deepEqual(titles({ search: 'panini' }), ['One Piece']);
    assert.deepEqual(titles({ statusFilter: 'Laufend' }), ['Berserk', 'One Piece']);
    assert.deepEqual(titles({ statusFilter: 'UNREAD' }), ['Akira', 'Dragon Ball']);
    assert.deepEqual(titles({ statusFilter: 'READ_ALL' }), ['Berserk']);
    assert.deepEqual(titles({ publisherFilter: 'carlsen manga' }), ['Akira', 'Berserk']);
    assert.deepEqual(titles({ sortBy: 'title_desc' }), ['One Piece', 'Dragon Ball', 'Berserk', 'Akira']);
    assert.deepEqual(titles({ sortBy: 'newest_first' }), ['Dragon Ball', 'One Piece', 'Akira', 'Berserk']);
    assert.deepEqual(titles({ sortBy: 'volumes_desc' }), ['Berserk', 'Akira', 'Dragon Ball', 'One Piece']);
    assert.deepEqual(titles({ sortBy: 'value_desc' }), ['Berserk', 'Akira', 'Dragon Ball', 'One Piece']);
    // sorts by the raw publisher string (so 'carlsen manga' comes before 'Carlsen Manga'); series without publisher last
    assert.deepEqual(titles({ sortBy: 'publisher_asc' }), ['Berserk', 'Akira', 'One Piece', 'Dragon Ball']);
    assert.deepEqual(titles({ sortBy: 'progress_desc' }), ['Berserk', 'Akira', 'Dragon Ball', 'One Piece']);
});

test('getCollectionTotals: owned volumes, collection value and completed series', async () => {
    const { getCollectionTotals } = await load();
    assert.deepEqual(getCollectionTotals(series), { totalOwnedVolumes: 20, totalCollectionValue: 180.5, completedSeries: 1 });
    assert.deepEqual(getCollectionTotals([]), { totalOwnedVolumes: 0, totalCollectionValue: 0, completedSeries: 0 });
});
