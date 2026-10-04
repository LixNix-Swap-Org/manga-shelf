import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const idb = vi.hoisted(() => ({ rows: null, patched: [] }));
vi.mock('../utils/offlineStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadOutboxEntries: vi.fn(async () => {
    if (!idb.rows) throw new Error('IndexedDB nicht verfügbar');
    return [...idb.rows.values()];
  }),
  putOutboxEntries: vi.fn(async (entries) => {
    if (!idb.rows) throw new Error('IndexedDB nicht verfügbar');
    for (const e of entries) idb.rows.set(e.key, e);
  }),
  deleteOutboxEntries: vi.fn(async (keys) => { for (const k of keys) idb.rows?.delete(k); }),
  updateOutboxEntriesById: vi.fn(async (entries) => {
    if (!idb.rows) throw new Error('IndexedDB nicht verfügbar');
    for (const e of entries) if (idb.rows.get(e.key)?.id === e.id) idb.rows.set(e.key, e);
  }),
  deleteOutboxEntriesById: vi.fn(async (entries) => {
    if (!idb.rows) throw new Error('IndexedDB nicht verfügbar');
    for (const e of entries) if (idb.rows.get(e.key)?.id === e.id) idb.rows.delete(e.key);
  }),
  patchCachedManga: vi.fn(async (id, change) => { idb.patched.push([id, change]); return true; })
}));

import {
  defaultOutboxStorage, applyChangeToCaches, getOutbox, resetOutbox, outboxScope, FALLBACK_KEY, normalizeOutboxEntry
} from '../utils/outbox';
import { applyVolumeChange, applyDetailToList, patchVolume, recomputeDetail } from '../utils/volumePatch';
import { writeCache, readCache, clearDataCache, detailKey, LIST_KEY } from '../utils/dataCache';
import { useOutboxPending } from '../app/useOutbox';

const me = { id: 1, username: 'anna' };
const detail = () => ({
  id: 3,
  total_value: 14,
  owned_volumes: 2,
  volumes: [
    { id: 10, volume_number: '1', status: 'Vorhanden', price: 7, owners: [{ user_id: 1, username: 'anna' }], owned_by_me: true, read_users: [{ id: 1, user_id: 1, username: 'anna' }], read_by: [1], is_read: true },
    { id: 11, volume_number: '2', status: 'Vorhanden', price: 7, owners: [{ user_id: 2, username: 'ben' }], owned_by_me: false, read_users: [], read_by: [], is_read: false },
    { id: 12, volume_number: '3', status: 'Fehlt', price: 7, owners: [], owned_by_me: false, read_users: [], read_by: [], is_read: false, purchase_date: null }
  ],
  reader_stats: [
    { user_id: 1, username: 'anna', role: 'admin', read_count: 1, total_owned: 2, unread_count: 1, percentage: 50 },
    { user_id: 2, username: 'ben', role: 'editor', read_count: 0, total_owned: 2, unread_count: 2, percentage: 0 }
  ]
});

beforeEach(() => {
  localStorage.clear();
  idb.rows = null;
  idb.patched = [];
  clearDataCache();
  resetOutbox();
});

