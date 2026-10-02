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
    assert.equal(getVolumeDisplayTitle({ type: 'special_edition', volume_number: 'Limited Edition 14' }), 'Limited Edition 14');
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
