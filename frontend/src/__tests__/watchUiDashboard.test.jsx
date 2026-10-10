// "Anderen Anime suchen…" of the match dialog through the Dashboard: the add dialog answers the search the dialog started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const state = vi.hoisted(() => {
  vi.stubEnv('VITE_APP_MODE', 'app');
  return { mangaList: null, shopping: null, radar: null };
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

import Dashboard from '../Dashboard';
import { fakeResponse } from './fakeResponse';
import { EDITOR, fakeBridge } from './watchFakes';
import { UNMATCHED_KEY, loadUnmatched, resetUnmatchedView } from '../app/watch/watchState';

const entry = (over = {}) => ({
  id: 1, title: 'Frieren', title_de: null, format: 'TV', season_year: 2023, episodes: 28, cover_image: null, anilist_id: 154587, mal_id: 52991,
  manual: false, next_airing: null, my_progress: { status: 'Schaue', episodes_watched: 3, score: null, notes: null }, progress_users: [], ...over
});
const KUSURIYA = entry({ id: 4, title: 'Kusuriya no Hitorigoto', episodes: 24, anilist_id: 161645, mal_id: 54492, my_progress: null });
const PHARMACIST = {
  external_id: 'GSERIES003', series_title: 'The Apothecary Diaries', season: 1, episode: 3, episodes_watched: 3, reason: 'no_match', candidates: []
};
const REMEMBER = { service: 'crunchyroll', external_id: 'GSERIES003', season: 1 };
const HITS = [
  { anilist_id: 999001, mal_id: null, title: { preferred: 'Kusuriya no Hitorigoto 2' }, format: 'TV', season_year: 2025, episodes: 24, in_collection_id: null },
  { anilist_id: 161645, mal_id: 54492, title: { preferred: 'Kusuriya no Hitorigoto' }, format: 'TV', season_year: 2023, episodes: 24, in_collection_id: 4 }
];

let fake;
let calls;
let created;

const pathOf = (url) => String(url).replace(/^https?:\/\/[^/]+/, '');
const posted = (path) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);

const renderDashboard = () => render(
  <MemoryRouter initialEntries={['/?view=anime']}>
    <Routes><Route path="/" element={<Dashboard user={EDITOR} onLogout={vi.fn()} />} /></Routes>
  </MemoryRouter>
);

const openMatch = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Zuordnen' }));
  return screen.findByRole('dialog', { name: 'Crunchyroll-Verlauf zuordnen' });
};

const openSearch = async (match) => {
  fireEvent.click(within(match).getByRole('button', { name: 'Anderen Anime suchen…' }));
  const add = await screen.findByRole('dialog', { name: 'Anime hinzufügen' });
  await within(add).findByText('Kusuriya no Hitorigoto 2');
  return add;
};

beforeEach(async () => {
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
  calls = [];
  created = () => fakeResponse(201, entry({ id: 9, title: 'Kusuriya no Hitorigoto 2', anilist_id: 999001, mal_id: null, my_progress: null, progress: [] }));
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const path = pathOf(url);
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
    if (path === '/api/anime') return method === 'POST' ? created() : fakeResponse(200, [entry(), KUSURIYA]);
    if (path.startsWith('/api/anime/search?')) return fakeResponse(200, { results: HITS, sources_used: ['anilist'], partial: false });
    if (path === '/api/anime/sync/run') return fakeResponse(200, { anilist: { ran: false, pulled: 0, changed: false }, watch: { auto_add: true, last_at: null } });
    const watched = /^\/api\/anime\/(\d+)\/watched$/.exec(path);
    if (watched) return fakeResponse(200, { anime_id: Number(watched[1]), progress: { status: 'Schaue', episodes_watched: 3 }, previous: null });
    if (path === '/api/anime/4') return fakeResponse(200, { ...KUSURIYA, description: null, relations: [], progress: [] });
    return fakeResponse(200, {});
  }));
  fake = fakeBridge();
  window.mangashelfNative = fake.bridge.native;
  fake.prefs.set(UNMATCHED_KEY, JSON.stringify({ scope: 'srv-1:3', items: [PHARMACIST] }));
  await loadUnmatched(fake.bridge, 'srv-1:3');
});

