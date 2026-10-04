import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../utils/offlineStore', () => ({
  loadMangaDetail: vi.fn(async () => null),
  updateCachedManga: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true)
}));

import MangaDetail from '../MangaDetail';
import { clearDataCache } from '../utils/dataCache';
import useVolumeSelection, { rangeBetween } from '../hooks/useVolumeSelection';
import useVolumeActions, { chunkRevert, BULK_UNDO_MS } from '../hooks/useVolumeActions';
import BulkActionBar, { bulkDeleteConfirmText } from '../components/detail/BulkActionBar';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

const vols = (...ids) => ids.map((id) => ({ id }));

describe('useVolumeSelection', () => {
  it('rangeBetween follows the visible order in both directions', () => {
    expect(rangeBetween([5, 3, 9, 1], 3, 1)).toEqual([3, 9, 1]);
    expect(rangeBetween([5, 3, 9, 1], 1, 5)).toEqual([5, 3, 9, 1]);
    expect(rangeBetween([5, 3], 7, 3)).toEqual([3]);
  });

  it('toggles single volumes, Shift selects the range since the last click, Shift on a selected one clears it', () => {
    const order = [10, 11, 12, 13, 14];
    const { result } = renderHook(() => useVolumeSelection({ volumes: vols(...order) }));
    act(() => result.current.toggleMode());
    expect(result.current.active).toBe(true);
    act(() => result.current.toggle(11, { orderedIds: order }));
    act(() => result.current.toggle(13, { range: true, orderedIds: order }));
    expect(result.current.ids.sort()).toEqual([11, 12, 13]);
    act(() => result.current.toggle(12, { range: true, orderedIds: order }));
    expect(result.current.ids).toEqual([11]);
    act(() => result.current.selectAll([10, 14]));
    expect(result.current.count).toBe(2);
    expect(result.current.isSelected(14)).toBe(true);
    act(() => result.current.toggleMode());
    expect([result.current.active, result.current.count]).toEqual([false, 0]);
  });

  it('drops ids of volumes that disappeared (deleted elsewhere or by the bulk edit)', () => {
    const { result, rerender } = renderHook(({ volumes }) => useVolumeSelection({ volumes }), { initialProps: { volumes: vols(1, 2, 3) } });
    act(() => result.current.selectAll([1, 2, 3]));
    rerender({ volumes: vols(1, 3) });
    expect(result.current.ids.sort()).toEqual([1, 3]);
  });
});

