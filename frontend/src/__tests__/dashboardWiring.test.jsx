// Covers how the dashboard wires its hooks into the shopping and radar views.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const state = vi.hoisted(() => ({ mangaList: null, shopping: null, radar: null, shoppingProps: null, radarProps: null, radarArgs: null }));

vi.mock('../hooks/useMangaList', () => ({ default: () => state.mangaList }));
vi.mock('../hooks/useOfflineStatus', () => ({
  default: ({ user }) => ({
    networkOffline: false, setNetworkOffline: vi.fn(), isOfflineMode: Boolean(user?.offline), offlineCopyAt: null,
    refreshingCopy: false, refreshError: null, handleRefreshOfflineCopy: vi.fn()
  })
}));
vi.mock('../hooks/useShoppingList', () => ({ default: () => state.shopping }));
vi.mock('../hooks/useReleaseRadar', () => ({ default: (args) => { state.radarArgs = args; return state.radar; } }));
vi.mock('../hooks/usePwaInstall', () => ({ default: () => ({ isInstallable: false, isInstalledApp: false, handleInstallClick: vi.fn() }) }));
vi.mock('../components/common/BarcodeScannerButton', () => ({ default: () => null }));
vi.mock('../components/modals/StatsModal', () => ({ default: () => null }));
vi.mock('../components/modals/AddMangaModal', () => ({ default: () => null }));
vi.mock('../components/modals/UserManagementModal', () => ({ default: () => null }));
vi.mock('../components/modals/ChangePasswordModal', () => ({ default: () => null }));
vi.mock('../components/modals/BackupRestoreModal', () => ({ default: () => null }));
vi.mock('../components/dashboard/ShoppingListView', () => ({
  default: (props) => { state.shoppingProps = props; return <div>Einkaufslisten-Ansicht</div>; }
}));
vi.mock('../components/dashboard/ReleaseRadarView', () => ({
  default: (props) => { state.radarProps = props; return <div>Radar-Ansicht</div>; }
}));

import Dashboard from '../Dashboard';

const renderDashboard = (url, user) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/" element={<Dashboard user={user} onLogout={vi.fn()} />} />
    </Routes>
  </MemoryRouter>
);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  state.shoppingProps = null;
  state.radarProps = null;
  state.mangaList = {
    mangas: [{ id: 1, title: 'Naruto', status: 'Laufend' }, { id: 2, title: 'Berserk', status: 'Laufend' }],
    loading: false, refreshing: false, error: null, fetchMangas: vi.fn(), handleDeleteManga: vi.fn(async () => true)
  };
  state.shopping = {
    shoppingData: null, loadingShopping: false, shoppingPublisherFilter: 'ALL', setShoppingPublisherFilter: vi.fn(),
    shoppingSearch: '', setShoppingSearch: vi.fn(), buyingIds: new Set([7]), shoppingError: 'server', offlineLastUpdated: null,
    cacheWriteFailed: false, pendingPurchases: 0, failedPurchases: [], fetchShoppingList: vi.fn(), handleQuickBuy: vi.fn(),
    syncPendingPurchases: vi.fn()
  };
  state.radar = {
    radarData: null, loadingRadar: false, radarError: 'server', radarPublisherFilter: 'ALL', setRadarPublisherFilter: vi.fn(),
    radarStatusFilter: 'ALL', setRadarStatusFilter: vi.fn(), radarSearch: '', setRadarSearch: vi.fn(),
    markingDeliveredIds: new Set(), radarSubView: 'passion', setRadarSubView: vi.fn(), mpYear: 2026, setMpYear: vi.fn(),
    mpMonth: 10, setMpMonth: vi.fn(), mpData: null, loadingMp: false, mpError: 'Manga Passion nicht erreichbar', mpSearch: '',
    setMpSearch: vi.fn(), mpPublisherFilter: 'ALL', setMpPublisherFilter: vi.fn(), mpPrintOnly: true, setMpPrintOnly: vi.fn(),
    mpMySeriesOnly: false, setMpMySeriesOnly: vi.fn(), importingMpIds: new Set([3]), fetchReleaseRadar: vi.fn(),
    handleMarkDelivered: vi.fn(), fetchMangaPassionReleases: vi.fn(), handlePrevMonth: vi.fn(), handleNextMonth: vi.fn(),
    handleCurrentMonth: vi.fn(), handleImportMangaPassion: vi.fn()
  };
});

describe('Dashboard wiring', () => {
  it('the shopping list gets the user, the shelf refresh, the load error and every running purchase', () => {
    const user = { id: 1, username: 'anna', role: 'editor' };
    renderDashboard('/?view=shopping', user);
    expect(screen.getByText('Einkaufslisten-Ansicht')).toBeTruthy();
    expect(state.shoppingProps.user).toBe(user);
    expect(state.shoppingProps.fetchMangas).toBe(state.mangaList.fetchMangas);
    expect(state.shoppingProps.shoppingError).toBe('server');
    expect(state.shoppingProps.buyingIds.has(7)).toBe(true);
  });

  it('the radar gets the load errors and App\'s offline mode', () => {
    renderDashboard('/?view=radar', { id: 1, username: 'anna', role: 'visitor', realRole: 'editor', offline: true });
    expect(state.radarArgs.offline).toBe(true);
    expect(state.radarProps.isOffline).toBe(true);
    expect(state.radarProps.radarError).toBe('server');
    expect(state.radarProps.mpError).toBe('Manga Passion nicht erreichbar');
    expect(state.radarProps.importingMpIds.has(3)).toBe(true);
  });

  it('the shelf search typed by one user is not restored for the next one in the same tab', () => {
    const first = renderDashboard('/', { id: 1, username: 'anna', role: 'editor' });
    fireEvent.change(document.getElementById('main-search-input'), { target: { value: 'Berserk' } });
    expect(screen.queryByText('Naruto')).toBeNull();
    first.unmount();

    renderDashboard('/', { id: 2, username: 'ben', role: 'editor' });
    expect(document.getElementById('main-search-input').value).toBe('');
    expect(screen.getByText('Naruto')).toBeTruthy();
  });
});
