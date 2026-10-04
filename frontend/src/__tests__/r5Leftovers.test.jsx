// Read date, scanned ISBN, trash toasts, genre reload and the continue-reading strip.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, renderHook, act, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../utils/offlineStore', () => ({
  loadMangaDetail: vi.fn(async () => null),
  loadMangaList: vi.fn(async () => []),
  updateCachedManga: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true),
  patchCachedManga: vi.fn(async () => false),
  loadOutboxEntries: vi.fn(async () => { throw new Error('no IndexedDB'); }),
  putOutboxEntries: vi.fn(async () => {}),
  deleteOutboxEntries: vi.fn(async () => {})
}));

import * as offlineStore from '../utils/offlineStore';
import useVolumeActions, { readAtForDate, localDateString, notifyTrashed } from '../hooks/useVolumeActions';
import useMangaData, { canFillTags } from '../hooks/useMangaData';
import useMangaList, { clearMangaListCache } from '../hooks/useMangaList';
import useVolumeEditForm from '../hooks/useVolumeEditForm';
import BatchReadModal from '../components/detail/BatchReadModal';
import AddVolumeBar, { ADD_VOLUME_NUMBER_ID } from '../components/detail/AddVolumeBar';
import { undoGapFill } from '../components/detail/GapFillModal';
import ContinueReading, { continueReadingItems } from '../components/dashboard/ContinueReading';
import { clearDataCache } from '../utils/dataCache';
import { resetOutbox } from '../utils/outbox';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

