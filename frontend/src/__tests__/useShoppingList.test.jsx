// useShoppingList: fetching, optimistic purchases, outbox replay and offline caches.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import useShoppingList from '../hooks/useShoppingList';
import { clearOfflineData } from '../utils/offlineStore';
import { queueKey, localToday } from '../utils/shoppingQueue';
import { getOutbox, outboxScope, resetOutbox, FALLBACK_KEY } from '../utils/outbox';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';
import { readCache, writeCache, detailKey, clearDataCache } from '../utils/dataCache';
import { PURCHASE_RECORDED_EVENT } from '../appShell';

let toasts;
beforeEach(() => { toasts = recordToasts(); });
afterEach(() => { toasts.stop(); });

const list = () => ({
  total_missing: 2, total_cost: 14, publishers: [{ publisher: 'Carlsen', count: 2, total_price: 14 }],
  items: [
    { id: 1, manga_id: 9, manga_title: 'Berserk', volume_number: '1', price: 7, effective_publisher: 'Carlsen' },
    { id: 2, manga_id: 9, manga_title: 'Berserk', volume_number: '2', price: 7, effective_publisher: 'Carlsen' }
  ],
  others: []
});
const json = (status, body = {}) => fakeResponse(status, body);

/** fetch stub: GET shopping list answers `listResponse()`, POST /api/volumes/:id/owners answers `putResponse(id)`. */
function stubFetch({ listResponse = () => json(200, list()), putResponse = () => json(200, { success: true }) } = {}) {
  const fetchMock = vi.fn(async (url, opts = {}) => {
    if (url.startsWith('/api/shopping-list')) return listResponse();
    const owners = url.match(/^\/api\/volumes\/(\d+)\/owners$/);
    if (owners && opts.method === 'POST') return putResponse(Number(owners[1]), opts);
    return json(404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const puts = (fetchMock) => fetchMock.mock.calls.filter(([url, opts]) => opts?.method === 'POST' && url.endsWith('/owners'));

function renderList(user = { id: 1 }) {
  const props = { user, setNetworkOffline: vi.fn(), fetchMangas: vi.fn() };
  const hook = renderHook((p) => useShoppingList(p), { initialProps: props });
  return { ...hook, props };
}

const queued = (userId = 1) => getOutbox().list(outboxScope(userId)).map((e) => e.volumeId);
const legacyQueue = (userId, entries) => localStorage.setItem(queueKey(userId), JSON.stringify(entries));

async function loaded(fetchMock, user) {
  const r = renderList(user);
  await act(() => r.result.current.fetchShoppingList());
  return r;
}

describe('useShoppingList', () => {
  beforeEach(() => {
    localStorage.clear();
    resetOutbox();
    clearDataCache();
  });

  it('quick buy online records the buyer as owner with the purchase date of today', async () => {
    const fetchMock = stubFetch();
    const { result } = await loaded(fetchMock);
    let outcome;
    await act(async () => { outcome = await result.current.handleQuickBuy(1); });
    expect(outcome).toBe('ok');
    const [url, opts] = puts(fetchMock)[0];
    expect(url).toBe('/api/volumes/1/owners');
    expect(JSON.parse(opts.body)).toEqual({ owned: true, purchase_date: localToday() });
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false);
  });

  it('batch mode: no alert and no refetch per item, results as objects', async () => {
    const statuses = { 1: 200, 2: 401 };
    const fetchMock = stubFetch({ putResponse: (id) => json(statuses[id], id === 2 ? { error: 'x', code: 'SESSION_INVALID' } : {}) });
    const { result, props } = await loaded(fetchMock);
    const listCalls = () => fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/shopping-list')).length;
    const before = listCalls();
    let ok;
    let auth;
    await act(async () => { ok = await result.current.handleQuickBuy(1, { batch: true }); });
    await act(async () => { auth = await result.current.handleQuickBuy(2, { batch: true }); });
    expect(ok).toEqual({ status: 'ok', error: '', httpStatus: 200 });
    // the session ended: the purchase stays in the outbox and goes out after the next login
    expect(auth).toEqual({ status: 'queued', error: '', httpStatus: null });
    expect(toasts.messages()).toEqual([]);
    expect(props.fetchMangas).not.toHaveBeenCalled();
    expect(listCalls()).toBe(before);
    expect(result.current.shoppingData.items).toEqual([]);
    expect(queued()).toEqual([2]);
  });

  it('batch mode: a volume that no longer exists leaves the list as a 404 result', async () => {
    const fetchMock = stubFetch({ putResponse: () => json(404, { error: 'Band nicht gefunden' }) });
    const { result } = await loaded(fetchMock);
    let outcome;
    await act(async () => { outcome = await result.current.handleQuickBuy(1, { batch: true }); });
    expect(outcome).toEqual({ status: 'failed', error: 'Band nicht gefunden', httpStatus: 404 });
    expect(toasts.messages('error')).toEqual([]);
    expect(result.current.shoppingData.items.map(i => i.id)).toEqual([2]);
  });

  it('batch mode: a gateway error queues the purchase', async () => {
    const fetchMock = stubFetch({ putResponse: () => json(503) });
    const { result } = await loaded(fetchMock);
    let outcome;
    await act(async () => { outcome = await result.current.handleQuickBuy(1, { batch: true }); });
    expect(outcome).toEqual({ status: 'queued', error: '', httpStatus: null });
    expect(queued()).toEqual([1]);
    expect(JSON.parse(localStorage.getItem(FALLBACK_KEY))).toMatchObject([{ kind: 'purchase', volumeId: 1, userId: 1, serverId: 'web' }]);
  });

  it('buyingIds holds every volume whose purchase is running', async () => {
    const releases = {};
    const fetchMock = stubFetch({ putResponse: (id) => new Promise((resolve) => { releases[id] = () => resolve(json(200)); }) });
    const { result } = await loaded(fetchMock);
    let first;
    let second;
    act(() => {
      first = result.current.handleQuickBuy(1, { batch: true });
      second = result.current.handleQuickBuy(2, { batch: true });
    });
    await waitFor(() => expect([...result.current.buyingIds].sort()).toEqual([1, 2]));
    await act(async () => { releases[1](); await first; });
    expect([...result.current.buyingIds]).toEqual([2]);
    await act(async () => { releases[2](); await second; });
    expect(result.current.buyingIds.size).toBe(0);
  });

  it('shoppingError tells why the list could not be loaded and clears after a success', async () => {
    let next = () => json(500);
    stubFetch({ listResponse: () => next() });
    const { result } = renderList({ id: 1 });
    await act(() => result.current.fetchShoppingList());
    expect(result.current.shoppingError).toBe('server');
    next = () => json(401, { code: 'SESSION_INVALID' });
    await act(() => result.current.fetchShoppingList());
    expect(result.current.shoppingError).toBe('auth');
    next = () => { throw new TypeError('Failed to fetch'); };
    await act(() => result.current.fetchShoppingList());
    expect(result.current.shoppingError).toBe('offline');
    next = () => json(200, list());
    await act(() => result.current.fetchShoppingList());
    expect(result.current.shoppingError).toBeNull();
  });

  it('a gateway error queues the purchase instead of dropping it', async () => {
    const fetchMock = stubFetch({ putResponse: () => json(502) });
    const { result, props } = await loaded(fetchMock);
    let outcome;
    await act(async () => { outcome = await result.current.handleQuickBuy(1); });
    expect(outcome).toBe('queued');
    expect(toasts.messages('error')).toEqual([]);
    expect(queued()).toEqual([1]);
    expect(result.current.shoppingData.items.map(i => i.id)).toEqual([2]);
    await waitFor(() => expect(result.current.pendingPurchases).toBe(1));
    expect(props.setNetworkOffline).toHaveBeenCalledWith(true);
  });

  it('an expired session keeps the purchase in the outbox for the next login', async () => {
    const fetchMock = stubFetch({ putResponse: () => json(401, { error: 'Sitzung ungültig', code: 'SESSION_INVALID' }) });
    const { result } = await loaded(fetchMock);
    let outcome;
    await act(async () => { outcome = await result.current.handleQuickBuy(1); });
    expect(outcome).toBe('queued');
    expect(toasts.messages('error')).toEqual([]);
    expect(queued()).toEqual([1]);
    expect(result.current.shoppingData.items.map(i => i.id)).toEqual([2]);
  });

  it('a queued purchase is announced as queued and patches the stored series copy', async () => {
    const fetchMock = stubFetch({ putResponse: () => json(401, { error: 'Sitzung ungültig', code: 'SESSION_INVALID' }) });
    const { result } = await loaded(fetchMock);
    writeCache(1, detailKey(9), { id: 9, title: 'Berserk', volumes: [{ id: 1, volume_number: '1', status: 'Fehlt', owners: [] }] });
    const events = [];
    const onPurchase = (e) => events.push(e.detail);
    window.addEventListener(PURCHASE_RECORDED_EVENT, onPurchase);
    try {
      await act(async () => { await result.current.handleQuickBuy(1); });
    } finally {
      window.removeEventListener(PURCHASE_RECORDED_EVENT, onPurchase);
    }
    expect(events).toEqual([{ volumeId: 1, queued: true }]);
    expect(readCache(1, detailKey(9)).data.volumes[0]).toMatchObject({ status: 'Vorhanden', owned_by_me: true, purchase_date: localToday() });
  });

  it('a 401 of an auth proxy (no app code) says so and keeps the purchase queued', async () => {
    const fetchMock = stubFetch({ putResponse: () => json(401, { error: 'proxy' }) });
    const { result } = await loaded(fetchMock);
    await act(() => result.current.handleQuickBuy(1));
    expect(toasts.messages('info')).toEqual([expect.stringContaining('nach der Anmeldung übertragen')]);
    expect(queued()).toEqual([1]);
  });

  it('a rejected purchase shows the server message', async () => {
    const fetchMock = stubFetch({ putResponse: () => json(403, { error: 'Nur Lesezugriff', code: 'READ_ONLY' }) });
    const { result } = await loaded(fetchMock);
    await act(() => result.current.handleQuickBuy(1));
    expect(toasts.messages('error')).toEqual(['Nur Lesezugriff']);
    expect(queued()).toEqual([]);
    expect(result.current.shoppingData.items).toHaveLength(2);
  });

  it("in App's offline mode the purchase is queued without trying the server", async () => {
    localStorage.setItem('mangashelf_shopping_cache', JSON.stringify(list()));
    const fetchMock = stubFetch();
    const { result } = renderList({ id: 1, offline: true });
    let outcome;
    await act(async () => { outcome = await result.current.handleQuickBuy(2); });
    expect(outcome).toBe('queued');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queued()).toEqual([2]);
    expect(getOutbox().list(outboxScope(1))[0]).toMatchObject({ kind: 'purchase', value: true, purchase_date: localToday(), deferred: true });
    expect(JSON.parse(localStorage.getItem('mangashelf_shopping_cache')).items.map(i => i.id)).toEqual([1]);
  });

  it('a purchase that cannot be stored stays in the list', async () => {
    const fetchMock = stubFetch({ putResponse: () => { throw new TypeError('Failed to fetch'); } });
    const { result } = await loaded(fetchMock);
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === FALLBACK_KEY) throw new DOMException('full', 'QuotaExceededError');
      return original.call(this, key, value);
    });
    let outcome;
    await act(async () => { outcome = await result.current.handleQuickBuy(1); });
    expect(outcome).toBe('failed');
    expect(toasts.messages('error')).toEqual([expect.stringContaining('nicht vorgemerkt')]);
    expect(result.current.shoppingData.items).toHaveLength(2);
    expect(queued()).toEqual([]);
  });

  it('moves the old purchase queue into the outbox once and sends it when App leaves offline mode', async () => {
    legacyQueue(1, [{ volumeId: 2, purchasedAt: '2026-10-01' }]);
    const fetchMock = stubFetch();
    const { rerender, props, result } = renderList({ id: 1, offline: true });
    await waitFor(() => expect(localStorage.getItem(queueKey(1))).toBeNull());
    expect(queued()).toEqual([2]);
    await waitFor(() => expect(result.current.pendingPurchases).toBe(1));
    expect(puts(fetchMock)).toHaveLength(0);
    rerender({ ...props, user: { id: 1, offline: false } });
    await waitFor(() => expect(queued()).toEqual([]));
    const [url, opts] = puts(fetchMock)[0];
    expect(url).toBe('/api/volumes/2/owners');
    expect(JSON.parse(opts.body)).toEqual({ owned: true, purchase_date: '2026-10-01' });
    await waitFor(() => expect(toasts.messages('success')).toEqual(['1 Änderung übertragen']));
    await waitFor(() => expect(props.fetchMangas).toHaveBeenCalled());
  });

  it("does not send another user's queued purchases", async () => {
    legacyQueue(1, [{ volumeId: 2 }]);
    const fetchMock = stubFetch();
    renderList({ id: 7 });
    await act(async () => {});
    expect(puts(fetchMock)).toHaveLength(0);
    expect(localStorage.getItem(queueKey(1))).not.toBeNull();
    expect(queued(7)).toEqual([]);
  });

  it('a fetched list hides purchases that are still queued', async () => {
    legacyQueue(1, [{ volumeId: 2 }]);
    const fetchMock = stubFetch({ putResponse: () => json(503) });
    const { result } = await loaded(fetchMock);
    expect(result.current.shoppingData.items.map(i => i.id)).toEqual([1]);
    expect(result.current.shoppingData.total_missing).toBe(1);
    expect(result.current.shoppingData.total_cost).toBe(7);
  });

  it('a successful fetch after a failure sends the queue (reconnect without an event)', async () => {
    let up = false;
    const fetchMock = stubFetch({
      listResponse: () => { if (!up) throw new TypeError('Failed to fetch'); return json(200, list()); },
      putResponse: () => { if (!up) throw new TypeError('Failed to fetch'); return json(200); }
    });
    const { result } = renderList({ id: 1 });
    await act(() => result.current.fetchShoppingList());
    await act(() => result.current.handleQuickBuy(2));
    expect(queued()).toEqual([2]);
    up = true;
    await act(() => result.current.fetchShoppingList());
    await waitFor(() => expect(queued()).toEqual([]));
    expect(puts(fetchMock).filter(([url]) => url === '/api/volumes/2/owners').length).toBeGreaterThanOrEqual(2);
  });

  it('a list that arrives after a logout is not cached', async () => {
    let release;
    stubFetch({ listResponse: () => new Promise((resolve) => { release = () => resolve(json(200, list())); }) });
    const { result } = renderList({ id: 1 });
    let pending;
    act(() => { pending = result.current.fetchShoppingList(); });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    await clearOfflineData();
    await act(async () => { release(); await pending; });
    expect(localStorage.getItem('mangashelf_shopping_cache')).toBeNull();
    expect(localStorage.getItem('mangashelf_shopping_meta')).toBeNull();
    expect(result.current.shoppingData).toBeNull();
  });

  it('a full storage does not claim a fresh offline copy', async () => {
    stubFetch();
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key.startsWith('mangashelf_shopping')) throw new DOMException('full', 'QuotaExceededError');
      return original.call(this, key, value);
    });
    const { result } = renderList({ id: 1 });
    await act(() => result.current.fetchShoppingList());
    expect(result.current.shoppingData.items).toHaveLength(2);
    expect(result.current.offlineLastUpdated).toBeNull();
    expect(result.current.cacheWriteFailed).toBe(true);
  });
});
