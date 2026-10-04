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
    assert.match(getStatusBadge('Abgebrochen'), /rose/);
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
    assert.equal(c.Abgebrochen, 0);
});

test('read state counts owned volumes only: wishlist-only series are neither read nor unread', async () => {
    const { getReadState, getMangaProgress, getFilterCounts, filterAndSortMangas } = await load();
    const wishlist = { id: 10, title: 'Wunschreihe', status: 'Laufend', owned_volumes: 0, volume_count: 3, read_volume_count: 0 };
    const unreadOwned = { id: 11, title: 'Teilweise', status: 'Laufend', owned_volumes: 2, volume_count: 4, read_volume_count: 0 };
    assert.deepEqual(getReadState(wishlist), { owned: 0, read: 0, pct: 0, complete: false, hasUnread: false });
    assert.equal(getMangaProgress(wishlist), 0);
    assert.equal(getMangaProgress(unreadOwned), 0);
    const c = getFilterCounts([wishlist, unreadOwned]);
    assert.equal(c.UNREAD, 1);
    assert.equal(c.READ_ALL, 0);
    const opts = { search: '', publisherFilter: 'ALL', sortBy: 'title_asc' };
    assert.deepEqual(filterAndSortMangas([wishlist, unreadOwned], { ...opts, statusFilter: 'UNREAD' }).map(m => m.title), ['Teilweise']);
    assert.deepEqual(filterAndSortMangas([wishlist, unreadOwned], { ...opts, statusFilter: 'READ_ALL' }), []);
    // an offline copy from an older server may still count reads of volumes that are not owned
    assert.deepEqual(getReadState({ owned_volumes: 2, read_volume_count: 5 }), { owned: 2, read: 2, pct: 100, complete: true, hasUnread: false });
});

test('getFilterCounts / filter: status Abgebrochen is its own chip', async () => {
    const { getFilterCounts, filterAndSortMangas } = await load();
    const list = [...series, { id: 5, title: 'Eingestellt', status: 'Abgebrochen', owned_volumes: 1, read_volume_count: 1 }];
    assert.equal(getFilterCounts(list).Abgebrochen, 1);
    assert.deepEqual(filterAndSortMangas(list, { search: '', statusFilter: 'Abgebrochen', publisherFilter: 'ALL', sortBy: 'title_asc' }).map(m => m.title), ['Eingestellt']);
});

test('getStatusTabs: chips with series, Alle, and the active chip even at count 0', async () => {
    const { getStatusTabs, getFilterCounts, isStatusFilter } = await load();
    const counts = getFilterCounts(series);
    const ids = (active) => getStatusTabs(counts, active).map(t => t.id);
    assert.deepEqual(ids('ALL'), ['ALL', 'Laufend', 'Abgeschlossen', 'UNREAD', 'READ_ALL', 'Pausiert']);
    assert.deepEqual(ids('Geplant'), ['ALL', 'Laufend', 'Abgeschlossen', 'UNREAD', 'READ_ALL', 'Pausiert', 'Geplant']);
    assert.equal(getStatusTabs(counts, 'Geplant').at(-1).count, 0);
    assert.equal(isStatusFilter('UNREAD'), true);
    assert.equal(isStatusFilter('Unbekannt'), false);
});

test('sanitizePublisherFilter: stale publisher -> ALL, case and "!" variants -> the canonical option', async () => {
    const { sanitizePublisherFilter, getAvailablePublishers } = await load();
    const pubs = getAvailablePublishers(series);
    assert.equal(sanitizePublisherFilter('Tokyopop', pubs), 'ALL');
    assert.equal(sanitizePublisherFilter('carlsen manga', pubs), 'Carlsen Manga');
    assert.equal(sanitizePublisherFilter('Carlsen Manga!', pubs), 'Carlsen Manga');
    assert.equal(sanitizePublisherFilter('ALL', pubs), 'ALL');
    assert.equal(sanitizePublisherFilter('', pubs), 'ALL');
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
    // by canonical publisher name ('carlsen manga' = 'Carlsen Manga', then by title); series without publisher last
    assert.deepEqual(titles({ sortBy: 'publisher_asc' }), ['Akira', 'Berserk', 'One Piece', 'Dragon Ball']);
    assert.deepEqual(titles({ sortBy: 'progress_desc' }), ['Berserk', 'Akira', 'Dragon Ball', 'One Piece']);
});