let toasts;
beforeEach(() => {
  toasts = recordToasts();
  clearDataCache();
  clearMangaListCache();
  localStorage.clear();
  resetOutbox();
  offlineStore.syncOfflineCopy.mockClear();
});
afterEach(() => {
  toasts.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const res = (status, body) => fakeResponse(status, body);
const bodyOf = (call) => JSON.parse(call[1].body);
const callTo = (fetchMock, suffix) => fetchMock.mock.calls.find(([url]) => String(url).endsWith(suffix));
const editor = { id: 2, role: 'editor', username: 'ed' };
const pastDay = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDateString(d);
};
const serverTime = (day) => new Date(`${day}T12:00:00`).toISOString().slice(0, 19).replace('T', ' ');

describe('Gelesen am', () => {
  it('readAtForDate: today, a future, an empty or a broken date stamp now; a past day is local noon in UTC', () => {
    const today = '2026-10-04';
    expect(readAtForDate('', today)).toBeNull();
    expect(readAtForDate('2026-10-04', today)).toBeNull();
    expect(readAtForDate('2026-10-05', today)).toBeNull();
    expect(readAtForDate('04.10.2026', today)).toBeNull();
    expect(readAtForDate('2026-09-01', today)).toBe(serverTime('2026-09-01'));
    expect(readAtForDate('2026-09-01', today)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('the read toggle sends a picked date and names it in the toast; without a pick it sends none', async () => {
    const fetchMock = vi.fn(async () => res(200, { success: true, is_read: true }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useVolumeActions({ id: '7', user: editor, canEdit: true, selectedReaderId: 2, fetchManga: vi.fn(async () => {}) }));
    expect(result.current.readDate).toBeNull();

    await act(() => result.current.handleToggleVolumeRead({ id: 4, volume_number: '4', read_users: [] }));
    expect(bodyOf(fetchMock.mock.calls[0])).not.toHaveProperty('read_at');

    const day = pastDay(10);
    act(() => result.current.setReadDate(day));
    await act(() => result.current.handleToggleVolumeRead({ id: 5, volume_number: '5', read_users: [] }));
    expect(bodyOf(fetchMock.mock.calls.at(-1))).toMatchObject({ read: true, read_at: serverTime(day) });
    expect(toasts.last().message).toMatch(/„Band 5“ als gelesen markiert \(gelesen am \d{2}\.\d{2}\.\d{4}\)/);

    // un-reading never carries a date
    await act(() => result.current.handleToggleVolumeRead({ id: 6, volume_number: '6', read_users: [{ user_id: 2 }] }));
    expect(bodyOf(fetchMock.mock.calls.at(-1))).toMatchObject({ read: false });
    expect(bodyOf(fetchMock.mock.calls.at(-1))).not.toHaveProperty('read_at');

    // a cleared field is "now" again
    act(() => result.current.setReadDate(''));
    expect(result.current.readDate).toBeNull();
  });

  it('the picked date belongs to the series: another route starts without one', async () => {
    const fetchMock = vi.fn(async () => res(200, { success: true, is_read: true }));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ id }) => useVolumeActions({ id, user: editor, canEdit: true, selectedReaderId: 2, fetchManga: vi.fn(async () => {}) }), { initialProps: { id: '7' } });
    act(() => result.current.setReadDate(pastDay(5)));
    expect(result.current.readDate).toBe(pastDay(5));
    rerender({ id: '8' });
    expect(result.current.readDate).toBeNull();
    await act(() => result.current.handleToggleVolumeRead({ id: 9, volume_number: '9', read_users: [] }));
    expect(bodyOf(fetchMock.mock.calls.at(-1))).not.toHaveProperty('read_at');
    expect(toasts.last().message).toBe('„Band 9“ als gelesen markiert');
    rerender({ id: '7' });
    expect(result.current.readDate).toBeNull();
  });

  it('past midnight the toggle stamps now: no date without a pick, and a pick of "today" stays "now"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 3, 23, 50));
      const fetchMock = vi.fn(async () => res(200, { success: true, is_read: true }));
      vi.stubGlobal('fetch', fetchMock);
      const { result } = renderHook(() => useVolumeActions({ id: '7', user: editor, canEdit: true, selectedReaderId: 2, fetchManga: vi.fn(async () => {}) }));
      vi.setSystemTime(new Date(2026, 9, 4, 0, 10));
      await act(() => result.current.handleToggleVolumeRead({ id: 4, volume_number: '4', read_users: [] }));
      expect(bodyOf(fetchMock.mock.calls.at(-1))).not.toHaveProperty('read_at');

      vi.setSystemTime(new Date(2026, 9, 4, 23, 55));
      act(() => result.current.setReadDate('2026-10-04'));
      vi.setSystemTime(new Date(2026, 9, 5, 0, 5));
      await act(() => result.current.handleToggleVolumeRead({ id: 5, volume_number: '5', read_users: [] }));
      expect(bodyOf(fetchMock.mock.calls.at(-1))).not.toHaveProperty('read_at');
      expect(toasts.last().message).toBe('„Band 5“ als gelesen markiert');

      act(() => result.current.setReadDate('2026-10-01'));
      await act(() => result.current.handleToggleVolumeRead({ id: 6, volume_number: '6', read_users: [] }));
      expect(bodyOf(fetchMock.mock.calls.at(-1))).toMatchObject({ read_at: serverTime('2026-10-01') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('BatchReadModal: "Gelesen am" starts empty (now), a picked past day is sent as read_at, "ungelesen" hides it', async () => {
    const fetchMock = vi.fn(async () => res(200, { success: true, count: 2, changed_ids: [1, 2] }));
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    const { rerender } = render(<BatchReadModal isOpen onClose={onClose} mangaId="9" user={editor} />);
    const dateField = screen.getByLabelText('Gelesen am');
    expect(dateField.value).toBe('');
    expect(dateField.max).toBe(localDateString());

    fireEvent.change(screen.getByLabelText(/Bis einschließlich/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Anwenden/ }));
    await waitFor(() => expect(callTo(fetchMock, '/api/volumes/batch-read')).toBeTruthy());
    expect(bodyOf(callTo(fetchMock, '/api/volumes/batch-read'))).not.toHaveProperty('read_at');

    fetchMock.mockClear();
    rerender(<BatchReadModal isOpen={false} onClose={onClose} mangaId="9" user={editor} />);
    rerender(<BatchReadModal isOpen onClose={onClose} mangaId="9" user={editor} />);
    const day = pastDay(30);
    fireEvent.change(screen.getByLabelText('Gelesen am'), { target: { value: day } });
    fireEvent.change(screen.getByLabelText(/Bis einschließlich/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Anwenden/ }));
    await waitFor(() => expect(callTo(fetchMock, '/api/volumes/batch-read')).toBeTruthy());
    expect(bodyOf(callTo(fetchMock, '/api/volumes/batch-read'))).toMatchObject({ read: true, read_at: serverTime(day) });
    await waitFor(() => expect(toasts.messages('success').at(-1)).toMatch(/2 Bände als gelesen markiert \(gelesen am /));

    // reopened, the field is empty again
    rerender(<BatchReadModal isOpen={false} onClose={onClose} mangaId="9" user={editor} />);
    rerender(<BatchReadModal isOpen onClose={onClose} mangaId="9" user={editor} />);
    expect(screen.getByLabelText('Gelesen am').value).toBe('');

    fetchMock.mockClear();
    rerender(<BatchReadModal isOpen={false} onClose={onClose} mangaId="9" user={editor} />);
    rerender(<BatchReadModal isOpen onClose={onClose} mangaId="9" user={editor} />);
    fireEvent.change(screen.getByLabelText('Gelesen am'), { target: { value: day } });
    fireEvent.click(screen.getByRole('button', { name: /Als ungelesen markieren/ }));
    expect(screen.queryByLabelText('Gelesen am')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Bis einschließlich/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Anwenden/ }));
    await waitFor(() => expect(callTo(fetchMock, '/api/volumes/batch-read')).toBeTruthy());
    expect(bodyOf(callTo(fetchMock, '/api/volumes/batch-read'))).not.toHaveProperty('read_at');
  });
});

describe('scanned ISBN for a new volume', () => {
  it('useVolumeActions sends newVolumeIsbn as isbn and clears it after the add', async () => {
    const fetchMock = vi.fn(async () => res(200, { id: 30 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useVolumeActions({ id: '7', user: editor, canEdit: true, fetchManga: vi.fn(async () => {}) }));
    act(() => {
      result.current.setNewVolumeNum('12');
      result.current.setNewVolumeIsbn('9783551000000');
    });
    await act(() => result.current.handleAddSingleVolume({ preventDefault() {} }));
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ volume_number: '12', isbn: '9783551000000' });
    expect(result.current.newVolumeIsbn).toBe('');

    act(() => result.current.setNewVolumeNum('13'));
    await act(() => result.current.handleAddSingleVolume({ preventDefault() {} }));
    expect(bodyOf(fetchMock.mock.calls[1])).not.toHaveProperty('isbn');
  });

  it('AddVolumeBar: a stable id for the number field and a removable ISBN chip', () => {
    const setNewVolumeIsbn = vi.fn();
    const props = {
      canEdit: true, handleAddSingleVolume: vi.fn(), handleUploadNewSingleCover: vi.fn(), newVolumeCover: '', newVolumeNum: '4',
      newVolumePrice: '', newVolumeReleaseDate: '', newVolumeStatus: 'Vorhanden', newVolumeType: 'volume',
      setNewVolumeCover: vi.fn(), setNewVolumeNum: vi.fn(), setNewVolumePrice: vi.fn(), setNewVolumeReleaseDate: vi.fn(),
      setNewVolumeStatus: vi.fn(), setNewVolumeType: vi.fn(), uploadingNewCover: false
    };
    const { container, rerender } = render(<AddVolumeBar {...props} />);
    expect(ADD_VOLUME_NUMBER_ID).toBe('add-volume-number');
    expect(container.querySelector('input[id$="-number"]').id).toBe(ADD_VOLUME_NUMBER_ID);
    expect(screen.getByLabelText('Nummer').id).toBe(ADD_VOLUME_NUMBER_ID);
    expect(screen.queryByText(/ISBN/)).toBeNull();

    rerender(<AddVolumeBar {...props} newVolumeIsbn="9783551000000" setNewVolumeIsbn={setNewVolumeIsbn} />);
    expect(screen.getByText('ISBN 9783551000000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Gescannte ISBN entfernen' }));
    expect(setNewVolumeIsbn).toHaveBeenCalledWith('');
  });
});

describe('trash toasts', () => {
  it('notifyTrashed shows nothing without a trash id', () => {
    expect(notifyTrashed('„X“', null, vi.fn())).toBeNull();
    expect(toasts.list).toEqual([]);
  });

  it('the editor delete names the trash in the question and restores from the toast', async () => {
    const fetchMock = vi.fn(async () => res(200, { success: true, trash_id: 31 }));
    vi.stubGlobal('fetch', fetchMock);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onClose = vi.fn();
    const onSuccess = vi.fn(async () => {});
    const { result } = renderHook(() => useVolumeEditForm({
      activeVolume: { id: 5, volume_number: '3', type: 'volume', status: 'Fehlt', images: [] }, mangaId: 1, canEdit: true, onClose, onSuccess
    }));
    await act(() => result.current.handleDeleteVolume(null, 5));
    expect(confirmSpy.mock.calls[0][0]).toMatch(/"Band 3" wirklich entfernen\? .*Papierkorb \(30 Tage wiederherstellbar\)/);
    expect(onClose).toHaveBeenCalledTimes(1);
    const toast = toasts.last();
    expect(toast).toMatchObject({ kind: 'success', message: '„Band 3“ in den Papierkorb gelegt', action: { label: 'Rückgängig' } });

    fetchMock.mockImplementation(async () => res(200, { success: true, kind: 'volume', id: 5 }));
    await act(async () => { await toast.action.onClick(); });
    expect(String(fetchMock.mock.calls.at(-1)[0])).toBe('/api/trash/31/restore');
    expect(fetchMock.mock.calls.at(-1)[1].method).toBe('POST');
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });

  it('undoing a gap fill puts the volume into the trash with its own "Rückgängig"', async () => {
    const fetchMock = vi.fn(async () => res(200, { success: true, trash_id: 8 }));
    vi.stubGlobal('fetch', fetchMock);
    const onSuccess = vi.fn(async () => {});
    expect(await undoGapFill(44, onSuccess, '„Band 5“')).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/volumes/44');
    const toast = toasts.last();
    expect(toast.message).toBe('„Band 5“ in den Papierkorb gelegt');
    fetchMock.mockImplementation(async () => res(409, { error: 'Band 5 existiert bereits (Fehlt).', code: 'VOLUME_DUPLICATE' }));
    await act(async () => { await toast.action.onClick(); });
    expect(toasts.messages('error')).toEqual(['Band 5 existiert bereits (Fehlt).']);
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });

  it('a series deleted on its page comes back from the toast and opens again', async () => {
    const SERVER = { id: 7, title: 'Berserk', status: 'Laufend', manga_passion_id: null, volumes: [] };
    const fetchMock = vi.fn(async () => res(200, SERVER));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const wrapper = ({ children }) => <MemoryRouter initialEntries={['/manga/7']}>{children}</MemoryRouter>;
    const { result } = renderHook(() => ({ data: useMangaData({ id: '7', user: editor, canEdit: true }), location: useLocation() }), { wrapper });
    await act(() => result.current.data.fetchManga());

    fetchMock.mockImplementation(async () => res(200, { success: true, trash_id: 12 }));
    await act(() => result.current.data.handleDeleteManga());
    expect(window.confirm.mock.calls[0][0]).toMatch(/Papierkorb \(30 Tage wiederherstellbar\)/);
    expect(result.current.location.pathname).toBe('/');
    const toast = toasts.last();
    expect(toast).toMatchObject({ message: '„Berserk“ in den Papierkorb gelegt', action: { label: 'Rückgängig' } });

    offlineStore.syncOfflineCopy.mockClear();
    fetchMock.mockImplementation(async () => res(200, { success: true, kind: 'manga', id: 7 }));
    await act(async () => { await toast.action.onClick(); });
    expect(String(fetchMock.mock.calls.at(-1)[0])).toBe('/api/trash/12/restore');
    expect(offlineStore.syncOfflineCopy).toHaveBeenCalledWith({ force: true });
    expect(result.current.location.pathname).toBe('/manga/7');
  });

  it('a refused series restore stays on the shelf', async () => {
    const fetchMock = vi.fn(async () => res(200, { id: 7, title: 'Berserk', volumes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const wrapper = ({ children }) => <MemoryRouter initialEntries={['/manga/7']}>{children}</MemoryRouter>;
    const { result } = renderHook(() => ({ data: useMangaData({ id: '7', user: editor, canEdit: true }), location: useLocation() }), { wrapper });
    await act(() => result.current.data.fetchManga());
    fetchMock.mockImplementation(async () => res(200, { success: true, trash_id: 13 }));
    await act(() => result.current.data.handleDeleteManga());
    fetchMock.mockImplementation(async () => res(409, { error: 'Die Reihe existiert bereits', code: 'TRASH_ID_TAKEN' }));
    await act(async () => { await toasts.last().action.onClick(); });
    expect(toasts.messages('error')).toEqual(['Die Reihe existiert bereits']);
    expect(result.current.location.pathname).toBe('/');
  });

  it('useMangaList calls onRestored after a series came back from the toast', async () => {
    const onRestored = vi.fn();
    const fetchMock = vi.fn(async (url, init) => {
      if (init?.method === 'DELETE') return res(200, { success: true, trash_id: 5 });
      if (String(url).endsWith('/restore')) return res(200, { success: true, kind: 'manga', id: 1 });
      return res(200, [{ id: 1, title: 'Akira' }]);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { result } = renderHook(() => useMangaList({ user: editor, canEdit: true, onRestored }));
    await act(() => result.current.fetchMangas());
    await act(async () => { await result.current.handleDeleteManga(null, 1, 'Akira'); });
    expect(onRestored).not.toHaveBeenCalled();
    await act(async () => { await toasts.last().action.onClick(); });
    expect(onRestored).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => res(409, { error: 'belegt' }));
    await act(async () => { await toasts.list.find((t) => t.action)?.action.onClick(); });
    expect(onRestored).toHaveBeenCalledTimes(1);
  });
});

describe('Genres nachladen', () => {
  const LINKED = { id: 7, title: 'Berserk', manga_passion_id: 123, tags: null, volumes: [] };
  const wrapper = ({ children }) => <MemoryRouter>{children}</MemoryRouter>;

  it('canFillTags: only a linked series without tags', () => {
    expect(canFillTags(LINKED)).toBe(true);
    expect(canFillTags({ ...LINKED, tags: '  ' })).toBe(true);
    expect(canFillTags({ ...LINKED, tags: 'Action' })).toBe(false);
    expect(canFillTags({ ...LINKED, manga_passion_id: null })).toBe(false);
    expect(canFillTags(null)).toBe(false);
  });

  it('asks sync-edition for the tags only, reports them and reloads the series', async () => {
    let tags = null;
    const fetchMock = vi.fn(async (url, init) => {
      if (init?.method === 'POST') {
        tags = 'Abenteuer, Fantasy';
        return res(200, { success: true, updated: true, source: 'cache', tags });
      }
      return res(200, { ...LINKED, tags });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useMangaData({ id: '7', user: editor, canEdit: true }), { wrapper });
    await act(() => result.current.fetchManga());
    expect(result.current.canFillTags).toBe(true);
    await act(() => result.current.handleFillTags());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(String(post[0])).toBe('/api/mangas/7/sync-edition');
    expect(bodyOf(post)).toEqual({ tags_only: true });
    expect(toasts.messages('success')).toEqual(['Genres übernommen: Abenteuer, Fantasy']);
    expect(result.current.manga.tags).toBe('Abenteuer, Fantasy');
    expect(result.current.canFillTags).toBe(false);
    expect(result.current.fillingTags).toBe(false);
  });

  it('no genres at Manga Passion is an info; an error shows the server text; visitors and offline get no button', async () => {
    const fetchMock = vi.fn(async (url, init) => (init?.method === 'POST'
      ? res(200, { success: true, updated: false, source: 'manga_passion', tags: null })
      : res(200, LINKED)));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useMangaData({ id: '7', user: editor, canEdit: true }), { wrapper });
    await act(() => result.current.fetchManga());
    await act(() => result.current.handleFillTags());
    expect(toasts.messages('info')).toEqual(['Manga Passion nennt für diese Ausgabe keine Genres.']);

    fetchMock.mockImplementation(async (url, init) => (init?.method === 'POST'
      ? res(503, { error: 'Manga Passion ist gerade nicht erreichbar', code: 'MP_UNAVAILABLE' })
      : res(200, LINKED)));
    await act(() => result.current.handleFillTags());
    expect(toasts.messages('error')).toEqual(['Manga Passion ist gerade nicht erreichbar']);

    const visitor = renderHook(() => useMangaData({ id: '7', user: { id: 3, role: 'visitor' }, canEdit: false }), { wrapper });
    await act(() => visitor.result.current.fetchManga());
    expect(visitor.result.current.canFillTags).toBe(false);
    const offline = renderHook(() => useMangaData({ id: '7', user: { ...editor, offline: true }, canEdit: true }), { wrapper });
    expect(offline.result.current.canFillTags).toBe(false);
  });
});

describe('Weiterlesen strip', () => {
  const entry = (id, extra = {}) => ({
    manga_id: id, title: `Reihe ${id}`, cover_image: null, last_read_at: '2026-10-01 10:00:00',
    next_volume: { id: id * 10, volume_number: String(id + 1), cover_image: null }, unread_after: 1, ...extra
  });

  it('continueReadingItems keeps at most three entries that have a next volume', () => {
    expect(continueReadingItems(null)).toEqual([]);
    const list = [entry(1), { ...entry(2), next_volume: null }, entry(3), entry(4), entry(5)];
    expect(continueReadingItems({ continue_reading: list }).map((i) => i.manga_id)).toEqual([1, 3, 4]);
  });

  it('shows the next volume of the last three series and links to them', async () => {
    const fetchMock = vi.fn(async () => res(200, { continue_reading: [entry(1, { unread_after: 4 }), entry(2), entry(3), entry(4)] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><ContinueReading userId={2} /></MemoryRouter>);
    const region = await screen.findByRole('region', { name: 'Weiterlesen' });
    const links = within(region).getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links[0].getAttribute('href')).toBe('/manga/1');
    expect(links[0].textContent).toMatch(/Reihe 1.*Weiter mit Band 2 · 4 ungelesen/);
    expect(links[1].textContent).not.toMatch(/ungelesen/);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/stats/reading');
  });

  it('stays hidden offline, without entries and on an error', async () => {
    const fetchMock = vi.fn(async () => res(200, { continue_reading: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<MemoryRouter><ContinueReading userId={2} enabled={false} /></MemoryRouter>);
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();

    const empty = render(<MemoryRouter><ContinueReading userId={2} /></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region', { name: 'Weiterlesen' })).toBeNull();
    empty.unmount();

    fetchMock.mockImplementation(async () => res(500, { error: 'kaputt' }));
    render(<MemoryRouter><ContinueReading userId={2} /></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('region', { name: 'Weiterlesen' })).toBeNull();
    expect(toasts.list).toEqual([]);
  });
});
