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
    const { next, updatedFields } = applyLookupToForm(schuber, { volume_number: 'Schuber 1', price: 25, notes: 'East Blue Leerschuber', cover_image: '/uploads/schuber.jpg' });
    assert.equal(next.volume_number, 'Schuber 1');
    assert.equal(next.price, '25');
    assert.equal(next.notes, 'East Blue Leerschuber');
    assert.equal(next.pages, '');
    assert.equal(next.isbn, '');
    // the previous cover is never dropped: the user can remove it with the X, a deleted upload cannot come back
    assert.equal(next.cover_image, '/uploads/schuber.jpg');
    assert.deepEqual(next.images, ['/uploads/schuber.jpg', '/uploads/band1.jpg', '/uploads/x.jpg']);
    assert.ok(updatedFields.includes('Seitenzahl entfernt') && updatedFields.includes('ISBN entfernt'));

    const unchanged = applyLookupToForm({ type: 'volume', volume_number: '2', price: '7', notes: 'x', cover_image: '/c.jpg', images: ['/c.jpg'] }, {});
    assert.deepEqual(unchanged.updatedFields, []);
});

test('applyLookupToForm: keeps the user\'s own cover when the lookup cover differs', async () => {
    const { applyLookupToForm } = await load();
    const prev = { type: 'volume', volume_number: '5', price: '', notes: '', cover_image: '/uploads/mine.jpg', images: ['/uploads/mine.jpg', '/uploads/extra.jpg'] };
    const { next, updatedFields } = applyLookupToForm(prev, { cover_image: '/uploads/official.jpg' });
    assert.equal(next.cover_image, '/uploads/mine.jpg');
    assert.deepEqual(next.images, ['/uploads/mine.jpg', '/uploads/extra.jpg']);
    assert.ok(!updatedFields.includes('Cover-Bild'));
});

test('applyLookupToForm: a Schuber keeps the user\'s own photo in the gallery when the lookup brings a cover', async () => {
    const { applyLookupToForm } = await load();
    const prev = { type: 'schuber', volume_number: 'Schuber 1', cover_image: '/uploads/my-own-photo.jpg', images: ['/uploads/my-own-photo.jpg', '/uploads/side.jpg'] };
    const { next } = applyLookupToForm(prev, { cover_image: '/uploads/official.jpg' });
    assert.equal(next.cover_image, '/uploads/official.jpg');
    assert.deepEqual(next.images, ['/uploads/official.jpg', '/uploads/my-own-photo.jpg', '/uploads/side.jpg']);

    // a cover that is missing from the image list is kept as well
    const lost = applyLookupToForm({ type: 'schuber', volume_number: 'Schuber 2', cover_image: '/uploads/mine.jpg', images: [] }, { cover_image: '/uploads/official.jpg' }).next;
    assert.deepEqual(lost.images, ['/uploads/official.jpg', '/uploads/mine.jpg']);
});

test('applyLookupToForm: an MP URL import (forceCover) sets the official cover and keeps the own photo second', async () => {
    const { applyLookupToForm } = await load();
    const prev = { type: 'volume', volume_number: '5', cover_image: '/uploads/mine.jpg', images: ['/uploads/mine.jpg'] };
    const { next, updatedFields } = applyLookupToForm(prev, { cover_image: '/uploads/mp.jpg' }, { forceCover: true });
    assert.equal(next.cover_image, '/uploads/mp.jpg');
    assert.deepEqual(next.images, ['/uploads/mp.jpg', '/uploads/mine.jpg']);
    assert.ok(updatedFields.includes('Cover-Bild'));

    const same = applyLookupToForm(prev, { cover_image: '/uploads/mine.jpg' }, { forceCover: true });
    assert.deepEqual(same.next, prev);
    assert.deepEqual(same.updatedFields, []);
});

