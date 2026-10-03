const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// Pure form helpers live in the frontend (ESM, frontend/package.json has "type": "module").
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'utils', 'volumeFormHelpers.js')).href);

test('buildVolumeForm: inputs become strings, the cover leads the image list without duplicates', async () => {
    const { buildVolumeForm } = await load();
    const form = buildVolumeForm({
        type: 'volume', volume_number: '3', status: 'Vorbestellt', price: 7.5, pages: 192, release_year: 2024,
        cover_image: '/uploads/a.jpg', images: ['/uploads/b.jpg', '/uploads/a.jpg']
    });
    assert.equal(form.price, '7.5');
    assert.equal(form.pages, '192');
    assert.equal(form.release_year, '2024');
    assert.equal(form.status, 'Vorbestellt');
    assert.deepEqual(form.images, ['/uploads/a.jpg', '/uploads/b.jpg']);
    assert.equal(form.cover_image, '/uploads/a.jpg');

    const empty = buildVolumeForm({ volume_number: 'Schuber 1' });
    assert.equal(empty.type, 'schuber');
    assert.equal(empty.status, 'Vorhanden');
    assert.equal(empty.price, '');
    assert.deepEqual(empty.images, []);
    assert.equal(buildVolumeForm({ cover_image: null, images: ['/x.jpg'] }).cover_image, '/x.jpg');
});

test('applyLookupToForm: fills what the lookup knows and reports it', async () => {
    const { applyLookupToForm } = await load();
    const prev = { type: 'volume', volume_number: '5', price: '', notes: '', publisher: '', isbn: '', pages: '', release_date: '', release_year: '', cover_image: '', images: [] };
    const { next, updatedFields } = applyLookupToForm(prev, {
        release_date: '2024-05-01', release_year: 2024, pages: 192, isbn: '9783551789012', price: 7, publisher: 'Carlsen Manga', notes: 'Titel des Bandes', cover_image: '/uploads/c.jpg'
    });
    assert.equal(next.release_date, '2024-05-01');
    assert.equal(next.release_year, '2024');
    assert.equal(next.pages, '192');
    assert.equal(next.price, '7');
    assert.equal(next.notes, 'Titel des Bandes');
    assert.deepEqual(next.images, ['/uploads/c.jpg']);
    assert.equal(next.cover_image, '/uploads/c.jpg');
    assert.ok(updatedFields.includes('ISBN') && updatedFields.includes('Verlag') && updatedFields.includes('Cover-Bild'));
});

test('applyLookupToForm: an entered price and own notes are kept for regular volumes', async () => {
    const { applyLookupToForm } = await load();
    const prev = { type: 'volume', volume_number: '5', price: '6.99', notes: 'Erstauflage', cover_image: '/uploads/mine.jpg', images: ['/uploads/mine.jpg'] };
    const { next } = applyLookupToForm(prev, { price: 7, notes: 'Offizieller Titel', cover_image: '/uploads/mine.jpg' });
    assert.equal(next.price, '6.99');
    assert.equal(next.notes, 'Erstauflage');
    // a zero price and the old placeholder note are replaced
    const placeholder = applyLookupToForm({ type: 'volume', volume_number: '1', price: '0,00', notes: 'Das Abenteuer beginnt' }, { price: 7, notes: 'Echter Titel' }).next;
    assert.equal(placeholder.price, '7');
    assert.equal(placeholder.notes, 'Echter Titel');
});

test('applyLookupToForm: Schuber entries take the official data, wrong volume data are cleared, nothing new = no changes', async () => {
    const { applyLookupToForm } = await load();
    const schuber = { type: 'schuber', volume_number: '1', price: '12', notes: 'Falsch', pages: '200', isbn: '123', cover_image: '/uploads/band1.jpg', images: ['/uploads/band1.jpg', '/uploads/x.jpg'] };
    const { next } = applyLookupToForm(schuber, { volume_number: 'Schuber 1', price: 25, notes: 'East Blue Leerschuber', cover_image: '/uploads/schuber.jpg' });
    assert.equal(next.volume_number, 'Schuber 1');
    assert.equal(next.price, '25');
    assert.equal(next.notes, 'East Blue Leerschuber');
    assert.equal(next.pages, '');
    assert.equal(next.isbn, '');
    assert.deepEqual(next.images, ['/uploads/schuber.jpg', '/uploads/x.jpg']);

    const unchanged = applyLookupToForm({ type: 'volume', volume_number: '2', price: '7', notes: 'x', cover_image: '/c.jpg', images: ['/c.jpg'] }, {});
    assert.deepEqual(unchanged.updatedFields, []);
});
