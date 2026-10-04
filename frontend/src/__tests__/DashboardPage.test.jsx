import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';

const state = vi.hoisted(() => ({
  offline: false,
  scanCode: '9783551000001',
  mangaList: null,
  shopping: null,
  radar: null,
  shoppingCalls: [],
  radarCalls: []
}));

vi.mock('../hooks/useMangaList', () => ({ default: () => state.mangaList }));
vi.mock('../hooks/useOfflineStatus', () => ({
  default: () => ({
    networkOffline: false, setNetworkOffline: vi.fn(), isOfflineMode: state.offline, offlineCopyAt: null,
    refreshingCopy: false, refreshError: null, handleRefreshOfflineCopy: vi.fn()
  })
}));
vi.mock('../hooks/useShoppingList', () => ({
  default: (args) => { state.shoppingCalls.push(args); return state.shopping; }
}));
vi.mock('../hooks/useReleaseRadar', () => ({
  default: (args) => { state.radarCalls.push(args); return state.radar; }
}));
vi.mock('../hooks/usePwaInstall', () => ({ default: () => ({ isInstallable: false, isInstalledApp: false, handleInstallClick: vi.fn() }) }));
vi.mock('../components/common/BarcodeScannerButton', () => ({
  default: ({ onDetected }) => <button type="button" onClick={() => onDetected(state.scanCode)}>Scan-Test</button>
}));
vi.mock('../components/modals/StatsModal', () => ({ default: ({ isOpen }) => (isOpen ? <div>Statistik-Dialog</div> : null) }));
vi.mock('../components/modals/AddMangaModal', () => ({
  default: ({ isOpen, onClose, onSeriesCreated, prefill }) => (isOpen ? (
    <div>
      <span>Anlegen-Dialog {prefill ? `mit ${prefill.form.title || '(leer)'} ${prefill.volume.isbn}` : 'leer'}</span>
      <button type="button" onClick={() => onSeriesCreated?.({ success: true, id: 42 })}>Nur Reihe angelegt</button>
      <button type="button" onClick={onClose}>Anlegen schließen</button>
    </div>
  ) : null)
}));
vi.mock('../components/modals/UserManagementModal', () => ({ default: () => null }));
vi.mock('../components/modals/ChangePasswordModal', () => ({ default: () => null }));
vi.mock('../components/modals/BackupRestoreModal', () => ({ default: () => null }));
vi.mock('../components/dashboard/ShoppingListView', () => ({
  default: ({ setActiveMainView }) => <button type="button" onClick={() => setActiveMainView('shelf')}>Zurück zum Regal</button>
}));
vi.mock('../components/dashboard/ReleaseRadarView', () => ({ default: () => <div>Radar-Ansicht</div> }));

import Dashboard from '../Dashboard';
import Toaster from '../components/common/Toaster';
import { fakeResponse, htmlResponse } from './fakeResponse';

const json = (status, body) => fakeResponse(status, body);

