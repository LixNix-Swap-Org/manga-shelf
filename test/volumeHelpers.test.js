const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// The helpers live in the frontend (ESM, frontend/package.json has "type": "module").
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'utils', 'volumeHelpers.js')).href);

test('normalizePubName: canonicalizes known publishers case-insensitively, passes unknown through', async () => {
    const { normalizePubName } = await load();
    assert.equal(normalizePubName('  CARLSEN MANGA '), 'Carlsen Manga');
    assert.equal(normalizePubName('panini'), 'Panini Verlags GmbH');
    assert.equal(normalizePubName('Unbekannter Verlag'), 'Unbekannter Verlag');
    assert.equal(normalizePubName(null), '');
    assert.equal(normalizePubName(42), '');
});

test('normalizePubName: names like Object.prototype keys are ordinary publishers, also with server names loaded', async () => {
    const { normalizePubName, setPublisherNames } = await load();
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(normalizePubName(` ${name} `), name);
    setPublisherNames({ publishers: [{ name: 'constructor', canonical: 'Constructor Verlag' }], aliases: [{ alias: '__proto__', canonical: 'Proto' }, { alias: 7, canonical: 'X' }] });
    try {
        assert.equal(normalizePubName('constructor'), 'Constructor Verlag');
        assert.equal(normalizePubName('__proto__'), 'Proto');
        assert.equal(normalizePubName('valueOf'), 'valueOf');
        assert.equal(normalizePubName('tokyopop'), 'TOKYOPOP');
    } finally {
        setPublisherNames(null);
    }
});

test('inferVolumeType: explicit type wins, otherwise keywords in number/notes', async () => {
    const { inferVolumeType } = await load();
    assert.equal(inferVolumeType({ type: 'schuber', volume_number: '1' }), 'schuber');
    assert.equal(inferVolumeType({ volume_number: 'Schuber 3' }), 'schuber');
    assert.equal(inferVolumeType({ volume_number: '14', notes: 'Limited Edition' }), 'special_edition');
    assert.equal(inferVolumeType({ volume_number: 'Special Edition 2' }), 'special_edition');
    assert.equal(inferVolumeType({ volume_number: 'Sonderband' }), 'special');
    assert.equal(inferVolumeType({ volume_number: '7' }), 'volume');
});

test('getVolumeSortInfo: volumes < numbered special editions < schuber < special', async () => {
    const { getVolumeSortInfo } = await load();
    const vol = getVolumeSortInfo({ type: 'volume', volume_number: '5' });
    const se = getVolumeSortInfo({ type: 'special_edition', volume_number: '5' });
    const seUnnumbered = getVolumeSortInfo({ type: 'special_edition', volume_number: 'Collectors' });
    const schuber = getVolumeSortInfo({ type: 'schuber', volume_number: 'Schuber 1' });
    const special = getVolumeSortInfo({ type: 'special', volume_number: 'Fanbook' });

    assert.equal(vol.num, 5);
    assert.equal(vol.rank, 1);
    assert.equal(se.rank, 1);
    assert.ok(se.subRank > vol.subRank, 'special edition sorts right after the same-numbered volume');
    assert.equal(seUnnumbered.rank, 1.5);
    assert.equal(schuber.rank, 2);
    assert.equal(special.rank, 3);
});

test('getVolumeDisplayTitle: adds prefixes without duplicating them', async () => {
    const { getVolumeDisplayTitle } = await load();
    assert.equal(getVolumeDisplayTitle({ volume_number: '3' }), 'Band 3');
    assert.equal(getVolumeDisplayTitle({ volume_number: 'Band 3' }), 'Band 3');
    assert.equal(getVolumeDisplayTitle({ type: 'schuber', volume_number: '2' }), 'Schuber 2');
    assert.equal(getVolumeDisplayTitle({ type: 'schuber', volume_number: 'Schuber 2' }), 'Schuber 2');
    assert.equal(getVolumeDisplayTitle({ type: 'special_edition', volume_number: '14' }), 'Band 14 (Special Edition)');
    assert.equal(getVolumeDisplayTitle({ type: 'special_edition', volume_number: 'Limited Edition 14' }), 'Band 14 (Limited Edition)');
    assert.equal(getVolumeDisplayTitle({ type: 'special', volume_number: 'Fanbook' }), 'Special Fanbook');
});

