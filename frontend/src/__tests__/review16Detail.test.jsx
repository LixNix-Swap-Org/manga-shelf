// MangaDetail wiring of the extracted hooks, and ReaderBar.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const scan = vi.hoisted(() => ({ code: '' }));
vi.mock('../components/common/BarcodeScannerButton', () => ({
  default: ({ id, onDetected, children }) => <button type="button" id={id} onClick={() => onDetected(scan.code)}>{children}</button>
}));
vi.mock('../utils/offlineStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadMangaDetail: vi.fn(async () => null),
  updateCachedManga: vi.fn(async () => {}),
  patchCachedManga: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true)
}));

import MangaDetail from '../MangaDetail';
import ReaderBar from '../components/detail/ReaderBar';
import { localDateString } from '../hooks/useVolumeActions';
import { NARROW_QUERY } from '../components/common/BottomNav';
import { clearDataCache } from '../utils/dataCache';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

const json = (status, body) => fakeResponse(status, body);
const editor = { id: 2, username: 'ed', role: 'editor' };
const visitor = { id: 3, username: 'gast', role: 'visitor' };
const VOLUMES = [
  { id: 51, manga_id: 5, volume_number: '1', type: 'volume', status: 'Vorhanden', isbn: '9783551000019', owners: [{ user_id: 2 }], read_users: [], read_by: [] }
];
const READERS = [{ user_id: 2, username: 'ed', read_count: 0, unread_count: 1, total_owned: 1 }];
const mangaWith = (extra = {}) => ({ id: 5, title: 'Server Titel', status: 'Laufend', total_volumes: 3, volumes: VOLUMES, reader_stats: READERS, ...extra });

function phone() {
  vi.stubGlobal('matchMedia', vi.fn((query) => ({ matches: query === NARROW_QUERY, media: query, addEventListener() {}, removeEventListener() {} })));
}

function serve({ manga = mangaWith(), lookup = () => json(404, {}), extra = () => undefined } = {}) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const custom = extra(url, init);
    if (custom) return custom;
    if (url === '/api/mangas/5') return json(200, manga);
    if (url.startsWith('/api/mangas/5/gaps')) return json(200, { matched: false, gaps: [] });
    if (url.startsWith('/api/lookup/isbn')) return lookup(url);
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodiesOf = (fetchMock, url, method = 'POST') => fetchMock.mock.calls
  .filter(([u, i]) => u === url && (i?.method || 'GET') === method)
  .map(([, i]) => JSON.parse(i.body));

const renderPage = (user = editor) => render(
  <MemoryRouter initialEntries={['/manga/5']}>
    <Routes><Route path="/manga/:id" element={<MangaDetail user={user} />} /></Routes>
  </MemoryRouter>
);

let toasts;
beforeEach(() => {
  toasts = recordToasts();
  clearDataCache();
  localStorage.clear();
  localStorage.setItem('mangashelf_volume_view_mode', 'grid');
  scan.code = '';
});
afterEach(() => {
  toasts.stop();
  vi.unstubAllGlobals();
});