test('applyLookupToForm: a known stale cover is replaced and dropped, a normal cover is kept', async () => {
    const { applyLookupToForm, STALE_COVER_MARKERS } = await load();
    const stale = `/uploads/${STALE_COVER_MARKERS[0]}-42.jpg`;
    const { next, updatedFields } = applyLookupToForm({ type: 'volume', volume_number: '1', cover_image: stale, images: [stale, '/uploads/back.jpg'] }, { cover_image: '/uploads/official.jpg' });
    assert.equal(next.cover_image, '/uploads/official.jpg');
    assert.deepEqual(next.images, ['/uploads/official.jpg', '/uploads/back.jpg']);
    assert.ok(updatedFields.includes('Cover-Bild'));

    const normal = applyLookupToForm({ type: 'volume', volume_number: '1', cover_image: '/uploads/1790000000000-1.jpg', images: ['/uploads/1790000000000-1.jpg'] }, { cover_image: '/uploads/official.jpg' }).next;
    assert.equal(normal.cover_image, '/uploads/1790000000000-1.jpg');
});

test('applyLookupToForm: the placeholder note is a named rule, a real note is kept', async () => {
    const { applyLookupToForm, PLACEHOLDER_NOTES } = await load();
    assert.deepEqual(PLACEHOLDER_NOTES, ['Das Abenteuer beginnt']);
    const kept = applyLookupToForm({ type: 'volume', volume_number: '1', notes: 'Das Abenteuer geht weiter' }, { notes: 'Echter Titel' });
    assert.equal(kept.next.notes, 'Das Abenteuer geht weiter');
    assert.deepEqual(kept.updatedFields, []);
});

test('applyLookupToForm: a lookup equal to the form changes and reports nothing', async () => {
    const { applyLookupToForm } = await load();
    const prev = {
        type: 'volume', volume_number: '5', release_date: '2024-05-01', release_year: '2024', pages: '192', isbn: '978-3-551-78901-2',
        price: '7,00', publisher: 'Carlsen Manga', notes: 'Titel des Bandes', cover_image: '/uploads/c.jpg', images: ['/uploads/c.jpg']
    };
    const { next, updatedFields } = applyLookupToForm(prev, {
        release_date: '2024-05-01', release_year: 2024, pages: 192, isbn: '9783551789012', price: 7, publisher: 'Carlsen Manga', notes: 'Titel des Bandes', cover_image: '/uploads/c.jpg'
    });
    assert.deepEqual(updatedFields, []);
    assert.deepEqual(next, prev);

    const partial = applyLookupToForm(prev, { release_date: '2024-06-01', release_year: 2024, publisher: 'Carlsen Manga' });
    assert.deepEqual(partial.updatedFields, ['Erscheinungsdatum (2024-06-01)']);
    assert.equal(partial.next.release_date, '2024-06-01');

    const onlyPublisher = applyLookupToForm(prev, { release_date: '2024-05-01', pages: 192, publisher: 'Egmont Manga' });
    assert.deepEqual(onlyPublisher.updatedFields, ['Verlag']);
});

test('applyLookupToForm: date, year, pages, ISBN and publisher are replaced when the lookup knows them and kept when not', async () => {
    const { applyLookupToForm } = await load();
    const prev = { type: 'volume', volume_number: '5', release_date: '2023-01-01', release_year: '2023', pages: '180', isbn: '9783551000000', publisher: 'Egmont Manga', price: '6.5', notes: '', cover_image: '', images: [] };
    const replaced = applyLookupToForm(prev, { release_date: '2024-05', release_year: 2024, pages: 192, isbn: '9783551789012', publisher: 'Carlsen Manga' }).next;
    assert.equal(replaced.release_date, '2024-05');
    assert.equal(replaced.release_year, '2024');
    assert.equal(replaced.pages, '192');
    assert.equal(replaced.isbn, '9783551789012');
    assert.equal(replaced.publisher, 'Carlsen Manga');
    assert.equal(replaced.price, '6.5');

    const kept = applyLookupToForm(prev, { release_date: null, release_year: null, pages: null, isbn: null, publisher: null });
    assert.deepEqual(kept.next, prev);
    assert.deepEqual(kept.updatedFields, []);
});

test('applyLookupToForm: a Schuber number change alone is reported, a form without number does not throw', async () => {
    const { applyLookupToForm } = await load();
    const renamed = applyLookupToForm({ type: 'schuber', volume_number: '2', pages: '', isbn: '' }, { volume_number: 'Schuber 2' });
    assert.equal(renamed.next.volume_number, 'Schuber 2');
    assert.deepEqual(renamed.updatedFields, ['Nummer (Schuber 2)']);

    const { next } = applyLookupToForm({ type: 'schuber' }, { volume_number: 'Schuber 2' });
    assert.equal(next.volume_number, 'Schuber 2');
});