test('getSpinePublisherTheme: known publishers get their accent, unknown ones the fallback', async () => {
    const { getSpinePublisherTheme } = await load();
    assert.equal(getSpinePublisherTheme('Carlsen Manga').accentName, 'Carlsen');
    assert.equal(getSpinePublisherTheme('Kaze Manga').accentName, 'Kazé');
    assert.equal(getSpinePublisherTheme('Panini Verlags GmbH').accentName, 'Panini');
    assert.equal(getSpinePublisherTheme('Irgendwer').accentName, 'Irgendwer');
    assert.equal(getSpinePublisherTheme('').accentName, 'Manga');
});

test('gapVolumeNumber: numbered gaps resolve to their number, labels without one to null', async () => {
    const { gapVolumeNumber } = await load();
    assert.equal(gapVolumeNumber(114), 114);
    assert.equal(gapVolumeNumber('114'), 114);
    assert.equal(gapVolumeNumber('26 (Abenteuer auf der Insel des Gottes)'), 26);
    assert.equal(gapVolumeNumber('7 (Titel (mit Klammern))'), 7);
    assert.equal(gapVolumeNumber('East Blue Leerschuber'), null);
    assert.equal(gapVolumeNumber('Special'), null);
    assert.equal(gapVolumeNumber(2.5), null);
});

test('normalizePubName: trailing "!" from Manga Passion does not create a second publisher', async () => {
    const { normalizePubName } = await load();
    assert.equal(normalizePubName('Carlsen Manga!'), 'Carlsen Manga');
    assert.equal(normalizePubName('Carlsen Manga !'), 'Carlsen Manga');
    assert.equal(normalizePubName('Panini Manga'), 'Panini Verlags GmbH');
    assert.equal(normalizePubName('Planet Manga'), 'Planet Manga');
    assert.equal(normalizePubName('Sonst Verlag!'), 'Sonst Verlag');
});

test('hasUserRead: uses the reader list when present, otherwise the caller own flag', async () => {
    const { hasUserRead } = await load();
    const withList = { read_users: [{ user_id: 2 }, { id: 5 }] };
    assert.equal(hasUserRead(withList, 2, 1), true);
    assert.equal(hasUserRead(withList, '5', 1), true);
    assert.equal(hasUserRead(withList, 1, 1), false);
    assert.equal(hasUserRead({ is_read: 1 }, 1, 1), true);
    assert.equal(hasUserRead({ is_read: 1 }, 2, 1), false);
    assert.equal(hasUserRead({}, 1, 1), false);
});

test('buildDisplayVolumeItems: gaps are interleaved by number, but only when sorting by number without filters', async () => {
    const { buildDisplayVolumeItems } = await load();
    const filteredVolumes = [{ id: 1, volume_number: '1' }, { id: 3, volume_number: '3' }, { id: 5, volume_number: '5' }];
    const detectedGapEntries = [{ label: 2, type: 'volume' }, { label: 4, type: 'volume' }];
    const base = {
        filteredVolumes, detectedGapEntries, detectedGaps: detectedGapEntries.map(e => e.label), mpGapMap: new Map(),
        showGaps: true, volumeTypeFilter: 'ALL', volumeFilter: 'ALL', volumeSearch: '', volumeSort: 'number_asc'
    };
    const shape = items => items.map(i => (i.isGap ? `gap${i.gapNumber}` : `v${i.volume.id}`));
    assert.deepEqual(shape(buildDisplayVolumeItems(base)), ['v1', 'gap2', 'v3', 'gap4', 'v5']);
    // useVolumeFilters hands number_desc over already sorted descending
    assert.deepEqual(shape(buildDisplayVolumeItems({ ...base, filteredVolumes: [...filteredVolumes].reverse(), volumeSort: 'number_desc' })), ['v5', 'gap4', 'v3', 'gap2', 'v1']);
    // not sorted by number, searching, hiding gaps or filtering by status: plain volumes only
    for (const override of [{ volumeSort: 'price_asc' }, { volumeSearch: 'x' }, { showGaps: false }, { volumeFilter: 'Vorhanden' }, { volumeTypeFilter: 'schuber' }]) {
        assert.deepEqual(shape(buildDisplayVolumeItems({ ...base, ...override })), ['v1', 'v3', 'v5']);
    }
    // a gap that is actually present in the list is not drawn as a ghost
    assert.deepEqual(shape(buildDisplayVolumeItems({ ...base, detectedGapEntries: [{ label: 3, type: 'volume' }], detectedGaps: [3] })), ['v1', 'v3', 'v5']);
    // special-edition gaps never become ghost entries
    assert.deepEqual(shape(buildDisplayVolumeItems({ ...base, detectedGapEntries: [{ label: '2 (Collectors Edition)', type: 'special_edition' }], detectedGaps: ['2 (Collectors Edition)'] })), ['v1', 'v3', 'v5']);
});

