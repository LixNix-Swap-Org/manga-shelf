// Pure dashboard helpers of the frontend (filters, sorting, counts, progress, search) loaded as ESM from the CommonJS test runner.
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

test('withVolumeSearch merges the volume-search index by id; rows without an entry stay the same object', async () => {
    const { withVolumeSearch, filterAndSortMangas } = await load();
    const list = [{ id: 1, title: 'Berserk' }, { id: 2, title: 'Akira', volume_search: 'Artbook' }, { id: 3, title: 'Monster' }];
    assert.equal(withVolumeSearch(list, null), list);
    assert.equal(withVolumeSearch(list, new Map()), list);
    const merged = withVolumeSearch(list, new Map([['1', '978-3-89921-123-4\nSigniert'], ['2', 'Artbook']]));
    assert.equal(merged[1], list[1]);
    assert.equal(merged[2], list[2]);
    assert.deepEqual(merged[0], { id: 1, title: 'Berserk', volume_search: '978-3-89921-123-4\nSigniert' });
    assert.equal(list[0].volume_search, undefined, 'the cached list is never changed');
    const ids = (search) => filterAndSortMangas(merged, { search, statusFilter: 'ALL', publisherFilter: 'ALL', sortBy: 'title_asc' }).map(m => m.id);
    assert.deepEqual(ids('9783899211234'), [1]);
    assert.deepEqual(ids('signiert'), [1]);
    assert.deepEqual(ids('artbook'), [2]);
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
    // digits of an ISBN never match as loose volume numbers, 4+ digits still find it
    assert.deepEqual(ids('berserk 4'), []);
    assert.deepEqual(ids('berserk 123'), []);
    assert.deepEqual(ids('89921'), [1]);
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
    // "Abgeschlossen" is the publication status: Akira has no target, so it is not a completed collection
    assert.deepEqual(getCollectionTotals(series), { totalOwnedVolumes: 20, totalCollectionValue: 180.5, completedSeries: 0 });
    assert.deepEqual(getCollectionTotals([]), { totalOwnedVolumes: 0, totalCollectionValue: 0, completedSeries: 0 });
});

test('isSeriesComplete: spec A2, a known total and that many regular volumes owned, publication status ignored', async () => {
    const { isSeriesComplete, getCollectionTotals } = await load();
    const list = [
        { id: 1, status: 'Abgeschlossen', total_volumes: 20, owned_volumes: 1, regular_owned: 1, max_regular_number: 1 },
        { id: 2, status: 'Abgeschlossen', total_volumes: 0, owned_volumes: 0, regular_owned: 0 },
        { id: 3, status: 'Laufend', total_volumes: 3, owned_volumes: 4, regular_owned: 3, max_regular_number: 3, extras_owned: 1 },
        { id: 4, status: 'Laufend', total_volumes: 3, owned_volumes: 4, regular_owned: 4, max_regular_number: 5 },
        { id: 5, status: 'Laufend', total_volumes: null, owned_volumes: 2, regular_owned: 2, max_regular_number: 2 }
    ];
    assert.deepEqual(list.map(isSeriesComplete), [false, false, true, true, false]);
    assert.equal(getCollectionTotals(list).completedSeries, 2);
});

test('wishlist: chip counts wished series (server flag first), filter shows only them', async () => {
    const { getFilterCounts, filterAndSortMangas, getStatusTabs, isStatusFilter } = await load();
    const list = [
        { id: 1, title: 'Wunsch', status: 'Laufend', wish_priority: 2, wished: 1, owned_volumes: 0 },
        { id: 2, title: 'Gekauft', status: 'Laufend', wish_priority: 3, wished: 0, owned_volumes: 1 },
        { id: 3, title: 'Offline alt', status: 'Geplant', wish_priority: 0, owned_volumes: 0 },
        { id: 4, title: 'Ohne', status: 'Laufend', wish_priority: null, owned_volumes: 0 }
    ];
    const counts = getFilterCounts(list);
    assert.equal(counts.WISHLIST, 2);
    assert.ok(getStatusTabs(counts, 'ALL').some(t => t.id === 'WISHLIST' && t.label === 'Wunschliste' && t.count === 2));
    assert.equal(getStatusTabs(getFilterCounts(series), 'ALL').some(t => t.id === 'WISHLIST'), false, 'no chip without wished series');
    assert.equal(isStatusFilter('WISHLIST'), true);
    const opts = { search: '', publisherFilter: 'ALL', sortBy: 'title_asc', statusFilter: 'WISHLIST' };
    assert.deepEqual(filterAndSortMangas(list, opts).map(m => m.title), ['Offline alt', 'Wunsch']);
});

