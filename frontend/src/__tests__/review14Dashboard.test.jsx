// Dashboard genre filter and statistics tools.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const state = vi.hoisted(() => ({ mangaList: null, shopping: null, radar: null, shoppingProps: null, radarProps: null, radarArgs: null, statsProps: null }));

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
vi.mock('../components/modals/StatsModal', () => ({ default: (props) => { state.statsProps = props; return <div>Statistik-Dialog</div>; } }));
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
    mangas: [{ id: 1, title: 'Naruto', status: 'Laufend', tags: 'Action, Shounen' }, { id: 2, title: 'Berserk', status: 'Laufend', tags: 'Action, Fantasy' }],
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

describe('Dashboard: genre filter and statistics tools', () => {
  const user = { id: 1, username: 'anna', role: 'editor' };

  it('the toolbar offers the collection genres and ?tags= filters the shelf', () => {
    renderDashboard('/?tags=Fantasy', user);
    const select = document.getElementById('filter-tag-select');
    expect(select).toBeTruthy();
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'Action', 'Shounen']);
    expect(screen.getByRole('button', { name: 'Genre-Filter „Fantasy“ entfernen' })).toBeTruthy();
    expect(screen.getByText('Berserk')).toBeTruthy();
    expect(screen.queryByText('Naruto')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Genre-Filter „Fantasy“ entfernen' }));
    expect(screen.getByText('Naruto')).toBeTruthy();
  });

  it('a change made by a statistics tool reloads the shelf, the shopping list and the radar', async () => {
    renderDashboard('/?view=stats', user);
    await waitFor(() => expect(state.statsProps).not.toBeNull());
    state.mangaList.fetchMangas.mockClear();
    state.statsProps.onDataChanged();
    expect(state.mangaList.fetchMangas).toHaveBeenCalledTimes(1);
    expect(state.shopping.fetchShoppingList).toHaveBeenCalled();
    expect(state.radar.fetchReleaseRadar).toHaveBeenCalled();
  });
});