test('buildDisplayVolumeItems: decimals keep the order, a special edition with the same number does not hide the gap', async () => {
    const { buildDisplayVolumeItems } = await load();
    const shape = items => items.map(i => (i.isGap ? `gap${i.gapNumber}` : `v${i.volume.id}`));
    const base = {
        mpGapMap: new Map(), showGaps: true, volumeTypeFilter: 'ALL', volumeFilter: 'ALL', volumeSearch: '', volumeSort: 'number_asc'
    };
    const gap = (n) => ({ label: n, type: 'volume' });

    // 12, 12.5, 13, 15 with gap 14: the ghost sits between 13 and 15, not in front of 12.5
    const decimals = [{ id: 12, volume_number: '12' }, { id: 125, volume_number: '12.5' }, { id: 13, volume_number: '13' }, { id: 15, volume_number: '15' }];
    assert.deepEqual(shape(buildDisplayVolumeItems({ ...base, filteredVolumes: decimals, detectedGapEntries: [gap(14)], detectedGaps: [14] })), ['v12', 'v125', 'v13', 'gap14', 'v15']);

    // Collectors Edition 5 is stored as "5" with its own type: Band 5 is still missing and shows a ghost in front of it
    const withSpecial = [{ id: 4, volume_number: '4' }, { id: 50, volume_number: '5', type: 'special_edition' }, { id: 6, volume_number: '6' }];
    assert.deepEqual(shape(buildDisplayVolumeItems({ ...base, filteredVolumes: withSpecial, detectedGapEntries: [gap(5)], detectedGaps: [5] })), ['v4', 'gap5', 'v50', 'v6']);

    // schuber stay behind all numbered volumes, gaps beyond the last volume still show
    const withSchuber = [{ id: 1, volume_number: '1' }, { id: 9, volume_number: 'Schuber 1', type: 'schuber' }];
    assert.deepEqual(shape(buildDisplayVolumeItems({ ...base, filteredVolumes: withSchuber, detectedGapEntries: [gap(2)], detectedGaps: [2] })), ['v1', 'gap2', 'v9']);
});

const shapeOf = items => items.map(i => (i.isGap ? `gap${i.gapNumber}` : String(i.volume.volume_number)));
const gapBase = { mpGapMap: new Map(), showGaps: true, volumeTypeFilter: 'ALL', volumeFilter: 'ALL', volumeSearch: '' };
const gapEntries = (...numbers) => ({ detectedGapEntries: numbers.map(n => ({ label: n, type: 'volume' })), detectedGaps: numbers });

