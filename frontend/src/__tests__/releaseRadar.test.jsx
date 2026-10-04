import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StrictMode } from 'react';
import useReleaseRadar from '../hooks/useReleaseRadar';
import ReleaseRadarView from '../components/dashboard/ReleaseRadarView';
import MpMonthNav from '../components/dashboard/radar/MpMonthNav';
import MpTimeline, { isDroppedSeries } from '../components/dashboard/radar/MpTimeline';
import RadarTabs from '../components/dashboard/radar/RadarTabs';
import PersonalTimeline from '../components/dashboard/radar/PersonalTimeline';
import PersonalSummary from '../components/dashboard/radar/PersonalSummary';
import PersonalFilters from '../components/dashboard/radar/PersonalFilters';
import { GERMAN_MONTHS } from '../utils/collectionHelpers';
import { groupMpItemsByDate, localISODate } from '../utils/radarHelpers';
import { fakeResponse, htmlResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

let toasts;
beforeEach(() => { toasts = recordToasts(); });
afterEach(() => { toasts.stop(); });

const json = (body, status = 200) => fakeResponse(status, body);
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

const hookProps = (over = {}) => ({
  canEdit: true, activeMainView: 'shelf', fetchMangas: vi.fn(async () => {}), fetchShoppingList: vi.fn(async () => {}), ...over
});
const callsTo = (fetchMock, part) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part));