describe('MangaDetail wiring (round 5 hooks)', () => {
  it('a scanned ISBN this series lacks fills the add form with number, price and the ISBN, which the new volume keeps', async () => {
    phone();
    const fetchMock = serve({
      lookup: () => json(200, { isbn: '9783551000035', found: true, matched_manga: { id: 5 }, matched_volume: null, book: { volume_number: '3', volume_number_known: true, price: 7.5 } }),
      extra: (url, init) => (url === '/api/volumes' && init.method === 'POST' ? json(200, { id: 60 }) : undefined)
    });
    renderPage();
    await screen.findByText('Server Titel');
    scan.code = '978-3-551-00003-5';
    fireEvent.click(document.getElementById('btn-detail-scan'));
    expect(await screen.findByText('ISBN 9783551000035')).toBeTruthy();
    const number = document.getElementById('add-volume-number');
    expect(number.value).toBe('3');
    fireEvent.submit(number.closest('form'));
    await waitFor(() => expect(bodiesOf(fetchMock, '/api/volumes')).toHaveLength(1));
    expect(bodiesOf(fetchMock, '/api/volumes')[0]).toMatchObject({ manga_id: '5', volume_number: '3', isbn: '9783551000035' });
    await waitFor(() => expect(screen.queryByText('ISBN 9783551000035')).toBeNull());
  });

  it('without an ISBN in the answer the scanned code is kept; the chip can be removed', async () => {
    phone();
    serve({ lookup: () => json(200, { found: true, matched_manga: { id: 5 }, matched_volume: null, book: { volume_number: '3', volume_number_known: true } }) });
    renderPage();
    await screen.findByText('Server Titel');
    scan.code = '3551000034';
    fireEvent.click(document.getElementById('btn-detail-scan'));
    expect(await screen.findByText('ISBN 9783551000033')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Gescannte ISBN entfernen' }));
    expect(screen.queryByText(/^ISBN /)).toBeNull();
  });

  it('"Gelesen am" in the reader bar dates the next read toggle', async () => {
    const fetchMock = serve({ extra: (url, init) => (url === '/api/volumes/51/read' && init.method === 'POST' ? json(200, { success: true, is_read: true, read_by: [2], read_users: [] }) : undefined) });
    renderPage();
    const date = await screen.findByLabelText('Gelesen am');
    expect(date.getAttribute('type')).toBe('date');
    expect(date.value).toBe('');
    expect(date.getAttribute('max')).toBe(localDateString());
    fireEvent.change(date, { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByTitle('Lesestatus umschalten (Gelesen / Ungelesen)'));
    await waitFor(() => expect(bodiesOf(fetchMock, '/api/volumes/51/read')).toHaveLength(1));
    const body = bodiesOf(fetchMock, '/api/volumes/51/read')[0];
    expect(body.read).toBe(true);
    expect(body.read_at).toBe(new Date('2026-09-01T12:00:00').toISOString().slice(0, 19).replace('T', ' '));
  });

  it('visitors get no date field', async () => {
    serve();
    renderPage(visitor);
    await screen.findByText('Server Titel');
    expect(screen.queryByLabelText('Gelesen am')).toBeNull();
  });

  it('"Genres nachladen" shows for a linked series without tags and asks the server for the tags only', async () => {
    let tags = '';
    const fetchMock = serve({
      extra: (url, init) => {
        if (url === '/api/mangas/5') return json(200, mangaWith({ manga_passion_id: 77, tags }));
        if (url === '/api/mangas/5/sync-edition' && init.method === 'POST') {
          tags = 'Action, Drama';
          return json(200, { success: true, updated: true, source: 'cache', tags });
        }
        return undefined;
      }
    });
    renderPage();
    const button = await screen.findByRole('button', { name: /Genres nachladen/ });
    expect(button.id).toBe('btn-fill-tags');
    fireEvent.click(button);
    await waitFor(() => expect(bodiesOf(fetchMock, '/api/mangas/5/sync-edition')).toEqual([{ tags_only: true }]));
    const list = await screen.findByRole('list', { name: 'Genres und Tags' });
    expect(within(list).getByText('Action')).toBeTruthy();
    expect(document.getElementById('btn-fill-tags')).toBeNull();
  });

  it('no "Genres nachladen" for visitors, unlinked series or series with tags', async () => {
    for (const [user, manga] of [[visitor, mangaWith({ manga_passion_id: 77 })], [editor, mangaWith()], [editor, mangaWith({ manga_passion_id: 77, tags: 'Action' })]]) {
      clearDataCache();
      serve({ manga });
      const view = renderPage(user);
      await screen.findByText('Server Titel');
      expect(document.getElementById('btn-fill-tags')).toBeNull();
      view.unmount();
    }
  });
});

describe('ReaderBar', () => {
  it('shows the date only with canToggle and setReadDate; an empty value stays possible', () => {
    const setReadDate = vi.fn();
    const props = { readers: READERS, selectedReaderId: 2, setSelectedReaderId: vi.fn(), user: editor, ownedCount: 1, currentReaderReadCount: 0, currentReaderUnreadCount: 1 };
    const { rerender } = render(<ReaderBar {...props} />);
    expect(screen.queryByLabelText('Gelesen am')).toBeNull();
    rerender(<ReaderBar {...props} canToggle readDate="2026-01-02" setReadDate={setReadDate} />);
    fireEvent.change(screen.getByLabelText('Gelesen am'), { target: { value: '' } });
    expect(setReadDate).toHaveBeenCalledWith('');
  });
});