test('buildDisplayVolumeItems: number_desc keeps the hook order, ghosts between the volumes and schuber last', async () => {
    const { buildDisplayVolumeItems, compareVolumesByNumber } = await load();
    const sorted = (vols, desc) => [...vols].sort((a, b) => compareVolumesByNumber(a, b, desc));
    const vols = [{ volume_number: '1' }, { volume_number: '3' }, { volume_number: '5' }, { volume_number: 'Schuber 1', type: 'schuber' }];
    const run = (desc, gaps, list = vols) => shapeOf(buildDisplayVolumeItems({
        ...gapBase, ...gapEntries(...gaps), filteredVolumes: sorted(list, desc), volumeSort: desc ? 'number_desc' : 'number_asc'
    }));
    assert.deepEqual(run(true, [2, 4]), ['5', 'gap4', '3', 'gap2', '1', 'Schuber 1']);
    assert.deepEqual(run(false, [2, 4]), ['1', 'gap2', '3', 'gap4', '5', 'Schuber 1']);
    // gaps beyond the highest volume come first in desc, gaps below the lowest after it
    assert.deepEqual(run(true, [6, 7]), ['gap7', 'gap6', '5', '3', '1', 'Schuber 1']);
    assert.deepEqual(run(true, [2], [{ volume_number: '3' }, { volume_number: '4' }]), ['4', '3', 'gap2']);

    // a ghost takes the slot of the regular volume: in front of the same-numbered special edition in both directions
    const withSe = [{ volume_number: '4' }, { volume_number: '5', type: 'special_edition' }, { volume_number: '6' }];
    assert.deepEqual(run(true, [5], withSe), ['6', 'gap5', '5', '4']);
    assert.deepEqual(run(false, [5], withSe), ['4', 'gap5', '5', '6']);

    const decimals = [{ volume_number: '12' }, { volume_number: '12.5' }, { volume_number: '13' }, { volume_number: '15' }];
    assert.deepEqual(run(true, [14], decimals), ['15', 'gap14', '13', '12.5', '12']);

    // with the ghosts removed, the order is exactly what the user sees with gaps off
    const mixed = [...vols, ...decimals, { volume_number: 'Artbook', type: 'special' }, { volume_number: 'Fanbook' }];
    for (const desc of [true, false]) {
        const input = sorted(mixed, desc);
        const items = buildDisplayVolumeItems({ ...gapBase, ...gapEntries(2, 4, 14), filteredVolumes: input, volumeSort: desc ? 'number_desc' : 'number_asc' });
        assert.deepEqual(items.filter(i => !i.isGap).map(i => i.volume), input);
        assert.equal(items.filter(i => i.isGap).length, 3);
    }
});

test('buildDisplayVolumeItems: a special edition stored as text sits at its number, not after all ghosts', async () => {
    const { buildDisplayVolumeItems, compareVolumesByNumber } = await load();
    const vols = [{ volume_number: '13' }, { volume_number: '14' }, { volume_number: 'Limited Edition 14', type: 'special_edition' }, { volume_number: '16' }, { volume_number: '18' }];
    const run = (desc, list, gaps) => shapeOf(buildDisplayVolumeItems({
        ...gapBase, ...gapEntries(...gaps), filteredVolumes: [...list].sort((a, b) => compareVolumesByNumber(a, b, desc)), volumeSort: desc ? 'number_desc' : 'number_asc'
    }));
    assert.deepEqual(run(false, vols, [15, 17]), ['13', '14', 'Limited Edition 14', 'gap15', '16', 'gap17', '18']);
    assert.deepEqual(run(true, vols, [15, 17]), ['18', 'gap17', '16', 'gap15', '14', 'Limited Edition 14', '13']);
    assert.deepEqual(run(false, [{ volume_number: '2' }, { volume_number: 'Band 5 Limited Edition', type: 'special_edition' }, { volume_number: '13' }], [3]),
        ['2', 'gap3', 'Band 5 Limited Edition', '13']);
    // no stored type: the name decides
    assert.deepEqual(run(false, [{ volume_number: '13' }, { volume_number: 'Limited Edition 14' }, { volume_number: '16' }], [15]),
        ['13', 'Limited Edition 14', 'gap15', '16']);
});

test('buildDisplayVolumeItems: "Band 2" covers gap 2; ghosts carry the regular volume metadata', async () => {
    const { buildDisplayVolumeItems, buildMpGapMap } = await load();
    const vols = [{ volume_number: '1' }, { volume_number: 'Band 2' }, { volume_number: '4' }];
    assert.deepEqual(shapeOf(buildDisplayVolumeItems({ ...gapBase, ...gapEntries(2, 3), filteredVolumes: vols, volumeSort: 'number_asc' })),
        ['1', 'Band 2', 'gap3', '4']);

    const gaps = [
        { volume_number: '3', type: 'volume', price: 7, cover_image: '/reg3.jpg' },
        { volume_number: '3', type: 'special_edition', price: 25, cover_image: '/ce3.jpg' },
        { volume_number: '3', type: 'schuber', price: 12, cover_image: '/schuber.jpg' }
    ];
    for (const order of [gaps, [...gaps].reverse()]) {
        const items = buildDisplayVolumeItems({ ...gapBase, ...gapEntries(3), mpGapMap: buildMpGapMap(order), filteredVolumes: vols, volumeSort: 'number_asc' });
        const ghost = items.find(i => i.isGap);
        assert.equal(ghost.gapMeta.price, 7);
        assert.equal(ghost.gapMeta.type, 'volume');
    }
});