describe('useReleaseRadar', () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('fetchReleaseRadar: an older response arriving last is dropped, loading ends with the newest', async () => {
    const first = deferred();
    const second = deferred();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useReleaseRadar(hookProps()));

    let p1, p2;
    act(() => { p1 = result.current.fetchReleaseRadar(); });
    act(() => { p2 = result.current.fetchReleaseRadar(); });
    await act(async () => { first.resolve(json({ total_releases: 1, publishers: [] })); await p1; });
    expect(result.current.radarData).toBe(null);
    expect(result.current.loadingRadar).toBe(true);

    await act(async () => { second.resolve(json({ total_releases: 2, publishers: [] })); await p2; });
    expect(result.current.radarData.total_releases).toBe(2);
    expect(result.current.loadingRadar).toBe(false);
  });

  it('a newer radar or month request aborts the older one, unmount aborts both', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { result, unmount } = renderHook(() => useReleaseRadar(hookProps()));
    act(() => { result.current.fetchReleaseRadar(); });
    act(() => { result.current.fetchReleaseRadar(); });
    act(() => { result.current.fetchMangaPassionReleases(2026, 3); });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(false);
    unmount();
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(true);
  });

  it('fetchReleaseRadar: a failed refresh keeps the loaded data and reports the error', async () => {
    fetchMock.mockResolvedValueOnce(json({ total_releases: 1, publishers: [] }));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useReleaseRadar(hookProps()));
    await act(() => result.current.fetchReleaseRadar());
    await act(() => result.current.fetchReleaseRadar());
    expect(result.current.radarData.total_releases).toBe(1);
    expect(result.current.radarError).toMatch(/nicht geladen/);

    fetchMock.mockResolvedValueOnce(json({ error: 'Fehler beim Laden des Release-Radars' }, 500));
    await act(() => result.current.fetchReleaseRadar());
    expect(result.current.radarError).toBe('Fehler beim Laden des Release-Radars');
  });

  it('a failed month shows the server error, keeps mpData null and is not retried by the effect', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Fehler beim Abrufen der Manga-Passion-Neuerscheinungen' }, 500));
    const { result } = renderHook(() => useReleaseRadar(hookProps({ activeMainView: 'radar' })));
    await flush();
    await flush();
    expect(result.current.mpError).toBe('Fehler beim Abrufen der Manga-Passion-Neuerscheinungen');
    expect(result.current.mpData).toBe(null);
    expect(result.current.loadingMp).toBe(false);
    expect(callsTo(fetchMock, '/manga-passion/releases')).toHaveLength(1);

    // a proxy error page without JSON still gives a message; the manual retry is allowed
    fetchMock.mockResolvedValueOnce(htmlResponse(502));
    await act(() => result.current.fetchMangaPassionReleases(result.current.mpYear, result.current.mpMonth));
    expect(result.current.mpError).toBe('Neuerscheinungen konnten nicht geladen werden');
    expect(callsTo(fetchMock, '/manga-passion/releases')).toHaveLength(2);
  });

  it('a cold month is not cut off by the 15 s read timeout (the server pages through Manga Passion)', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(() => new Promise(() => {}));
      const { result } = renderHook(() => useReleaseRadar(hookProps()));
      act(() => { result.current.fetchMangaPassionReleases(2026, 10); });
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      const [, init] = callsTo(fetchMock, '/manga-passion/releases?year=2026&month=10')[0];
      expect(init.signal.aborted).toBe(false);
      expect(result.current.mpError).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offline: nothing is fetched', async () => {
    const { result } = renderHook(() => useReleaseRadar(hookProps({ activeMainView: 'radar', offline: true })));
    await flush();
    await act(() => result.current.fetchReleaseRadar());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('months answered out of order: the later selection wins', async () => {
    const a = deferred();
    const b = deferred();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result } = renderHook(() => useReleaseRadar(hookProps()));
    let pa, pb;
    act(() => { pa = result.current.fetchMangaPassionReleases(2026, 5); });
    act(() => { pb = result.current.fetchMangaPassionReleases(2026, 6); });
    await act(async () => { b.resolve(json({ year: 2026, month: 6, items: [], publishers: [] })); await pb; });
    await act(async () => { a.resolve(json({ year: 2026, month: 5, items: [], publishers: [] })); await pa; });
    expect(result.current.mpData.month).toBe(6);
    expect(result.current.loadingMp).toBe(false);
  });

  it('a publisher missing from the new month resets the filter, a present one (any case) stays', async () => {
    fetchMock.mockResolvedValue(json({ year: 2026, month: 6, items: [], publishers: [{ name: 'Carlsen', count: 2 }] }));
    const { result } = renderHook(() => useReleaseRadar(hookProps()));
    act(() => result.current.setMpPublisherFilter('carlsen'));
    await act(() => result.current.fetchMangaPassionReleases(2026, 6));
    expect(result.current.mpPublisherFilter).toBe('carlsen');
    act(() => result.current.setMpPublisherFilter('Kazé'));
    await act(() => result.current.fetchMangaPassionReleases(2026, 6));
    expect(result.current.mpPublisherFilter).toBe('ALL');

    act(() => result.current.setMpPublisherFilter('Kazé'));
    fetchMock.mockResolvedValueOnce(json({ error: 'x' }, 500));
    await act(() => result.current.fetchMangaPassionReleases(2026, 7));
    expect(result.current.mpPublisherFilter).toBe('Kazé');
  });

  it('handleMarkDelivered keeps a stored purchase date, uses the local day otherwise and refreshes the shopping list', async () => {
    const props = hookProps();
    fetchMock.mockResolvedValue(json({ success: true, publishers: [] }));
    const { result } = renderHook(() => useReleaseRadar(props));

    await act(() => result.current.handleMarkDelivered({ id: 5, status: 'Vorbestellt', purchase_date: '2026-08-01' }));
    const put1 = callsTo(fetchMock, '/api/volumes/5')[0][1];
    expect(JSON.parse(put1.body)).toEqual({ status: 'Vorhanden' });

    let ok;
    await act(async () => { ok = await result.current.handleMarkDelivered({ id: 6, status: 'Fehlt', purchase_date: null }); });
    expect(ok).toBe(true);
    expect(JSON.parse(callsTo(fetchMock, '/api/volumes/6')[0][1].body)).toEqual({ status: 'Vorhanden', purchase_date: localISODate() });
    expect(props.fetchShoppingList).toHaveBeenCalledTimes(2);
    expect(props.fetchMangas).toHaveBeenCalledTimes(2);
  });

  it('import: per-item busy ids, a second click on a running card is ignored', async () => {
    const importA = deferred();
    const importB = deferred();
    fetchMock.mockImplementation((url, opts) => {
      if (String(url).includes('/manga-passion/import')) {
        return JSON.parse(opts.body).mp_volume_id === 1 ? importA.promise : importB.promise;
      }
      return Promise.resolve(json({ year: 2026, month: 10, items: [], publishers: [] }));
    });
    const { result } = renderHook(() => useReleaseRadar(hookProps()));
    const itemA = { id: 1, title: 'A', volume_number: '1', publisher: 'Carlsen', date: '2026-10-02', type: 'volume', edition_id: 11 };
    const itemB = { id: 2, title: 'B', volume_number: '1', publisher: 'Carlsen', date: '2026-10-02', type: 'volume', edition_id: 12 };

    let pa, pb;
    act(() => { pa = result.current.handleImportMangaPassion(itemA); });
    act(() => { pb = result.current.handleImportMangaPassion(itemB); });
    act(() => { result.current.handleImportMangaPassion(itemA); });
    expect([...result.current.importingMpIds].sort()).toEqual([1, 2]);
    expect(callsTo(fetchMock, '/manga-passion/import')).toHaveLength(2);

    await act(async () => { importA.resolve(json({ success: true, manga_id: 7, volume_id: 70, status: 'Vorbestellt', series_created: true })); await pa; });
    expect(result.current.importingMpIds.has(1)).toBe(false);
    expect(result.current.importingMpIds.has(2)).toBe(true);
    await act(async () => { importB.resolve(json({ success: true, manga_id: 8, volume_id: 80, status: 'Vorbestellt' })); await pb; });
    expect(result.current.importingMpIds.size).toBe(0);
  });

  it('import: request body follows the import contract and the month is reloaded afterwards', async () => {
    const month = { year: 2026, month: 10, publishers: [], items: [
      { id: 1, title: 'Blue Lock – Episode Nagi', volume_number: '1', publisher: 'Kazé', date: '2026-10', type: 'volume', volume_title: null, edition_id: 5, is_digital: false, match_kind: 'prefix', user_manga_id: 3, in_collection: true },
      { id: 2, title: 'Blue Lock – Episode Nagi', volume_number: '2', publisher: 'Kazé', date: null, type: 'volume', edition_id: 5, is_digital: false, match_kind: 'prefix', user_manga_id: 3, in_collection: true }
    ] };
    fetchMock.mockImplementation((url) => (String(url).includes('/manga-passion/import')
      ? Promise.resolve(json({ success: true, manga_id: 9, volume_id: 90, status: 'Vorbestellt', series_created: true }))
      : Promise.resolve(json(month))));
    const { result } = renderHook(() => useReleaseRadar(hookProps()));
    await act(() => result.current.fetchMangaPassionReleases(2026, 10));

    let res;
    await act(async () => { res = await result.current.handleImportMangaPassion({ ...month.items[0], is_digital: true }, 'Fehlt'); });
    expect(res.manga_id).toBe(9);
    const body = JSON.parse(callsTo(fetchMock, '/manga-passion/import')[0][1].body);
    expect(body).toMatchObject({
      manga_id: null, title: 'Blue Lock – Episode Nagi', volume_number: '1', type: 'volume', mp_volume_id: 1,
      edition_id: null, release_date: '2026-10', target_status: 'Fehlt'
    });
    await flush();
    expect(callsTo(fetchMock, '/manga-passion/releases?year=2026&month=10')).toHaveLength(2);
  });

  it('prev / next stop at the supported years', async () => {
    fetchMock.mockResolvedValue(json({ items: [], publishers: [] }));
    const { result } = renderHook(() => useReleaseRadar(hookProps()));
    act(() => { result.current.setMpYear(2000); result.current.setMpMonth(1); });
    act(() => result.current.handlePrevMonth());
    expect(result.current.mpYear).toBe(2000);
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => result.current.handleNextMonth());
    expect([result.current.mpYear, result.current.mpMonth]).toEqual([2000, 2]);
    await flush();
  });
});

