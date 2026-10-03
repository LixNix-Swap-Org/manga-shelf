const test = require('node:test');
const assert = require('node:assert');

let helpers;
test.before(async () => { helpers = await import('../frontend/src/utils/scanHelpers.js'); });

test('scan prefill uses the catalogue series before the volume title', () => {
  const p = helpers.buildScanPrefill({ title: 'Mein kleiner Bruder!', series: 'Kaguya-sama', volume_number: '2', volume_number_known: true, author: 'A', publisher: 'Carlsen', price: 7, pages: 192, release_year: 2021, cover_url: 'https://covers.openlibrary.org/b/isbn/9783551000000-L.jpg' }, '9783551000000');
  assert.strictEqual(p.form.title, 'Kaguya-sama');
  assert.strictEqual(p.form.cover_image, 'https://covers.openlibrary.org/b/isbn/9783551000000-L.jpg?default=false');
  assert.deepStrictEqual(
    [p.volume.volume_number, p.volume.price, p.volume.pages, p.volume.release_year, p.volume.isbn],
    ['2', '7', '192', '2021', '9783551000000']
  );
});

test('scan prefill leaves an unknown volume number empty instead of guessing "1"', () => {
  const p = helpers.buildScanPrefill({ title: 'Berserk', volume_number: '1', volume_number_known: false }, '9783551000000');
  assert.strictEqual(p.volume.volume_number, '');
  assert.strictEqual(p.form.cover_image, '');
});

test('scan volume payload carries the manga id and the cleaned fields', () => {
  const body = helpers.buildScanVolumePayload(5, { volume_number: ' 3 ', status: 'Fehlt', isbn: '978', price: '', pages: '', release_year: '', publisher: 'X' });
  assert.deepStrictEqual(body, { manga_id: 5, volume_number: '3', status: 'Fehlt', isbn: '978', price: null, pages: null, release_year: null, publisher: 'X' });
});

test('prefillTotalVolumes leaves the total open for running series', () => {
  assert.strictEqual(helpers.prefillTotalVolumes({ total_volumes: 1, status: 'Laufend' }, ''), '');
  assert.strictEqual(helpers.prefillTotalVolumes({ total_volumes: 1, status: 'Laufend' }, '5'), '5');
  assert.strictEqual(helpers.prefillTotalVolumes({ total_volumes: 12, status: 'Abgeschlossen' }, ''), '12');
  assert.strictEqual(helpers.prefillTotalVolumes({ status: 'Abgeschlossen' }, '3'), '3');
});