describe('volumePatch', () => {
  it('a read toggle updates the readers of the volume and the reader stats', () => {
    const next = applyVolumeChange(detail(), { kind: 'read', volumeId: 11, value: true, targetUserId: 2 }, me);
    expect(next.volumes[1]).toMatchObject({ read_by: [2], is_read: false, read_users: [{ id: 2, user_id: 2, username: 'ben' }] });
    expect(next.reader_stats[1]).toMatchObject({ read_count: 1, unread_count: 1, percentage: 50 });
    const unread = applyVolumeChange(next, { kind: 'read', volumeId: 10, value: false, targetUserId: 1 }, me);
    expect(unread.volumes[0]).toMatchObject({ read_by: [], is_read: false });
    expect(unread.reader_stats[0]).toMatchObject({ read_count: 0, percentage: 0 });
  });

  it('owning follows the server rules: the first owner makes it "Vorhanden", the last one leaving makes it "Fehlt"', () => {
    const bought = applyVolumeChange(detail(), { kind: 'purchase', volumeId: 12, value: true, purchase_date: '2026-10-03' }, me);
    expect(bought.volumes[2]).toMatchObject({ status: 'Vorhanden', owned_by_me: true, purchase_date: '2026-10-03' });
    expect(bought.volumes[2].owners).toEqual([{ user_id: 1, username: 'anna', price: 7, purchase_date: '2026-10-03' }]);
    expect(bought).toMatchObject({ owned_volumes: 3, total_value: 21 });
    expect(bought.reader_stats[0]).toMatchObject({ total_owned: 3, read_count: 1, percentage: 33 });

    const left = applyVolumeChange(detail(), { kind: 'owned', volumeId: 10, value: false }, me);
    expect(left.volumes[0]).toMatchObject({ status: 'Fehlt', owners: [], owned_by_me: false, purchase_date: null });
    expect(left.reader_stats[0]).toMatchObject({ read_count: 0, total_owned: 1 });

    const shared = applyVolumeChange(detail(), { kind: 'owned', volumeId: 11, value: true }, me);
    expect(shared.volumes[1].owners.map((o) => o.user_id)).toEqual([2, 1]);
    expect(shared.volumes[1].status).toBe('Vorhanden');
  });

  it('a status write to "Fehlt" removes the owners; an unknown volume leaves the detail as it was', () => {
    const missing = applyVolumeChange(detail(), { kind: 'status', volumeId: 11, value: 'Fehlt' }, me);
    expect(missing.volumes[1]).toMatchObject({ status: 'Fehlt', owners: [], owned_by_me: false });
    const same = detail();
    expect(applyVolumeChange(same, { kind: 'status', volumeId: 99, value: 'Fehlt' }, me)).toBe(same);
    expect(patchVolume({ id: 1 }, { kind: 'nope' })).toBeNull();
    expect(recomputeDetail({ volumes: [] })).toMatchObject({ owned_volumes: 0, total_value: 0 });
  });

  it('the wish flag follows the owned volumes: the first owned volume ends the wish, the last one leaving restores it', () => {
    const wishedDetail = { ...detail(), wish_priority: 2, wished: 0 };
    const none = applyVolumeChange(applyVolumeChange(wishedDetail, { kind: 'owned', volumeId: 10, value: false }, me), { kind: 'status', volumeId: 11, value: 'Fehlt' }, me);
    expect(none).toMatchObject({ owned_volumes: 0, wished: 1 });
    const bought = applyVolumeChange(none, { kind: 'purchase', volumeId: 12, value: true }, me);
    expect(bought).toMatchObject({ owned_volumes: 1, wished: 0 });
    const [row] = applyDetailToList([{ id: 3, wished: 1, wish_priority: 2 }], bought, me);
    expect(row.wished).toBe(0);
    expect(applyVolumeChange({ ...detail(), wish_priority: null }, { kind: 'owned', volumeId: 10, value: false }, me).wished).toBe(0);
    // a detail that only carries the flag keeps it while nothing is owned
    const flagOnly = { id: 5, wished: 1, volumes: [{ id: 50, status: 'Fehlt', owners: [] }] };
    expect(applyVolumeChange(flagOnly, { kind: 'read', volumeId: 50, value: true, targetUserId: 1 }, me).wished).toBe(1);
    expect(applyVolumeChange(flagOnly, { kind: 'purchase', volumeId: 50, value: true }, me).wished).toBe(0);
    expect('wished' in applyVolumeChange(detail(), { kind: 'purchase', volumeId: 12, value: true }, me)).toBe(false);
  });

  it('the series row of the shelf list follows the patched detail', () => {
    const next = applyVolumeChange(detail(), { kind: 'purchase', volumeId: 12, value: true }, me);
    const [row, other] = applyDetailToList([{ id: 3, owned_volumes: 2, read_volume_count: 1 }, { id: 4, owned_volumes: 9 }], next, me);
    expect(row).toMatchObject({ owned_volumes: 3, regular_owned: 3, max_regular_number: 3, extras_owned: 0, total_value: 21, read_volume_count: 1 });
    expect(other).toEqual({ id: 4, owned_volumes: 9 });
  });
});