describe('BulkActionBar', () => {
  const props = (over = {}) => ({
    count: 3, visibleCount: 5, allVisibleSelected: false, onSelectAllVisible: vi.fn(), onClear: vi.fn(), onClose: vi.fn(),
    onApply: vi.fn(async () => true), userId: 4, readerId: 4, ...over
  });

  it('every button sends its change', async () => {
    const p = props({ readerId: 9 });
    render(<BulkActionBar {...p} />);
    expect(screen.getByText('3 Bände ausgewählt')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Als vorhanden (mir)' }));
    expect(p.onApply.mock.calls[0][0]).toEqual({ owners: { add: [4] }, set: { purchase_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } });

    fireEvent.click(screen.getByRole('button', { name: 'Status…' }));
    fireEvent.change(screen.getByLabelText('Neuer Status'), { target: { value: 'Vorbestellt' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' })); });
    expect(p.onApply).toHaveBeenLastCalledWith({ set: { status: 'Vorbestellt' } }, 'auf „Vorbestellt“ gesetzt');
    expect(screen.queryByLabelText('Neuer Status')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Preis…' }));
    fireEvent.change(screen.getByLabelText('Preis in €'), { target: { value: ' 7,50 ' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' })); });
    expect(p.onApply).toHaveBeenLastCalledWith({ set: { price: '7,50' } }, 'mit Preis 7,50 € gespeichert');

    fireEvent.click(screen.getByRole('button', { name: 'Kaufdatum…' }));
    fireEvent.change(screen.getByLabelText('Kaufdatum'), { target: { value: '2024-05-01' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' })); });
    expect(p.onApply).toHaveBeenLastCalledWith({ set: { purchase_date: '2024-05-01' } }, 'mit neuem Kaufdatum gespeichert');

    fireEvent.click(screen.getByRole('button', { name: 'Gelesen' }));
    expect(p.onApply).toHaveBeenLastCalledWith({ read: { read: true, user_id: 9 } }, 'als gelesen markiert');
    fireEvent.click(screen.getByRole('button', { name: 'Ungelesen' }));
    expect(p.onApply).toHaveBeenLastCalledWith({ read: { read: false, user_id: 9 } }, 'als ungelesen markiert');
  });

  it('delete asks first; the visible-selection button switches to clearing', () => {
    const confirmDelete = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const p = props({ confirmDelete });
    const { rerender } = render(<BulkActionBar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    expect(p.onApply).not.toHaveBeenCalled();
    expect(confirmDelete).toHaveBeenCalledWith(bulkDeleteConfirmText(3));
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    expect(p.onApply).toHaveBeenCalledWith({ delete: true }, 'gelöscht');

    fireEvent.click(screen.getByRole('button', { name: 'Alle sichtbaren (5)' }));
    expect(p.onSelectAllVisible).toHaveBeenCalled();
    rerender(<BulkActionBar {...p} allVisibleSelected />);
    fireEvent.click(screen.getByRole('button', { name: 'Auswahl aufheben' }));
    expect(p.onClear).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Auswahl beenden' }));
    expect(p.onClose).toHaveBeenCalled();
  });

  it('actions are disabled without a selection', () => {
    render(<BulkActionBar {...props({ count: 0 })} />);
    expect(screen.getByText('Keine Bände ausgewählt')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Als vorhanden (mir)' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Löschen' }).disabled).toBe(true);
  });
});

describe('useVolumeActions.handleBulkEdit', () => {
  let toasts;
  beforeEach(() => { toasts = recordToasts(); });
  afterEach(() => {
    toasts.stop();
    vi.unstubAllGlobals();
  });

  const editor = { id: 4, username: 'ed', role: 'editor' };
  const setup = () => {
    const fetchManga = vi.fn(async () => {});
    const hook = renderHook(() => useVolumeActions({ id: '7', user: editor, canEdit: true, selectedReaderId: 4, fetchManga, volumes: [] }));
    return { fetchManga, hook };
  };
  const bodies = (fetchMock) => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));

  it('sends one request, refetches once and offers a 10 s undo that sends the previous values back', async () => {
    const previous = [{ id: 1, volume: { manga_id: 7, status: 'Fehlt' }, owners: [] }, { id: 2, volume: { manga_id: 7, status: 'Fehlt' }, owners: [] }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(200, { success: true, updated: 2, ids: [1, 2], not_found: [], previous }))
      .mockResolvedValueOnce(fakeResponse(200, { success: true, restored: [1, 2], conflicts: [], not_found: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchManga, hook } = setup();

    let ok;
    await act(async () => { ok = await hook.result.current.handleBulkEdit([1, 2], { set: { status: 'Vorhanden' } }, 'auf „Vorhanden“ gesetzt'); });
    expect(ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/volumes/bulk');
    expect(bodies(fetchMock)[0]).toEqual({ ids: [1, 2], set: { status: 'Vorhanden' } });
    expect(fetchManga).toHaveBeenCalledTimes(1);
    const toast = toasts.last();
    expect(toast.message).toBe('2 Bände auf „Vorhanden“ gesetzt');
    expect(toast.duration).toBe(BULK_UNDO_MS);
    expect(BULK_UNDO_MS).toBe(10000);

    await act(async () => { await toast.action.onClick(); });
    expect(bodies(fetchMock)[1]).toEqual({ revert: previous });
    expect(fetchManga).toHaveBeenCalledTimes(2);
  });

  it('reports the server error and does not refetch on a refused request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(400, { error: 'Ungültiger Preis', code: 'BULK_FIELD' })));
    const { fetchManga, hook } = setup();
    let ok;
    await act(async () => { ok = await hook.result.current.handleBulkEdit([1], { set: { price: 'x' } }, 'gespeichert'); });
    expect(ok).toBe(false);
    expect(toasts.messages('error')).toEqual(['Ungültiger Preis']);
    expect(fetchManga).not.toHaveBeenCalled();
  });

  it('an undo of deleted volumes reports the ones whose number was taken again', async () => {
    const previous = [{ id: 1, volume: { manga_id: 7 }, owners: [] }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(200, { success: true, updated: 1, ids: [1], previous, deleted: true }))
      .mockResolvedValueOnce(fakeResponse(409, {
        success: false, restored: [], not_found: [], error: 'Band 1 existiert bereits (Fehlt).', code: 'VOLUME_DUPLICATE',
        conflicts: [{ id: 1, status: 409, code: 'VOLUME_DUPLICATE', error: 'Band 1 existiert bereits (Fehlt).' }]
      }));
    vi.stubGlobal('fetch', fetchMock);
    const { hook } = setup();
    await act(async () => { await hook.result.current.handleBulkEdit([1], { delete: true }, 'gelöscht'); });
    expect(toasts.last().message).toBe('1 Band gelöscht');
    await act(async () => { await toasts.last().action.onClick(); });
    expect(toasts.messages('error')).toEqual(['1 Band konnte nicht wiederhergestellt werden: Band 1 existiert bereits (Fehlt).']);
  });

  it('chunkRevert keeps every request below the size limit and the order intact', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, volume: { notes: 'x'.repeat(40) } }));
    const chunks = chunkRevert(entries, 150);
    expect(chunks.flat()).toEqual(entries);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(150);
    expect(chunkRevert([])).toEqual([]);
  });
});

describe('MangaDetail selection wiring', () => {
  const editor = { id: 2, username: 'ed', role: 'editor' };
  const volume = (id, number, status = 'Fehlt') => ({ id, volume_number: number, type: 'volume', status, owners: [], read_users: [] });
  const MANGA = {
    id: 5, title: 'Auswahl Reihe', status: 'Laufend', total_volumes: 3, reader_stats: [],
    volumes: [volume(51, '1'), volume(52, '2'), volume(53, '3')]
  };
  let toasts;
  beforeEach(() => {
    toasts = recordToasts();
    clearDataCache();
    localStorage.clear();
    localStorage.setItem('mangashelf_volume_view_mode', 'grid');
  });
  afterEach(() => {
    toasts.stop();
    vi.unstubAllGlobals();
  });

  it('Auswählen, Shift range over the visible order, one bulk request and one reload', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push([url, init.method || 'GET', init.body ? JSON.parse(init.body) : null]);
      if (url === '/api/mangas/5') return fakeResponse(200, MANGA);
      if (url.startsWith('/api/mangas/5/gaps')) return fakeResponse(200, { matched: false, gaps: [] });
      if (url === '/api/volumes/bulk') return fakeResponse(200, { success: true, updated: 3, ids: [51, 52, 53], not_found: [], previous: [] });
      return fakeResponse(404, {});
    }));
    render(
      <MemoryRouter initialEntries={['/manga/5']}>
        <Routes><Route path="/manga/:id" element={<MangaDetail user={editor} />} /></Routes>
      </MemoryRouter>
    );
    await screen.findByText('Auswahl Reihe');
    fireEvent.click(screen.getByRole('button', { name: 'Auswählen' }));
    expect(screen.getByRole('region', { name: 'Sammelbearbeitung' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Band 1 auswählen' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Band 3 auswählen' }), { shiftKey: true });
    expect(screen.getByText('3 Bände ausgewählt')).toBeTruthy();

    const loads = () => calls.filter(([url]) => url === '/api/mangas/5').length;
    const before = loads();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Als vorhanden (mir)' })); });
    const bulk = calls.filter(([url]) => url === '/api/volumes/bulk');
    expect(bulk).toHaveLength(1);
    expect(bulk[0][2]).toMatchObject({ ids: [51, 52, 53], owners: { add: [2] } });
    expect(loads() - before).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Auswahl beenden' }));
    expect(screen.queryByRole('region', { name: 'Sammelbearbeitung' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Band 1 auswählen' })).toBeNull();
  });
});
