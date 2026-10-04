// useMpGaps gap autofill: confirm text, request body and result handling.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useMpGaps, { gapFillConfirmText, LONG_JOB_TIMEOUT_TEXT } from '../hooks/useMpGaps';
import { TIMEOUTS } from '../utils/api';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

let toasts;
beforeEach(() => { toasts = recordToasts(); });
afterEach(() => { toasts.stop(); });

const json = (status, body) => fakeResponse(status, body);

const guessed = { matched: true, link_confirmed: false, edition: { id: 7, title: 'Geraten' }, gaps: [] };
const NEEDS_CONFIRMATION = {
  success: false, needs_confirmation: true, updated_count: 0,
  message: 'Die passende Manga-Passion-Edition ist nicht eindeutig. Bitte zuerst mit „Edition bestätigen“ bestätigen.'
};

const props = (overrides = {}) => ({
  id: '1', canEdit: true, volumes: [], manga: { total_volumes: 3 },
  fetchManga: vi.fn(async () => {}), setShowMpEditionModal: vi.fn(), ...overrides
});

async function withGapData(fetchMock, data) {
  vi.stubGlobal('fetch', fetchMock);
  const hook = renderHook(() => useMpGaps(props()));
  await act(() => hook.result.current.fetchMpGaps());
  expect(hook.result.current.mpGapData).toEqual(data);
  return hook;
}

describe('useMpGaps: autofill of an unconfirmed edition', () => {
  beforeEach(() => {
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers to confirm the suggested edition, links it and then fills the volumes', async () => {
    let autofills = 0;
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('/gaps')) return json(200, guessed);
      if (url.endsWith('/sync-edition')) return json(200, { success: true });
      if (url.endsWith('/autofill-volumes')) {
        autofills++;
        return json(200, autofills === 1 ? NEEDS_CONFIRMATION : { success: true, updated_count: 3, total_user_volumes: 4 });
      }
      return json(404, {});
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    const { result } = await withGapData(fetchMock, guessed);

    await act(() => result.current.handleBatchAutofillManga());

    const autofillBodies = fetchMock.mock.calls.filter(([url]) => url.endsWith('/autofill-volumes')).map(([, init]) => JSON.parse(init.body));
    expect(autofillBodies).toEqual([{}, {}]);
    const sync = fetchMock.mock.calls.find(([url]) => url.endsWith('/sync-edition'));
    expect(JSON.parse(sync[1].body).edition_id).toBe(7);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1][0]).toMatch(/Edition „Geraten“ jetzt bestätigen/);
    expect(toasts.messages('success')).toContainEqual(expect.stringMatching(/3 von 4 Bänden/));
    expect(result.current.batchAutofilling).toBe(false);
  });

  it('declining the confirmation links nothing and fills nothing', async () => {
    const fetchMock = vi.fn(async (url) => (url.includes('/gaps') ? json(200, guessed) : json(200, NEEDS_CONFIRMATION)));
    vi.stubGlobal('confirm', vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false));
    const { result } = await withGapData(fetchMock, guessed);

    await act(() => result.current.handleBatchAutofillManga());

    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/sync-edition'))).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/autofill-volumes'))).toHaveLength(1);
    expect(toasts.messages('error')).toEqual([]);
  });

  it('without a suggested edition the server text is shown', async () => {
    const none = { matched: false, gaps: [] };
    const fetchMock = vi.fn(async (url) => (url.includes('/gaps') ? json(200, none) : json(200, NEEDS_CONFIRMATION)));
    vi.stubGlobal('confirm', vi.fn(() => true));
    const { result } = await withGapData(fetchMock, none);

    await act(() => result.current.handleBatchAutofillManga());

    expect(toasts.messages('error')).toContainEqual(NEEDS_CONFIRMATION.message);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe('gapFillConfirmText', () => {
  it('names a single gap in the singular', () => {
    expect(gapFillConfirmText(['4'], 'Fehlt')).toBe("Den fehlenden Band 4 auf Status 'Fehlt' erfassen?");
    expect(gapFillConfirmText(['4', '5'], 'Vorbestellt', 'Testreihe'))
      .toBe("2 fehlende Bände auf Status 'Vorbestellt' erfassen? Preise, Termine und Cover kommen aus der Manga-Passion-Edition „Testreihe“.");
  });
});

describe('useMpGaps: autofill timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('an autofill the client stopped waiting for reloads the series instead of reporting a plain error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const p = props();
    const { result } = renderHook(() => useMpGaps(p));
    let pending;
    act(() => { pending = result.current.handleBatchAutofillManga(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(TIMEOUTS.long); await pending; });
    expect(toasts.messages('error')).toEqual([LONG_JOB_TIMEOUT_TEXT]);
    expect(p.fetchManga).toHaveBeenCalledTimes(1);
    expect(result.current.batchAutofilling).toBe(false);
  });
});