test('buildMpGapMap: only regular volumes, whatever the order; lookups by plain number keep working', async () => {
    const { buildMpGapMap, getRegularGapMeta } = await load();
    const gaps = [
        { volume_number: '5', type: 'volume', price: 8 },
        { volume_number: '5', type: 'special_edition', price: 32 },
        { volume_number: '6', type: 'schuber', price: 12 },
        { volume_number: '07', price: 9 }
    ];
    for (const order of [gaps, [...gaps].reverse()]) {
        const map = buildMpGapMap(order);
        assert.equal(map.get('5').price, 8);
        assert.equal(getRegularGapMeta(map, 5).price, 8);
        assert.equal(map.get('6'), undefined);
        assert.equal(getRegularGapMeta(map, 7).price, 9);
        assert.equal(map.size, 2);
    }
    assert.equal(buildMpGapMap(undefined).size, 0);
});

test('buildDisplayVolumeItems: publisher, condition and owner filters hide the ghosts', async () => {
    const { buildDisplayVolumeItems, filtersAllowGaps } = await load();
    const vols = [{ volume_number: '1' }, { volume_number: '3' }];
    const base = { ...gapBase, ...gapEntries(2), filteredVolumes: vols, volumeSort: 'number_asc' };
    for (const extra of [{ volumeConditionFilter: 'Akzeptabel' }, { volumePublisherFilter: 'Carlsen Manga' }, { volumeOwnerFilter: 'u1' }, { volumeSearch: '  x ' }]) {
        assert.equal(buildDisplayVolumeItems({ ...base, ...extra }).some(i => i.isGap), false, JSON.stringify(extra));
        assert.equal(filtersAllowGaps(extra), false);
    }
    // the person's missing volumes, status "Fehlt" and type "Bände" still show gaps
    for (const extra of [{}, { volumeOwnerFilter: 'u1', volumeOwnerMissing: true }, { volumeFilter: 'Fehlt' }, { volumeTypeFilter: 'volume' }, { volumeSearch: '   ' }]) {
        assert.deepEqual(shapeOf(buildDisplayVolumeItems({ ...base, ...extra })), ['1', 'gap2', '3'], JSON.stringify(extra));
        assert.equal(filtersAllowGaps(extra), true);
    }
});

test('detectGapEntries: local fallback counts "Band N" but not "Starter 1"; MP gaps check type and number', async () => {
    const { detectGapEntries } = await load();
    const labels = (entries) => entries.map(e => e.label);
    assert.deepEqual(detectGapEntries(null, [{ volume_number: '1' }, { volume_number: 'Band 2' }, { volume_number: '3' }], 3), []);
    assert.deepEqual(labels(detectGapEntries(null, [{ volume_number: 'Starter 1' }, { volume_number: '2' }, { volume_number: '3' }], 3)), [1]);
    assert.deepEqual(labels(detectGapEntries({ matched: false, message: 'x' }, [{ volume_number: '1' }, { volume_number: '4', type: 'special_edition' }], 3)), [2, 3]);
    assert.deepEqual(detectGapEntries(null, [], 10), []);

    const mp = { matched: true, gaps: [
        { volume_number: '2', type: 'volume', title: 'Titel' },
        { volume_number: '3', type: 'volume' },
        { volume_number: '3', type: 'special_edition', title: 'Collectors Edition' }
    ] };
    assert.deepEqual(detectGapEntries(mp, [{ volume_number: 'Band 3' }], 5), [
        { label: '2 (Titel)', type: 'volume' },
        { label: '3 (Collectors Edition)', type: 'special_edition' }
    ]);
});

test('regularVolumeNumber: only "N" and "Band N" of regular volumes', async () => {
    const { regularVolumeNumber } = await load();
    assert.equal(regularVolumeNumber({ volume_number: '5' }), 5);
    assert.equal(regularVolumeNumber({ volume_number: ' band 14 ' }), 14);
    assert.equal(regularVolumeNumber({ volume_number: 'Starter 1' }), null);
    assert.equal(regularVolumeNumber({ volume_number: 'Vol. 3' }), null);
    assert.equal(regularVolumeNumber({ volume_number: '5', type: 'special_edition' }), null);
    assert.equal(regularVolumeNumber({ volume_number: '12.5' }), null);
});

