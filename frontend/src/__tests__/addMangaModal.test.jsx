import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import AddMangaModal from '../components/modals/AddMangaModal';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** routes: { 'POST /api/mangas': (url, init) => Response | Promise<Response> } */
function mockFetch(routes) {
  const fn = vi.fn(async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${String(url).split('?')[0]}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const callsTo = (fn, key) => fn.mock.calls.filter(([url, init = {}]) => `${init.method || 'GET'} ${String(url).split('?')[0]}` === key);
const bodyOf = (call) => JSON.parse(call[1].body);

const scanPrefill = (overrides = {}) => ({
  form: { title: 'Frieren', author: 'Kanehito Yamada', publisher: 'EMA', cover_image: '', ...overrides.form },
  volume: { enabled: true, volume_number: '3', status: 'Vorhanden', isbn: '9783770443096', price: '7.50', pages: '', release_year: '', publisher: 'EMA', ...overrides.volume }
});

const renderModal = (props = {}) => {
  const handlers = { onClose: vi.fn(), onSuccess: vi.fn(), onSeriesCreated: vi.fn() };
  const utils = render(<AddMangaModal isOpen {...handlers} {...props} />);
  return { ...handlers, ...utils };
};

const titleInput = () => screen.getByPlaceholderText(/One Piece/);
const submitButton = () => document.querySelector('button[type="submit"]');

describe('AddMangaModal: lookup status and publisher', () => {
  it('keeps an AniList "Abgebrochen" status visible in the select and sends it', async () => {
    const fetchFn = mockFetch({
      'GET /api/lookup/manga': () => json(200, [{ id: 'al_1', source: 'anilist', title: 'Shaman King Flowers', status: 'Abgebrochen', cover_image: '' }]),
      'POST /api/mangas': () => json(200, { success: true, id: 7 })
    });
    const { onSuccess } = renderModal();
    fireEvent.change(titleInput(), { target: { value: 'Shaman King' } });
    fireEvent.click(screen.getByRole('button', { name: /Auto-Fill/ }));
    await waitFor(() => expect(titleInput().value).toBe('Shaman King Flowers'));
    expect(screen.getByLabelText('Status').value).toBe('Abgebrochen');
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(bodyOf(callsTo(fetchFn, 'POST /api/mangas')[0]).status).toBe('Abgebrochen');
  });

  it('ignores "Unbekannt" status and publisher from Manga Passion', async () => {
    const fetchFn = mockFetch({
      'GET /api/lookup/manga': () => json(200, [{ id: 'mp_1', source: 'manga_passion', title: 'Blame!', status: 'Unbekannt', publisher: 'Unbekannt', manga_passion_id: 12 }]),
      'POST /api/mangas': () => json(200, { success: true, id: 8 })
    });
    const { onSuccess } = renderModal();
    fireEvent.change(titleInput(), { target: { value: 'Blame' } });
    fireEvent.change(screen.getByPlaceholderText(/Carlsen/), { target: { value: 'Carlsen Manga' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Pausiert' } });
    fireEvent.click(screen.getByRole('button', { name: /Auto-Fill/ }));
    await waitFor(() => expect(titleInput().value).toBe('Blame!'));
    expect(screen.getByLabelText('Status').value).toBe('Pausiert');
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const body = bodyOf(callsTo(fetchFn, 'POST /api/mangas')[0]);
    expect(body.status).toBe('Pausiert');
    expect(body.publisher).toBe('Carlsen Manga');
    expect(body.manga_passion_id).toBe(12);
  });

  it('describes both lookup sources in the Auto-Fill tooltip', () => {
    renderModal();
    expect(screen.getByRole('button', { name: /Auto-Fill/ }).title).toBe('Sucht in Manga Passion (deutsche Ausgaben) und AniList');
  });
});

describe('AddMangaModal: series created, scanned volume failed', () => {
  it('a rejected volume request keeps the series; the retry only creates the volume', async () => {
    let volumeAttempts = 0;
    const fetchFn = mockFetch({
      'POST /api/mangas': () => json(200, { success: true, id: 43 }),
      'POST /api/volumes': () => {
        volumeAttempts += 1;
        if (volumeAttempts === 1) throw new TypeError('Failed to fetch');
        return json(200, { id: 900 });
      }
    });
    const { onSuccess, onSeriesCreated, onClose } = renderModal({ prefill: scanPrefill() });
    fireEvent.click(submitButton());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Die Reihe wurde angelegt, der Band aber nicht: Netzwerkfehler/);
    expect(screen.getByRole('alert').textContent).not.toMatch(/Failed to fetch/);
    expect(submitButton().textContent).toContain('Band anlegen');
    expect(onSeriesCreated).toHaveBeenCalledTimes(1);
    expect(onSeriesCreated.mock.calls[0][0].id).toBe(43);
    expect(titleInput().matches(':disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /Auto-Fill/ }).matches(':disabled')).toBe(true);

    fireEvent.click(submitButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(callsTo(fetchFn, 'POST /api/mangas')).toHaveLength(1);
    const volumeCalls = callsTo(fetchFn, 'POST /api/volumes');
    expect(volumeCalls).toHaveLength(2);
    expect(bodyOf(volumeCalls[1]).manga_id).toBe(43);
    expect(onSuccess.mock.calls[0][0].id).toBe(43);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSeriesCreated).toHaveBeenCalledTimes(1);
  });

  it('a 409 with existing_id on the retry counts as created', async () => {
    let volumeAttempts = 0;
    mockFetch({
      'POST /api/mangas': () => json(200, { success: true, id: 43 }),
      'POST /api/volumes': () => {
        volumeAttempts += 1;
        if (volumeAttempts === 1) throw new TypeError('Load failed');
        return json(409, { error: 'Band 3 existiert bereits', existing_id: 900 });
      }
    });
    const { onSuccess, onClose } = renderModal({ prefill: scanPrefill() });
    fireEvent.click(submitButton());
    await screen.findByRole('alert');
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ id: 43 })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('after a volume 4xx, unticking the volume turns the button into "Fertig" without another request', async () => {
    const fetchFn = mockFetch({
      'POST /api/mangas': () => json(200, { success: true, id: 5 }),
      'POST /api/volumes': () => json(400, { error: 'Ungültige Bandnummer' })
    });
    const { onSuccess, onSeriesCreated } = renderModal({ prefill: scanPrefill() });
    fireEvent.click(submitButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/Ungültige Bandnummer/);
    expect(onSeriesCreated).toHaveBeenCalledTimes(1);
    expect(document.getElementById('btn-close-add-modal').textContent).toBe('Schließen');
    fireEvent.click(screen.getByLabelText(/Gescannten Band gleich anlegen/));
    expect(submitButton().textContent).toContain('Fertig');
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a non-JSON success answer does not report a created series', async () => {
    mockFetch({
      'POST /api/mangas': () => new Response('<html>proxy</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    });
    const { onSuccess } = renderModal();
    fireEvent.change(titleInput(), { target: { value: 'Dorohedoro' } });
    fireEvent.click(submitButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/eventuell trotzdem angelegt/);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(submitButton().textContent).toContain('Manga anlegen');
  });
});

describe('AddMangaModal: closing', () => {
  it('a drag that starts in a field and ends on the backdrop does not close', () => {
    const { onClose } = renderModal();
    fireEvent.change(titleInput(), { target: { value: 'Berserk' } });
    fireEvent.pointerDown(titleInput());
    fireEvent.mouseDown(titleInput());
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    expect(titleInput().value).toBe('Berserk');
  });

  it('a plain backdrop click closes once', () => {
    const { onClose } = renderModal();
    const overlay = screen.getByRole('dialog');
    fireEvent.pointerDown(overlay);
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop, X and Escape do nothing while submitting', async () => {
    const pending = deferred();
    mockFetch({ 'POST /api/mangas': () => pending.promise });
    const { onClose } = renderModal();
    fireEvent.change(titleInput(), { target: { value: 'Vagabond' } });
    fireEvent.click(submitButton());
    const overlay = screen.getByRole('dialog');
    await waitFor(() => expect(overlay.getAttribute('data-busy')).toBe('true'));
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    fireEvent.keyDown(overlay, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(json(200, { success: true, id: 1 })); });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Escape closes the result list first, then the dialog', async () => {
    mockFetch({
      'GET /api/lookup/manga': () => json(200, [
        { id: 'mp_1', source: 'manga_passion', title: 'Monster', status: 'Abgeschlossen' },
        { id: 'al_2', source: 'anilist', title: 'Monster (AniList)', status: 'Abgeschlossen' }
      ])
    });
    const { onClose } = renderModal();
    fireEvent.change(titleInput(), { target: { value: 'Monster' } });
    fireEvent.click(screen.getByRole('button', { name: /Auto-Fill/ }));
    await screen.findByText('Monster (AniList)');
    const escape = fireEvent.keyDown(titleInput(), { key: 'Escape' });
    expect(escape).toBe(false);
    expect(screen.queryByText('Monster (AniList)')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(titleInput(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AddMangaModal: covers', () => {
  it('a submit while the scanned cover is still caching stores the local copy', async () => {
    const upload = deferred();
    const remote = 'https://covers.openlibrary.org/b/isbn/9783770443096-L.jpg?default=false';
    const fetchFn = mockFetch({
      'POST /api/upload-remote': () => upload.promise,
      'POST /api/mangas': () => json(200, { success: true, id: 11 }),
      'POST /api/volumes': () => json(200, { id: 1 })
    });
    const { onSuccess } = renderModal({ prefill: scanPrefill({ form: { cover_image: remote } }) });
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton().textContent).toContain('Cover wird geladen'));
    expect(callsTo(fetchFn, 'POST /api/mangas')).toHaveLength(0);
    await act(async () => { upload.resolve(json(200, { url: '/uploads/scan.jpg' })); });
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(bodyOf(callsTo(fetchFn, 'POST /api/mangas')[0]).cover_image).toBe('/uploads/scan.jpg');
    expect(callsTo(fetchFn, 'POST /api/upload-remote')).toHaveLength(1);
  });

  it('a scanned cover the catalogue does not have is saved as no cover', async () => {
    const upload = deferred();
    const fetchFn = mockFetch({
      'POST /api/upload-remote': () => upload.promise,
      'POST /api/mangas': () => json(200, { success: true, id: 12 }),
      'POST /api/volumes': () => json(200, { id: 1 })
    });
    const { onSuccess } = renderModal({ prefill: scanPrefill({ form: { cover_image: 'https://covers.openlibrary.org/b/isbn/1-L.jpg?default=false' } }) });
    fireEvent.click(submitButton());
    await act(async () => { upload.resolve(json(502, { error: 'Bild konnte nicht geladen werden' })); });
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(bodyOf(callsTo(fetchFn, 'POST /api/mangas')[0]).cover_image).toBeNull();
  });

  it('a typed remote URL is cached on submit and kept as typed when the server cannot fetch it', async () => {
    let answer = json(200, { url: '/uploads/typed.jpg' });
    const fetchFn = mockFetch({
      'POST /api/upload-remote': () => answer,
      'POST /api/mangas': () => json(200, { success: true, id: 13 })
    });
    const first = renderModal();
    fireEvent.change(titleInput(), { target: { value: 'Akira' } });
    fireEvent.change(screen.getByPlaceholderText(/example\.com/), { target: { value: 'https://example.org/akira.jpg' } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(first.onSuccess).toHaveBeenCalled());
    expect(bodyOf(callsTo(fetchFn, 'POST /api/mangas')[0]).cover_image).toBe('/uploads/typed.jpg');
    first.unmount();

    answer = json(400, { error: 'Bild-URL nicht erreichbar oder nicht erlaubt' });
    const second = renderModal();
    fireEvent.change(titleInput(), { target: { value: 'Akira' } });
    fireEvent.change(screen.getByPlaceholderText(/example\.com/), { target: { value: 'https://example.org/akira.jpg' } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(second.onSuccess).toHaveBeenCalled());
    expect(bodyOf(callsTo(fetchFn, 'POST /api/mangas')[1]).cover_image).toBe('https://example.org/akira.jpg');
  });
});

describe('AddMangaModal: choosing a lookup result', () => {
  const twoResults = () => json(200, [
    { id: 'mp_a', source: 'manga_passion', title: 'Result A', status: 'Laufend', cover_image: 'https://img.example/a.jpg' },
    { id: 'al_b', source: 'anilist', title: 'Result B', status: 'Laufend', cover_image: 'https://img.example/b.jpg' }
  ]);

  it('locks the list and submit while the chosen cover downloads', async () => {
    const coverA = deferred();
    mockFetch({
      'GET /api/lookup/manga': twoResults,
      'POST /api/upload-remote': () => coverA.promise
    });
    renderModal();
    fireEvent.change(titleInput(), { target: { value: 'Result' } });
    fireEvent.click(screen.getByRole('button', { name: /Auto-Fill/ }));
    const buttonA = (await screen.findByText('Result A')).closest('button');
    const buttonB = screen.getByText('Result B').closest('button');
    fireEvent.click(buttonA);
    await waitFor(() => expect(buttonB.disabled).toBe(true));
    expect(buttonA.disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText('Wird übernommen…')).toBeTruthy();
    fireEvent.click(buttonB);
    await act(async () => { coverA.resolve(json(200, { url: '/uploads/a.jpg' })); });
    await waitFor(() => expect(titleInput().value).toBe('Result A'));
    expect(screen.getByPlaceholderText(/example\.com/).value).toBe('/uploads/a.jpg');
    expect(submitButton().disabled).toBe(false);
  });

  it('a pick that finishes after the dialog closed does not fill the next form', async () => {
    const coverA = deferred();
    mockFetch({
      'GET /api/lookup/manga': twoResults,
      'POST /api/upload-remote': () => coverA.promise
    });
    const props = { onClose: vi.fn(), onSuccess: vi.fn() };
    const { rerender } = render(<AddMangaModal isOpen {...props} />);
    fireEvent.change(titleInput(), { target: { value: 'Result' } });
    fireEvent.click(screen.getByRole('button', { name: /Auto-Fill/ }));
    fireEvent.click((await screen.findByText('Result A')).closest('button'));
    fireEvent.click(document.getElementById('btn-close-add-modal'));
    rerender(<AddMangaModal isOpen={false} {...props} />);
    rerender(<AddMangaModal isOpen {...props} />);
    await act(async () => { coverA.resolve(json(200, { url: '/uploads/a.jpg' })); });
    expect(titleInput().value).toBe('');
    expect(screen.getByPlaceholderText(/example\.com/).value).toBe('');
  });
});