const monthNavProps = (over = {}) => ({
  mpData: { year: 2026, month: 10, print_count: 5, total_items: 7, user_series_count: 3, user_series_print_count: 2 },
  mpCurrent: true, loadingMp: false, fetchMangaPassionReleases: vi.fn(), mpYear: 2026, setMpYear: vi.fn(), mpMonth: 10,
  setMpMonth: vi.fn(), handlePrevMonth: vi.fn(), handleNextMonth: vi.fn(), handleCurrentMonth: vi.fn(), mpPrintOnly: true,
  GERMAN_MONTHS, ...over
});

describe('MpMonthNav', () => {
  it('disables both selects and the arrows while loading', () => {
    render(<MpMonthNav {...monthNavProps({ loadingMp: true })} />);
    expect(screen.getByLabelText('Monat').disabled).toBe(true);
    expect(screen.getByLabelText('Jahr').disabled).toBe(true);
    expect(screen.getByTitle('Nächster Monat').disabled).toBe(true);
  });

  it('shows a year outside the old fixed list and offers the way back to the current month', () => {
    const props = monthNavProps({ mpYear: 2023, mpMonth: 12, mpData: null, mpCurrent: false });
    render(<MpMonthNav {...props} />);
    expect(screen.getByLabelText('Jahr').value).toBe('2023');
    fireEvent.click(screen.getByText('Aktueller Monat'));
    expect(props.handleCurrentMonth).toHaveBeenCalled();
  });

  it('hides the current-month button on the current month and counts print entries of my series', () => {
    const now = new Date();
    render(<MpMonthNav {...monthNavProps({ mpYear: now.getFullYear(), mpMonth: now.getMonth() + 1 })} />);
    expect(screen.queryByText('Aktueller Monat')).toBe(null);
    expect(screen.getByText('Aus deinen Reihen').parentElement.textContent).toContain('2');
  });
});