test('getSeriesProgress: an incomplete series never shows 100 %, a started one never 0 %', async () => {
    const { getSeriesProgress } = await load();
    const pct = (regular, total) => getSeriesProgress({ regular_owned: regular, max_regular_number: regular, total_volumes: total, owned_volumes: regular }).pct;
    assert.equal(pct(199, 200), 99);
    assert.equal(pct(399, 400), 99);
    assert.equal(pct(107, 108), 99);
    assert.equal(pct(200, 200), 100);
    assert.equal(pct(2, 3), 67);
    assert.equal(pct(1, 300), 1);
    assert.equal(pct(0, 300), 0);
    assert.equal(getSeriesProgress({ regular_owned: 0, total_volumes: 0, owned_volumes: 0 }).pct, null);
    assert.equal(getSeriesProgress({ regular_owned: 6, max_regular_number: 6, total_volumes: 5, owned_volumes: 6 }).pct, 100);
});

test('getSeriesProgress / getVolumeProgressCounts: a duplicate regular volume is no extra', async () => {
    const { getSeriesProgress, getVolumeProgressCounts } = await load();
    assert.deepEqual(getSeriesProgress({ regular_owned: 5, extras_owned: 0, max_regular_number: 5, total_volumes: 5, owned_volumes: 6 }),
        { owned: 5, total: 5, extras: 0, pct: 100 });
    // rows without extras_owned (older offline snapshots) keep the old rule
    assert.equal(getSeriesProgress({ regular_owned: 4, max_regular_number: 4, total_volumes: 4, owned_volumes: 6 }).extras, 2);

    const owned = (volume_number, type) => ({ volume_number, type, status: 'Vorhanden' });
    const volumes = [owned('1'), owned('2'), owned('Band 2'), owned('3'), owned('3'), owned('Schuber 1', 'schuber'), owned('Starter 1'),
        { volume_number: '4', status: 'Fehlt' }];
    const counts = getVolumeProgressCounts(volumes);
    assert.deepEqual(counts, { regular_owned: 3, max_regular_number: 3, extras_owned: 2, owned_volumes: 7 });
    assert.deepEqual(getSeriesProgress({ ...counts, total_volumes: 5 }), { owned: 3, total: 5, extras: 2, pct: 60 });
});

test('getVolumeDisplayTitle: "Band" only in front of a number', async () => {
    const { getVolumeDisplayTitle, getSpecialEditionNumber } = await load();
    const title = (volume_number, type, notes) => getVolumeDisplayTitle({ volume_number, type, notes });
    assert.equal(title('Collectors', 'special_edition'), 'Collectors (Special Edition)');
    assert.equal(title('Artbook', 'special_edition'), 'Artbook (Special Edition)');
    assert.equal(title('Variant Cover', 'special_edition'), 'Variant Cover');
    assert.equal(title('Collectors Edition', 'special_edition'), 'Collectors Edition');
    assert.equal(title('Bandana Box', 'special_edition'), 'Bandana Box (Special Edition)');
    assert.equal(title('14', 'special_edition'), 'Band 14 (Special Edition)');
    assert.equal(title('Limited Edition 14', 'special_edition'), 'Band 14 (Limited Edition)');
    assert.equal(title('Band 5 Limited Edition', 'special_edition'), 'Band 5 (Limited Edition)');
    assert.equal(title('5.5', 'volume'), 'Band 5.5');
    assert.equal(title('Artbook', 'volume'), 'Artbook');
    assert.equal(title('Starter 1', 'volume'), 'Starter 1');
    assert.equal(title('  ', 'volume'), 'Band ?');
    assert.equal(title('', 'special'), 'Special');
    assert.equal(title('', 'schuber'), 'Schuber');
    for (const [n, type] of [['Collectors', 'special_edition'], ['Artbook', 'volume'], ['', 'volume'], ['', 'special_edition'], ['x', 'special']]) {
        const t = title(n, type);
        assert.doesNotMatch(t, /^Band \D(?!$)/);
        assert.equal(t, t.trim());
    }
    assert.equal(getSpecialEditionNumber({ volume_number: 'Collectors' }), '');
    assert.equal(getSpecialEditionNumber({ volume_number: 'Band 5 Limited Edition' }), '5');
});

