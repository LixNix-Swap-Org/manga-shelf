// Catalog stage c2: a series or the volumes it lacks from another own shelf (add dialog section, detail notice).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AddMangaModal from '../components/modals/AddMangaModal';
import CopyVolumesNotice from '../components/detail/CopyVolumesNotice';
import { recordToasts } from './toastLog';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** routes: { 'GET /api/shelves': (url, init) => Response } */
function mockFetch(routes) {
  const fn = vi.fn(async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${String(url).split('?')[0].replace(/^https?:\/\/[^/]+/, '')}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const callsTo = (fn, key) => fn.mock.calls.filter(([url, init = {}]) => `${init.method || 'GET'} ${String(url).split('?')[0].replace(/^https?:\/\/[^/]+/, '')}` === key);

const SHELVES = { shelves: [{ id: 1, name: 'Sammlung', role: 'owner' }, { id: 5, name: 'Mein Regal', role: 'owner' }] };
const HIT = { id: 11, title: 'Frieren', alt_title: null, author: 'Kanehito Yamada', publisher: 'EMA', language: 'de', format: 'print', cover_image: null, shelf_id: 1, shelf_name: 'Sammlung', volume_count: 12 };
const titleInput = () => screen.getByPlaceholderText(/One Piece/);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AddMangaModal: from your shelves', () => {
  it('offers a series of another own shelf and copies it with its volumes', async () => {
    const fetchFn = mockFetch({
      'GET /api/shelves': () => json(200, SHELVES),
      'GET /api/mangas/copy-candidates': () => json(200, { shelf_id: 5, results: [HIT] }),
      'POST /api/mangas/copy': () => json(201, { success: true, id: 42, shelf_id: 5, volumes_created: 12 })
    });
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    render(<AddMangaModal isOpen onClose={onClose} onSuccess={onSuccess} />);
    await waitFor(() => expect(callsTo(fetchFn, 'GET /api/shelves').length).toBe(1));
    fireEvent.change(titleInput(), { target: { value: 'Frier' } });
    const section = await screen.findByRole('region', { name: 'Aus deinen Regalen' });
    expect(section.textContent).toContain('Frieren');
    expect(section.textContent).toContain('in „Sammlung“ · 12 Bände');
    const query = new URL(callsTo(fetchFn, 'GET /api/mangas/copy-candidates')[0][0], 'http://x').searchParams;
    expect(query.get('q')).toBe('Frier');

    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen: Frieren' }));
    fireEvent.click(screen.getByLabelText('Bände mitnehmen (als „Fehlt“)'));
    fireEvent.click(screen.getByRole('button', { name: 'In dieses Regal übernehmen' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ id: 42, copied: true })));
    expect(JSON.parse(callsTo(fetchFn, 'POST /api/mangas/copy')[0][1].body)).toEqual({ from: 11, volumes: true });
    expect(onClose).toHaveBeenCalled();
  });

  it('sends the chosen shelf and shows a refusal in the dialog', async () => {
    const fetchFn = mockFetch({
      'GET /api/shelves': () => json(200, SHELVES),
      'GET /api/mangas/copy-candidates': () => json(200, { shelf_id: 5, results: [{ ...HIT, volume_count: 0 }] }),
      'POST /api/mangas/copy': () => json(409, { error: 'Diese Ausgabe steht schon in diesem Regal', code: 'COPY_EXISTS', existing_id: 3 })
    });
    const onSuccess = vi.fn();
    render(<AddMangaModal isOpen onClose={vi.fn()} onSuccess={onSuccess} />);
    fireEvent.change(await screen.findByLabelText('Regal'), { target: { value: '5' } });
    fireEvent.change(titleInput(), { target: { value: 'Frieren' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Übernehmen: Frieren' }));
    expect(screen.queryByLabelText('Bände mitnehmen (als „Fehlt“)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'In dieses Regal übernehmen' }));
    expect(await screen.findByText('Diese Ausgabe steht schon in diesem Regal')).toBeTruthy();
    expect(onSuccess).not.toHaveBeenCalled();
    const lastSearch = callsTo(fetchFn, 'GET /api/mangas/copy-candidates').at(-1)[0];
    expect(new URL(lastSearch, 'http://x').searchParams.get('shelf_id')).toBe('5');
    expect(JSON.parse(callsTo(fetchFn, 'POST /api/mangas/copy')[0][1].body)).toEqual({ from: 11, shelf_id: 5, volumes: false });
  });

  it('asks nothing with a single shelf', async () => {
    const fetchFn = mockFetch({ 'GET /api/shelves': () => json(200, { shelves: [SHELVES.shelves[0]] }) });
    render(<AddMangaModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);
    await waitFor(() => expect(callsTo(fetchFn, 'GET /api/shelves').length).toBe(1));
    fireEvent.change(titleInput(), { target: { value: 'Frieren' } });
    await new Promise((r) => setTimeout(r, 450));
    expect(callsTo(fetchFn, 'GET /api/mangas/copy-candidates')).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Aus deinen Regalen' })).toBeNull();
  });
});

describe('CopyVolumesNotice', () => {
  const SOURCES = { sources: [{ manga_id: 11, shelf_id: 1, shelf_name: 'Sammlung', volumes: [{ id: 1, volume_number: '13', type: 'volume' }, { id: 2, volume_number: '14', type: 'volume' }] }] };

  it('names the missing volumes, asks, copies and reloads', async () => {
    const toasts = recordToasts();
    const fetchFn = mockFetch({
      'GET /api/mangas/42/volume-sources': () => json(200, SOURCES),
      'POST /api/mangas/42/volumes/copy': () => json(200, { success: true, created: [90, 91] })
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onCopied = vi.fn(async () => {});
    render(<CopyVolumesNotice mangaId={42} enabled version={12} onCopied={onCopied} />);
    expect(await screen.findByText('2 Bände aus „Sammlung“ fehlen hier.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bände übernehmen' }));
    await waitFor(() => expect(onCopied).toHaveBeenCalledTimes(1));
    expect(JSON.parse(callsTo(fetchFn, 'POST /api/mangas/42/volumes/copy')[0][1].body)).toEqual({ from: 11 });
    expect(toasts.messages('success')).toContain('2 Bände übernommen');
    toasts.stop();
  });

  it('asks nothing while disabled and shows nothing without sources', async () => {
    const fetchFn = mockFetch({ 'GET /api/mangas/42/volume-sources': () => json(200, { sources: [] }) });
    const { container, rerender } = render(<CopyVolumesNotice mangaId={42} enabled={false} version={1} />);
    expect(fetchFn).not.toHaveBeenCalled();
    rerender(<CopyVolumesNotice mangaId={42} enabled version={1} />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(container.innerHTML).toBe('');
  });
});