describe('RadarTabs', () => {
  it('has short and full labels and no calendar count while the month is not loaded', () => {
    render(<RadarTabs radarSubView="passion" setRadarSubView={vi.fn()} radarData={null} mpCount={null} mpYear={2026} mpMonth={10} />);
    expect(screen.getByText('Neuheiten').className).toContain('lg:hidden');
    expect(screen.getByText('Deutsche Neuheiten (Manga Passion)').className).toContain('hidden lg:inline');
    expect(screen.getByText('Meine Vorbestellungen & Budget')).toBeTruthy();
    expect(screen.getByTitle('Deutsche Neuheiten (Manga Passion)').textContent).not.toMatch(/\d/);
  });
});

const card = (over) => ({
  id: 1, title: 'Berserk', volume_number: '42', publisher: 'Panini', date: '2026-10-02', price: 12, is_digital: false,
  in_collection: true, user_manga_id: 4, match_kind: 'exact', user_volume_status: null, ...over
});
const renderTimeline = (props) => render(
  <MemoryRouter>
    <MpTimeline
      loadingMp={false} mpError={null} onRetry={vi.fn()} mpYear={2026} mpMonth={10} canEdit onImport={vi.fn()}
      GERMAN_MONTHS={GERMAN_MONTHS} filtersActive={false} onResetFilters={vi.fn()}
      {...props}
      mpDateGroups={props.mpDateGroups ?? groupMpItemsByDate(props.mpData?.items || [])}
    />
  </MemoryRouter>
);

