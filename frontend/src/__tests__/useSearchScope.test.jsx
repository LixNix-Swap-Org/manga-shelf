// Covers the header search scope: the per-device setting, the typed-only online lookup and its wiring in the dashboard.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const state = vi.hoisted(() => ({ mangaList: null, localHits: new Map() }));

vi.mock('../utils/offlineStore', async (importOriginal) => ({
  ...(await importOriginal()),
  lookupLocalIsbn: vi.fn(async (isbn) => state.localHits.get(isbn) ?? null)
}));
vi.mock('../hooks/useMangaList', () => ({ default: () => state.mangaList }));
vi.mock('../hooks/useOfflineStatus', () => ({
  default: ({ user }) => ({
    networkOffline: false, setNetworkOffline: vi.fn(), isOfflineMode: Boolean(user?.offline), offlineCopyAt: null,
    refreshingCopy: false, refreshError: null, handleRefreshOfflineCopy: vi.fn()
  })
}));
vi.mock('../hooks/useShoppingList', () => ({
  default: () => ({
    shoppingData: null, loadingShopping: false, shoppingPublisherFilter: 'ALL', setShoppingPublisherFilter: vi.fn(),
    shoppingSearch: '', setShoppingSearch: vi.fn(), buyingIds: new Set(), offlineLastUpdated: null, cacheWriteFailed: false,
    pendingPurchases: 0, failedPurchases: [], fetchShoppingList: vi.fn(), handleQuickBuy: vi.fn(), syncPendingPurchases: vi.fn()
  })
}));
vi.mock('../hooks/useReleaseRadar', () => ({
  default: () => ({
    radarData: null, loadingRadar: false, radarError: null, radarPublisherFilter: 'ALL', setRadarPublisherFilter: vi.fn(),
    radarStatusFilter: 'ALL', setRadarStatusFilter: vi.fn(), radarSearch: '', setRadarSearch: vi.fn(),
    markingDeliveredIds: new Set(), radarSubView: 'passion', setRadarSubView: vi.fn(), mpYear: 2026, setMpYear: vi.fn(),
    mpMonth: 10, setMpMonth: vi.fn(), mpData: null, loadingMp: false, mpError: null, mpSearch: '', setMpSearch: vi.fn(),
    mpPublisherFilter: 'ALL', setMpPublisherFilter: vi.fn(), mpPrintOnly: true, setMpPrintOnly: vi.fn(), mpMySeriesOnly: false,
    setMpMySeriesOnly: vi.fn(), importingMpIds: new Set(), fetchReleaseRadar: vi.fn(), handleMarkDelivered: vi.fn(),
    fetchMangaPassionReleases: vi.fn(), handlePrevMonth: vi.fn(), handleNextMonth: vi.fn(), handleCurrentMonth: vi.fn(),
    handleImportMangaPassion: vi.fn()
  })
}));
vi.mock('../hooks/usePwaInstall', () => ({ default: () => ({ isInstallable: false, isInstalledApp: false, handleInstallClick: vi.fn() }) }));
vi.mock('../components/common/BarcodeScannerButton', () => ({
  default: ({ onDetected }) => <button type="button" onClick={() => onDetected('9783551000001')}>Scan-Test</button>
}));
vi.mock('../components/modals/AddMangaModal', () => ({
  default: ({ isOpen, prefill }) => (isOpen ? (
    <div role="dialog" aria-label="Anlegen">
      {prefill ? `Anlegen mit ${prefill.form.title} ${prefill.form.manga_passion_id ?? '-'} ${prefill.volume === null ? 'ohne Band' : 'mit Band'}` : 'Anlegen leer'}
    </div>
  ) : null)
}));

import useSearchScope, { SEARCH_SCOPE_KEY, ONLINE_DEBOUNCE_MS } from '../hooks/useSearchScope';
import DashboardHeader from '../components/dashboard/DashboardHeader';
import Dashboard from '../Dashboard';
import { clearOnlineAnswers } from '../components/dashboard/OnlineResults';
import { fakeResponse } from './fakeResponse';

