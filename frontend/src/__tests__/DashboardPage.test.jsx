// Covers the dashboard page: loading, routing, scanner and offline behaviour.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';

const state = vi.hoisted(() => ({
  offline: false,
  scanCode: '9783551000001',
  mangaList: null,
  shopping: null,
  radar: null,
  shoppingCalls: [],
  radarCalls: [],
  localHits: new Map()
}));

vi.mock('../utils/offlineStore', async (importOriginal) => ({
  ...(await importOriginal()),
  lookupLocalIsbn: vi.fn(async (isbn) => state.localHits.get(isbn) ?? null)
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
import { buildShareLink, receiveDeepLink } from '../app/deepLink';

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
  state.localHits.clear();
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

// the bottom navigation stays mounted (hidden) above 640 px with its own scanner; the header's is the visible one
const headerScan = () => within(document.querySelector('header[data-sticky-header]')).getByText('Scan-Test');

describe('Dashboard', () => {
  it('the header stays sticky: no ancestor clips with overflow hidden, and it pads itself below the status bar', () => {
    renderDashboard('/');
    const header = document.querySelector('header[data-sticky-header]');
    expect(header.className).toMatch(/(^| )sticky( |$)/);
    expect(header.className).toContain('top-0');
    expect(header.className).toContain('pt-[max(0.75rem,env(safe-area-inset-top))]');
    for (let el = header.parentElement; el && el !== document.body; el = el.parentElement) {
      expect(el.className || '').not.toMatch(/overflow(-[xy])?-(hidden|auto|scroll)/);
    }
    expect(header.parentElement.className).toContain('overflow-x-clip');
  });

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
    fireEvent.click(document.getElementById('btn-nav-shopping'));
    expect(currentUrl()).toBe('/?view=shopping');
    expect(state.shopping.fetchShoppingList).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Zurück zum Regal'));
    expect(currentUrl()).toBe('/');

    fireEvent.click(document.getElementById('btn-nav-radar'));
    expect(currentUrl()).toBe('/?view=radar');
    expect(state.radar.fetchReleaseRadar).toHaveBeenCalled();
    expect(state.radar.fetchMangaPassionReleases).toHaveBeenCalledTimes(1);
    fireEvent.click(document.getElementById('btn-nav-shopping'));
    expect(currentUrl()).toBe('/?view=shopping');
  });

  it('a view chosen in the app opens at its top; the shelf returns to its saved offset and Back keeps the browser\'s', () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    vi.stubGlobal('scrollY', 600);
    try {
      renderDashboard('/');
      fireEvent.click(document.getElementById('btn-nav-shopping'));
      expect(currentUrl()).toBe('/?view=shopping');
      expect(scrollTo).toHaveBeenCalledWith(0, 0);

      scrollTo.mockClear();
      fireEvent.click(document.getElementById('btn-nav-shelf'));
      expect(currentUrl()).toBe('/');
      expect(scrollTo).not.toHaveBeenCalledWith(0, 0);
      expect(scrollTo).toHaveBeenCalledWith(0, 600);

      scrollTo.mockClear();
      fireEvent.click(document.getElementById('btn-nav-shelf'));
      expect(scrollTo).not.toHaveBeenCalled();

      fireEvent.click(document.getElementById('btn-nav-radar'));
      expect(scrollTo).toHaveBeenCalledWith(0, 0);
      scrollTo.mockClear();
      act(() => navigateTo(-1));
      expect(currentUrl()).toBe('/');
      expect(scrollTo).not.toHaveBeenCalledWith(0, 0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a scan with several similar series offers a choice instead of searching for the volume title', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {
      found: true, isbn: state.scanCode, book: { title: 'Die Prophezeiung', series: 'Naruto' }, matched_manga: null,
      matched_candidates: [{ id: 1, title: 'Naruto Gaiden' }, { id: 2, title: 'Naruto Shippuden' }]
    })));
    renderDashboard('/');
    fireEvent.click(headerScan());
    expect(await screen.findByText('Mehrere Reihen passen – bitte auswählen')).toBeTruthy();
    expect(document.getElementById('main-search-input').value).toBe('');
    fireEvent.click(screen.getByText('Naruto Shippuden'));
    expect(currentUrl()).toBe('/manga/2');
  });

  it('choosing a series in the scan dialog replaces the dialog\'s history entry: one Back returns to the shelf', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {
      found: true, isbn: state.scanCode, book: { title: 'Die Prophezeiung', series: 'Naruto' }, matched_manga: null,
      matched_candidates: [{ id: 1, title: 'Naruto Gaiden' }, { id: 2, title: 'Naruto Shippuden' }]
    })));
    window.history.replaceState(null, '', '/');
    const back = vi.spyOn(window.history, 'back');
    const length = window.history.length;
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Dashboard user={{ id: 1, username: 'anna', role: 'editor' }} onLogout={vi.fn()} />} />
          <Route path="/manga/:id" element={<div>Detailseite</div>} />
        </Routes>
      </BrowserRouter>
    );
    fireEvent.click(headerScan());
    await screen.findByText('Mehrere Reihen passen – bitte auswählen');
    expect(window.history.length).toBe(length + 1);
    fireEvent.click(screen.getByText('Naruto Shippuden'));
    expect(await screen.findByText('Detailseite')).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(window.location.pathname).toBe('/manga/2');
    expect(window.history.length).toBe(length + 1);
    expect(back).not.toHaveBeenCalled();
    back.mockRestore();
  });

  it('an unknown ISBN shows the server message, keeps the digits out of the search and offers to add', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { found: false, isbn: state.scanCode, message: 'Keine Metadaten für diese ISBN gefunden.' })));
    renderDashboard('/');
    fireEvent.click(headerScan());
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
    fireEvent.click(headerScan());
    expect(await screen.findByText(`ISBN ${state.scanCode} wird gesucht...`)).toBeTruthy();
    await act(async () => { answer(json(200, { found: false, isbn: state.scanCode, message: 'Nichts gefunden.' })); });
    expect(await screen.findByText('Nichts gefunden.')).toBeTruthy();
    expect(screen.queryByText(/wird gesucht/)).toBeNull();
    expect(screen.getByText('Nichts gefunden.').closest('[role="status"]')).toBeTruthy();
  });

  it('a gateway error page and a network failure give a readable message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(502)));
    renderDashboard('/');
    fireEvent.click(headerScan());
    expect(await screen.findByText(/ISBN-Suche fehlgeschlagen/)).toBeTruthy();
  });

  it('scanning offline says the lookup needs the server', async () => {
    state.offline = true;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderDashboard('/', { id: 1, username: 'anna', role: 'visitor', realRole: 'editor', offline: true });
    fireEvent.click(headerScan());
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
    fireEvent.click(headerScan());
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

describe('Dashboard: local scan and share target', () => {
  const localHit = { manga: { id: 4, title: 'Berserk' }, volume: { id: 9, status: 'Vorhanden' }, syncedAt: 1 };

  it('a volume of the offline copy opens its series without asking the server, also offline', async () => {
    state.localHits.set(state.scanCode, localHit);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = renderDashboard('/');
    fireEvent.click(headerScan());
    await waitFor(() => expect(currentUrl()).toBe('/manga/4'));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/lookup/isbn'))).toBe(false);
    unmount();

    state.offline = true;
    renderDashboard('/', { id: 1, username: 'anna', role: 'visitor', realRole: 'editor', offline: true });
    fireEvent.click(headerScan());
    await waitFor(() => expect(currentUrl()).toBe('/manga/4'));
    expect(screen.queryByText(/braucht eine Verbindung/)).toBeNull();
  });

  it('a shared text with an ISBN is looked up like a scan and the share parameters leave the URL', async () => {
    state.localHits.set('9783551000002', localHit);
    vi.stubGlobal('fetch', vi.fn());
    renderDashboard('/?share_text=' + encodeURIComponent('Schau mal: ISBN 978-3-551-00000-2'));
    await waitFor(() => expect(currentUrl()).toBe('/manga/4'));
  });

  it('a shared text without an ISBN says so and the URL is cleaned; a Manga Passion link offers to add the series', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { unmount } = renderDashboard('/?view=shopping&share_text=hallo');
    expect(await screen.findByText('Im geteilten Text wurde keine ISBN gefunden.')).toBeTruthy();
    expect(currentUrl()).toBe('/?view=shopping');
    unmount();

    renderDashboard('/?share_url=' + encodeURIComponent('https://www.manga-passion.de/editions/123/berserk'));
    expect(await screen.findByText(/Manga-Passion-Link erkannt/)).toBeTruthy();
    expect(currentUrl()).toBe('/');
    fireEvent.click(screen.getByRole('button', { name: 'Reihe anlegen' }));
    expect(await screen.findByText('Anlegen-Dialog leer')).toBeTruthy();
  });

  const CR_TEXT = 'Frieren E7 auf Crunchyroll https://www.crunchyroll.com/de/watch/GG1U2Q5MW/the-hero-party';
  const animeApi = (calls) => vi.fn(async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    if (url === '/api/anime') return json(200, [{ id: 1, title: 'Frieren', episodes: 28, my_progress: { status: 'Schaue', episodes_watched: 6 }, progress_users: [] }]);
    if (url === '/api/anime/resolve-link') {
      return json(200, { service: 'crunchyroll', kind: 'episode', external_id: 'GG1U2Q5MW', series_id: null, series_title: 'Frieren', episode: 7, episode_source: 'text', anime_id: 1, match: 'title', candidates: [], url: 'https://www.crunchyroll.com/watch/GG1U2Q5MW/the-hero-party', page_checked: false });
    }
    return json(200, {});
  });

  it('a shared Crunchyroll link opens the anime tab and asks "Frieren, Folge 7 gesehen?" instead of looking for an ISBN', async () => {
    const calls = [];
    vi.stubGlobal('fetch', animeApi(calls));
    renderDashboard('/?share_text=' + encodeURIComponent(CR_TEXT));
    expect(await screen.findByRole('heading', { name: 'Frieren, Folge 7 gesehen?' })).toBeTruthy();
    expect(currentUrl()).toBe('/?view=anime');
    expect(calls).toContain('POST /api/anime/resolve-link');
    expect(screen.queryByText('Im geteilten Text wurde keine ISBN gefunden.')).toBeNull();
  });

  it('"Zur Liste hinzufügen" searches the series title; the added entry is then the one the episode is saved for', async () => {
    const calls = [];
    let list = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      calls.push(`${method} ${url}`);
      if (url === '/api/anime' && method === 'POST') {
        list = [{ id: 5, title: 'Frieren', episodes: 28, my_progress: null, progress_users: [] }];
        return json(200, { ...list[0], progress: [] });
      }
      if (url === '/api/anime') return json(200, list);
      if (url === '/api/anime/resolve-link') {
        return json(200, { service: 'crunchyroll', kind: 'episode', external_id: 'GG1U2Q5MW', series_id: 'GG5H5XQX4', series_title: 'Frieren', episode: 7, episode_source: 'text', anime_id: null, match: null, candidates: [], url: 'https://www.crunchyroll.com/watch/GG1U2Q5MW/the-hero-party', page_checked: false });
      }
      if (url.startsWith('/api/anime/search')) return json(200, { results: [{ anilist_id: 154587, mal_id: null, title: { preferred: 'Frieren' }, in_collection_id: null }], sources_used: ['anilist'], partial: false });
      if (url === '/api/anime/5/watched') return json(200, { anime_id: 5, progress: { status: 'Schaue', episodes_watched: 7, resume_url: null, resume_episode: 7 } });
      return json(200, {});
    }));
    renderDashboard('/?share_text=' + encodeURIComponent(CR_TEXT));
    fireEvent.click(await screen.findByRole('button', { name: /Zur Liste hinzufügen/ }));
    expect(await screen.findByDisplayValue('Frieren')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.startsWith('GET /api/anime/search?q=Frieren'))).toBe(true));
    fireEvent.click(await screen.findByRole('button', { name: /^Hinzufügen/ }));
    expect(await screen.findByRole('heading', { name: 'Frieren, Folge 7 gesehen?' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('heading', { name: /Anime hinzufügen/ })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Ja, gesehen' }));
    await waitFor(() => expect(calls).toContain('POST /api/anime/5/watched'));
  });

  it('visitors get a note for a shared streaming link and no request', async () => {
    const calls = [];
    vi.stubGlobal('fetch', animeApi(calls));
    renderDashboard('/?share_text=' + encodeURIComponent(CR_TEXT), { id: 3, username: 'vera', role: 'visitor' });
    expect(await screen.findByText('Nur Bearbeiter können ihren Fortschritt speichern.')).toBeTruthy();
    expect(calls).not.toContain('POST /api/anime/resolve-link');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a share from the app shell (deep link) reaches the mounted dashboard; a share without a streaming link is read for an ISBN', async () => {
    const calls = [];
    vi.stubGlobal('fetch', animeApi(calls));
    renderDashboard('/');
    act(() => { receiveDeepLink(buildShareLink({ text: CR_TEXT })); });
    expect(await screen.findByRole('heading', { name: 'Frieren, Folge 7 gesehen?' })).toBeTruthy();
    expect(currentUrl()).toBe('/?view=anime');
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    act(() => { receiveDeepLink(buildShareLink({ text: 'Notiz ohne Nummer' })); });
    expect(await screen.findByText('Im geteilten Text wurde keine ISBN gefunden.')).toBeTruthy();
  });
});