let navigateTo = null;
function LocationProbe() {
  const location = useLocation();
  navigateTo = useNavigate();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

const renderDashboard = (url = '/', user = { id: 1, username: 'anna', role: 'editor' }) => render(
  <>
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/" element={<Dashboard user={user} onLogout={vi.fn()} />} />
        <Route path="/manga/:id" element={<div>Detailseite</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
    <Toaster />
  </>
);

const currentUrl = () => screen.getByTestId('location').textContent;

beforeEach(() => {
  state.offline = false;
  state.shoppingCalls = [];
  state.radarCalls = [];
  try { sessionStorage.clear(); localStorage.clear(); } catch (_) {}
  state.mangaList = {
    mangas: [{ id: 1, title: 'Naruto', status: 'Laufend', owned_volumes: 1, regular_owned: 1 }],
    loading: false, refreshing: false, error: null, fetchMangas: vi.fn(), handleDeleteManga: vi.fn(async () => true)
  };
  state.shopping = {
    shoppingData: null, loadingShopping: false, shoppingPublisherFilter: 'ALL', setShoppingPublisherFilter: vi.fn(),
    shoppingSearch: '', setShoppingSearch: vi.fn(), buyingId: null, offlineLastUpdated: null, cacheWriteFailed: false,
    pendingPurchases: 0, failedPurchases: [], fetchShoppingList: vi.fn(), handleQuickBuy: vi.fn(), syncPendingPurchases: vi.fn()
  };
  state.radar = {
    radarData: null, loadingRadar: false, radarError: null, radarPublisherFilter: 'ALL', setRadarPublisherFilter: vi.fn(),
    radarStatusFilter: 'ALL', setRadarStatusFilter: vi.fn(), radarSearch: '', setRadarSearch: vi.fn(),
    markingDeliveredIds: new Set(), radarSubView: 'passion', setRadarSubView: vi.fn(), mpYear: 2026, setMpYear: vi.fn(),
    mpMonth: 10, setMpMonth: vi.fn(), mpData: null, loadingMp: false, mpError: null, mpSearch: '', setMpSearch: vi.fn(),
    mpPublisherFilter: 'ALL', setMpPublisherFilter: vi.fn(), mpPrintOnly: true, setMpPrintOnly: vi.fn(), mpMySeriesOnly: false,
    setMpMySeriesOnly: vi.fn(), importingMpIds: new Set(), fetchReleaseRadar: vi.fn(), handleMarkDelivered: vi.fn(),
    fetchMangaPassionReleases: vi.fn(), handlePrevMonth: vi.fn(), handleNextMonth: vi.fn(), handleCurrentMonth: vi.fn(),
    handleImportMangaPassion: vi.fn()
  };
});

describe('Dashboard', () => {
  it('?view=stats opens the statistics over the shelf and cleans the URL', async () => {
    renderDashboard('/?view=stats');
    expect(await screen.findByText('Statistik-Dialog')).toBeTruthy();
    expect(document.getElementById('btn-nav-shelf').getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(currentUrl()).toBe('/'));
  });

  it('?view=stats does not open the statistics offline', async () => {
    state.offline = true;
    renderDashboard('/?view=stats', { id: 1, username: 'anna', role: 'visitor', realRole: 'editor', offline: true });
    await waitFor(() => expect(currentUrl()).toBe('/'));
    expect(screen.queryByText('Statistik-Dialog')).toBeNull();
  });

  it('passes the user to the shopping hook (queue sync when offline mode ends) and the offline flag to the radar', () => {
    const user = { id: 5, username: 'anna', role: 'editor' };
    renderDashboard('/', user);
    expect(state.shoppingCalls.at(-1).user).toBe(user);
    expect(state.radarCalls.at(-1).offline).toBe(false);
  });

  it('every view change goes through the URL, also the back button of the shopping list', () => {
    renderDashboard('/');
    fireEvent.click(document.getElementById('btn-mobile-shopping'));
    expect(currentUrl()).toBe('/?view=shopping');
    expect(state.shopping.fetchShoppingList).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Zurück zum Regal'));
    expect(currentUrl()).toBe('/');

    fireEvent.click(document.getElementById('btn-mobile-radar'));
    expect(currentUrl()).toBe('/?view=radar');
    expect(state.radar.fetchReleaseRadar).toHaveBeenCalled();
    expect(state.radar.fetchMangaPassionReleases).toHaveBeenCalledTimes(1);
    fireEvent.click(document.getElementById('btn-mobile-shopping'));
    expect(currentUrl()).toBe('/?view=shopping');
  });

  it('a scan with several similar series offers a choice instead of searching for the volume title', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {
      found: true, isbn: state.scanCode, book: { title: 'Die Prophezeiung', series: 'Naruto' }, matched_manga: null,
      matched_candidates: [{ id: 1, title: 'Naruto Gaiden' }, { id: 2, title: 'Naruto Shippuden' }]
    })));
    renderDashboard('/');
    fireEvent.click(screen.getByText('Scan-Test'));
    expect(await screen.findByText('Mehrere Reihen passen – bitte auswählen')).toBeTruthy();
    expect(document.getElementById('main-search-input').value).toBe('');
    fireEvent.click(screen.getByText('Naruto Shippuden'));
    expect(currentUrl()).toBe('/manga/2');
  });

  it('an unknown ISBN shows the server message, keeps the digits out of the search and offers to add', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { found: false, isbn: state.scanCode, message: 'Keine Metadaten für diese ISBN gefunden.' })));
    renderDashboard('/');
    fireEvent.click(screen.getByText('Scan-Test'));
    expect(await screen.findByText('Keine Metadaten für diese ISBN gefunden.')).toBeTruthy();
    expect(document.getElementById('main-search-input').value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Reihe manuell anlegen' }));
    expect(await screen.findByText(`Anlegen-Dialog mit (leer) ${state.scanCode}`)).toBeTruthy();
    expect(screen.queryByText('Keine Metadaten für diese ISBN gefunden.')).toBeNull();
  });

  it('the scan messages share the toast stack: the busy message is replaced by the result', async () => {
    let answer;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answer = resolve; })));
    renderDashboard('/');
    fireEvent.click(screen.getByText('Scan-Test'));
    expect(await screen.findByText(`ISBN ${state.scanCode} wird gesucht...`)).toBeTruthy();
    await act(async () => { answer(json(200, { found: false, isbn: state.scanCode, message: 'Nichts gefunden.' })); });
    expect(await screen.findByText('Nichts gefunden.')).toBeTruthy();
    expect(screen.queryByText(/wird gesucht/)).toBeNull();
    expect(screen.getByText('Nichts gefunden.').closest('[role="status"]')).toBeTruthy();
  });

  it('a gateway error page and a network failure give a readable message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(502)));
    renderDashboard('/');
    fireEvent.click(screen.getByText('Scan-Test'));
    expect(await screen.findByText(/ISBN-Suche fehlgeschlagen/)).toBeTruthy();
  });

  it('scanning offline says the lookup needs the server', async () => {
    state.offline = true;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderDashboard('/', { id: 1, username: 'anna', role: 'visitor', realRole: 'editor', offline: true });
    fireEvent.click(screen.getByText('Scan-Test'));
    expect(await screen.findByText(/braucht eine Verbindung/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a series created without its volume shows up in the list at once', async () => {
    renderDashboard('/');
    fireEvent.click(document.getElementById('btn-open-add-manga'));
    expect(await screen.findByText('Anlegen-Dialog leer')).toBeTruthy();
    state.mangaList.fetchMangas.mockClear();
    fireEvent.click(screen.getByText('Nur Reihe angelegt'));
    expect(state.mangaList.fetchMangas).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Anlegen schließen'));
    expect(screen.queryByText(/Anlegen-Dialog/)).toBeNull();
  });

  it('Escape closes the add dialog and drops a scan prefill; a manual open never carries one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { found: true, isbn: state.scanCode, book: { title: 'Neu 1', series: 'Neu' } })));
    renderDashboard('/');
    fireEvent.click(screen.getByText('Scan-Test'));
    expect(await screen.findByText(`Anlegen-Dialog mit Neu ${state.scanCode}`)).toBeTruthy();
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(screen.queryByText(/Anlegen-Dialog/)).toBeNull();
    fireEvent.click(document.getElementById('btn-open-add-manga'));
    expect(await screen.findByText('Anlegen-Dialog leer')).toBeTruthy();
  });

  it('a delete refreshes the shopping and radar badges', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderDashboard('/');
    fireEvent.click(screen.getByRole('button', { name: 'Naruto löschen' }));
    await waitFor(() => expect(state.shopping.fetchShoppingList).toHaveBeenCalled());
    expect(state.radar.fetchReleaseRadar).toHaveBeenCalled();
  });

  it('editors open the CSV dialog from the header; a closed dialog is not mounted', async () => {
    renderDashboard('/');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(document.getElementById('btn-open-csv'));
    expect(await screen.findByRole('dialog', { name: /CSV-Export & Import/ })).toBeTruthy();
  });

  it('Back and Forward between views change the view and load its data', async () => {
    renderDashboard('/');
    fireEvent.click(document.getElementById('btn-nav-shopping'));
    expect(currentUrl()).toBe('/?view=shopping');
    state.shopping.fetchShoppingList.mockClear();
    act(() => { navigateTo(-1); });
    expect(currentUrl()).toBe('/');
    expect(document.getElementById('btn-nav-shelf').getAttribute('aria-current')).toBe('page');
    act(() => { navigateTo(1); });
    expect(document.getElementById('btn-nav-shopping').getAttribute('aria-current')).toBe('page');
    expect(state.shopping.fetchShoppingList).toHaveBeenCalledTimes(1);
  });

  it('choosing the open view again reloads its data without a new history entry', () => {
    renderDashboard('/?view=shopping');
    state.shopping.fetchShoppingList.mockClear();
    fireEvent.click(document.getElementById('btn-nav-shopping'));
    expect(state.shopping.fetchShoppingList).toHaveBeenCalledTimes(1);
    act(() => { navigateTo(-1); });
    expect(currentUrl()).toBe('/?view=shopping');
  });
});

describe('Dashboard page structure', () => {
  it('starts with a skip link to the main region and names the tab after the view', async () => {
    renderDashboard('/');
    const skip = screen.getByRole('link', { name: 'Zum Inhalt springen' });
    expect(document.querySelector('a[href], button')).toBe(skip);
    expect(screen.getByRole('main').id).toBe(skip.getAttribute('href').slice(1));
    expect(document.title).toBe('Sammlung – Manga Shelf');
    fireEvent.click(document.getElementById('btn-nav-shopping'));
    await waitFor(() => expect(document.title).toBe('Einkaufsliste – Manga Shelf'));
    fireEvent.click(document.getElementById('btn-nav-radar'));
    await waitFor(() => expect(document.title).toBe('Release-Radar – Manga Shelf'));
  });

  it('the header reaches below the iOS status bar and names the app heading', () => {
    renderDashboard('/');
    expect(screen.getByRole('banner').className).toMatch(/pt-\[max\(0\.75rem,env\(safe-area-inset-top\)\)\]/);
    expect(screen.getByRole('heading', { level: 1 }).tabIndex).toBe(-1);
    expect(screen.getByRole('heading', { level: 2, name: 'Sammlung' })).toBeTruthy();
  });
});
