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
    assert.deepEqual(shape(buildDisplayVolumeItems({ ...base, volumeSort: 'number_desc' })), ['v5', 'gap4', 'v3', 'gap2', 'v1']);
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
