import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import useMpGaps, { LONG_JOB_TIMEOUT_TEXT } from '../hooks/useMpGaps';
import { TIMEOUTS } from '../utils/api';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

let toasts;
beforeEach(() => { toasts = recordToasts(); });
afterEach(() => { toasts.stop(); });

const json = (status, body) => fakeResponse(status, body);

// fetch whose answers the test releases one by one
const deferredFetch = () => {
  const calls = [];
  const fn = vi.fn((url, init) => new Promise(resolve => calls.push({ url, init, resolve })));
  return { fn, calls };
};

const baseProps = (overrides = {}) => ({
  id: '1', canEdit: true, volumes: [{ volume_number: '1' }], manga: { total_volumes: 3 },
  fetchManga: vi.fn(async () => {}), setShowMpEditionModal: vi.fn(), ...overrides
});

const guessed = { matched: true, link_confirmed: false, edition: { id: 7, title: 'Geraten' }, gaps: [], discrepancy: { official_total: 3, db_total: 5 } };
const linked = { matched: true, link_confirmed: true, edition: { id: 9, title: 'Bestätigt' }, gaps: [], discrepancy: { official_total: 3, db_total: 5 } };

describe('useMpGaps', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('confirm', vi.fn(() => true));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a slower earlier gap check does not overwrite a later one', async () => {
    const f = deferredFetch();
    vi.stubGlobal('fetch', f.fn);
    const { result } = renderHook(() => useMpGaps(baseProps()));
    act(() => { result.current.fetchMpGaps(); });
    act(() => { result.current.fetchMpGaps(9, true); });
    await act(async () => f.calls[1].resolve(json(200, linked)));
    await act(async () => f.calls[0].resolve(json(200, guessed)));
    expect(result.current.mpGapData.edition.id).toBe(9);
    expect(result.current.mpGapLoading).toBe(false);
  });

  it('switching series clears the old data and ignores its late answer', async () => {
    const f = deferredFetch();
    vi.stubGlobal('fetch', f.fn);
    const { result, rerender } = renderHook((props) => useMpGaps(props), { initialProps: baseProps() });
    await act(async () => {
      const p = result.current.fetchMpGaps();
      f.calls[0].resolve(json(200, linked));
      await p;
    });
    expect(result.current.mpGapData.edition.id).toBe(9);

    act(() => { result.current.fetchMpGaps(); });
    rerender(baseProps({ id: '2' }));
    expect(result.current.mpGapData).toBe(null);
    await act(async () => f.calls[1].resolve(json(200, guessed)));
    expect(result.current.mpGapData).toBe(null);
    expect(result.current.mpGapLoading).toBe(false);
  });

  it('a failed gap check is reported instead of silently keeping the old state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(503, { error: 'Manga Passion ist gerade nicht erreichbar' })));
    const { result } = renderHook(() => useMpGaps(baseProps()));
    await act(async () => { await result.current.fetchMpGaps(); });
    expect(result.current.mpGapError).toMatch(/nicht erreichbar/);
    expect(result.current.mpGapNotice).toMatch(/nicht erreichbar/);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await act(async () => { await result.current.fetchMpGaps(); });
    expect(result.current.mpGapError).toMatch(/Netzwerkfehler/);
  });

  it('does not import gaps or fix the volume count from an unconfirmed edition', async () => {
    const fetchMock = vi.fn(async () => json(200, { ...guessed, gaps: [{ volume_number: '2', type: 'volume', price: 7 }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useMpGaps(baseProps()));
    await act(async () => { await result.current.fetchMpGaps(); });
    expect(result.current.detectedGaps).toEqual([2]);
    fetchMock.mockClear();
    await act(async () => { await result.current.handleBatchFillGaps('Fehlt'); });
    await act(async () => { await result.current.handleSyncTotalVolumes(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toasts.messages('error')).toHaveLength(2);
    expect(toasts.messages('error')[0]).toMatch(/Geraten/);
    expect(result.current.gapEditionUnconfirmed).toBe(true);
    expect(result.current.canSyncVolumeCount).toBe(false);
  });

  it('"Bandzahl anpassen" on a confirmed edition keeps the series status', async () => {
    const fetchMock = vi.fn(async (url) => (String(url).includes('sync-edition') ? json(200, { success: true }) : json(200, linked)));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useMpGaps(baseProps()));
    await act(async () => { await result.current.fetchMpGaps(); });
    await act(async () => { await result.current.handleSyncTotalVolumes(); });
    const sync = fetchMock.mock.calls.find(([url]) => String(url).includes('sync-edition'));
    expect(JSON.parse(sync[1].body)).toEqual({ edition_id: 9, update_total_volumes: true, update_status: false, update_publisher: false });
  });

  it('picking an edition links it with its status and closes the dialog', async () => {
    const fetchMock = vi.fn(async (url) => (String(url).includes('sync-edition') ? json(200, { success: true }) : json(200, linked)));
    vi.stubGlobal('fetch', fetchMock);
    const props = baseProps();
    const { result } = renderHook(() => useMpGaps(props));
    await act(async () => { await result.current.handleSelectMpEdition({ id: 9 }); });
    const sync = fetchMock.mock.calls.find(([url]) => String(url).includes('sync-edition'));
    expect(JSON.parse(sync[1].body).update_status).toBe(true);
    expect(props.setShowMpEditionModal).toHaveBeenCalledWith(false);
    await waitFor(() => expect(result.current.mpGapData?.edition?.id).toBe(9));
  });

  it('batch import sends the confirmed edition and the regular gaps', async () => {
    const data = { ...linked, gaps: [{ volume_number: '2', type: 'volume', price: 7 }, { volume_number: '2', type: 'special_edition', price: 25 }] };
    const fetchMock = vi.fn(async (url) => (String(url).includes('batch-import') ? json(200, { success: true }) : json(200, data)));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useMpGaps(baseProps()));
    await act(async () => { await result.current.fetchMpGaps(); });
    expect(result.current.mpGapMap.get('2').price).toBe(7);
    await act(async () => { await result.current.handleBatchFillGaps('Fehlt'); });
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('batch-import'));
    expect(JSON.parse(call[1].body).edition_id).toBe(9);
    expect(globalThis.confirm.mock.calls[0][0]).toMatch(/Bestätigt/);
  });

  it('a gap check may take minutes (a cold edition pages through Manga Passion)', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(() => new Promise(() => {}));
      vi.stubGlobal('fetch', fetchMock);
      const { result } = renderHook(() => useMpGaps(baseProps()));
      act(() => { result.current.fetchMpGaps(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
      expect(result.current.mpGapLoading).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a gap import that outlives the client timeout reloads the server state instead of inviting a second import', async () => {
    vi.useFakeTimers();
    try {
      const data = { ...linked, gaps: [{ volume_number: '2', type: 'volume' }] };
      let gapChecks = 0;
      const fetchMock = vi.fn((url, init) => {
        if (String(url).includes('batch-import')) {
          return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
        }
        gapChecks += 1;
        return Promise.resolve(json(200, data));
      });
      vi.stubGlobal('fetch', fetchMock);
      const props = baseProps();
      const { result } = renderHook(() => useMpGaps(props));
      await act(async () => { await result.current.fetchMpGaps(); });
      let pending;
      act(() => { pending = result.current.handleBatchFillGaps('Fehlt'); });
      const importCall = fetchMock.mock.calls.find(([url]) => String(url).includes('batch-import'));
      await act(async () => { await vi.advanceTimersByTimeAsync(TIMEOUTS.long - 1000); });
      expect(importCall[1].signal.aborted).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); await pending; });
      expect(toasts.messages('error')).toEqual([LONG_JOB_TIMEOUT_TEXT]);
      expect(props.fetchManga).toHaveBeenCalledTimes(1);
      expect(gapChecks).toBe(2);
      expect(result.current.fillingGapLoading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
