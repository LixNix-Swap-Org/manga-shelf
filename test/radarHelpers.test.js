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

test('filterMpItems / filterRadarItems: the shared folded, typo-tolerant search', async () => {
    const { filterMpItems, filterRadarItems } = await load();
    const mp = [
        { id: 1, title: 'Pokémon Adventures', volume_number: '12', publisher: 'Egmont Manga' },
        { id: 2, title: "Hell's Paradise: Jigokuraku", volume_number: '3', publisher: 'Kazé' },
        { id: 3, title: 'Dr. Stone', volume_number: '26', publisher: 'Carlsen' }
    ];
    const mpIds = (mpSearch) => filterMpItems(mp, { mpPrintOnly: false, mpMySeriesOnly: false, mpPublisherFilter: 'ALL', mpSearch }).map(i => i.id);
    assert.deepEqual(mpIds('pokemon'), [1]);
    assert.deepEqual(mpIds('hells paradise'), [2]);
    assert.deepEqual(mpIds('kaze'), [2]);
    assert.deepEqual(mpIds('dr stone 26'), [3]);
    assert.deepEqual(mpIds('adventurs'), [1]);
    assert.deepEqual(mpIds(''), [1, 2, 3]);

    const radar = [
        { id: 1, manga_title: 'Kaijū No. 8', volume_number: '14', effective_publisher: 'Carlsen Manga', status: 'Vorbestellt' },
        { id: 2, manga_title: 'Gregs Tagebücher', volume_number: '19', effective_publisher: 'Baumhaus', status: 'Erscheint bald' }
    ];
    const radarIds = (radarSearch) => filterRadarItems(radar, { radarPublisherFilter: 'ALL', radarStatusFilter: 'ALL', radarSearch }).map(i => i.id);
    assert.deepEqual(radarIds('kaiju'), [1]);
    assert.deepEqual(radarIds('tagebuecher 19'), [2]);
    assert.deepEqual(radarIds('baumhaus'), [2]);
    assert.deepEqual(radarIds('kaiju 19'), []);
});

test('groupMpItemsByDate: month-only entries after the dated days of that month, with a month label', async () => {
    const { groupMpItemsByDate } = await load();
    const groups = groupMpItemsByDate([
        { id: 1, date: '2026-11' }, { id: 2, date: '2026-11-20' }, { id: 3, date: null }, { id: 4, date: '2026-10-30' }
    ]);
    assert.deepEqual(groups.map(g => g.dateKey), ['2026-10-30', '2026-11-20', '2026-11', 'Ohne Datum']);
    assert.equal(groups[2].dateLabel, 'November 2026 (Tag noch offen)');
});

test('volume status groups: owned, ordered, upcoming and missing decide the calendar buttons', async () => {
    const { volumeStatusGroup, mpCardActions } = await load();
    assert.equal(volumeStatusGroup('Vorhanden'), 'owned');
    assert.equal(volumeStatusGroup('Gelesen'), 'owned');
    assert.equal(volumeStatusGroup('Vorbestellt'), 'ordered');
    assert.equal(volumeStatusGroup('Bestellt'), 'ordered');
    assert.equal(volumeStatusGroup('Erscheint bald'), 'upcoming');
    assert.equal(volumeStatusGroup('Fehlt'), 'missing');
    assert.equal(volumeStatusGroup(null), null);
    assert.deepEqual(mpCardActions('Gelesen'), { preorder: false, cart: false });
    // the cart button would send 'Fehlt' and move an ordered volume back to the shopping list
    assert.deepEqual(mpCardActions('Bestellt'), { preorder: false, cart: false });
    assert.deepEqual(mpCardActions('Vorbestellt'), { preorder: false, cart: false });
    assert.deepEqual(mpCardActions('Erscheint bald'), { preorder: true, cart: true });
    assert.deepEqual(mpCardActions('Fehlt'), { preorder: true, cart: false });
    assert.deepEqual(mpCardActions(null), { preorder: true, cart: true });
});