test('filterAndSortMangas: progress = reading progress, completion = collection progress of the card', async () => {
    const { filterAndSortMangas, SORT_OPTIONS, isSortOption } = await load();
    const a = { id: 1, title: 'A', owned_volumes: 2, regular_owned: 2, max_regular_number: 2, total_volumes: 2, read_volume_count: 0 };
    const b = { id: 2, title: 'B', owned_volumes: 1, regular_owned: 1, max_regular_number: 1, total_volumes: 10, read_volume_count: 1 };
    const c = { id: 3, title: 'C', owned_volumes: 0, regular_owned: 0, max_regular_number: 0, total_volumes: null, read_volume_count: 0 };
    const order = (sortBy) => filterAndSortMangas([c, b, a], { search: '', statusFilter: 'ALL', publisherFilter: 'ALL', sortBy }).map(m => m.title);
    assert.deepEqual(order('progress_desc'), ['B', 'A', 'C']);
    assert.deepEqual(order('completion_desc'), ['A', 'B', 'C']);
    // series without a target stay last in both directions
    assert.deepEqual(order('completion_asc'), ['B', 'A', 'C']);
    assert.match(SORT_OPTIONS.find(o => o.value === 'progress_desc').label, /Lesefortschritt/);
    assert.equal(isSortOption('completion_desc'), true);
    assert.equal(isSortOption('bogus'), false);
});

test('filterAndSortMangas: equal volume counts / values fall back to the title', async () => {
    const { filterAndSortMangas } = await load();
    const list = [
        { id: 1, title: 'Zetman', owned_volumes: 3, total_value: 20 },
        { id: 2, title: 'akira', owned_volumes: 3, total_value: 20 },
        { id: 3, title: 'Monster', owned_volumes: 3, total_value: 20 }
    ];
    const order = (sortBy) => filterAndSortMangas(list, { search: '', statusFilter: 'ALL', publisherFilter: 'ALL', sortBy }).map(m => m.title);
    assert.deepEqual(order('volumes_desc'), ['akira', 'Monster', 'Zetman']);
    assert.deepEqual(order('value_desc'), ['akira', 'Monster', 'Zetman']);
});

test('filterAndSortMangas: folded, typo-tolerant search over title, alt title, author, publisher and tags', async () => {
    const { filterAndSortMangas } = await load();
    const list = [
        { id: 1, title: 'Kaijū No. 8', author: 'Naoya Matsumoto', publisher: 'Carlsen Manga', tags: 'Action, Monster' },
        { id: 2, title: 'Gregs Tagebücher', author: 'Jeff Kinney', publisher: 'Baumhaus' },
        { id: 3, title: "Hell's Paradise", alt_title: 'Jigokuraku', author: 'Yuji Kaku', publisher: 'Kazé', tags: 'Horror' },
        { id: 4, title: 'Jujutsu Kaisen', author: 'Gege Akutami', publisher: 'Crunchyroll' }
    ];
    const titles = (search) => filterAndSortMangas(list, { search, statusFilter: 'ALL', publisherFilter: 'ALL', sortBy: 'title_asc' }).map(m => m.id);
    assert.deepEqual(titles('kaiju'), [1]);
    assert.deepEqual(titles('tagebucher'), [2]);
    assert.deepEqual(titles('hells paradise'), [3]);
    assert.deepEqual(titles('jigokuraku'), [3]);
    assert.deepEqual(titles('kaze'), [3]);
    assert.deepEqual(titles('horror'), [3], 'tags');
    assert.deepEqual(titles('monster'), [1], 'tags');
    assert.deepEqual(titles('jujutsu kaisn'), [4], 'one typo');
    assert.deepEqual(titles('kinney tagebuecher'), [2], 'tokens across fields, umlaut spelled out');
});

