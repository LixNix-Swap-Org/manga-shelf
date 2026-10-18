// The shelf chosen in the collection toolbar: stored per server and account, reset with the other filters, shown as a
// removable badge on the screens it narrows (statistics, trash, shopping list, radar), and the shared shelf list.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  clearShelves, invalidateShelves, readShelfFilter, shelfFilterKey, shelfQuery, writeShelfFilter
} from '../utils/shelfScope';
import { useShelves } from '../hooks/useShelfViewer';
import useCollectionFilters from '../hooks/useCollectionFilters';
import useShoppingList from '../hooks/useShoppingList';
import CollectionToolbar from '../components/dashboard/CollectionToolbar';
import ShelfScopeBadge from '../components/common/ShelfScopeBadge';
import StatsModal from '../components/modals/StatsModal';
import TrashModal from '../components/modals/TrashModal';
import ShoppingListView from '../components/dashboard/ShoppingListView';
import ReleaseRadarView from '../components/dashboard/ReleaseRadarView';
import { normalizePubName } from '../utils/volumeHelpers';
import { setActiveBase } from '../app/connection';
import { resetOutbox } from '../utils/outbox';
import { clearDataCache } from '../utils/dataCache';
import { fakeResponse } from './fakeResponse';

const SHELVES = [
  { id: 1, name: 'Familie', role: 'owner', is_default: true },
  { id: 3, name: 'Zweites', role: 'viewer', is_default: false }
];