test('filterRadarItems: the Vorbestellt chip covers Bestellt, every item has exactly one chip', async () => {
    const { filterRadarItems, RADAR_STATUS_CHIPS, radarStatusChipOf, isOrderedStatus, deliveredLabel } = await load();
    const items = ['Vorbestellt', 'Bestellt', 'Erscheint bald', 'Fehlt'].map((status, i) => ({
        id: i + 1, manga_title: 'X', volume_number: String(i + 1), effective_publisher: 'Carlsen', status
    }));
    const ids = (chip) => filterRadarItems(items, { radarPublisherFilter: 'ALL', radarStatusFilter: chip, radarSearch: '' }).map(i => i.id);
    assert.deepEqual(ids('Vorbestellt'), [1, 2]);
    assert.equal(ids('Vorbestellt').length, items.filter(i => isOrderedStatus(i.status)).length);
    assert.deepEqual(ids('Erscheint bald'), [3]);
    assert.deepEqual(ids('Geplant'), [4]);
    assert.deepEqual(ids('ALL'), [1, 2, 3, 4]);
    const chips = RADAR_STATUS_CHIPS.filter(c => c.id !== 'ALL').map(c => c.id);
    for (const item of items) assert.equal(chips.filter(c => radarStatusChipOf(item.status) === c).length, 1);
    assert.equal(deliveredLabel('Fehlt'), 'Gekauft');
    assert.equal(deliveredLabel('Vorbestellt'), 'Geliefert');
});

test('selectVisibleRadarGroups: drops groups without a match and keeps the order', async () => {
    const { selectVisibleRadarGroups } = await load();
    const groups = [
        { key: '2026-10', items: [{ id: 1, manga_title: 'Berserk', volume_number: '41', effective_publisher: 'Panini', status: 'Vorbestellt' }] },
        { key: '2026-11', items: [{ id: 2, manga_title: 'One Piece', volume_number: '112', effective_publisher: 'Carlsen', status: 'Fehlt' }] },
        { key: '2026-12', items: [{ id: 3, manga_title: 'Berserk', volume_number: '42', effective_publisher: 'Panini', status: 'Erscheint bald' }] }
    ];
    const base = { radarPublisherFilter: 'ALL', radarStatusFilter: 'ALL', radarSearch: '' };
    assert.deepEqual(selectVisibleRadarGroups(groups, { ...base, radarSearch: 'zzz' }), []);
    assert.deepEqual(selectVisibleRadarGroups(groups, { ...base, radarSearch: 'berserk' }).map(g => g.key), ['2026-10', '2026-12']);
    assert.deepEqual(selectVisibleRadarGroups(groups, { ...base, radarStatusFilter: 'Geplant' }).map(g => g.visibleItems.map(i => i.id)), [[2]]);
    assert.deepEqual(selectVisibleRadarGroups(undefined, base), []);
});

test('radarViewState: a failed load is an error, never the empty state', async () => {
    const { radarViewState } = await load();
    assert.equal(radarViewState({ loading: false, error: 'HTTP 500', hasData: false, count: 0 }), 'error');
    assert.equal(radarViewState({ loading: false, error: null, hasData: true, count: 0 }), 'empty');
    assert.equal(radarViewState({ loading: false, error: null, hasData: true, count: 3 }), 'list');
    assert.equal(radarViewState({ loading: true, error: 'x', hasData: false, count: 0 }), 'loading');
    // stale data or a failed refresh keeps the list
    assert.equal(radarViewState({ loading: false, error: 'x', hasData: true, count: 2 }), 'list');
    assert.equal(radarViewState({ loading: false, error: null, hasData: false, count: 0 }), 'idle');
});