describe('Dashboard: foreground refresh', () => {
  it('reloads the shelf when the app returns after more than a minute in the background, not after a short switch', () => {
    let t = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
    const setVisibility = (value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    try {
      renderDashboard('/');
      state.mangaList.fetchMangas.mockClear();
      setVisibility('hidden');
      t += 5_000;
      setVisibility('visible');
      expect(state.mangaList.fetchMangas).not.toHaveBeenCalled();
      setVisibility('hidden');
      t += 61_000;
      setVisibility('visible');
      expect(state.mangaList.fetchMangas).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      delete document.visibilityState;
    }
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

describe('Dashboard: shelf filters in the URL', () => {
  const shelf = [
    { id: 1, title: 'Naruto', author: 'Masashi Kishimoto', publisher: 'Carlsen Manga', status: 'Laufend', owned_volumes: 1, regular_owned: 1, total_volumes: 72, missing_count: 2 },
    { id: 2, title: 'Death Note', author: 'Tsugumi Ohba, Takeshi Obata', publisher: 'Tokyopop', status: 'Abgeschlossen', owned_volumes: 12, regular_owned: 12, total_volumes: 12 },
    { id: 3, title: 'Bakuman', author: 'Tsugumi Ohba / Takeshi Obata', publisher: 'Tokyopop', status: 'Abgeschlossen', owned_volumes: 3, regular_owned: 3, total_volumes: 20, collecting: 'abgebrochen' }
  ];
  const titlesShown = () => ['Naruto', 'Death Note', 'Bakuman'].filter(t => screen.queryAllByText(t).length > 0);

  beforeEach(() => { state.mangaList = { ...state.mangaList, mangas: shelf }; });

  it('?author= and ?collect= of a link filter the shelf; the author chip clears its filter and the URL', async () => {
    renderDashboard('/?author=Tsugumi%20Ohba&collect=complete');
    expect(titlesShown()).toEqual(['Death Note']);
    expect(screen.getByLabelText('Sammelstand filtern').value).toBe('complete');
    fireEvent.click(screen.getByRole('button', { name: 'Autor-Filter „Tsugumi Ohba“ entfernen' }));
    await waitFor(() => expect(currentUrl()).toBe('/?collect=complete'));
    expect(titlesShown()).toEqual(['Death Note']);
  });

  it('a filter change replaces the history entry and keeps ?view=; localStorage stays the default without URL values', async () => {
    localStorage.setItem('mangashelf_collect_filter', 'gaps');
    renderDashboard('/');
    expect(titlesShown()).toEqual(['Naruto']);
    expect(currentUrl()).toBe('/');
    fireEvent.change(screen.getByLabelText('Sammelstand filtern'), { target: { value: 'abgebrochen' } });
    await waitFor(() => expect(currentUrl()).toBe('/?collect=abgebrochen'));
    expect(titlesShown()).toEqual(['Bakuman']);
    fireEvent.click(document.getElementById('btn-nav-shopping'));
    expect(currentUrl()).toBe('/?collect=abgebrochen&view=shopping');
    act(() => navigateTo(-1));
    expect(currentUrl()).toBe('/?collect=abgebrochen');
    expect(localStorage.getItem('mangashelf_collect_filter')).toBe('abgebrochen');
  });

  it('grouping by publisher shows a section heading per publisher with its count', async () => {
    renderDashboard('/?group=publisher');
    const sections = () => [...document.querySelectorAll('section[aria-labelledby^="shelf-group-"]')];
    expect(sections().map(s => s.querySelector('h3').textContent)).toEqual(['Carlsen Manga1 Reihe', 'TOKYOPOP2 Reihen']);
    expect(sections()[1].textContent).toContain('Death Note');
    fireEvent.change(screen.getByLabelText('Gruppieren'), { target: { value: 'none' } });
    await waitFor(() => expect(currentUrl()).toBe('/'));
    expect(sections()).toHaveLength(0);
  });
});