const EDITOR = { id: 1, username: 'anna', role: 'editor' };

let lookups = [];
const stubFetch = (hits = []) => {
  lookups = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const href = String(url);
    if (href.includes('/api/lookup/manga')) {
      lookups.push(href);
      return fakeResponse(200, hits);
    }
    return fakeResponse(200, []);
  }));
};

beforeEach(() => {
  try { sessionStorage.clear(); localStorage.clear(); } catch (_) {}
  clearOnlineAnswers();
  state.localHits.clear();
  state.mangaList = {
    mangas: [{ id: 1, title: 'Naruto', status: 'Laufend', owned_volumes: 1, regular_owned: 1, language: 'de' }],
    loading: false, refreshing: false, error: null, fetchMangas: vi.fn(), handleDeleteManga: vi.fn(async () => true)
  };
  stubFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useSearchScope', () => {
  it('starts in the collection scope and remembers the choice per device', () => {
    const { result, unmount } = renderHook(() => useSearchScope());
    expect(result.current.scope).toBe('collection');
    act(() => result.current.setScope('online'));
    expect(result.current.scope).toBe('online');
    expect(localStorage.getItem(SEARCH_SCOPE_KEY)).toBe('online');
    unmount();
    expect(renderHook(() => useSearchScope()).result.current.scope).toBe('online');
    localStorage.setItem(SEARCH_SCOPE_KEY, 'everywhere');
    expect(renderHook(() => useSearchScope()).result.current.scope).toBe('collection');
  });

  it('online scope: a typed query of three characters is looked up 600 ms after the last keystroke', () => {
    vi.useFakeTimers();
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    const { result } = renderHook(() => useSearchScope());
    act(() => result.current.onTyped('ro'));
    act(() => vi.advanceTimersByTime(ONLINE_DEBOUNCE_MS * 2));
    expect(result.current.onlineQuery).toBe('');
    act(() => result.current.onTyped('ros'));
    act(() => vi.advanceTimersByTime(300));
    act(() => result.current.onTyped(' rosa '));
    expect(result.current.pending).toBe(true);
    act(() => vi.advanceTimersByTime(ONLINE_DEBOUNCE_MS - 1));
    expect(result.current.onlineQuery).toBe('');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.onlineQuery).toBe('rosa');
    expect(result.current.onlineSeq).toBeGreaterThan(0);
    expect(result.current.pending).toBe(false);
  });

  it('Enter submits at once and cancels the pending keystroke timer; a new query replaces the old one', () => {
    vi.useFakeTimers();
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    const { result } = renderHook(() => useSearchScope());
    act(() => result.current.onTyped('frie'));
    act(() => result.current.submitOnline('frieren'));
    expect(result.current.onlineQuery).toBe('frieren');
    const first = result.current.onlineSeq;
    act(() => vi.advanceTimersByTime(ONLINE_DEBOUNCE_MS * 2));
    expect(result.current.onlineQuery).toBe('frieren');
    expect(result.current.onlineSeq).toBe(first);
    act(() => result.current.submitOnline('frieren'));
    expect(result.current.onlineSeq).toBe(first + 1);
    act(() => result.current.onTyped('fr'));
    expect(result.current.onlineQuery).toBe('');
  });

  it('online scope: typing the current online query again neither waits nor asks again', () => {
    vi.useFakeTimers();
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    const { result } = renderHook(() => useSearchScope());
    act(() => result.current.submitOnline('rosa'));
    const seq = result.current.onlineSeq;
    act(() => result.current.onTyped('rosa '));
    expect(result.current.pending).toBe(false);
    act(() => result.current.onTyped('rosar'));
    expect(result.current.pending).toBe(true);
    act(() => result.current.onTyped('rosa'));
    expect(result.current.pending).toBe(false);
    act(() => vi.advanceTimersByTime(ONLINE_DEBOUNCE_MS * 2));
    expect(result.current.onlineQuery).toBe('rosa');
    expect(result.current.onlineSeq).toBe(seq);
  });

  it('submits are numbered across instances, so a new dashboard never repeats an earlier number', () => {
    const first = renderHook(() => useSearchScope());
    act(() => first.result.current.submitOnline('rosa'));
    const seq = first.result.current.onlineSeq;
    first.unmount();
    const second = renderHook(() => useSearchScope());
    act(() => second.result.current.submitOnline('rosa'));
    expect(second.result.current.onlineSeq).toBeGreaterThan(seq);
  });

  it('a clear cancels a pending lookup', () => {
    vi.useFakeTimers();
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    const { result } = renderHook(() => useSearchScope());
    act(() => result.current.onTyped('rosa'));
    act(() => result.current.clearOnline());
    act(() => vi.advanceTimersByTime(ONLINE_DEBOUNCE_MS * 2));
    expect(result.current.onlineQuery).toBe('');
    expect(result.current.onlineSeq).toBe(0);
  });

  it('collection scope: typing never starts a lookup; the button does once and a new query hides it again', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSearchScope());
    act(() => result.current.onTyped('rosa'));
    act(() => vi.advanceTimersByTime(ONLINE_DEBOUNCE_MS * 2));
    expect(result.current.onlineQuery).toBe('');
    act(() => result.current.submitOnline('rosa'));
    expect(result.current.onlineQuery).toBe('rosa');
    expect(result.current.scope).toBe('collection');
    expect(localStorage.getItem(SEARCH_SCOPE_KEY)).toBeNull();
    act(() => result.current.onTyped('rosa '));
    expect(result.current.onlineQuery).toBe('rosa');
    act(() => result.current.onTyped('rosar'));
    expect(result.current.onlineQuery).toBe('');
  });

  it('switching back to the collection drops the online query; disabled (offline) it never sets one', () => {
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    const { result, rerender } = renderHook(({ enabled }) => useSearchScope({ enabled }), { initialProps: { enabled: true } });
    act(() => result.current.submitOnline('rosa'));
    act(() => result.current.setScope('collection'));
    expect(result.current.onlineQuery).toBe('');
    rerender({ enabled: false });
    act(() => result.current.submitOnline('rosa'));
    act(() => result.current.onTyped('rosa'));
    expect(result.current.onlineQuery).toBe('');
  });
});

