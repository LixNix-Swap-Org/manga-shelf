// Dashboard wiring of the extracted hooks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const state = vi.hoisted(() => ({ local: false, mangaList: null, shopping: null, radar: null, outcome: null }));

vi.mock('../utils/api', async (importOriginal) => ({ ...(await importOriginal()), isLocalMode: () => state.local }));
vi.mock('../hooks/useMangaList', () => ({ default: () => state.mangaList }));
vi.mock('../hooks/useOfflineStatus', () => ({
  default: () => ({
    networkOffline: false, setNetworkOffline: vi.fn(), isOfflineMode: false, offlineCopyAt: null,
    refreshingCopy: false, refreshError: null, handleRefreshOfflineCopy: vi.fn()
  })
}));
vi.mock('../hooks/useShoppingList', () => ({ default: () => state.shopping }));
vi.mock('../hooks/useReleaseRadar', () => ({ default: () => state.radar }));
vi.mock('../hooks/usePwaInstall', async (importOriginal) => ({ ...(await importOriginal()), default: () => ({ isInstallable: false, isInstalledApp: false, handleInstallClick: vi.fn() }) }));
vi.mock('../components/modals/AccountModal', () => ({
  default: ({ isOpen, initialTab }) => (isOpen ? <div role="dialog" aria-label="Konto">Konto-Tab {initialTab}</div> : null)
}));
vi.mock('../components/modals/BackupExportModal', () => ({
  default: ({ onReplaced }) => <button type="button" onClick={() => onReplaced()}>Eingespielt</button>
}));
vi.mock('../components/dashboard/ReleaseRadarView', () => ({ default: () => null }));

import Dashboard from '../Dashboard';
import { fakeResponse } from './fakeResponse';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search} ${JSON.stringify(location.state)}`}</output>;
}

const renderAt = (entry, { user = { id: 1, username: 'anna', role: 'editor' }, onLocalReplaced } = {}) => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/" element={<Dashboard user={user} onLogout={vi.fn()} onLocalReplaced={onLocalReplaced} />} />
      <Route path="/server" element={<p>Geräteseite</p>} />
    </Routes>
    <LocationProbe />
  </MemoryRouter>
);

beforeEach(() => {
  state.local = false;
  vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(404, { error: 'Nicht gefunden' })));
  state.mangaList = { mangas: [], loading: false, refreshing: false, error: null, fetchMangas: vi.fn(), handleDeleteManga: vi.fn(async () => true) };
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
afterEach(() => { vi.unstubAllGlobals(); });

describe('Dashboard: wiring of round 5', () => {
  it('the navigation state { openAccount: "keys" } opens the keys tab once and is cleared, the view stays', async () => {
    renderAt({ pathname: '/', search: '?view=shopping', state: { openAccount: 'keys' } });
    expect((await screen.findByRole('dialog', { name: 'Konto' })).textContent).toBe('Konto-Tab keys');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/?view=shopping null'));
  });

  it('without that state no dialog opens', async () => {
    renderAt({ pathname: '/', state: { other: true } });
    await screen.findByTestId('location');
    expect(screen.queryByRole('dialog', { name: 'Konto' })).toBeNull();
  });

  it('local mode: a restore from the header runs App\'s reload, then the shelf reloads its data', async () => {
    state.local = true;
    const onLocalReplaced = vi.fn(async () => ({ status: 'local', user: { id: 2, username: 'Ich', role: 'admin', local: true } }));
    renderAt('/', { user: { id: 1, username: 'Ich', role: 'admin', local: true }, onLocalReplaced });
    const fetchesBefore = state.mangaList.fetchMangas.mock.calls.length;
    const radarBefore = state.radar.fetchReleaseRadar.mock.calls.length;
    const publisherCalls = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/publishers')).length;
    await waitFor(() => expect(publisherCalls()).toBeGreaterThan(0));
    const publishersBefore = publisherCalls();
    fireEvent.click(document.getElementById('btn-open-backups'));
    fireEvent.click(await screen.findByRole('button', { name: 'Eingespielt' }));
    await waitFor(() => expect(state.radar.fetchReleaseRadar.mock.calls.length).toBeGreaterThan(radarBefore));
    expect(onLocalReplaced).toHaveBeenCalledTimes(1);
    expect(state.mangaList.fetchMangas.mock.calls.length).toBeGreaterThan(fetchesBefore);
    expect(state.shopping.fetchShoppingList).toHaveBeenCalled();
    expect(publisherCalls()).toBeGreaterThan(publishersBefore);
    expect(screen.getByTestId('location').textContent).toMatch(/^\/ /);
  });

  it('local mode: a restore that leaves no collection goes to the device screen without reloading the shelf', async () => {
    state.local = true;
    const onLocalReplaced = vi.fn(async () => ({ status: 'localFailed', user: null }));
    renderAt('/', { user: { id: 1, username: 'Ich', role: 'admin', local: true }, onLocalReplaced });
    const radarBefore = state.radar.fetchReleaseRadar.mock.calls.length;
    fireEvent.click(document.getElementById('btn-open-backups'));
    fireEvent.click(await screen.findByRole('button', { name: 'Eingespielt' }));
    expect(await screen.findByText('Geräteseite')).toBeTruthy();
    expect(state.radar.fetchReleaseRadar.mock.calls.length).toBe(radarBefore);
  });
});
