import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../utils/offlineStore', () => ({
  loadMangaList: vi.fn(async () => []),
  syncOfflineCopy: vi.fn(async () => true)
}));

import { loadMangaList, syncOfflineCopy } from '../utils/offlineStore';
import useMangaList, { clearMangaListCache, SESSION_EXPIRED_EVENT } from '../hooks/useMangaList';
import { startPrefetch, readCache, PREFETCH_MANGAS, LIST_KEY } from '../utils/dataCache';
import { recordToasts } from './toastLog';
import { fakeResponse, htmlResponse } from './fakeResponse';

let toasts;
beforeEach(() => { toasts = recordToasts(); });
afterEach(() => { toasts.stop(); });

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const user = { id: 1, username: 'admin', role: 'admin' };
const listA = [{ id: 1, title: 'Akira' }, { id: 2, title: 'Berserk' }];
const listB = [{ id: 2, title: 'Berserk' }];
const click = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

const mount = async (fetchMock, props = { user, canEdit: true }) => {
  vi.stubGlobal('fetch', fetchMock);
  const hook = renderHook(() => useMangaList(props));
  await act(() => hook.result.current.fetchMangas());
  return hook;
};

describe('useMangaList', () => {
  beforeEach(() => {
    clearMangaListCache();
    loadMangaList.mockReset().mockResolvedValue([]);
    syncOfflineCopy.mockClear();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });

  it('a refresh keeps the list on screen: loading only before the first answer', async () => {
    const second = deferred();
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, listA)).mockReturnValueOnce(second.promise);
    const { result } = await mount(fetchMock);
    expect(result.current.loading).toBe(false);
    expect(result.current.mangas).toEqual(listA);

    let pending;
    act(() => { pending = result.current.fetchMangas(); });
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.mangas).toEqual(listA);
    await act(async () => { second.resolve(json(200, listB)); await pending; });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.mangas).toEqual(listB);
  });

  it('an older response that arrives last does not overwrite the newer list', async () => {
    const first = deferred();
    const second = deferred();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const { result } = renderHook(() => useMangaList({ user, canEdit: true }));
    let p1;
    let p2;
    act(() => { p1 = result.current.fetchMangas(); p2 = result.current.fetchMangas(); });
    await act(async () => { second.resolve(json(200, listB)); await p2; });
    expect(result.current.loading).toBe(false);
    await act(async () => { first.resolve(json(200, listA)); await p1; });
    expect(result.current.mangas).toEqual(listB);
  });

  it('a refresh aborts the previous request and unmount aborts the running one', async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const { result, unmount } = renderHook(() => useMangaList({ user, canEdit: true }));
    act(() => { result.current.fetchMangas(); });
    act(() => { result.current.fetchMangas(); });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(false);
    unmount();
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
  });

  it('a 200 that is not JSON (captive portal) keeps the list and falls back like a network error', async () => {
    loadMangaList.mockResolvedValue(listA);
    const { result } = await mount(vi.fn(async () => new Response('<html>Portal</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })));
    expect(result.current.mangas).toEqual(listA);
    expect(result.current.error).toMatch(/Server nicht erreichbar/);
  });

  it('401: announces the expired session and drops an offline copy shown while waiting', async () => {
    loadMangaList.mockResolvedValue(listA);
    const onExpired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    const { result } = await mount(vi.fn(async () => json(401, { error: 'Sitzung ungültig', code: 'SESSION_INVALID' })));
    window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(result.current.mangas).toEqual([]);
    expect(result.current.error).toMatch(/Sitzung/);
    expect(readCache(user.id, LIST_KEY)).toBeNull();
  });

  it('500 keeps the current list and reports an error instead of an empty collection', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, listA)).mockResolvedValueOnce(json(500, { error: 'Interner Serverfehler' }));
    const { result } = await mount(fetchMock);
    loadMangaList.mockClear();
    await act(() => result.current.fetchMangas());
    expect(result.current.mangas).toEqual(listA);
    expect(result.current.error).toBe('Interner Serverfehler');
    expect(loadMangaList).not.toHaveBeenCalled();
  });

  it('503 on the first load shows the offline copy with a notice', async () => {
    loadMangaList.mockResolvedValue(listB);
    const { result } = await mount(vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 503 })));
    expect(result.current.mangas).toEqual(listB);
    expect(result.current.error).toMatch(/Offline-Kopie/);
  });

  it('a later successful refresh clears the error', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(500, {})).mockResolvedValueOnce(json(200, listA));
    const { result } = await mount(fetchMock);
    expect(result.current.error).toMatch(/Fehler 500/);
    await act(() => result.current.fetchMangas());
    expect(result.current.error).toBeNull();
  });

  it('delete: removes the card at once, refreshes, re-syncs the offline copy and reports success', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const refetch = deferred();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, listA))
      .mockResolvedValueOnce(json(200, { message: 'ok' }))
      .mockReturnValueOnce(refetch.promise);
    const { result } = await mount(fetchMock);
    let ok;
    await act(async () => { ok = await result.current.handleDeleteManga(click(), 1, 'Akira'); });
    expect(ok).toBe(true);
    expect(result.current.mangas).toEqual(listB);
    expect(result.current.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('/api/mangas/1', expect.objectContaining({ method: 'DELETE' }));
    expect(syncOfflineCopy).toHaveBeenCalledWith({ force: true });
    await act(async () => { refetch.resolve(json(200, listB)); });
  });

  it('delete: an HTML error page is a server error, not a network error', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, listA))
      .mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    const { result } = await mount(fetchMock);
    let ok;
    await act(async () => { ok = await result.current.handleDeleteManga(click(), 1, 'Akira'); });
    expect(ok).toBe(false);
    expect(toasts.messages('error')).toEqual(['Fehler beim Löschen (HTTP 502)']);
    expect(result.current.mangas).toEqual(listA);
  });

  it('a remount for the same user renders the last list at once, another user starts empty', async () => {
    const first = await mount(vi.fn(async () => json(200, listA)));
    first.unmount();

    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { result } = renderHook(() => useMangaList({ user, canEdit: true }));
    expect(result.current.loading).toBe(false);
    expect(result.current.mangas).toEqual(listA);
    expect(result.current.dataAt).toBeGreaterThan(0);

    const other = renderHook(() => useMangaList({ user: { id: 2, username: 'ed' }, canEdit: true }));
    expect(other.result.current.loading).toBe(true);
    expect(other.result.current.mangas).toEqual([]);
  });

  it('revalidates the shown copy with its ETag: a 304 keeps the same list object', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, listA, { ETag: 'W/"v1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const { unmount } = await mount(fetchMock);
    unmount();

    const again = renderHook(() => useMangaList({ user, canEdit: true }));
    const shown = again.result.current.mangas;
    await act(() => again.result.current.fetchMangas());
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'If-None-Match': 'W/"v1"' });
    expect(again.result.current.mangas).toBe(shown);
    expect(again.result.current.error).toBeNull();
  });

  it('a changed list on screen (after a delete) is fetched in full, without If-None-Match', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, listA, { ETag: 'W/"v1"' }))
      .mockResolvedValueOnce(json(200, { message: 'ok' }))
      .mockResolvedValueOnce(json(200, listB, { ETag: 'W/"v2"' }));
    const { result } = await mount(fetchMock);
    await act(async () => { await result.current.handleDeleteManga(click(), 1, 'Akira'); });
    await act(async () => {});
    expect(fetchMock.mock.calls[2][1].headers).toBeUndefined();
    expect(readCache(user.id, LIST_KEY).etag).toBe('W/"v2"');
  });

  it('the first load shows the offline copy while the server is still answering', async () => {
    loadMangaList.mockResolvedValue(listB);
    const answer = deferred();
    vi.stubGlobal('fetch', vi.fn(() => answer.promise));
    const { result } = renderHook(() => useMangaList({ user, canEdit: true }));
    let pending;
    act(() => { pending = result.current.fetchMangas(); });
    await act(async () => {});
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.mangas).toEqual(listB);
    expect(result.current.dataAt).toBeNull();
    await act(async () => { answer.resolve(json(200, listA)); await pending; });
    expect(result.current.mangas).toEqual(listA);
    expect(result.current.refreshing).toBe(false);
  });

  it('a server answer that arrives first is not replaced by the slower offline copy', async () => {
    const copy = deferred();
    loadMangaList.mockReturnValue(copy.promise);
    const { result } = await mount(vi.fn(async () => json(200, listA)));
    await act(async () => { copy.resolve(listB); });
    expect(result.current.mangas).toEqual(listA);
  });

  it('takes the list prefetched at startup instead of asking again', async () => {
    const fetchMock = vi.fn(async () => json(200, listB));
    startPrefetch(PREFETCH_MANGAS, async () => json(200, listA));
    const { result } = await mount(fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.mangas).toEqual(listA);
  });

  it('a prefetched 401 (no session at startup) is ignored and the list is requested', async () => {
    startPrefetch(PREFETCH_MANGAS, async () => json(401, { error: 'Nicht angemeldet', code: 'AUTH_REQUIRED' }));
    const fetchMock = vi.fn(async () => json(200, listA));
    const { result } = await mount(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.mangas).toEqual(listA);
  });

  it('delete: a 401 without a session code (proxy) is reported, an announced session end is not', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, listA))
      .mockResolvedValueOnce(fakeResponse(401, { error: 'x' }))
      .mockResolvedValueOnce(htmlResponse(401))
      .mockResolvedValueOnce(fakeResponse(401, { error: 'Sitzung ungültig', code: 'SESSION_INVALID' }));
    const { result } = await mount(fetchMock);
    for (let i = 0; i < 3; i++) {
      let ok;
      await act(async () => { ok = await result.current.handleDeleteManga(click(), 1, 'Akira'); });
      expect(ok).toBe(false);
    }
    expect(toasts.messages('error')).toEqual(['x', 'Sitzung abgelaufen – bitte neu anmelden. (HTTP 401)']);
    expect(result.current.mangas).toEqual(listA);
  });
});