describe('MpTimeline', () => {
  it('a failed load shows the error with a retry, not the empty filter text', () => {
    const onRetry = vi.fn();
    renderTimeline({ mpData: null, mpError: 'Fehler beim Abrufen der Manga-Passion-Neuerscheinungen', onRetry });
    expect(screen.getByText('Fehler beim Abrufen der Manga-Passion-Neuerscheinungen')).toBeTruthy();
    expect(screen.queryByText(/mit den aktiven Filtern/)).toBe(null);
    fireEvent.click(screen.getByText('Erneut versuchen'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('a month that loaded empty shows the empty state', () => {
    renderTimeline({ mpData: { items: [] } });
    expect(screen.getByText('Keine Neuerscheinungen für diese Auswahl')).toBeTruthy();
  });

  it('status-aware cards: Bestellt has no import buttons, Erscheint bald keeps both, Gelesen is owned', () => {
    renderTimeline({ mpData: { items: [
      card({ id: 1, user_volume_status: 'Bestellt' }),
      card({ id: 2, volume_number: '43', user_volume_status: 'Erscheint bald' }),
      card({ id: 3, volume_number: '41', user_volume_status: 'Gelesen' })
    ] } });
    expect(screen.getByText('Bestellt')).toBeTruthy();
    expect(screen.getByText('Erscheint bald')).toBeTruthy();
    expect(screen.getByText('Gelesen')).toBeTruthy();
    expect(screen.getAllByText('Vorbestellen')).toHaveLength(1);
    expect(screen.getAllByLabelText('Auf die Einkaufsliste setzen')).toHaveLength(1);
  });

  it('month-only and unknown dates, busy card and truncated hint', () => {
    renderTimeline({
      mpData: { truncated: true, items: [card({ id: 1, date: '2026-11', in_collection: false, user_manga_id: null }), card({ id: 2, date: null })] },
      importingMpIds: new Set([1])
    });
    expect(screen.getByText('11.2026')).toBeTruthy();
    expect(screen.getByText('Datum offen')).toBeTruthy();
    expect(screen.getByText(/nicht alle Einträge/)).toBeTruthy();
    const buttons = screen.getAllByText('Vorbestellen').map(el => el.closest('button'));
    expect(buttons.map(b => b.disabled)).toEqual([true, false]);
  });
});

describe('MpTimeline: collecting status of the series', () => {
  it('a dropped series is greyed with "Nicht mehr gesammelt"; owned and ordered volumes keep their badge', () => {
    renderTimeline({ mpData: { items: [
      card({ id: 1, user_manga_collecting: 'abgebrochen' }),
      card({ id: 2, volume_number: '43', user_manga_collecting: 'abgebrochen', user_volume_status: 'Fehlt' }),
      card({ id: 3, volume_number: '41', user_manga_collecting: 'abgebrochen', user_volume_status: 'Vorbestellt' })
    ] } });
    const badges = screen.getAllByText('Nicht mehr gesammelt');
    expect(badges).toHaveLength(2);
    expect(screen.queryByText('Einkaufsliste')).toBeNull();
    expect(screen.getByText('Vorbestellt')).toBeTruthy();
    expect(badges[0].closest('.glass-card').className).toContain('opacity-60');
    expect(screen.getByText('Vorbestellt').closest('.glass-card').className).not.toContain('opacity-60');
    expect(isDroppedSeries(card({ match_kind: 'prefix', user_manga_collecting: null }))).toBe(false);
  });

  it('a missing volume of a paused series is not announced as on the shopping list', () => {
    renderTimeline({ mpData: { items: [card({ id: 1, user_manga_collecting: 'pausiert', user_volume_status: 'Fehlt' })] } });
    expect(screen.getByText('Pausiert')).toBeTruthy();
    expect(screen.queryByText('Einkaufsliste')).toBeNull();
  });
});

const radarItem = (over) => ({
  id: 1, manga_id: 4, manga_title: 'Berserk', volume_number: '42', effective_publisher: 'Panini', status: 'Vorbestellt',
  price: 8.5, release_date: '2026-11', countdown_label: 'Nächsten Monat', days_until: null, ...over
});
const renderPersonal = (props) => render(
  <MemoryRouter>
    <PersonalTimeline
      setRadarSubView={vi.fn()} loadingRadar={false} radarError={null} onRetry={vi.fn()} radarPublisherFilter="ALL"
      radarStatusFilter="ALL" radarSearch="" onResetFilters={vi.fn()} canEdit onMarkDelivered={vi.fn()}
      {...props}
    />
  </MemoryRouter>
);

describe('PersonalTimeline', () => {
  const data = { total_releases: 2, groups: [{ key: '2026-11', label: 'November 2026', items: [
    radarItem({}), radarItem({ id: 2, status: 'Fehlt', volume_number: '43', release_date: '2026-11-20' })
  ] }] };

  it('spinner on the first load, error panel when the first load fails', () => {
    const { unmount } = renderPersonal({ radarData: null, loadingRadar: true });
    expect(screen.getByRole('status').textContent).toBe('Lade deine Vorbestellungen...');
    expect(screen.queryByText(/Keine anstehenden/)).toBe(null);
    unmount();
    renderPersonal({ radarData: null, radarError: 'Server weg' });
    expect(screen.getByText('Server weg')).toBeTruthy();
    expect(screen.queryByText(/Keine anstehenden/)).toBe(null);
  });

  it('no-match panel when the filters hide every item, with a reset', () => {
    const onResetFilters = vi.fn();
    renderPersonal({ radarData: data, radarSearch: 'zzz', onResetFilters });
    expect(screen.getByText('Keine Bände für diese Filter')).toBeTruthy();
    fireEvent.click(screen.getByText('Filter zurücksetzen'));
    expect(onResetFilters).toHaveBeenCalled();
  });

  it('German month-only dates, Gekauft for unordered volumes, busy per item', () => {
    renderPersonal({ radarData: data, markingDeliveredIds: new Set([1]) });
    expect(screen.getByText('11.2026')).toBeTruthy();
    expect(screen.getByText('20.11.2026')).toBeTruthy();
    expect(screen.getByText('Geliefert').closest('button').disabled).toBe(true);
    expect(screen.getByText('Gekauft').closest('button').disabled).toBe(false);
  });

  it('a broken volume cover falls back to the series cover, without a shared failure map', () => {
    const item = radarItem({ vol_cover: '/uploads/dead.jpg', manga_cover: '/uploads/series.jpg' });
    renderPersonal({ radarData: { total_releases: 1, groups: [{ key: 'k', label: 'L', items: [item] }] } });
    const img = screen.getByAltText('Berserk');
    expect(img.getAttribute('loading')).toBe('lazy');
    fireEvent.error(img);
    expect(screen.getByAltText('Berserk').getAttribute('src')).toBe('/uploads/series.jpg');
    fireEvent.error(screen.getByAltText('Berserk'));
    expect(screen.queryByAltText('Berserk')).toBe(null);
  });

  it('one live region stays mounted from idle through loading to the list, empty until a load starts', () => {
    const base = {
      setRadarSubView: vi.fn(), radarError: null, onRetry: vi.fn(), radarPublisherFilter: 'ALL', radarStatusFilter: 'ALL',
      radarSearch: '', onResetFilters: vi.fn(), canEdit: true, onMarkDelivered: vi.fn()
    };
    const view = (props) => <MemoryRouter><PersonalTimeline {...base} {...props} /></MemoryRouter>;
    const { rerender } = render(view({ radarData: null, loadingRadar: false }));
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    rerender(view({ radarData: null, loadingRadar: true }));
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('Lade deine Vorbestellungen...');
    rerender(view({ radarData: data, loadingRadar: false }));
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('');
  });
});

describe('PersonalFilters', () => {
  it('the clear-search X is a named button that empties the search', () => {
    const setRadarSearch = vi.fn();
    render(<PersonalFilters radarData={{ publishers: [] }} radarPublisherFilter="ALL" setRadarPublisherFilter={vi.fn()}
      radarStatusFilter="ALL" setRadarStatusFilter={vi.fn()} radarSearch="berserk" setRadarSearch={setRadarSearch} />);
    const clear = screen.getByRole('button', { name: 'Suche löschen' });
    expect(clear.getAttribute('type')).toBe('button');
    fireEvent.click(clear);
    expect(setRadarSearch).toHaveBeenCalledWith('');
  });
});

describe('PersonalSummary', () => {
  it('shows a dash instead of 0,00 € while nothing is loaded', () => {
    render(<PersonalSummary radarData={null} loadingRadar={false} fetchReleaseRadar={vi.fn()} />);
    expect(screen.queryByText(/0,00/)).toBe(null);
    expect(screen.getAllByText('–').length).toBeGreaterThan(0);
  });
});

const viewProps = (over = {}) => ({
  radarSubView: 'personal', setRadarSubView: vi.fn(), radarData: { total_releases: 0, groups: [], publishers: [] },
  loadingRadar: false, radarError: null, fetchReleaseRadar: vi.fn(), radarPublisherFilter: 'ALL', setRadarPublisherFilter: vi.fn(),
  radarStatusFilter: 'ALL', setRadarStatusFilter: vi.fn(), radarSearch: '', setRadarSearch: vi.fn(), mpData: null, loadingMp: false,
  mpError: null, fetchMangaPassionReleases: vi.fn(), mpYear: 2026, setMpYear: vi.fn(), mpMonth: 10, setMpMonth: vi.fn(),
  handlePrevMonth: vi.fn(), handleNextMonth: vi.fn(), handleCurrentMonth: vi.fn(), mpPrintOnly: true, setMpPrintOnly: vi.fn(),
  mpMySeriesOnly: false, setMpMySeriesOnly: vi.fn(), mpPublisherFilter: 'ALL', setMpPublisherFilter: vi.fn(), mpSearch: '',
  setMpSearch: vi.fn(), canEdit: true, handleImportMangaPassion: vi.fn(), handleMarkDelivered: vi.fn(async () => true),
  GERMAN_MONTHS, ...over
});

describe('ReleaseRadarView', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ changes: [
      { volume_id: 9, manga_title: 'Berserk', volume_number: '5', type: 'special_edition', notes: 'Collectors Edition', stored_date: '2026-11-01', new_date: '2026-12' }
    ] })));
  });

  it('the import notice is announced through a status region that is always mounted', async () => {
    const handleImportMangaPassion = vi.fn(async () => ({ skipped_owned: true }));
    const props = viewProps({
      radarSubView: 'passion', handleImportMangaPassion,
      mpData: { year: 2026, month: 10, items: [card({ id: 1, user_volume_status: 'Erscheint bald' })], publishers: [] }
    });
    const { container } = render(<MemoryRouter><ReleaseRadarView {...props} /></MemoryRouter>);
    const region = container.querySelector('p.sr-only[role="status"]');
    expect(region.textContent).toBe('');
    fireEvent.click(screen.getByText('Vorbestellen'));
    await waitFor(() => expect(region.textContent).toMatch(/bereits im Regal/));
    expect(container.querySelector('p.sr-only[role="status"]')).toBe(region);
    fireEvent.click(screen.getByRole('button', { name: 'Hinweis schließen' }));
    expect(region.textContent).toBe('');
  });

  it('offline: a notice instead of empty lists, nothing fetched', () => {
    render(<MemoryRouter><ReleaseRadarView {...viewProps({ isOffline: true })} /></MemoryRouter>);
    expect(screen.getByText('Release-Radar ist offline nicht verfügbar')).toBeTruthy();
    expect(screen.queryByText(/Keine anstehenden/)).toBe(null);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('date changes load once per visit, use the volume display title and drop a delivered volume', async () => {
    const props = viewProps();
    const { rerender } = render(<MemoryRouter><ReleaseRadarView {...props} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Neue Termine bei Manga Passion/)).toBeTruthy());
    expect(screen.getByText(/Berserk – .*Collectors Edition/)).toBeTruthy();
    expect(screen.getByText('12.2026')).toBeTruthy();

    rerender(<MemoryRouter><ReleaseRadarView {...props} radarSubView="passion" /></MemoryRouter>);
    rerender(<MemoryRouter><ReleaseRadarView {...props} radarSubView="personal" /></MemoryRouter>);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('StrictMode: the aborted first load is repeated, so the date-change hint still appears', async () => {
    const body = { changes: [{ volume_id: 9, manga_title: 'Berserk', volume_number: '5', stored_date: '2026-11-01', new_date: '2026-12-01' }] };
    vi.stubGlobal('fetch', vi.fn((url, { signal } = {}) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(json(body)), 5);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      });
    })));
    render(<StrictMode><MemoryRouter><ReleaseRadarView {...viewProps()} /></MemoryRouter></StrictMode>);
    await waitFor(() => expect(screen.getByText(/Neue Termine bei Manga Passion/)).toBeTruthy());
    expect(fetch.mock.calls.filter(([url]) => url === '/api/release-radar/changes')).toHaveLength(2);
  });

  it('switching the sub-tab during the load repeats it on return; a finished load is not repeated', async () => {
    const props = viewProps();
    let release;
    vi.stubGlobal('fetch', vi.fn((url, { signal } = {}) => new Promise((resolve, reject) => {
      release = () => resolve(json({ changes: [] }));
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const { rerender } = render(<MemoryRouter><ReleaseRadarView {...props} /></MemoryRouter>);
    rerender(<MemoryRouter><ReleaseRadarView {...props} radarSubView="passion" /></MemoryRouter>);
    rerender(<MemoryRouter><ReleaseRadarView {...props} radarSubView="personal" /></MemoryRouter>);
    await act(async () => { release(); });
    rerender(<MemoryRouter><ReleaseRadarView {...props} radarSubView="passion" /></MemoryRouter>);
    rerender(<MemoryRouter><ReleaseRadarView {...props} radarSubView="personal" /></MemoryRouter>);
    await flush();
    expect(fetch.mock.calls.filter(([url]) => url === '/api/release-radar/changes')).toHaveLength(2);
  });
});