afterEach(() => {
  resetUnmatchedView();
  vi.unstubAllGlobals();
  delete window.mangashelfNative;
  localStorage.clear();
});

describe('Dashboard: "Anderen Anime suchen…" in the match dialog', () => {
  it('opens "Anime hinzufügen" with the series title above the dialog; an added hit is assigned with remember', async () => {
    renderDashboard();
    const match = await openMatch();
    const add = await openSearch(match);
    expect(within(add).getByLabelText('Titel suchen').value).toBe('The Apothecary Diaries');
    expect(calls.some((c) => c.path === `/api/anime/search?q=${encodeURIComponent('The Apothecary Diaries')}`)).toBe(true);
    expect(match.isConnected).toBe(true);

    fireEvent.click(within(add).getByRole('button', { name: /Hinzufügen/ }));
    await waitFor(() => expect(posted('/api/anime/9/watched')).toEqual([{ episode: 3, remember: REMEMBER }]));
    expect(posted('/api/anime')).toEqual([{ anilist_id: 999001, manga_id: null }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((c) => c.path === '/api/anime/9')).toBe(false);
  });

  it('closing the add dialog answers nothing: the match dialog stays and nothing is saved; an entry already in the list is assigned', async () => {
    renderDashboard();
    const match = await openMatch();
    let add = await openSearch(match);
    fireEvent.click(within(add).getByRole('button', { name: 'Schließen' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Anime hinzufügen' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Crunchyroll-Verlauf zuordnen' })).toBe(match);
    expect(calls.filter((c) => c.method === 'POST' && /^\/api\/anime(\/\d+\/watched)?$/.test(c.path))).toEqual([]);

    add = await openSearch(match);
    fireEvent.click(within(add).getByRole('button', { name: /schon im Regal/ }));
    await waitFor(() => expect(posted('/api/anime/4/watched')).toEqual([{ episode: 3, remember: REMEMBER }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((c) => c.path === '/api/anime/4')).toBe(false);
  });

  it('a hit that exists by now (409 with its id) is assigned to that entry', async () => {
    created = () => fakeResponse(409, { error: 'Dieser Anime ist schon in der Liste', code: 'DUPLICATE', id: 4 });
    renderDashboard();
    const match = await openMatch();
    const add = await openSearch(match);
    fireEvent.click(within(add).getByRole('button', { name: /Hinzufügen/ }));
    await waitFor(() => expect(posted('/api/anime/4/watched')).toEqual([{ episode: 3, remember: REMEMBER }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((c) => c.path === '/api/anime/4')).toBe(false);
  });

  it('without a pending match the toolbar\'s add dialog opens an existing entry as before and an added hit is only added', async () => {
    resetUnmatchedView();
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Anime hinzufügen' }));
    let add = await screen.findByRole('dialog', { name: 'Anime hinzufügen' });
    fireEvent.change(within(add).getByLabelText('Titel suchen'), { target: { value: 'Kusuriya' } });
    fireEvent.click(within(add).getByRole('button', { name: 'Suchen' }));
    fireEvent.click(await within(add).findByRole('button', { name: /Hinzufügen/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Anime hinzufügen' })).toBeNull());
    expect(posted('/api/anime')).toEqual([{ anilist_id: 999001, manga_id: null }]);

    fireEvent.click(screen.getByRole('button', { name: 'Anime hinzufügen' }));
    add = await screen.findByRole('dialog', { name: 'Anime hinzufügen' });
    fireEvent.change(within(add).getByLabelText('Titel suchen'), { target: { value: 'Kusuriya' } });
    fireEvent.click(within(add).getByRole('button', { name: 'Suchen' }));
    fireEvent.click(await within(add).findByRole('button', { name: /schon im Regal/ }));
    expect(await screen.findByRole('dialog', { name: 'Kusuriya no Hitorigoto' })).toBeTruthy();
    expect(calls.filter((c) => /\/watched$/.test(c.path))).toEqual([]);
  });
});