const headerProps = (overrides = {}) => ({
  activeMainView: 'shelf', canEdit: true, handleBarcodeDetected: vi.fn(), handleInstallClick: vi.fn(), handleOpenCsvModal: vi.fn(),
  handleOpenModal: vi.fn(), handleOpenPasswordModal: vi.fn(), handleOpenRestoreModal: vi.fn(), handleOpenStats: vi.fn(),
  handleOpenUsersModal: vi.fn(), isInstallable: false, isInstalledApp: false, isOfflineMode: false, isVisitor: false,
  mobileMenuOpen: false, onLogout: vi.fn(), radarData: null, search: '', searchInputRef: { current: null },
  setMobileMenuOpen: vi.fn(), setSearch: vi.fn(), setView: vi.fn(), shoppingData: null, user: EDITOR, ...overrides
});
const scopeProps = (scope = 'collection') => ({
  scope, setScope: vi.fn(), onTyped: vi.fn(), submitOnline: vi.fn(), clearOnline: vi.fn()
});

describe('DashboardHeader scope button', () => {
  it('sits after the scanner, keeps its name and shows the scope through aria-pressed and the tooltip', () => {
    const searchScope = scopeProps();
    const { rerender } = render(<DashboardHeader {...headerProps({ searchScope })} />);
    const input = document.getElementById('main-search-input');
    const buttons = input.parentElement.querySelectorAll('button');
    expect(buttons[0].textContent).toBe('Scan-Test');
    const scope = buttons[1];
    expect(scope.id).toBe('btn-search-scope');
    expect(scope.getAttribute('aria-pressed')).toBe('false');
    expect(scope.getAttribute('aria-label')).toBe('Online mitsuchen');
    expect(scope.getAttribute('title')).toBe('Sucht nur in der Sammlung');
    expect(scope.className).toContain('hit-44');
    expect(input.getAttribute('placeholder')).toBe('Titel, Autor, Tag, ISBN oder Notiz suchen...');
    fireEvent.click(scope);
    expect(searchScope.setScope).toHaveBeenCalledWith('online');
    expect(document.activeElement).not.toBe(input);

    const online = scopeProps('online');
    rerender(<DashboardHeader {...headerProps({ searchScope: online, search: 'rosa' })} />);
    const pressed = document.getElementById('btn-search-scope');
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect(pressed.getAttribute('aria-label')).toBe('Online mitsuchen');
    expect(pressed.getAttribute('title')).toBe('Sucht in der Sammlung und online');
    expect(input.getAttribute('placeholder')).toBe('Sammlung und online suchen…');
    expect(screen.getByRole('textbox', { name: 'Sammlung durchsuchen' })).toBe(input);
    const order = [...input.parentElement.querySelectorAll('button')].map((b) => b.id || b.textContent);
    expect(order).toEqual(['Scan-Test', 'btn-search-scope', '']);
    fireEvent.click(pressed);
    expect(online.setScope).toHaveBeenCalledWith('collection');
  });

  it('is hidden offline and without a scope; the placeholder then stays the collection one', () => {
    const searchScope = scopeProps('online');
    const { rerender } = render(<DashboardHeader {...headerProps({ searchScope, user: { ...EDITOR, offline: true }, isOfflineMode: true })} />);
    expect(document.getElementById('btn-search-scope')).toBeNull();
    expect(document.getElementById('main-search-input').getAttribute('placeholder')).toBe('Titel, Autor, Tag, ISBN oder Notiz suchen...');
    rerender(<DashboardHeader {...headerProps()} />);
    expect(document.getElementById('btn-search-scope')).toBeNull();
  });

  it('is offered to guests too', () => {
    render(<DashboardHeader {...headerProps({ searchScope: scopeProps(), canEdit: false, isVisitor: true, user: { id: 2, username: 'gast', role: 'visitor' } })} />);
    expect(screen.getByRole('button', { name: 'Online mitsuchen' })).toBeTruthy();
  });

  it('typing reports the value; Enter submits only in the online scope', () => {
    const searchScope = scopeProps();
    const props = headerProps({ searchScope });
    const { rerender } = render(<DashboardHeader {...props} />);
    const input = document.getElementById('main-search-input');
    fireEvent.change(input, { target: { value: 'rosa' } });
    expect(props.setSearch).toHaveBeenCalledWith('rosa');
    expect(searchScope.onTyped).toHaveBeenCalledWith('rosa');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(searchScope.submitOnline).not.toHaveBeenCalled();
    const online = scopeProps('online');
    rerender(<DashboardHeader {...props} search="rosa" searchScope={online} />);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(online.submitOnline).toHaveBeenCalledWith('rosa');
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

const renderDashboard = (user = EDITOR) => render(
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="/" element={<Dashboard user={user} onLogout={vi.fn()} />} />
      <Route path="/manga/:id" element={<div>Detailseite</div>} />
    </Routes>
    <LocationProbe />
  </MemoryRouter>
);

const settle = (ms = ONLINE_DEBOUNCE_MS + 150) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const holdLookups = () => {
  lookups = [];
  const releases = [];
  vi.stubGlobal('fetch', vi.fn((url) => {
    const href = String(url);
    if (!href.includes('/api/lookup/manga')) return Promise.resolve(fakeResponse(200, []));
    lookups.push(href);
    return new Promise((resolve) => { releases.push(resolve); });
  }));
  return releases;
};
const searchInput = () => document.getElementById('main-search-input');

describe('Dashboard: online lookups only for typed input', () => {
  it('a restored session search never fetches, not even in the online scope', async () => {
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    sessionStorage.setItem('mangashelf_search', JSON.stringify({ user: '1', search: 'rosa' }));
    renderDashboard();
    expect(searchInput().value).toBe('rosa');
    await settle();
    expect(lookups).toEqual([]);
    expect(await screen.findByRole('button', { name: 'Online nach „rosa“ suchen' })).toBeTruthy();
    expect(lookups).toEqual([]);
  });

  it('a series opened by a scan sets the search without a lookup', async () => {
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    state.localHits.set('9783551000001', { manga: { id: 1, title: 'Naruto' } });
    renderDashboard();
    fireEvent.click(within(document.querySelector('header[data-sticky-header]')).getByText('Scan-Test'));
    expect(await screen.findByText('Detailseite')).toBeTruthy();
    await settle();
    expect(lookups).toEqual([]);
  });

  it('a clear within the debounce never fetches; typed input fetches once with the default language', async () => {
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    stubFetch([{ id: 'mp_7', source: 'manga_passion', manga_passion_id: 7, title: 'Rosa', author: 'A' }]);
    renderDashboard();
    fireEvent.change(searchInput(), { target: { value: 'rosa' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(searchInput().value).toBe('');
    await settle();
    expect(lookups).toEqual([]);

    fireEvent.change(searchInput(), { target: { value: 'rosa' } });
    await settle();
    await waitFor(() => expect(lookups).toHaveLength(1));
    expect(lookups[0]).toContain('/api/lookup/manga?q=rosa');
    expect(lookups[0]).not.toContain('language=');
    expect(await screen.findByText('1 online gefunden')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Nicht in deiner Sammlung' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Filter & Suche zurücksetzen/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neue Reihe „rosa“ anlegen' })).toBeTruthy();
  });

  it('collection scope: typing never fetches, the row looks up once and keeps the scope', async () => {
    stubFetch([{ id: 'al_1', source: 'anilist', title: 'Naruto', work_key: 'anilist:1' }]);
    renderDashboard();
    fireEvent.change(searchInput(), { target: { value: 'Naru' } });
    await settle();
    expect(lookups).toEqual([]);
    expect(screen.getByText('Naruto')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Online nach „Naru“ suchen' }));
    await waitFor(() => expect(lookups).toHaveLength(1));
    const heading = await screen.findByRole('heading', { name: 'Online-Treffer zu „Naru“' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByRole('button', { name: 'Online nach „Naru“ suchen' })).toBeNull();
    expect(localStorage.getItem(SEARCH_SCOPE_KEY)).toBeNull();
    expect(document.getElementById('btn-search-scope').getAttribute('aria-pressed')).toBe('false');
  });

  it('"Anlegen" on a hit opens the add dialog prefilled without a volume; "Neue Reihe" with only the title', async () => {
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    stubFetch([{ id: 'mp_7', source: 'manga_passion', manga_passion_id: 7, title: 'Rosa', author: 'A' }]);
    renderDashboard();
    fireEvent.change(searchInput(), { target: { value: 'rosa' } });
    await settle();
    fireEvent.click(await screen.findByRole('button', { name: 'Anlegen: Rosa' }));
    expect(await screen.findByText('Anlegen mit Rosa 7 ohne Band')).toBeTruthy();
  });

  it('"Neue Reihe „…“ anlegen" opens the dialog with only the title; guests get neither add button', async () => {
    const first = renderDashboard();
    fireEvent.change(searchInput(), { target: { value: 'Unbekannt XY' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Neue Reihe „Unbekannt XY“ anlegen' }));
    expect(await screen.findByText('Anlegen mit Unbekannt XY - ohne Band')).toBeTruthy();
    first.unmount();

    sessionStorage.clear();
    renderDashboard({ id: 2, username: 'gast', role: 'visitor' });
    fireEvent.change(searchInput(), { target: { value: 'Unbekannt XY' } });
    expect(await screen.findByRole('button', { name: 'Online nach „Unbekannt XY“ suchen' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Neue Reihe/ })).toBeNull();
  });

  it('the online button in the empty panel hands focus to the status line of the results', async () => {
    renderDashboard();
    fireEvent.change(searchInput(), { target: { value: 'rosa' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Online nach „rosa“ suchen' }));
    const status = await screen.findByText('Online nichts gefunden zu „rosa“');
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(lookups).toHaveLength(1);
  });

  it('back on a new dashboard, a query whose lookup failed before is asked again', async () => {
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    lookups = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const href = String(url);
      if (!href.includes('/api/lookup/manga')) return fakeResponse(200, []);
      lookups.push(href);
      return fakeResponse(400, { error: 'Suchbegriff erforderlich' });
    }));
    const first = renderDashboard();
    fireEvent.change(searchInput(), { target: { value: 'rosa' } });
    await settle();
    expect(await screen.findByText('Suchbegriff erforderlich')).toBeTruthy();
    first.unmount();
    sessionStorage.clear();
    renderDashboard();
    fireEvent.change(searchInput(), { target: { value: 'rosa' } });
    await settle();
    await waitFor(() => expect(lookups).toHaveLength(2));
  });

  it('Enter or a trailing space while the lookup runs asks only once', async () => {
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    const releases = holdLookups();
    renderDashboard();
    fireEvent.change(searchInput(), { target: { value: 'rosa' } });
    await settle();
    expect(lookups).toHaveLength(1);
    fireEvent.keyDown(searchInput(), { key: 'Enter' });
    fireEvent.change(searchInput(), { target: { value: 'rosa ' } });
    await settle();
    expect(lookups).toHaveLength(1);
    await act(async () => { releases[0](fakeResponse(200, [{ id: 'al_9', source: 'anilist', title: 'Rosa' }])); });
    expect(await screen.findByText('1 online gefunden')).toBeTruthy();
    expect(lookups).toHaveLength(1);
  });

  it('a shelf that runs empty while the lookup runs moves the section without asking again', async () => {
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    holdLookups();
    renderDashboard();
    fireEvent.change(searchInput(), { target: { value: 'Naru' } });
    await settle();
    expect(lookups).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Online-Treffer zu „Naru“' })).toBeTruthy();
    fireEvent.change(searchInput(), { target: { value: 'Naruqqq' } });
    expect(await screen.findByRole('heading', { name: 'Nicht in deiner Sammlung' })).toBeTruthy();
    expect(lookups).toHaveLength(1);
    await settle();
    expect(lookups).toHaveLength(2);
    expect(lookups[1]).toContain('q=Naruqqq');
  });

  it('a status filter after a failed lookup moves the section without asking again', async () => {
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    state.mangaList.mangas = [
      ...state.mangaList.mangas,
      { id: 2, title: 'Berserk', status: 'Abgeschlossen', owned_volumes: 1, regular_owned: 1, language: 'de' }
    ];
    lookups = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const href = String(url);
      if (!href.includes('/api/lookup/manga')) return fakeResponse(200, []);
      lookups.push(href);
      return fakeResponse(503, { error: 'x', code: 'SOURCES_UNAVAILABLE' });
    }));
    renderDashboard();
    fireEvent.change(searchInput(), { target: { value: 'Naru' } });
    await settle();
    expect(await screen.findByText('Online-Quellen gerade nicht erreichbar')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Status-Filter' })).getByRole('button', { name: /Abgeschlossen/ }));
    expect(await screen.findByRole('heading', { name: 'Nicht in deiner Sammlung' })).toBeTruthy();
    expect(screen.getByText('Online-Quellen gerade nicht erreichbar')).toBeTruthy();
    await settle();
    expect(lookups).toHaveLength(1);
  });

  it('offline: no scope button, no row and no lookup', async () => {
    localStorage.setItem(SEARCH_SCOPE_KEY, 'online');
    renderDashboard({ id: 1, username: 'anna', role: 'visitor', realRole: 'editor', offline: true });
    expect(document.getElementById('btn-search-scope')).toBeNull();
    fireEvent.change(searchInput(), { target: { value: 'rosa' } });
    await settle();
    expect(lookups).toEqual([]);
    expect(screen.getByText('Keine Treffer gefunden')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Online nach/ })).toBeNull();
  });
});