describe('applyChangeToCaches', () => {
  it('patches the in-memory detail and list (dropping their ETags) and the offline copy', async () => {
    writeCache(1, detailKey(3), detail(), '"etag-d"');
    writeCache(1, LIST_KEY, [{ id: 3, owned_volumes: 2 }], '"etag-l"');
    await applyChangeToCaches({ user: { id: 1, username: 'anna' }, mangaId: 3, change: { kind: 'purchase', volumeId: 12, value: true } });
    expect(readCache(1, detailKey(3))).toMatchObject({ etag: null, data: { owned_volumes: 3 } });
    expect(readCache(1, LIST_KEY)).toMatchObject({ etag: null, data: [{ id: 3, owned_volumes: 3 }] });
    const [[id, change]] = idb.patched;
    expect(id).toBe(3);
    const stored = change(detail(), [{ id: 3, owned_volumes: 2 }]);
    expect(stored.detail.owned_volumes).toBe(3);
    expect(stored.list[0].owned_volumes).toBe(3);
    expect(change(null, [])).toEqual({});
    expect(await applyChangeToCaches({ user: me, mangaId: null, change: {} })).toBe(false);
  });
});

describe('outbox storage', () => {
  it('without IndexedDB the entries live in localStorage', async () => {
    const storage = defaultOutboxStorage();
    const entry = normalizeOutboxEntry({ kind: 'read', volumeId: 1, userId: 1, serverId: 'web', value: true });
    await storage.put([entry]);
    expect(JSON.parse(localStorage.getItem(FALLBACK_KEY))).toEqual([entry]);
    expect(await storage.load()).toEqual([entry]);
    await storage.delete([entry.key]);
    expect(localStorage.getItem(FALLBACK_KEY)).toBeNull();
  });

  it('settled entries change only the stored row that still holds them, in IndexedDB and in the fallback', async () => {
    const older = normalizeOutboxEntry({ kind: 'read', volumeId: 1, userId: 1, serverId: 'web', value: true });
    const newer = normalizeOutboxEntry({ kind: 'read', volumeId: 1, userId: 1, serverId: 'web', value: false });
    const fallback = defaultOutboxStorage();
    await fallback.put([newer]);
    await fallback.remove([older]);
    await fallback.update([{ ...older, attempts: 2 }]);
    expect(JSON.parse(localStorage.getItem(FALLBACK_KEY))).toEqual([newer]);

    localStorage.clear();
    idb.rows = new Map([[newer.key, newer]]);
    const storage = defaultOutboxStorage();
    await storage.remove([older]);
    await storage.update([{ ...older, attempts: 2 }]);
    expect([...idb.rows.values()]).toEqual([newer]);
    await storage.remove([newer]);
    expect(idb.rows.size).toBe(0);
  });

  it('entries stranded in localStorage move into IndexedDB once it works', async () => {
    const entry = normalizeOutboxEntry({ kind: 'read', volumeId: 2, userId: 1, serverId: 'web', value: true });
    localStorage.setItem(FALLBACK_KEY, JSON.stringify([entry]));
    idb.rows = new Map();
    const storage = defaultOutboxStorage();
    expect(await storage.load()).toEqual([entry]);
    expect([...idb.rows.keys()]).toEqual([entry.key]);
    expect(localStorage.getItem(FALLBACK_KEY)).toBeNull();
  });
});

describe('useOutboxPending', () => {
  it('counts the queued changes of the user and the purchases among them, live', async () => {
    const { result } = renderHook(() => useOutboxPending(1));
    expect(result.current.total).toBe(0);
    await act(async () => {
      await getOutbox().add({ kind: 'purchase', volumeId: 5, userId: 1, serverId: 'web' });
      await getOutbox().add({ kind: 'read', volumeId: 6, userId: 1, serverId: 'web', value: true });
      await getOutbox().add({ kind: 'read', volumeId: 7, userId: 2, serverId: 'web', value: true });
    });
    await waitFor(() => expect(result.current.total).toBe(2));
    expect(result.current.purchases).toBe(1);
    expect([...result.current.purchaseIds]).toEqual([5]);
    expect(getOutbox().list(outboxScope(2))).toHaveLength(1);
  });
});