test('filterAndSortMangas: with a search, title-prefix hits come first; the chosen sort orders each group', async () => {
    const { filterAndSortMangas } = await load();
    const list = [
        { id: 1, title: 'Akira', author: 'Katsuhiro One', owned_volumes: 9 },
        { id: 2, title: 'Die One-Show', owned_volumes: 1 },
        { id: 3, title: 'One Piece', owned_volumes: 2 },
        { id: 4, title: 'One-Punch Man', owned_volumes: 5 },
        { id: 5, title: 'Someone', owned_volumes: 7 }
    ];
    const ids = (sortBy) => filterAndSortMangas(list, { search: 'one', statusFilter: 'ALL', publisherFilter: 'ALL', sortBy }).map(m => m.id);
    assert.deepEqual(ids('title_asc'), [3, 4, 2, 5, 1]);
    assert.deepEqual(ids('volumes_desc'), [4, 3, 5, 2, 1]);
    // no search: the chosen sort alone
    assert.deepEqual(filterAndSortMangas(list, { search: '  ', statusFilter: 'ALL', publisherFilter: 'ALL', sortBy: 'volumes_desc' }).map(m => m.id), [1, 5, 4, 3, 2]);
});

test('filterAndSortMangas: ISBNs, notes and named volumes when the list carries volume_search', async () => {
    const { filterAndSortMangas } = await load();
    const list = [
        { id: 1, title: 'Berserk', volume_search: '978-3-89921-123-4\nErstauflage, signiert' },
        { id: 2, title: 'Akira', volume_search: ['9783551000001', 'Artbook Collectors Edition'] },
        { id: 3, title: 'Monster' }
    ];
    const ids = (search) => filterAndSortMangas(list, { search, statusFilter: 'ALL', publisherFilter: 'ALL', sortBy: 'title_asc' }).map(m => m.id);
    assert.deepEqual(ids('9783899211234'), [1]);
    assert.deepEqual(ids('89921-123'), [1]);
    assert.deepEqual(ids('signiert'), [1]);
    assert.deepEqual(ids('erstaufl'), [1]);
    assert.deepEqual(ids('artbook'), [2]);
    assert.deepEqual(ids('3551000'), [2]);
    assert.deepEqual(ids('monster'), [3]);
});

test('title and publisher sorts are natural: numbers by value, case and accents ignored', async () => {
    const { filterAndSortMangas, getAvailablePublishers } = await load();
    const list = [
        { id: 1, title: 'Band 10', publisher: 'Verlag 10' },
        { id: 2, title: 'band 2', publisher: 'Verlag 2' },
        { id: 3, title: 'Éclair', publisher: 'Verlag 1' },
        { id: 4, title: 'Band 1', publisher: 'Verlag 1' }
    ];
    const ids = (sortBy) => filterAndSortMangas(list, { search: '', statusFilter: 'ALL', publisherFilter: 'ALL', sortBy }).map(m => m.id);
    assert.deepEqual(ids('title_asc'), [4, 2, 1, 3]);
    assert.deepEqual(ids('title_desc'), [3, 1, 2, 4]);
    assert.deepEqual(ids('publisher_asc'), [4, 3, 2, 1]);
    assert.deepEqual(getAvailablePublishers(list), ['Verlag 1', 'Verlag 2', 'Verlag 10']);
});

test('getCollectionTotals: owned volumes, collection value and completed series', async () => {
    const { getCollectionTotals } = await load();
    assert.deepEqual(getCollectionTotals(series), { totalOwnedVolumes: 20, totalCollectionValue: 180.5, completedSeries: 1 });
    assert.deepEqual(getCollectionTotals([]), { totalOwnedVolumes: 0, totalCollectionValue: 0, completedSeries: 0 });
});