let routes;
let fetchMock;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearShelves();
  clearDataCache();
  resetOutbox();
  routes = { '/api/shelves': () => fakeResponse(200, { shelves: SHELVES }) };
  fetchMock = vi.fn(async (url) => {
    const path = String(url);
    const route = Object.keys(routes).find((key) => path === key || path.startsWith(`${key}?`));
    return route ? routes[route](path) : fakeResponse(404, { error: 'unbekannt' });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const requested = (prefix) => fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith(prefix));

describe('stored shelf filter', () => {
  it('is kept per account; the device-wide key of older builds is dropped; anything but a shelf id means every shelf', () => {
    localStorage.setItem('mangashelf_shelf_filter', '3');
    expect(readShelfFilter(1)).toBe('ALL');
    writeShelfFilter(1, '3');
    expect(readShelfFilter(1)).toBe('3');
    expect(readShelfFilter(2)).toBe('ALL');
    expect(localStorage.getItem('mangashelf_shelf_filter')).toBeNull();
    expect(shelfFilterKey(1)).not.toBe(shelfFilterKey(2));
    writeShelfFilter(1, 'ALL');
    expect(localStorage.getItem(shelfFilterKey(1))).toBeNull();
    localStorage.setItem(shelfFilterKey(1), '0');
    expect(readShelfFilter(1)).toBe('ALL');
    localStorage.setItem(shelfFilterKey(1), '1; DROP');
    expect(readShelfFilter(1)).toBe('ALL');
  });

  it('is kept per server as well', () => {
    vi.stubEnv('VITE_APP_MODE', 'app');
    try {
      setActiveBase('https://a.example.org');
      writeShelfFilter(1, '3');
      setActiveBase('https://b.example.org');
      expect(readShelfFilter(1)).toBe('ALL');
      setActiveBase('https://a.example.org');
      expect(readShelfFilter(1)).toBe('3');
    } finally {
      setActiveBase('');
    }
  });

  it('shelfQuery builds the parameter only for a shelf id', () => {
    expect(shelfQuery('3')).toBe('?shelf_id=3');
    expect(shelfQuery(3, '&')).toBe('&shelf_id=3');
    expect(shelfQuery('ALL')).toBe('');
    expect(shelfQuery(null)).toBe('');
  });
});

describe('useCollectionFilters: shelf', () => {
  const mangas = [
    { id: 1, title: 'Naruto', status: 'Laufend', shelf_id: 1 },
    { id: 2, title: 'Frieren', status: 'Laufend', shelf_id: 1 },
    { id: 3, title: 'Dandadan', status: 'Laufend', shelf_id: 3 }
  ];

  it('another account on this device starts with every shelf; switching back restores the own choice', async () => {
    const { result, rerender } = renderHook(({ userId }) => useCollectionFilters(mangas, { userId }), { initialProps: { userId: 1 } });
    await waitFor(() => expect(result.current.availableShelves.map((s) => s.name)).toEqual(['Familie', 'Zweites']));
    act(() => result.current.setShelfFilter('3'));
    expect(result.current.filtered.map((m) => m.title)).toEqual(['Dandadan']);
    expect(localStorage.getItem(shelfFilterKey(1))).toBe('3');

    rerender({ userId: 2 });
    expect(result.current.shelfFilter).toBe('ALL');
    expect(result.current.filtered).toHaveLength(3);
    rerender({ userId: 1 });
    expect(result.current.shelfFilter).toBe('3');
  });

  it('a shelf the list does not know yet makes it load again (new or renamed shelf)', async () => {
    const { result, rerender } = renderHook(({ rows }) => useCollectionFilters(rows, { userId: 1 }), { initialProps: { rows: mangas } });
    await waitFor(() => expect(result.current.availableShelves).toHaveLength(2));
    expect(requested('/api/shelves')).toHaveLength(1);
    routes['/api/shelves'] = () => fakeResponse(200, { shelves: [...SHELVES, { id: 5, name: 'Kinderregal', role: 'owner' }] });
    rerender({ rows: [...mangas, { id: 4, title: 'Yotsuba', status: 'Laufend', shelf_id: 5 }] });
    await waitFor(() => expect(result.current.availableShelves.map((s) => s.name)).toContain('Kinderregal'));
    expect(requested('/api/shelves')).toHaveLength(2);
  });
});

describe('shared shelf list', () => {
  it('one request for every reader; invalidateShelves loads it again', async () => {
    const first = renderHook(() => useShelves(1));
    const second = renderHook(() => useShelves(1));
    await waitFor(() => expect(second.result.current).toEqual(SHELVES));
    expect(first.result.current).toEqual(SHELVES);
    expect(requested('/api/shelves')).toHaveLength(1);
    routes['/api/shelves'] = () => fakeResponse(200, { shelves: [SHELVES[0]] });
    act(() => invalidateShelves());
    await waitFor(() => expect(first.result.current).toEqual([SHELVES[0]]));
    expect(requested('/api/shelves')).toHaveLength(2);
    expect(renderHook(() => useShelves(1, false)).result.current).toBeNull();
  });
});

describe('CollectionToolbar: Zurücksetzen', () => {
  it('resets the shelf filter with the others', () => {
    const setShelfFilter = vi.fn();
    render(
      <CollectionToolbar
        availablePublishers={[]} filterCounts={{ ALL: 3 }} filtered={[]} publisherFilter="ALL" search=""
        setPublisherFilter={vi.fn()} setSearch={vi.fn()} setSortBy={vi.fn()} setStatusFilter={vi.fn()} setViewMode={vi.fn()}
        sortBy="title_asc" statusFilter="ALL" viewMode="grid"
        availableShelves={[{ id: 1, name: 'Familie', count: 2 }, { id: 3, name: 'Zweites', count: 1 }]}
        shelfFilter="3" setShelfFilter={setShelfFilter}
      />
    );
    expect(screen.getByLabelText('Regal filtern').value).toBe('3');
    fireEvent.click(screen.getByRole('button', { name: 'Filter und Suche zurücksetzen' }));
    expect(setShelfFilter).toHaveBeenCalledWith('ALL');
  });
});

describe('ShelfScopeBadge', () => {
  it('names the shelf, its button shows every shelf again; without a name nothing renders', () => {
    const onClear = vi.fn();
    const { container, rerender } = render(<ShelfScopeBadge name="Zweites" onClear={onClear} />);
    expect(container.textContent).toBe('Regal: Zweites');
    fireEvent.click(screen.getByRole('button', { name: 'Alle Regale anzeigen' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    rerender(<ShelfScopeBadge name={null} onClear={onClear} />);
    expect(container.innerHTML).toBe('');
  });
});

const statsBody = {
  summary: { total_series: 1, completed_series: 0, total_owned_volumes: 1, total_missing_volumes: 0, total_owned_value: 7, total_possible_value: 7 },
  publishers: [],
  user_reading_stats: [{ user_id: 1, username: 'anna', role: 'admin', read_count: 1, unread_count: 0, total_owned: 1, read_pct: 100 }],
  owner_stats: [],
  top_series: [],
  spending: { by_year: [], by_month: [], year_only: { volumes: 0, total: 0 }, without_date: { volumes: 0, total: 0 } }
};

describe('screens narrowed by the shelf', () => {
  it('StatsModal: asks for the shelf, names it, clears it; the reading history follows; a 404 drops the shelf', async () => {
    routes['/api/stats'] = () => fakeResponse(200, statsBody);
    routes['/api/stats/reading'] = () => fakeResponse(200, {
      user: { id: 1, username: 'anna' }, months: 1, by_month: [{ month: '2026-10', volumes: 0, pages: 0, series: 0 }],
      backlog_by_month: [{ month: '2026-10', owned: 1, read: 1, backlog: 0 }], this_year: { year: 2026, volumes: 0, pages: 0 },
      last_year: { year: 2025, volumes: 0, pages: 0 }, streak: { longest: 0, longest_end: null, current: 0 }, unknown_date: 0, continue_reading: []
    });
    const onClearShelf = vi.fn();
    const onShelfMissing = vi.fn();
    const ui = (shelfId, shelfName) => (
      <MemoryRouter>
        <StatsModal isOpen onClose={vi.fn()} user={{ id: 1, role: 'admin' }} shelfId={shelfId} shelfName={shelfName} onClearShelf={onClearShelf} onShelfMissing={onShelfMissing} />
      </MemoryRouter>
    );
    const { rerender } = render(ui('3', 'Zweites'));
    const dialog = await screen.findByRole('dialog', { name: /Statistik- & Finanz-Dashboard/ });
    expect(within(dialog).getByText('Regal: Zweites')).toBeTruthy();
    await waitFor(() => expect(requested('/api/stats?')).toEqual(['/api/stats?shelf_id=3']));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Alle Regale anzeigen' }));
    expect(onClearShelf).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole('button', { name: /Leseverlauf/ }));
    await waitFor(() => expect(requested('/api/stats/reading')).toEqual(['/api/stats/reading?user_id=1&shelf_id=3']));

    rerender(ui(null, null));
    await waitFor(() => expect(requested('/api/stats').filter((u) => u === '/api/stats')).toHaveLength(1));
    expect(screen.queryByText('Regal: Zweites')).toBeNull();

    routes['/api/stats'] = (path) => (path.includes('shelf_id') ? fakeResponse(404, { error: 'Regal nicht gefunden' }) : fakeResponse(200, statsBody));
    rerender(ui('9', '#9'));
    await waitFor(() => expect(onShelfMissing).toHaveBeenCalledTimes(1));
  });

  it('TrashModal: lists the shelf only, names it; a 404 drops the shelf', async () => {
    routes['/api/trash'] = (path) => (path.includes('shelf_id=9') ? fakeResponse(404, { error: 'Regal nicht gefunden' }) : fakeResponse(200, { items: [], retention_days: 30 }));
    const onShelfMissing = vi.fn();
    const { rerender } = render(<TrashModal onClose={vi.fn()} user={{ id: 1, role: 'editor' }} shelfId="3" shelfName="Zweites" onClearShelf={vi.fn()} onShelfMissing={onShelfMissing} />);
    expect(await screen.findByText('Regal: Zweites')).toBeTruthy();
    await waitFor(() => expect(requested('/api/trash')).toEqual(['/api/trash?shelf_id=3']));
    rerender(<TrashModal onClose={vi.fn()} user={{ id: 1, role: 'editor' }} shelfId="9" shelfName="#9" onClearShelf={vi.fn()} onShelfMissing={onShelfMissing} />);
    await waitFor(() => expect(onShelfMissing).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shopping list and radar name the shelf with a way back to every shelf', () => {
    const onClearShelf = vi.fn();
    render(
      <MemoryRouter>
        <ShoppingListView
          shoppingData={{ total_missing: 0, total_cost: 0, publishers: [], items: [], others: [] }} loadingShopping={false}
          fetchShoppingList={vi.fn()} fetchMangas={vi.fn()} isOfflineMode={false} offlineLastUpdated={null}
          syncPendingPurchases={vi.fn(async () => null)} shoppingSearch="" setShoppingSearch={vi.fn()}
          shoppingPublisherFilter="ALL" setShoppingPublisherFilter={vi.fn()} normalizePubName={normalizePubName}
          setActiveMainView={vi.fn()} canEdit handleQuickBuy={vi.fn()} buyingId={null}
          shelfName="Zweites" onClearShelf={onClearShelf}
        />
      </MemoryRouter>
    );
    expect(screen.getByText('Regal: Zweites')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Alle Regale anzeigen' }));
    expect(onClearShelf).toHaveBeenCalledTimes(1);
  });

  it('the personal radar names the shelf; the Manga Passion calendar does not follow it', () => {
    const months = Array.from({ length: 12 }, (_, i) => `Monat ${i + 1}`);
    const radar = (radarSubView) => (
      <MemoryRouter>
        <ReleaseRadarView
          radarSubView={radarSubView} setRadarSubView={vi.fn()} radarData={{ total_releases: 0, groups: [], publishers: [] }}
          loadingRadar={false} radarError={null} fetchReleaseRadar={vi.fn()} radarPublisherFilter="ALL" setRadarPublisherFilter={vi.fn()}
          radarStatusFilter="ALL" setRadarStatusFilter={vi.fn()} radarSearch="" setRadarSearch={vi.fn()} mpData={null} loadingMp={false}
          mpError={null} fetchMangaPassionReleases={vi.fn()} mpYear={2026} setMpYear={vi.fn()} mpMonth={10} setMpMonth={vi.fn()}
          handlePrevMonth={vi.fn()} handleNextMonth={vi.fn()} handleCurrentMonth={vi.fn()} mpPrintOnly setMpPrintOnly={vi.fn()}
          mpMySeriesOnly={false} setMpMySeriesOnly={vi.fn()} mpPublisherFilter="ALL" setMpPublisherFilter={vi.fn()} mpSearch=""
          setMpSearch={vi.fn()} canEdit handleImportMangaPassion={vi.fn()} handleMarkDelivered={vi.fn(async () => true)}
          GERMAN_MONTHS={months} shelfName="Zweites" onClearShelf={vi.fn()}
        />
      </MemoryRouter>
    );
    const { rerender } = render(radar('personal'));
    expect(screen.getByText('Regal: Zweites')).toBeTruthy();
    rerender(radar('passion'));
    expect(screen.queryByText('Regal: Zweites')).toBeNull();
  });

  it('useShoppingList: a shelf-scoped list is never stored as the offline copy; a 404 drops the shelf', async () => {
    routes['/api/shopping-list'] = (path) => (path.includes('shelf_id=9')
      ? fakeResponse(404, { error: 'Regal nicht gefunden' })
      : fakeResponse(200, { total_missing: 1, total_cost: 7, publishers: [], items: [{ id: 1, manga_id: 9, manga_title: 'Berserk', volume_number: '1', price: 7 }], others: [] }));
    const onShelfMissing = vi.fn();
    const props = { user: { id: 1 }, setNetworkOffline: vi.fn(), fetchMangas: vi.fn(), shelfFilter: '3', onShelfMissing };
    const { result, rerender } = renderHook((p) => useShoppingList(p), { initialProps: props });
    await act(() => result.current.fetchShoppingList());
    expect(requested('/api/shopping-list')).toEqual(['/api/shopping-list?include_others=1&shelf_id=3']);
    expect(result.current.shoppingData.items).toHaveLength(1);
    expect(localStorage.getItem('mangashelf_shopping_cache')).toBeNull();

    rerender({ ...props, shelfFilter: 'ALL' });
    await act(() => result.current.fetchShoppingList());
    expect(JSON.parse(localStorage.getItem('mangashelf_shopping_cache')).items).toHaveLength(1);

    rerender({ ...props, shelfFilter: '9' });
    await act(() => result.current.fetchShoppingList());
    expect(onShelfMissing).toHaveBeenCalledTimes(1);
    expect(result.current.shoppingError).toBeNull();
  });
});
