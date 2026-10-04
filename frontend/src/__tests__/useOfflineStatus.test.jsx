// useOfflineStatus: offline copy metadata, sync trigger and the synced event.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../utils/offlineStore', () => ({
  OFFLINE_SYNCED_EVENT: 'mangashelf:offline-synced',
  loadMeta: vi.fn(),
  syncOfflineCopy: vi.fn()
}));

const { loadMeta, syncOfflineCopy, OFFLINE_SYNCED_EVENT } = await import('../utils/offlineStore');
const { default: useOfflineStatus } = await import('../hooks/useOfflineStatus');

const synced = (at) => act(() => { window.dispatchEvent(new CustomEvent(OFFLINE_SYNCED_EVENT, { detail: { synced_at: at } })); });
const render = () => renderHook(() => useOfflineStatus({ user: { id: 1 }, onOnlineRef: { current: () => {} } }));

describe('useOfflineStatus', () => {
  beforeEach(() => {
    loadMeta.mockReset();
    syncOfflineCopy.mockReset();
  });

  it('shows a copy that a background sync stored after the dashboard loaded', async () => {
    loadMeta.mockResolvedValue(null);
    const { result } = render();
    await waitFor(() => expect(loadMeta).toHaveBeenCalled());
    expect(result.current.offlineCopyAt).toBeNull();
    synced(1700000000000);
    expect(result.current.offlineCopyAt).toBe(1700000000000);
  });

  it('an older value read from the store does not replace a newer sync', async () => {
    let resolveMeta;
    loadMeta.mockReturnValue(new Promise((r) => { resolveMeta = r; }));
    const { result } = render();
    synced(2000);
    await act(async () => { resolveMeta({ synced_at: 1000 }); });
    expect(result.current.offlineCopyAt).toBe(2000);
  });

  it('a logout clears the age', async () => {
    loadMeta.mockResolvedValue({ synced_at: 1000 });
    const { result } = render();
    await waitFor(() => expect(result.current.offlineCopyAt).toBe(1000));
    synced(null);
    expect(result.current.offlineCopyAt).toBeNull();
  });

  it('a failed refresh is reported and keeps the old age', async () => {
    loadMeta.mockResolvedValue({ synced_at: 1000 });
    syncOfflineCopy.mockResolvedValue(false);
    const { result } = render();
    await waitFor(() => expect(result.current.offlineCopyAt).toBe(1000));
    await act(() => result.current.handleRefreshOfflineCopy());
    expect(syncOfflineCopy).toHaveBeenCalledWith({ force: true });
    expect(result.current.refreshError).toBe('Aktualisierung fehlgeschlagen');
    expect(result.current.offlineCopyAt).toBe(1000);
    expect(result.current.refreshingCopy).toBe(false);

    syncOfflineCopy.mockResolvedValue(true);
    await act(() => result.current.handleRefreshOfflineCopy());
    expect(result.current.refreshError).toBeNull();
  });
});
