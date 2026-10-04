import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, renderHook, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../utils/offlineStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadMangaList: vi.fn(async () => []),
  loadMangaDetail: vi.fn(async () => null),
  updateCachedManga: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true)
}));

import MangaDetail from '../MangaDetail';
import useShoppingList from '../hooks/useShoppingList';
import useMangaList, { clearMangaListCache, SESSION_EXPIRED_EVENT } from '../hooks/useMangaList';
import { PURCHASE_RECORDED_EVENT } from '../appShell';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

let toasts;
beforeEach(() => { toasts = recordToasts(); });
afterEach(() => { toasts.stop(); });

const json = (status, body = {}) => fakeResponse(status, body);

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('useShoppingList quick buy ordering', () => {
  const shoppingList = { total_missing: 1, total_cost: 7, publishers: [], items: [{ id: 7, manga_id: 5, volume_number: '1' }], others: [] };

  it('starts the purchase request synchronously when the user is known and announces the purchase', async () => {
    const fetchMock = vi.fn(async (url) => (url.startsWith('/api/shopping-list') ? json(200, shoppingList) : json(200, { success: true })));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useShoppingList({ user: { id: 1 }, setNetworkOffline: vi.fn(), fetchMangas: vi.fn() }));
    await waitFor(() => expect(result.current.loadingShopping).toBe(false));
    fetchMock.mockClear();

    const onPurchase = vi.fn();
    window.addEventListener(PURCHASE_RECORDED_EVENT, onPurchase);
    let pending;
    act(() => { pending = result.current.handleQuickBuy(7); });
    expect(fetchMock).toHaveBeenCalledWith('/api/volumes/7/owners', expect.objectContaining({ method: 'POST' }));
    await act(async () => { await pending; });
    window.removeEventListener(PURCHASE_RECORDED_EVENT, onPurchase);
    expect(onPurchase).toHaveBeenCalledTimes(1);
    expect(onPurchase.mock.calls[0][0].detail).toEqual({ volumeId: 7 });
  });
});

describe('useMangaList on a 401', () => {
  it('keeps the loaded list until the session handler signs out', async () => {
    clearMangaListCache();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const listA = [{ id: 1, title: 'Akira' }];
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(200, listA))
      .mockResolvedValueOnce(json(401, { error: 'Sitzung ungültig', code: 'SESSION_INVALID' })));
    const { result } = renderHook(() => useMangaList({ user: { id: 1, username: 'a', role: 'admin' }, canEdit: true }));
    await act(() => result.current.fetchMangas());
    expect(result.current.mangas).toEqual(listA);

    const onExpired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    await act(() => result.current.fetchMangas());
    window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(result.current.mangas).toEqual(listA);
    expect(result.current.error).toMatch(/Sitzung/);
  });
});

describe('MangaDetail after a quick buy', () => {
  const editor = { id: 2, username: 'ed', role: 'editor' };
  const manga = (status) => ({
    id: 5, title: 'Berserk', status: 'Laufend', total_volumes: 1, reader_stats: [],
    volumes: [{ id: 7, volume_number: '1', type: 'volume', status, read_users: [], owners: [] }]
  });

  it('refetches once when a volume of this series was bought, not for other volumes', async () => {
    let status = 'Fehlt';
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/mangas/5') return json(200, manga(status));
      if (url.startsWith('/api/mangas/5/gaps')) return json(200, { matched: false, gaps: [] });
      return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/manga/5']}>
        <Routes><Route path="/manga/:id" element={<MangaDetail user={editor} />} /></Routes>
      </MemoryRouter>
    );
    await screen.findByText('Berserk');
    const detailCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/mangas/5').length;
    expect(detailCalls()).toBe(1);

    act(() => { window.dispatchEvent(new CustomEvent(PURCHASE_RECORDED_EVENT, { detail: { volumeId: 99 } })); });
    expect(detailCalls()).toBe(1);

    status = 'Vorhanden';
    await act(async () => { window.dispatchEvent(new CustomEvent(PURCHASE_RECORDED_EVENT, { detail: { volumeId: 7 } })); });
    await waitFor(() => expect(detailCalls()).toBe(2));
  });
});
