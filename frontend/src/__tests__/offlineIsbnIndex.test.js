// Offline ISBN index follows changes made in the app.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PURCHASE_RECORDED_EVENT } from '../appShell';

function fakeIndexedDB() {
  const stores = new Map([['kv', new Map()], ['outbox', new Map()]]);
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction(name) {
      const data = stores.get(name);
      const ops = [];
      const request = (op) => { const req = {}; ops.push(() => { req.result = op(); req.onsuccess?.(); }); return req; };
      const store = {
        get(key) { return request(() => structuredClone(data.get(key))); },
        put(value, key) { return request(() => { data.set(key, structuredClone(value)); }); },
        delete(key) { return request(() => { data.delete(key); }); },
        clear() { return request(() => { data.clear(); }); }
      };
      const tx = { objectStore: () => store };
      setTimeout(() => { for (let i = 0; i < ops.length; i++) ops[i](); tx.oncomplete?.(); }, 0);
      return tx;
    }
  };
  return {
    data: stores.get('kv'),
    open() {
      const req = { result: db };
      setTimeout(() => { req.onupgradeneeded?.(); req.onsuccess(); }, 0);
      return req;
    }
  };
}

const volume = (over = {}) => ({ id: 32, volume_number: '2', isbn: '3-551-76294-5', status: 'Fehlt', owned_by_me: false, owners: [], ...over });
const detail = (vol = volume()) => ({ id: 3, title: 'Naruto', volumes: [vol] });
const snapshot = {
  generated_at: '2026-10-03T10:00:00Z',
  user: { id: 1, username: 'anna', role: 'editor' },
  mangas: [{ id: 3, title: 'Naruto' }],
  details: { 3: detail() }
};

let idb;
let store;
beforeEach(async () => {
  idb = fakeIndexedDB();
  vi.stubGlobal('indexedDB', idb);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.resetModules();
  store = await import('../utils/offlineStore');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const statusOf = async () => (await store.lookupLocalIsbn('9783551762948'))?.volume;

describe('offline ISBN index follows changes made in the app', () => {
  it('the purchase event name matches appShell', () => {
    expect(store.PURCHASE_EVENT_NAME).toBe(PURCHASE_RECORDED_EVENT);
  });

  it('updateCachedManga renews the index from the stored details', async () => {
    await store.saveSnapshot(snapshot);
    expect(await statusOf()).toMatchObject({ status: 'Fehlt', owned_by_me: false });
    await store.updateCachedManga(detail(volume({ status: 'Vorhanden', owned_by_me: true, owners: [{ username: 'anna' }] })));
    expect(await statusOf()).toMatchObject({ status: 'Vorhanden', owned_by_me: true, owners: ['anna'] });
    expect(idb.data.get('isbn-index').entries[0][4]).toBe('Vorhanden');
  });

  it('patchCachedManga (outbox toggles) renews the index', async () => {
    await store.saveSnapshot(snapshot);
    expect((await statusOf()).status).toBe('Fehlt');
    await store.patchCachedManga(3, (d) => ({ detail: { ...d, volumes: [{ ...d.volumes[0], status: 'Vorhanden', owned_by_me: true }] } }));
    expect(await statusOf()).toMatchObject({ status: 'Vorhanden', owned_by_me: true });
  });

  it('a recorded purchase marks the volume owned until the next sync or logout', async () => {
    await store.saveSnapshot(snapshot);
    expect((await statusOf()).status).toBe('Fehlt');
    window.dispatchEvent(new CustomEvent(PURCHASE_RECORDED_EVENT, { detail: { volumeId: 32 } }));
    expect(await statusOf()).toMatchObject({ status: 'Vorhanden', owned_by_me: true });

    await store.updateCachedManga(detail(volume({ status: 'Fehlt' })));
    expect((await statusOf()).status).toBe('Fehlt');

    store.markLocalOwned(32);
    await store.clearOfflineData();
    await store.saveSnapshot(snapshot);
    expect((await statusOf()).status).toBe('Fehlt');
  });

  it('a purchase queued offline reaches the stored detail, so a re-scan shows the volume as owned', async () => {
    await store.saveSnapshot(snapshot);
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } })));
    const { resetOutbox } = await import('../utils/outbox');
    resetOutbox();
    const { default: useShoppingList } = await import('../hooks/useShoppingList');
    store.writeShoppingCache({ items: [{ id: 32, manga_id: 3, manga_title: 'Naruto', volume_number: '2' }] });
    const events = [];
    const onPurchase = (e) => events.push(e.detail);
    window.addEventListener(PURCHASE_RECORDED_EVENT, onPurchase);
    try {
      const { result } = renderHook(() => useShoppingList({ user: { id: 1, username: 'anna', offline: true }, setNetworkOffline: vi.fn(), fetchMangas: vi.fn() }));
      let outcome;
      await act(async () => { outcome = await result.current.handleQuickBuy(32); });
      expect(outcome).toBe('queued');
      expect(events).toEqual([{ volumeId: 32, queued: true }]);
      expect(idb.data.get('manga:3').volumes[0]).toMatchObject({ status: 'Vorhanden', owned_by_me: true });
      expect(await statusOf()).toMatchObject({ status: 'Vorhanden', owned_by_me: true });
      expect(idb.data.get('isbn-index').entries[0][4]).toBe('Vorhanden');
    } finally {
      window.removeEventListener(PURCHASE_RECORDED_EVENT, onPurchase);
    }
  });

  it('clearOfflineData also drops the anime list cache', async () => {
    localStorage.setItem('mangashelf_anime_cache', '[]');
    localStorage.setItem('mangashelf_anime_cache_meta', '{"user_id":1}');
    await store.clearOfflineData();
    expect(localStorage.getItem('mangashelf_anime_cache')).toBeNull();
    expect(localStorage.getItem('mangashelf_anime_cache_meta')).toBeNull();
  });
});
