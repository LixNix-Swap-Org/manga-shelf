// The share dialog stays visible and keeps focus while the lazy "Anime hinzufügen" dialog is still loading.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const state = vi.hoisted(() => {
  let release;
  const chunk = new Promise((resolve) => { release = resolve; });
  return { chunk, releaseChunk: () => release(), mangaList: null, shopping: null, radar: null };
});

vi.mock('../hooks/useMangaList', () => ({ default: () => state.mangaList }));
vi.mock('../hooks/useOfflineStatus', () => ({
  default: () => ({
    networkOffline: false, setNetworkOffline: vi.fn(), isOfflineMode: false, offlineCopyAt: null,
    refreshingCopy: false, refreshError: null, handleRefreshOfflineCopy: vi.fn()
  })
}));
vi.mock('../hooks/useShoppingList', () => ({ default: () => state.shopping }));
vi.mock('../hooks/useReleaseRadar', () => ({ default: () => state.radar }));
vi.mock('../hooks/usePwaInstall', () => ({ default: () => ({ isInstallable: false, isInstalledApp: false, handleInstallClick: vi.fn() }) }));
// a lazy chunk that loads only when the test says so
vi.mock('../components/modals/AddAnimeModal', async () => {
  await state.chunk;
  const { default: useDialogA11y } = await import('../hooks/useDialogA11y');
  return {
    default: function FakeAddAnime({ onClose, returnFocusRef }) {
      const ref = useDialogA11y(true, { onClose, returnFocusRef });
      return (
        <div ref={ref} role="dialog" aria-modal="true" aria-label="Anime hinzufügen" tabIndex={-1}>
          <button type="button" onClick={onClose}>Hinzufügen schließen</button>
        </div>
      );
    }
  };
});

import Dashboard from '../Dashboard';
import { fakeResponse } from './fakeResponse';

const CR_TEXT = 'Frieren E7 auf Crunchyroll https://www.crunchyroll.com/de/watch/GG1U2Q5MW/the-hero-party';

beforeEach(() => {
  try { sessionStorage.clear(); localStorage.clear(); } catch (_) {}
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
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url === '/api/anime') return fakeResponse(200, []);
    if (url === '/api/anime/resolve-link') {
      return fakeResponse(200, {
        service: 'crunchyroll', kind: 'episode', external_id: 'GG1U2Q5MW', series_id: null, series_title: 'Frieren', episode: 7, episode_source: 'text',
        anime_id: null, match: null, candidates: [], entry: null, url: 'https://www.crunchyroll.com/watch/GG1U2Q5MW/the-hero-party', page_checked: false
      });
    }
    return fakeResponse(200, {});
  }));
});

describe('Dashboard: share dialog and the lazy add dialog', () => {
  it('"Zur Liste hinzufügen" leaves the share dialog shown while the chunk loads; closing the add dialog returns focus into it', async () => {
    render(
      <MemoryRouter initialEntries={['/?share_text=' + encodeURIComponent(CR_TEXT)]}>
        <Routes><Route path="/" element={<Dashboard user={{ id: 1, username: 'anna', role: 'editor' }} onLogout={vi.fn()} />} /></Routes>
      </MemoryRouter>
    );
    const add = await screen.findByRole('button', { name: /Zur Liste hinzufügen/ });
    const share = screen.getByRole('dialog');
    add.focus();
    fireEvent.click(add);
    await act(async () => { await Promise.resolve(); });
    // one shared Suspense boundary hid the open dialog (display: none) while the add dialog's chunk loaded
    expect(share.style.display).not.toBe('none');
    expect(document.activeElement).toBe(add);

    // a browser moves focus off a hidden button: with the opener gone the add dialog falls back to the share dialog
    act(() => { add.blur(); });
    await act(async () => { state.releaseChunk(); await state.chunk; });
    fireEvent.click(await screen.findByRole('button', { name: 'Hinzufügen schließen' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Anime hinzufügen' })).toBeNull());
    expect(share.contains(document.activeElement)).toBe(true);
  });
});