test('reconcilePublisherFilter and publisherOptions: a stale publisher resets, a failed load keeps it selectable', async () => {
    const { reconcilePublisherFilter, publisherOptions } = await load();
    const pubs = [{ name: 'Carlsen', count: 3 }, { name: 'Panini', count: 1 }];
    assert.equal(reconcilePublisherFilter('Kazé', pubs, 'name'), 'ALL');
    assert.equal(reconcilePublisherFilter('carlsen', pubs, 'name'), 'carlsen');
    assert.equal(reconcilePublisherFilter('ALL', pubs, 'name'), 'ALL');
    assert.equal(reconcilePublisherFilter('Kazé', undefined, 'name'), 'Kazé');
    assert.equal(reconcilePublisherFilter('Kazé', [], 'name'), 'Kazé');
    assert.equal(reconcilePublisherFilter('Kazé', [{ publisher: 'Kazé', count: 1 }], 'publisher'), 'Kazé');
    assert.deepEqual(publisherOptions(pubs, 'name', 'ALL').map(o => o.label), ['Carlsen (3)', 'Panini (1)']);
    assert.deepEqual(publisherOptions(null, 'name', 'Kazé'), [{ value: 'Kazé', label: 'Kazé (0)' }]);
    assert.equal(publisherOptions(pubs, 'name', 'PANINI').length, 2);
});

test('buildYearOptions and shiftMonth: a selected year inside the window is always an option, navigation stays in the server window', async () => {
    const { buildYearOptions, shiftMonth, isCurrentMonth, RADAR_MIN_YEAR, RADAR_MAX_YEAR } = await load();
    const thisYear = new Date().getFullYear();
    assert.deepEqual([RADAR_MIN_YEAR, RADAR_MAX_YEAR], [thisYear - 5, thisYear + 3], 'same window as GET /manga-passion/releases');
    const gapless = (ys) => ys.every((y, i) => i === 0 || y === ys[i - 1] + 1);
    const cur = thisYear;
    for (const sel of [cur - 3, cur + 3, cur, cur - 5]) {
        const ys = buildYearOptions(cur, sel);
        assert.ok(ys.includes(sel) && ys.includes(cur), `${cur}/${sel}`);
        assert.ok(gapless(ys), `${cur}/${sel}`);
    }
    assert.deepEqual(buildYearOptions(cur, cur), [cur - 2, cur - 1, cur, cur + 1, cur + 2, cur + 3]);
    assert.equal(buildYearOptions(RADAR_MIN_YEAR + 1, RADAR_MIN_YEAR)[0], RADAR_MIN_YEAR);
    assert.deepEqual(shiftMonth(cur, 1, -1), { year: cur - 1, month: 12 });
    assert.deepEqual(shiftMonth(cur + 1, 12, 1), { year: cur + 2, month: 1 });
    assert.equal(shiftMonth(RADAR_MIN_YEAR, 1, -1), null);
    assert.equal(shiftMonth(RADAR_MAX_YEAR, 12, 1), null);
    assert.ok(isCurrentMonth(2026, 10, new Date(2026, 9, 3)));
    assert.ok(!isCurrentMonth(2026, 11, new Date(2026, 9, 3)));
});

test('month fetch state machine: a failed month is not refetched by itself, stale responses are ignored', async () => {
    const { shouldAutoFetchMp, mpMonthKey, createRequestSequence, mpMatchesSelection } = await load();
    const base = { active: true, offline: false, hasData: false, loading: false, failedKey: null, year: 2026, month: 10 };
    assert.equal(shouldAutoFetchMp(base), true);
    assert.equal(shouldAutoFetchMp({ ...base, failedKey: mpMonthKey(2026, 10) }), false);
    assert.equal(shouldAutoFetchMp({ ...base, failedKey: mpMonthKey(2026, 10), month: 11 }), true);
    assert.equal(shouldAutoFetchMp({ ...base, active: false }), false);
    assert.equal(shouldAutoFetchMp({ ...base, offline: true }), false);
    assert.equal(shouldAutoFetchMp({ ...base, loading: true }), false);
    assert.equal(shouldAutoFetchMp({ ...base, hasData: true }), false);

    const seq = createRequestSequence();
    const a = seq.next();
    const b = seq.next();
    assert.equal(seq.isCurrent(a), false);
    assert.equal(seq.isCurrent(b), true);

    assert.equal(mpMatchesSelection({ year: 2026, month: 10 }, 2026, 10), true);
    assert.equal(mpMatchesSelection({ year: 2026, month: 9 }, 2026, 10), false);
    assert.equal(mpMatchesSelection(null, 2026, 10), false);
});