test('matchesConditionFilter: the none-sentinel keeps volumes without a condition', async () => {
    const { matchesConditionFilter, CONDITION_NONE } = await load();
    assert.equal(matchesConditionFilter({ condition: null }, CONDITION_NONE), true);
    assert.equal(matchesConditionFilter({ condition: '  ' }, CONDITION_NONE), true);
    assert.equal(matchesConditionFilter({}, CONDITION_NONE), true);
    assert.equal(matchesConditionFilter({ condition: 'Gut' }, CONDITION_NONE), false);
    assert.equal(matchesConditionFilter({ condition: 'Ohne' }, CONDITION_NONE), false);
    assert.equal(matchesConditionFilter({ condition: 'Gut' }, 'Gut'), true);
    assert.equal(matchesConditionFilter({ condition: 'Sehr gut' }, 'Gut'), false);
    assert.equal(matchesConditionFilter({ condition: 'Gut' }, 'ALL'), true);
});

test('gap edition guards and status text', async () => {
    const { isGapEditionUnconfirmed, canFixVolumeCount, gapStatusText } = await load();
    const discrepancy = { official_total: 3, db_total: 5 };
    const guessed = { matched: true, link_confirmed: false, edition: { id: 7, title: 'X' }, discrepancy };
    const linked = { ...guessed, link_confirmed: true };
    assert.equal(isGapEditionUnconfirmed(guessed), true);
    assert.equal(isGapEditionUnconfirmed(linked), false);
    assert.equal(isGapEditionUnconfirmed(null), false);
    assert.equal(canFixVolumeCount(guessed), false);
    assert.equal(canFixVolumeCount(linked), true);
    assert.equal(canFixVolumeCount({ ...linked, edition: null }), false);
    assert.equal(canFixVolumeCount({ ...linked, discrepancy: null }), false);

    assert.equal(gapStatusText(null, null), null);
    assert.equal(gapStatusText(linked, 'Netzfehler'), 'Netzfehler');
    assert.equal(gapStatusText({ matched: false, message: 'Keine passende deutsche Edition' }, null), 'Keine passende deutsche Edition');
    assert.match(gapStatusText({ ...linked, stale: true }, null), /veraltet/);
    assert.match(gapStatusText({ ...linked, incomplete: true }, null), /unvollständig/);
    assert.equal(gapStatusText(linked, null), null);
});

test('normalizePubName: the offline fallback map matches the built-in names of core/lib/publishers.js', async () => {
    const { CANONICAL_PUBLISHERS: frontend } = await load();
    const { CANONICAL_PUBLISHERS: core } = require('../core/lib/publishers');
    assert.deepEqual(frontend, core);
});

test('normalizePubName: the server names (setPublisherNames) win, follow a merged built-in name, null forgets them', async () => {
    const { normalizePubName, setPublisherNames, publisherNamesVersion, subscribePublisherNames } = await load();
    let calls = 0;
    const stop = subscribePublisherNames(() => { calls++; });
    const before = publisherNamesVersion();
    try {
        setPublisherNames({
            publishers: [
                { name: 'Carlsen Verlag GmbH', canonical: 'Carlsen Manga' },
                { name: 'TOKYOPOP GmbH', canonical: 'TOKYOPOP' },
                { name: 'Mein Verlag', canonical: 'Mein Verlag' }
            ],
            aliases: [{ alias: 'panini verlags gmbh', canonical: 'Panini' }, { alias: 'ema', canonical: 'Egmont Manga' }, { alias: 42 }]
        });
        assert.equal(calls, 1);
        assert.equal(publisherNamesVersion(), before + 1);
        assert.equal(normalizePubName('carlsen verlag gmbh'), 'Carlsen Manga');
        assert.equal(normalizePubName(' TOKYOPOP GmbH! '), 'TOKYOPOP');
        assert.equal(normalizePubName('EMA'), 'Egmont Manga');
        assert.equal(normalizePubName('panini'), 'Panini');
        assert.equal(normalizePubName('Panini Manga'), 'Panini');
        assert.equal(normalizePubName('Kaze Manga'), 'Kazé Manga');
        assert.equal(normalizePubName('Unbekannt'), 'Unbekannt');

        setPublisherNames(null);
        assert.equal(normalizePubName('panini'), 'Panini Verlags GmbH');
        assert.equal(normalizePubName('Carlsen Verlag GmbH'), 'Carlsen Verlag GmbH');
        assert.equal(calls, 2);
    } finally {
        stop();
        setPublisherNames(null);
    }
});
