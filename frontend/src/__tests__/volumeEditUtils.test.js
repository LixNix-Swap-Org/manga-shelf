import { describe, it, expect, vi } from 'vitest';
import {
  parsePriceInput, priceForQuery, validateVolumeForm, buildSaveBody, partialDateLabel, isFullDate, filterUploadFiles,
  chunk, addImages, removeImage, moveImage, deleteVolumeRequest, isAllowedImageUrl, buildEditorForm
} from '../components/detail/volumeEdit/editorUtils';

const reply = (status, body, type = 'application/json') => async () => new Response(body, { status, headers: { 'Content-Type': type } });

describe('price parsing (same rules as routes/volumes.js parsePrice)', () => {
  it.each([
    ['', null], ['7.5', 7.5], ['7,50', 7.5], ['€ 7,99', 7.99], ['7,99 €', 7.99], ['1.234,56', 1234.56], ['99999', 99999]
  ])('%s -> %s', (input, expected) => expect(parsePriceInput(input)).toBe(expected));

  it.each(['sieben', '7abc', '-3', '1.234', '7,999', '100000'])('%s is invalid', (input) => {
    expect(Number.isNaN(parsePriceInput(input))).toBe(true);
  });

  it('query price is a plain decimal', () => {
    expect(priceForQuery('12,95')).toBe('12.95');
    expect(priceForQuery('')).toBe('');
    expect(priceForQuery('sieben')).toBe('');
  });
});

describe('validateVolumeForm / buildSaveBody', () => {
  const form = { volume_number: '3', price: '7.5', target_price: '', status: 'Fehlt' };

  it('flags blank numbers and bad prices', () => {
    expect(validateVolumeForm({ ...form, volume_number: '  ', price: 'x', target_price: 'y' })).toEqual({
      volume_number: expect.any(String), price: expect.any(String), target_price: expect.any(String)
    });
    expect(validateVolumeForm({ ...form, volume_number: 'x'.repeat(81) }).volume_number).toBe('Höchstens 80 Zeichen.');
    expect(validateVolumeForm(form)).toEqual({});
  });

  it('values unchanged since opening are not checked', () => {
    const legacy = { ...form, price: '12.999' };
    expect(validateVolumeForm(legacy, legacy)).toEqual({});
    expect(validateVolumeForm({ ...legacy, price: '12.9999' }, legacy).price).toBeTruthy();
  });

  it('sends the status only when it differs from the server state', () => {
    expect(buildSaveBody({ ...form, volume_number: ' 4 ' }, 'Fehlt')).toEqual({ volume_number: '4', price: '7.5', target_price: '' });
    expect(buildSaveBody(form, 'Vorhanden').status).toBe('Fehlt');
  });

  it('legacy Gelesen opens as Vorhanden', () => {
    expect(buildEditorForm({ volume_number: '1', status: 'Gelesen' }).status).toBe('Vorhanden');
    expect(buildEditorForm({ volume_number: '1', status: 'Bestellt' }).status).toBe('Bestellt');
  });
});

describe('partial dates', () => {
  it('labels month-only and year-only values', () => {
    expect(partialDateLabel('2026-11')).toBe('November 2026');
    expect(partialDateLabel('2026')).toBe('2026');
    expect(partialDateLabel('2026-11-05')).toBeNull();
    expect(partialDateLabel('')).toBeNull();
    expect(isFullDate('2026-11-05')).toBe(true);
    expect(isFullDate('2026-11')).toBe(false);
  });
});

describe('uploads', () => {
  it('filters by type and size and chunks by 10', () => {
    const ok = new File(['x'], 'a.JPG', { type: 'image/jpeg' });
    const heic = new File(['x'], 'b.heic', { type: 'image/heic' });
    const big = new File(['x'], 'c.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 16 * 1024 * 1024 });
    const { accepted, rejected } = filterUploadFiles([ok, heic, big]);
    expect(accepted).toEqual([ok]);
    expect(rejected.map(r => r.name)).toEqual(['b.heic', 'c.png']);
    expect(chunk(Array.from({ length: 23 }, (_, i) => i), 10).map(c => c.length)).toEqual([10, 10, 3]);
  });

  it('allows only http(s) and /uploads/ image URLs', () => {
    expect(isAllowedImageUrl('https://a.de/x.jpg')).toBe(true);
    expect(isAllowedImageUrl('/uploads/x.jpg')).toBe(true);
    expect(isAllowedImageUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedImageUrl('foo')).toBe(false);
  });
});

describe('image reducers work on the latest state', () => {
  const base = { images: ['/a', '/b'], cover_image: '/a' };

  it('an appended upload survives a removal computed afterwards', () => {
    const queued = addImages(base, ['/c']);
    expect(removeImage(queued, '/b')).toEqual({ images: ['/a', '/c'], cover_image: '/a' });
  });

  it('removing the cover picks the next image, removing the last clears it', () => {
    expect(removeImage(base, '/a').cover_image).toBe('/b');
    expect(removeImage({ images: ['/a'], cover_image: '/a' }, '/a')).toEqual({ images: [], cover_image: '' });
  });

  it('moves by URL, so a prepended image does not shift the target', () => {
    const shifted = { ...base, images: ['/new', '/a', '/b'] };
    expect(moveImage(shifted, '/a', 1).images).toEqual(['/new', '/b', '/a']);
    expect(moveImage(base, '/b', 1)).toBe(base);
    expect(moveImage(base, '/gone', -1)).toBe(base);
  });

  it('addImages keeps the cover and skips duplicates', () => {
    expect(addImages(base, ['/b', '/c'])).toEqual({ images: ['/a', '/b', '/c'], cover_image: '/a' });
    expect(addImages({ images: [], cover_image: '' }, ['/c'])).toEqual({ images: ['/c'], cover_image: '/c' });
  });
});

describe('deleteVolumeRequest', () => {
  it.each([
    [reply(200, '{"success":true}'), { ok: true, gone: false }],
    [reply(404, '{"error":"Band nicht gefunden"}'), { ok: true, gone: true }],
    [reply(503, '{"error":"Wiederherstellung läuft"}'), { ok: false, error: 'Wiederherstellung läuft' }],
    [reply(502, '<html>Bad Gateway</html>', 'text/html'), { ok: false, error: 'Fehler beim Löschen des Bands (HTTP 502)' }],
    [async () => { throw new TypeError('Failed to fetch'); }, { ok: false, error: 'Netzwerkfehler beim Löschen des Bands' }]
  ])('outcome %#', async (impl, expected) => {
    vi.stubGlobal('fetch', vi.fn(impl));
    expect(await deleteVolumeRequest(5)).toEqual(expected);
  });
});