test('withId / withoutId: busy ids are tracked per item, the original set is not mutated', async () => {
    const { withId, withoutId } = await load();
    const empty = new Set();
    const a = withId(empty, 1);
    const ab = withId(a, 2);
    assert.equal(empty.size, 0);
    assert.deepEqual([...ab], [1, 2]);
    const b = withoutId(ab, 1);
    assert.deepEqual([...b], [2]);
    assert.deepEqual([...ab], [1, 2]);
});

test('localISODate: the local calendar day, not the UTC one', async () => {
    const { localISODate } = await load();
    const prevTz = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    try {
        assert.equal(localISODate(new Date('2026-10-04T00:30:00+02:00')), '2026-10-04');
        assert.equal(localISODate(new Date('2026-11-01T00:30:00+01:00')), '2026-11-01');
        assert.equal(localISODate(new Date('2026-10-04T23:30:00+02:00')), '2026-10-04');
    } finally {
        if (prevTz === undefined) delete process.env.TZ;
        else process.env.TZ = prevTz;
    }
});

test('formatReleaseDate: German short dates for full, month-only and year-only values', async () => {
    const { formatReleaseDate } = await load();
    assert.equal(formatReleaseDate('2026-11-15'), '15.11.2026');
    assert.equal(formatReleaseDate('2026-11'), '11.2026');
    assert.equal(formatReleaseDate('2026-3'), '03.2026');
    assert.equal(formatReleaseDate('2026'), '2026');
    assert.equal(formatReleaseDate(''), '–');
    assert.equal(formatReleaseDate(null), '–');
    assert.equal(formatReleaseDate('bald'), 'bald');
});

test('applyImportToMpItems: every entry of the imported series gets the series, only the clicked one the volume', async () => {
    const { applyImportToMpItems, sameMpSeries } = await load();
    const items = [
        { id: 1, title: 'Frieren Neu', volume_number: '1', user_manga_id: null, in_collection: false },
        { id: 2, title: 'Frieren Neu', volume_number: '2', user_manga_id: null, in_collection: false },
        { id: 3, title: 'Frieren Neu (eBook)', volume_number: '1', user_manga_id: null, in_collection: false },
        { id: 4, title: 'Frieren Neu – Artbook', volume_number: 'Artbook', user_manga_id: null, in_collection: false },
        { id: 5, title: 'Akira', volume_number: '1', user_manga_id: 9, in_collection: true }
    ];
    const next = applyImportToMpItems(items, items[0], { manga_id: 7, volume_id: 70, status: 'Vorbestellt' }, 'Vorbestellt');
    assert.deepEqual(next.map(i => i.user_manga_id), [7, 7, 7, null, 9]);
    assert.equal(next[0].user_volume_id, 70);
    assert.equal(next[0].user_volume_status, 'Vorbestellt');
    assert.equal(next[1].user_volume_id, undefined);
    assert.equal(next[1].user_volume_status, undefined);
    assert.equal(items[1].user_manga_id, null);
    // short keys only merge on the same title, like the backend's findSeriesForImport
    assert.equal(sameMpSeries('K', 'K.'), false);
    assert.equal(sameMpSeries('frieren neu!', 'Frieren Neu'), true);
});

test('importNotice: skipped imports and a reused series are reported', async () => {
    const { importNotice } = await load();
    const item = { title: 'Berserk', volume_number: '42', user_manga_id: null };
    assert.match(importNotice(item, { skipped_owned: true }), /bereits im Regal/);
    assert.match(importNotice(item, { skipped_ordered: true }), /bereits bestellt/);
    assert.match(importNotice(item, { series_created: false }), /vorhandenen Reihe/);
    assert.equal(importNotice(item, { series_created: true }), null);
    assert.equal(importNotice({ ...item, user_manga_id: 3 }, { series_created: false }), null);
});