test('collect filter: gaps need a missing volume or an unreached total; dropped and complete series have none', async () => {
    const { hasCollectionGaps, matchesCollectFilter, getCollectCounts, collectingOf } = await load();
    assert.equal(hasCollectionGaps({ missing_count: 1, total_volumes: null, regular_owned: 3 }), true);
    assert.equal(hasCollectionGaps({ missing_count: 0, total_volumes: 10, regular_owned: 4 }), true);
    assert.equal(hasCollectionGaps({ missing_count: 0, total_volumes: null, regular_owned: 4 }), false);
    assert.equal(hasCollectionGaps({ missing_count: 2, total_volumes: 5, regular_owned: 5 }), false, 'complete (spec A2) wins over a stale entry');
    assert.equal(hasCollectionGaps({ missing_count: 2, collecting: 'abgebrochen' }), false);
    assert.equal(hasCollectionGaps({ missing_count: 2, collecting: 'pausiert' }), true);
    assert.equal(matchesCollectFilter({ preorder_count: 1 }, 'preorder'), true);
    assert.equal(matchesCollectFilter({}, 'preorder'), false);
    assert.equal(matchesCollectFilter({ total_volumes: 3, regular_owned: 3 }, 'complete'), true);
    assert.equal(matchesCollectFilter({ collecting: 'pausiert' }, 'pausiert'), true);
    assert.equal(matchesCollectFilter({}, 'abgebrochen'), false);
    assert.equal(matchesCollectFilter({}, 'ALL'), true);
    assert.equal(collectingOf({ collecting: 'unbekannt' }), 'aktiv');
    assert.deepEqual(getCollectCounts([{ missing_count: 1 }, { collecting: 'abgebrochen', missing_count: 3 }, { preorder_count: 2 }]),
        { ALL: 3, gaps: 1, preorder: 1, complete: 0, pausiert: 0, abgebrochen: 1 });
});

test('authors: a shared author field is split into names; the filter matches one name, case and spacing independent', async () => {
    const { splitAuthors, matchesAuthor, filterAndSortMangas } = await load();
    assert.deepEqual(splitAuthors('Tsugumi Ohba, Takeshi  Obata'), ['Tsugumi Ohba', 'Takeshi Obata']);
    assert.deepEqual(splitAuthors('A & B / C; D und E'), ['A', 'B', 'C', 'D', 'E']);
    assert.deepEqual(splitAuthors(null), []);
    assert.equal(matchesAuthor({ author: 'Tsugumi Ohba, Takeshi Obata' }, ' tsugumi  OHBA '), true);
    assert.equal(matchesAuthor({ author: 'Tsugumi Ohba' }, 'Ohba'), false);
    assert.equal(matchesAuthor({ author: null }, ''), true);
    const list = [{ id: 1, title: 'B', author: 'Oda' }, { id: 2, title: 'A', author: 'Toriyama, Oda' }, { id: 3, title: 'C', author: 'Kubo' }];
    assert.deepEqual(filterAndSortMangas(list, { search: '', statusFilter: 'ALL', publisherFilter: 'ALL', sortBy: 'title_asc', authorFilter: 'oda' }).map(m => m.id), [2, 1]);
});

test('groupMangas: sections per publisher / author / status, the empty one last, list order kept inside', async () => {
    const { groupMangas } = await load();
    const list = [
        { id: 1, title: 'A', publisher: 'carlsen manga', author: 'X', status: 'Abgeschlossen' },
        { id: 2, title: 'B', publisher: null, author: null, status: 'Laufend' },
        { id: 3, title: 'C', publisher: 'Altraverse', author: 'X', status: 'Laufend' },
        { id: 4, title: 'D', publisher: 'Carlsen Manga', author: 'Y, Z', status: null }
    ];
    const sections = (by) => groupMangas(list, by).map(s => [s.label, s.items.map(m => m.id)]);
    assert.deepEqual(sections('publisher'), [['Altraverse', [3]], ['Carlsen Manga', [1, 4]], ['Ohne Verlag', [2]]]);
    assert.deepEqual(sections('author'), [['X', [1, 3]], ['Y, Z', [4]], ['Ohne Autor', [2]]]);
    assert.deepEqual(sections('status'), [['Laufend', [2, 3]], ['Abgeschlossen', [1]], ['Ohne Status', [4]]]);
    assert.deepEqual(sections('none'), [['', [1, 2, 3, 4]]]);
    assert.deepEqual(sections('genre'), [['', [1, 2, 3, 4]]]);
});

test('filter URL: valid values are read, defaults leave the query, other parameters stay', async () => {
    const { readFilterParams, writeFilterParams } = await load();
    assert.deepEqual(readFilterParams('?view=radar&status=Laufend&collect=gaps&author=Oda&sort=nope&group=status&publisher=Panini'),
        { status: 'Laufend', publisher: 'Panini', collect: 'gaps', author: 'Oda', group: 'status' });
    assert.deepEqual(readFilterParams('?status=Unsinn&collect=&author=%20'), {});
    assert.deepEqual(readFilterParams('%%%'), {});
    assert.equal(writeFilterParams('?view=radar', { status: 'ALL', collect: 'gaps', author: 'Eiichiro Oda', sort: 'title_asc', group: 'none' }),
        '?view=radar&collect=gaps&author=Eiichiro+Oda');
    assert.equal(writeFilterParams('?collect=gaps&view=shopping', { collect: 'ALL' }), '?view=shopping');
    assert.equal(writeFilterParams('', { author: '' }), '');
});
