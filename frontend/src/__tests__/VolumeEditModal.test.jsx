// Covers the volume edit modal: fields, saving, owners, photos and undo.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import VolumeEditModal from '../components/detail/VolumeEditModal';
import { ownersUndoBody } from '../components/detail/volumeEdit/OwnersField';
import { recordToasts } from './toastLog';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const manga = {
  id: 1,
  publisher: 'Carlsen Manga',
  reader_stats: [{ user_id: 1, username: 'ed' }, { user_id: 2, username: 'anna' }]
};
const editor = { id: 1, role: 'editor' };

const volume = (over = {}) => ({
  id: 7, manga_id: 1, type: 'volume', volume_number: '3', status: 'Vorhanden', price: 7.5,
  owners: [{ user_id: 1, username: 'ed' }], images: [], cover_image: null, isbn: '', release_date: '', ...over
});

/** fetch mock answering by "METHOD path" prefix; records every call. */
const routeFetch = (routes) => {
  const fn = vi.fn(async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url}`;
    const hit = Object.keys(routes).find(k => key.startsWith(k));
    if (!hit) throw new Error(`unexpected request ${key}`);
    return routes[hit](url, init);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
};
const callsTo = (fn, prefix) => fn.mock.calls.filter(([url, init = {}]) => `${init.method || 'GET'} ${url}`.startsWith(prefix));

const setup = (vol, props = {}) => {
  const handlers = { onClose: vi.fn(), onSuccess: vi.fn(), onPreviewImage: vi.fn() };
  const utils = render(
    <VolumeEditModal isOpen activeVolume={vol} manga={manga} mangaId={1} canEdit user={editor} {...handlers} {...props} />
  );
  return { ...utils, ...handlers };
};

const save = () => fireEvent.click(screen.getByRole('button', { name: /Speichern/ }));
const putBody = async (fetchMock) => {
  await waitFor(() => expect(callsTo(fetchMock, 'PUT /api/volumes/')).toHaveLength(1));
  return JSON.parse(callsTo(fetchMock, 'PUT /api/volumes/')[0][1].body);
};

describe('VolumeEditModal: owner toggle and status', () => {
  it('removing the last owner switches the form to Fehlt and Save does not re-add the owner', async () => {
    const fetchMock = routeFetch({
      'POST /api/volumes/7/owners': () => json(200, { success: true, status: 'Fehlt', owners: [] }),
      'PUT /api/volumes/7': () => json(200, { success: true })
    });
    const { onClose, onSuccess } = setup(volume());
    fireEvent.click(screen.getByRole('button', { name: 'ed', pressed: true }));
    await screen.findByRole('button', { name: 'Fehlt noch', pressed: true });
    expect(screen.getByRole('button', { name: 'ed', pressed: false })).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledTimes(1);

    save();
    const body = await putBody(fetchMock);
    expect(body).not.toHaveProperty('status');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('adding the first owner switches the form to Vorhanden', async () => {
    const fetchMock = routeFetch({
      'POST /api/volumes/7/owners': () => json(200, { success: true, status: 'Vorhanden', owners: [{ user_id: 1, username: 'ed' }] }),
      'PUT /api/volumes/7': () => json(200, { success: true })
    });
    setup(volume({ status: 'Fehlt', owners: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'ed', pressed: false }));
    await screen.findByRole('button', { name: 'Im Besitz', pressed: true });
    save();
    expect(await putBody(fetchMock)).not.toHaveProperty('status');
  });

  it('a status the user picks after the toggle is still sent', async () => {
    const fetchMock = routeFetch({
      'POST /api/volumes/7/owners': () => json(200, { success: true, status: 'Fehlt', owners: [] }),
      'PUT /api/volumes/7': () => json(200, { success: true })
    });
    setup(volume());
    fireEvent.click(screen.getByRole('button', { name: 'ed', pressed: true }));
    await screen.findByRole('button', { name: 'Fehlt noch', pressed: true });
    fireEvent.click(screen.getByRole('button', { name: 'Erscheint bald' }));
    save();
    expect((await putBody(fetchMock)).status).toBe('Erscheint bald');
  });

  it('removing the last owner clears the purchase date the server dropped; Save does not write it back', async () => {
    const fetchMock = routeFetch({
      'POST /api/volumes/7/owners': () => json(200, { success: true, status: 'Fehlt', owners: [] }),
      'PUT /api/volumes/7': () => json(200, { success: true })
    });
    setup(volume({ purchase_date: '2026-03-14' }));
    expect(screen.getByLabelText('Kaufdatum').value).toBe('2026-03-14');
    fireEvent.click(screen.getByRole('button', { name: 'ed', pressed: true }));
    await screen.findByRole('button', { name: 'Fehlt noch', pressed: true });
    expect(screen.getByLabelText('Kaufdatum').value).toBe('');
    save();
    expect(await putBody(fetchMock)).not.toHaveProperty('purchase_date');
  });

  it('an unchanged purchase date is not sent; a date the user typed is, also across an owner toggle', async () => {
    const fetchMock = routeFetch({
      'POST /api/volumes/7/owners': () => json(200, { success: true, status: 'Fehlt', owners: [] }),
      'PUT /api/volumes/7': () => json(200, { success: true })
    });
    const { unmount } = setup(volume({ purchase_date: '2026-03-14' }));
    save();
    expect(await putBody(fetchMock)).not.toHaveProperty('purchase_date');
    unmount();

    fetchMock.mockClear();
    setup(volume({ purchase_date: '2026-03-14' }));
    fireEvent.change(screen.getByLabelText('Kaufdatum'), { target: { value: '2026-04-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'ed', pressed: true }));
    await screen.findByRole('button', { name: 'Fehlt noch', pressed: true });
    expect(screen.getByLabelText('Kaufdatum').value).toBe('2026-04-01');
    save();
    expect((await putBody(fetchMock)).purchase_date).toBe('2026-04-01');
  });

  it('an owner leaving moves the date to the remaining owner (purchase_date of the owners answer)', async () => {
    const fetchMock = routeFetch({
      'POST /api/volumes/7/owners': () => json(200, {
        success: true,
        status: 'Vorhanden',
        owners: [{ user_id: 2, username: 'anna', price: 7.5, purchase_date: '2024-06-06', condition: null }],
        owned_by_me: false,
        previous_purchase_date: '2024-04-04',
        removed_owner: { user_id: 1, price: 7.5, purchase_date: '2024-04-04', condition: null },
        purchase_date: '2024-06-06'
      }),
      'PUT /api/volumes/7': () => json(200, { success: true })
    });
    setup(volume({
      purchase_date: '2024-04-04',
      owners: [{ user_id: 1, username: 'ed' }, { user_id: 2, username: 'anna' }]
    }));
    fireEvent.click(screen.getByRole('button', { name: 'ed', pressed: true }));
    await waitFor(() => expect(screen.getByLabelText('Kaufdatum').value).toBe('2024-06-06'));
    save();
    expect(await putBody(fetchMock)).not.toHaveProperty('purchase_date');
  });

  it('renders the Bestellt status and maps a legacy Gelesen to Im Besitz', () => {
    routeFetch({});
    const { unmount } = setup(volume({ status: 'Bestellt' }));
    expect(screen.getByRole('button', { name: 'Bestellt', pressed: true })).toBeTruthy();
    unmount();
    setup(volume({ status: 'Gelesen' }));
    expect(screen.getByRole('button', { name: 'Im Besitz', pressed: true })).toBeTruthy();
  });
});

describe('VolumeEditModal: labels', () => {
  it('clicking the release date caption does not start the autofill', () => {
    const fetchMock = routeFetch({});
    setup(volume());
    fireEvent.click(screen.getByText('Erscheinungsdatum (Radar)'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Erscheinungsdatum \(Radar\)/).getAttribute('type')).toBe('date');
  });

  it('clicking the ISBN caption does not open the camera', () => {
    routeFetch({});
    const { container } = setup(volume());
    const camera = container.querySelector('input[type="file"][capture]');
    const onCameraClick = vi.fn();
    camera.addEventListener('click', onCameraClick);
    fireEvent.click(screen.getByText('ISBN-Nummer'));
    expect(onCameraClick).not.toHaveBeenCalled();
    expect(screen.getByLabelText('ISBN-Nummer').getAttribute('placeholder')).toMatch(/978/);
  });

  it('fields and pills have accessible names', () => {
    routeFetch({});
    setup(volume({ status: 'Fehlt' }));
    expect(screen.getByLabelText('Kaufpreis (€)')).toBeTruthy();
    expect(screen.getByLabelText('Zielpreis (€)')).toBeTruthy();
    expect(screen.getByLabelText('Wunsch-Priorität')).toBeTruthy();
    expect(screen.getByLabelText(/Band-Nummer/)).toBeTruthy();
    expect(screen.getByLabelText(/Kaufdatum/)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Sammler-Status' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Besitzer' })).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('VolumeEditModal: validation', () => {
  it('an invalid price blocks the save with an inline error', async () => {
    const fetchMock = routeFetch({});
    setup(volume());
    fireEvent.change(screen.getByLabelText('Kaufpreis (€)'), { target: { value: 'sieben' } });
    expect(screen.getByText('Ungültiger Preis, z. B. 7,50')).toBeTruthy();
    save();
    expect(await screen.findByText('Bitte prüfen: Kaufpreis')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('German prices with thousands separator are accepted', async () => {
    const fetchMock = routeFetch({ 'PUT /api/volumes/7': () => json(200, { success: true }) });
    setup(volume());
    fireEvent.change(screen.getByLabelText('Kaufpreis (€)'), { target: { value: '1.234,56 €' } });
    expect(screen.queryByText(/Ungültiger Preis/)).toBeNull();
    save();
    expect((await putBody(fetchMock)).price).toBe('1.234,56 €');
  });

  it('an unchanged legacy price does not block the save and is not sent', async () => {
    const fetchMock = routeFetch({ 'PUT /api/volumes/7': () => json(200, { success: true }) });
    setup(volume({ price: 12.999 }));
    save();
    expect(await putBody(fetchMock)).toEqual({});
  });

  it('only fields the user changed are sent, so an older copy cannot overwrite newer server values', async () => {
    const fetchMock = routeFetch({ 'PUT /api/volumes/7': () => json(200, { success: true }) });
    setup(volume({ price: 7, notes: 'alt', isbn: '9783551762948', condition: 'Neu' }));
    fireEvent.change(screen.getByLabelText('Kaufpreis (€)'), { target: { value: '8' } });
    save();
    expect(await putBody(fetchMock)).toEqual({ price: '8' });
  });

  it('a refreshed volume replaces untouched fields of the open form; touched fields win', async () => {
    const fetchMock = routeFetch({ 'PUT /api/volumes/7': () => json(200, { success: true }) });
    const stale = volume({ price: 7, notes: 'alt', purchase_date: '2024-01-01' });
    const handlers = { onClose: vi.fn(), onSuccess: vi.fn(), onPreviewImage: vi.fn() };
    const view = render(<VolumeEditModal isOpen activeVolume={stale} manga={manga} mangaId={1} canEdit user={editor} {...handlers} />);
    fireEvent.change(screen.getByLabelText('Kaufdatum'), { target: { value: '2024-02-02' } });
    view.rerender(
      <VolumeEditModal isOpen activeVolume={{ ...stale, price: 9, notes: 'neu', purchase_date: '2024-03-03' }} manga={manga} mangaId={1} canEdit user={editor} {...handlers} />
    );
    expect(screen.getByLabelText('Kaufpreis (€)').value).toBe('9');
    expect(screen.getByLabelText('Kaufdatum').value).toBe('2024-02-02');
    save();
    expect(await putBody(fetchMock)).toEqual({ purchase_date: '2024-02-02' });
  });

  it('a blank volume number is not sent; a padded one is trimmed', async () => {
    const fetchMock = routeFetch({ 'PUT /api/volumes/7': () => json(200, { success: true }) });
    setup(volume());
    const input = screen.getByLabelText(/Band-Nummer/);
    fireEvent.change(input, { target: { value: '   ' } });
    save();
    expect(await screen.findByText('Bitte eine Bandnummer eingeben.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: ' 4 ' } });
    save();
    expect((await putBody(fetchMock)).volume_number).toBe('4');
  });

  it('shows the server error inline instead of an alert', async () => {
    routeFetch({ 'PUT /api/volumes/7': () => new Response('<html>Bad Gateway</html>', { status: 502 }) });
    setup(volume());
    save();
    expect(await screen.findByText('Fehler beim Speichern des Bands (HTTP 502)')).toBeTruthy();
  });
});

describe('VolumeEditModal: month-only dates', () => {
  it('names a stored YYYY-MM date and keeps it on save', async () => {
    const fetchMock = routeFetch({ 'PUT /api/volumes/7': () => json(200, { success: true }) });
    setup(volume({ release_date: '2026-11' }));
    expect(screen.getByText('Gespeichert: November 2026 (nur Monat)')).toBeTruthy();
    save();
    expect(await putBody(fetchMock)).not.toHaveProperty('release_date');
  });

  it('entfernen clears the partial date', async () => {
    const fetchMock = routeFetch({ 'PUT /api/volumes/7': () => json(200, { success: true }) });
    setup(volume({ release_date: '2026-11' }));
    fireEvent.click(screen.getByRole('button', { name: 'entfernen' }));
    expect(screen.queryByText(/Gespeichert:/)).toBeNull();
    save();
    expect((await putBody(fetchMock)).release_date).toBe('');
  });
});

describe('VolumeEditModal: async results and reopen', () => {
  it('a late autofill result does not land in the next volume', async () => {
    let resolveLookup;
    const fetchMock = routeFetch({
      'GET /api/volumes/lookup': () => new Promise(r => { resolveLookup = r; })
    });
    const handlers = { onClose: vi.fn(), onSuccess: vi.fn(), onPreviewImage: vi.fn() };
    const props = { manga, mangaId: 1, canEdit: true, user: editor, ...handlers };
    const { rerender } = render(<VolumeEditModal isOpen activeVolume={volume({ id: 3, volume_number: '3' })} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Daten jetzt automatisch ausfüllen/ }));
    rerender(<VolumeEditModal isOpen={false} activeVolume={null} {...props} />);
    rerender(<VolumeEditModal isOpen activeVolume={volume({ id: 4, volume_number: '4', isbn: '9783551000004' })} {...props} />);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => {
      resolveLookup(json(200, { success: true, data: { isbn: '9783551000003', publisher: 'Fremd', release_date: '2020-01-01' } }));
    });
    expect(screen.getByLabelText('ISBN-Nummer').value).toBe('9783551000004');
    expect(screen.getByLabelText('Verlag').value).toBe('');
    expect(screen.queryByText(/Erfolgreich/)).toBeNull();
  });

  it('autofill errors show the server message and the price is sent as a decimal', async () => {
    const fetchMock = routeFetch({
      'GET /api/volumes/lookup': () => json(500, { error: 'Fehler beim Abrufen der Band-Metadaten' })
    });
    setup(volume());
    fireEvent.change(screen.getByLabelText('Kaufpreis (€)'), { target: { value: '12,95' } });
    fireEvent.click(screen.getByRole('button', { name: /Daten jetzt automatisch ausfüllen/ }));
    expect(await screen.findByText('Fehler beim Abrufen der Band-Metadaten')).toBeTruthy();
    expect(new URL(fetchMock.mock.calls[0][0], 'http://x').searchParams.get('price')).toBe('12.95');
    expect(screen.getByRole('button', { name: 'Meldung schließen' })).toBeTruthy();
  });
});

describe('VolumeEditModal: photos', () => {
  const file = (name, type = 'image/jpeg') => new File(['x'], name, { type });

  it('uploads more than 10 photos in chunks and names rejected files', async () => {
    let n = 0;
    const fetchMock = routeFetch({
      'POST /api/upload/multiple': (url, init) => json(200, { urls: init.body.getAll('images').map(() => `/uploads/p${++n}.jpg`) })
    });
    const { container } = setup(volume());
    const files = [...Array.from({ length: 12 }, (_, i) => file(`f${i}.jpg`)), file('scan.heic', 'image/heic')];
    fireEvent.change(container.querySelector('input[type="file"][multiple]'), { target: { files } });
    await waitFor(() => expect(screen.getAllByRole('img', { name: /^Foto / })).toHaveLength(12));
    const uploads = callsTo(fetchMock, 'POST /api/upload/multiple');
    expect(uploads.map(([, init]) => init.body.getAll('images').length)).toEqual([10, 2]);
    expect(screen.getByText(/Nicht hochgeladen: scan\.heic/)).toBeTruthy();
  });

  it('shrinks large photos before the upload', async () => {
    const fetchMock = routeFetch({
      'POST /api/upload/multiple': (url, init) => json(200, { urls: init.body.getAll('images').map((f, i) => `/uploads/s${i}-${f.name}`) })
    });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4000, height: 3000, close: () => {} })));
    const toBlob = vi.fn((cb) => cb(new Blob(['small'], { type: 'image/jpeg' })));
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag, opts) => {
      if (tag !== 'canvas') return realCreate(tag, opts);
      return { width: 0, height: 0, getContext: () => ({ fillRect: () => {}, drawImage: () => {} }), toBlob };
    });
    const { container } = setup(volume());
    const big = new File([new Uint8Array(2 * 1024 * 1024)], 'IMG_1.PNG', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type="file"][multiple]'), { target: { files: [big] } });
    await waitFor(() => expect(callsTo(fetchMock, 'POST /api/upload/multiple')).toHaveLength(1));
    const [sent] = callsTo(fetchMock, 'POST /api/upload/multiple')[0][1].body.getAll('images');
    expect([sent.name, sent.type, sent.size]).toEqual(['IMG_1.jpg', 'image/jpeg', 5]);
  });

  it('a failed remote download is reported and not hotlinked unless the user asks', async () => {
    routeFetch({ 'POST /api/upload-remote': () => json(415, { error: 'Die Datei ist kein gültiges Bild' }) });
    setup(volume());
    fireEvent.click(screen.getByRole('button', { name: 'URL eingeben' }));
    fireEvent.change(screen.getByPlaceholderText(/Bild-URL/), { target: { value: 'https://example.com/page' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    expect(await screen.findByText('Die Datei ist kein gültiges Bild')).toBeTruthy();
    expect(screen.queryAllByRole('img', { name: /^Foto / })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Trotzdem als externen Link hinzufügen' }));
    expect(screen.getByRole('img', { name: 'Foto 1' }).getAttribute('src')).toBe('https://example.com/page');
  });

  it('a downloaded image keeps the existing cover', async () => {
    routeFetch({ 'POST /api/upload-remote': () => json(200, { url: '/uploads/new.jpg' }) });
    setup(volume({ cover_image: '/uploads/old.jpg', images: ['/uploads/old.jpg'] }));
    fireEvent.click(screen.getByRole('button', { name: 'URL eingeben' }));
    fireEvent.change(screen.getByPlaceholderText(/Bild-URL/), { target: { value: 'https://example.com/b.jpg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    await waitFor(() => expect(screen.getAllByRole('img', { name: /^Foto / })).toHaveLength(2));
    expect(screen.getByRole('img', { name: 'Foto 1' }).getAttribute('src')).toBe('/uploads/old.jpg');
    expect(screen.getByRole('img', { name: 'Foto 2' }).getAttribute('src')).toBe('/uploads/new.jpg');
    expect(screen.getAllByText('Cover')).toHaveLength(1);
  });

  it('rejects URLs that are not http(s) without a request', async () => {
    const fetchMock = routeFetch({});
    setup(volume());
    fireEvent.click(screen.getByRole('button', { name: 'URL eingeben' }));
    fireEvent.change(screen.getByPlaceholderText(/Bild-URL/), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    expect(await screen.findByText(/Bild-URL mit http/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('img', { name: /^Foto / })).toHaveLength(0);
  });
});

describe('VolumeEditModal: delete', () => {
  it('a volume already deleted elsewhere (404) closes the editor and refreshes', async () => {
    vi.stubGlobal('confirm', () => true);
    routeFetch({ 'DELETE /api/volumes/7': () => json(404, { error: 'Band nicht gefunden' }) });
    const { onClose, onSuccess } = setup(volume());
    fireEvent.click(screen.getByRole('button', { name: /Band löschen/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSuccess).toHaveBeenCalled();
  });

  it('other failures stay open with the server message', async () => {
    vi.stubGlobal('confirm', () => true);
    routeFetch({ 'DELETE /api/volumes/7': () => json(503, { error: 'Wiederherstellung läuft' }) });
    const { onClose } = setup(volume());
    fireEvent.click(screen.getByRole('button', { name: /Band löschen/ }));
    expect(await screen.findByText('Wiederherstellung läuft')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('OwnersField: undo of an owner toggle', () => {
  const bodiesTo = (fn) => callsTo(fn, 'POST /api/volumes/7/owners').map(([, init]) => JSON.parse(init.body));

  it('un-own: Rückgängig re-adds the removed row and puts the volume purchase date back into the form', async () => {
    const toasts = recordToasts();
    let call = 0;
    const fetchMock = routeFetch({
      'POST /api/volumes/7/owners': () => (call++ === 0
        ? json(200, {
          success: true, status: 'Fehlt', owners: [], previous_purchase_date: '2026-03-14',
          removed_owner: { user_id: 1, price: 6.5, purchase_date: '2026-03-10', condition: null }
        })
        : json(200, { success: true, status: 'Vorhanden', owners: [{ user_id: 1, username: 'ed' }], previous_purchase_date: null, removed_owner: null }))
    });
    const { onSuccess } = setup(volume({ purchase_date: '2026-03-14' }));
    fireEvent.click(screen.getByRole('button', { name: 'ed', pressed: true }));
    await screen.findByRole('button', { name: 'Fehlt noch', pressed: true });
    expect(screen.getByLabelText('Kaufdatum').value).toBe('');
    const toast = toasts.last();
    toasts.stop();
    expect(toast.message).toBe('ed besitzt den Band nicht mehr');
    expect(toast.action.label).toBe('Rückgängig');

    await act(async () => { await toast.action.onClick(); });
    expect(bodiesTo(fetchMock)[1]).toEqual({ owned: true, price: 6.5, purchase_date: '2026-03-10', previous_purchase_date: '2026-03-14' });
    await screen.findByRole('button', { name: 'ed', pressed: true });
    expect(screen.getByRole('button', { name: 'Im Besitz', pressed: true })).toBeTruthy();
    expect(screen.getByLabelText('Kaufdatum').value).toBe('2026-03-14');
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });

  it('buy for another user (admin): Rückgängig removes it again with that user and the old date', async () => {
    const toasts = recordToasts();
    const fetchMock = routeFetch({
      'POST /api/volumes/7/owners': () => json(200, {
        success: true, status: 'Vorhanden', owners: [{ user_id: 1, username: 'ed' }, { user_id: 2, username: 'anna' }],
        previous_purchase_date: null, removed_owner: null
      })
    });
    setup(volume(), { user: { id: 1, role: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'anna', pressed: false }));
    await screen.findByRole('button', { name: 'anna', pressed: true });
    const toast = toasts.last();
    toasts.stop();
    expect(toast.message).toBe('anna als Besitzer eingetragen');
    await act(async () => { await toast.action.onClick(); });
    expect(bodiesTo(fetchMock)).toEqual([
      { owned: true, user_id: 2 },
      { owned: false, user_id: 2, previous_purchase_date: null }
    ]);
  });

  it('a failed undo is an error toast; a failed toggle offers no undo', async () => {
    const toasts = recordToasts();
    let call = 0;
    routeFetch({
      'POST /api/volumes/7/owners': () => (call++ === 0
        ? json(200, { success: true, status: 'Fehlt', owners: [], previous_purchase_date: null, removed_owner: { user_id: 1, price: null, purchase_date: null } })
        : json(409, { error: 'Band wurde inzwischen gelöscht' }))
    });
    setup(volume());
    fireEvent.click(screen.getByRole('button', { name: 'ed', pressed: true }));
    await screen.findByRole('button', { name: 'Fehlt noch', pressed: true });
    await act(async () => { await toasts.last().action.onClick(); });
    expect(toasts.messages('error')).toEqual(['Band wurde inzwischen gelöscht']);
    fireEvent.click(screen.getByRole('button', { name: 'ed', pressed: false }));
    expect(await screen.findByText('Band wurde inzwischen gelöscht')).toBeTruthy();
    expect(toasts.list.filter((t) => t.action)).toHaveLength(1);
    toasts.stop();
  });

  it('ownersUndoBody: no undo for an un-own without the removed row; no date key from an older server', () => {
    expect(ownersUndoBody({ owners: [] }, true)).toBeNull();
    expect(ownersUndoBody({ owners: [] }, false)).toEqual({ owned: false });
    expect(ownersUndoBody({ removed_owner: { price: null, purchase_date: null }, previous_purchase_date: null }, true, { user_id: 3 }))
      .toEqual({ owned: true, user_id: 3, previous_purchase_date: null });
  });
});

describe('VolumePhotoManager: upload cancel', () => {
  it('offers "Upload abbrechen" only while photos upload and calls onCancelUpload', async () => {
    const { default: VolumePhotoManager } = await import('../components/detail/VolumePhotoManager');
    const base = {
      editVolForm: { images: [], cover_image: null, volume_number: '3', type: 'volume' },
      handleAddImageUrl: vi.fn(), handleMoveVolumeImage: vi.fn(), handleRemoveVolumeImage: vi.fn(),
      handleSetVolumeCover: vi.fn(), handleUploadVolumeImages: vi.fn(), manualImageUrl: '', setManualImageUrl: vi.fn(),
      setShowUrlInput: vi.fn(), showUrlInput: false, onPreviewImage: vi.fn()
    };
    const onCancelUpload = vi.fn();
    const { rerender } = render(<VolumePhotoManager {...base} uploadingVolImage={false} onCancelUpload={onCancelUpload} />);
    expect(screen.queryByRole('button', { name: /Upload abbrechen/ })).toBeNull();
    rerender(<VolumePhotoManager {...base} uploadingVolImage onCancelUpload={onCancelUpload} />);
    fireEvent.click(screen.getByRole('button', { name: /Upload abbrechen/ }));
    expect(onCancelUpload).toHaveBeenCalledTimes(1);
  });
});
