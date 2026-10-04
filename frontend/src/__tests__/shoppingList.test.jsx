import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ShoppingListView from '../components/dashboard/ShoppingListView';
import { SCAN_LIST_KEY } from '../utils/scanHelpers';
import { normalizePubName } from '../utils/volumeHelpers';
import { SESSION_EXPIRED_EVENT } from '../hooks/useMangaList';
import { runBeforeLogout } from '../appShell';
import { fakeResponse, htmlResponse } from './fakeResponse';
import Toaster from '../components/common/Toaster';
import { recordToasts } from './toastLog';
import { notify } from '../utils/notify';

// The offline copy's ISBN index: `localHits` maps an ISBN to what lookupLocalIsbn answers
const localHits = vi.hoisted(() => new Map());
vi.mock('../utils/offlineStore', async (importOriginal) => ({
  ...(await importOriginal()),
  lookupLocalIsbn: vi.fn(async (isbn) => localHits.get(isbn) ?? null)
}));

// The real scanner needs a camera photo; the stub reports the ISBN stored in `nextScan`
let nextScan = '';
vi.mock('../components/common/BarcodeScannerButton', () => ({
  default: ({ onDetected, buttonText }) => (
    <button type="button" onClick={() => onDetected(nextScan)}>{buttonText}</button>
  )
}));

const row = (over = {}) => ({
  id: 1, manga_id: 9, volume_number: '1', isbn: '9783551000011', price: 7, status: 'Fehlt', type: 'volume', notes: null,
  priority: 0, target_price: null, manga_title: 'Berserk', manga_cover: null, effective_publisher: 'Carlsen Manga', ...over
});
const list = (items = [row(), row({ id: 2, volume_number: '2', isbn: '9783551000028' })], extra = {}) => ({
  total_missing: items.length, total_cost: 14,
  publishers: [{ publisher: 'Carlsen Manga', count: items.length, total_price: 14 }],
  items, others: [], ...extra
});
const response = (status, body) => fakeResponse(status, body);
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function props(over = {}) {
  return {
    shoppingData: list(),
    loadingShopping: false,
    fetchShoppingList: vi.fn(),
    fetchMangas: vi.fn(),
    isOfflineMode: false,
    offlineLastUpdated: null,
    syncPendingPurchases: vi.fn(async () => null),
    shoppingSearch: '',
    setShoppingSearch: vi.fn(),
    shoppingPublisherFilter: 'ALL',
    setShoppingPublisherFilter: vi.fn(),
    normalizePubName,
    setActiveMainView: vi.fn(),
    canEdit: true,
    handleQuickBuy: vi.fn(async () => 'ok'),
    buyingId: null,
    ...over
  };
}

function MangaPage() {
  const location = useLocation();
  return <p data-testid="detail">{JSON.stringify(location.state)}</p>;
}

function SearchProbe() {
  return <p data-testid="search">{useLocation().search}</p>;
}

function renderView(p = props(), { path = '/' } = {}) {
  const ui = (q) => (
    <>
      <MemoryRouter initialEntries={[path]}>
        <SearchProbe />
        <Routes>
          <Route path="/" element={<ShoppingListView {...q} />} />
          <Route path="/manga/:id" element={<MangaPage />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </>
  );
  const utils = render(ui(p));
  return { ...utils, props: p, rerenderWith: (q) => utils.rerender(ui(q)) };
}

const seedScans = (entries) => localStorage.setItem(SCAN_LIST_KEY, JSON.stringify({ savedAt: Date.now(), userId: null, entries }));
const scanEntries = () => Array.from(document.querySelectorAll('#shop-scan-list li'));
const scan = async (isbn) => {
  nextScan = isbn;
  fireEvent.click(screen.getByRole('button', { name: 'Laden-Scan' }));
  await flush();
  await flush();
};

let toasts;
beforeEach(() => {
  localStorage.clear();
  localHits.clear();
  toasts = recordToasts();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  toasts.stop();
  vi.useRealTimers();
});

describe('ShoppingListView scan list', () => {
  it('labels a scanned shopping-list volume with title and volume name', async () => {
    renderView();
    await scan('978-3-551-00001-1');
    expect(scanEntries()[0].textContent).toContain('Berserk Band 1');
    expect(scanEntries()[0].textContent).not.toContain('undefined');
  });

  it('books only successes and stops after a failure the hook already reported', async () => {
    seedScans([
      { isbn: '9783551000011', kind: 'buy', label: 'Berserk Band 1', itemId: 1 },
      { isbn: '9783551000028', kind: 'buy', label: 'Berserk Band 2', itemId: 2 }
    ]);
    const p = props({ handleQuickBuy: vi.fn(async (id) => (id === 1 ? 'failed' : 'ok')) });
    renderView(p);
    fireEvent.click(screen.getByRole('button', { name: '2 als gekauft abhaken' }));
    await flush();
    expect(p.handleQuickBuy).toHaveBeenCalledTimes(1);
    const [first, second] = scanEntries();
    expect(first.textContent).toContain('nicht gebucht');
    expect(first.querySelector('.line-through')).toBeNull();
    expect(second.querySelector('.line-through')).toBeNull();
    expect(screen.getByText(/0 von 2 gebucht, 1 nicht versucht/)).toBeTruthy();
    // the failed entry can be retried
    expect(screen.getByRole('button', { name: '2 als gekauft abhaken' })).toBeTruthy();
  });

  it('batch mode: marks ok and queued done, keeps going after a conflict, refreshes once', async () => {
    seedScans([
      { isbn: '1', kind: 'buy', label: 'A', itemId: 1 },
      { isbn: '2', kind: 'buy', label: 'B', itemId: 2 },
      { isbn: '3', kind: 'buy', label: 'C', itemId: 3 }
    ]);
    const outcomes = { 1: { status: 'ok' }, 2: { status: 'failed', error: 'Konflikt', httpStatus: 409 }, 3: { status: 'queued' } };
    const items = [row({ id: 1 }), row({ id: 2 }), row({ id: 3 })];
    const p = props({ shoppingData: list(items), handleQuickBuy: vi.fn(async (id, opts) => (opts?.batch ? outcomes[id] : 'ok')) });
    renderView(p);
    fireEvent.click(screen.getByRole('button', { name: '3 als gekauft abhaken' }));
    await flush();
    expect(p.handleQuickBuy).toHaveBeenCalledTimes(3);
    const [a, b, c] = scanEntries();
    expect(a.querySelector('.line-through')).not.toBeNull();
    expect(b.textContent).toContain('nicht gebucht: Konflikt');
    expect(c.textContent).toContain('(vorgemerkt)');
    expect(p.fetchShoppingList).toHaveBeenCalledTimes(1);
    expect(p.fetchMangas).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/2 von 3 gebucht, 1 vorgemerkt. Fehler: Konflikt/)).toBeTruthy();
  });

  it('keeps the scan list across unmount and drops open entries no longer on the list', async () => {
    const first = renderView();
    await scan('9783551000011');
    await scan('9783551000028');
    expect(scanEntries()).toHaveLength(2);
    first.unmount();

    renderView(props({ shoppingData: list([row()]) }));
    await flush();
    const entries = scanEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].textContent).toContain('Berserk Band 1');
  });

  it('a failed lookup is offline-unchecked and can be rechecked once online', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(response(200, {
        found: true, matched_manga: { id: 4, title: 'Naruto' },
        matched_volume: { id: 40, volume_number: '3', status: 'Vorhanden', owned_by_me: true }, book: {}
      }));
    vi.stubGlobal('fetch', fetchMock);
    renderView();
    await scan('9783551762931');
    let [entry] = scanEntries();
    expect(entry.dataset.kind).toBe('offline');
    expect(entry.textContent).toContain('offline, nicht geprüft');

    fireEvent.click(within(entry).getByRole('button', { name: 'Erneut prüfen' }));
    await flush();
    await flush();
    [entry] = scanEntries();
    expect(entry.dataset.kind).toBe('owned');
    expect(entry.textContent).toContain('Naruto Band 3');
    expect(scanEntries()).toHaveLength(1);
  });

  it('treats a 503 as offline and a 400 as a misread barcode', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(503, { error: 'down' }))
      .mockResolvedValueOnce(response(400, { error: 'Ungültige Prüfziffer' }));
    vi.stubGlobal('fetch', fetchMock);
    renderView();
    await scan('9783551762931');
    expect(scanEntries()[0].dataset.kind).toBe('offline');
    expect(toasts.messages('error')).toEqual([]);
    await scan('9783551762948');
    expect(toasts.messages('error')).toEqual(['Ungültige Prüfziffer']);
    expect(screen.getByRole('alert').textContent).toContain('Ungültige Prüfziffer');
    expect(scanEntries()).toHaveLength(1);
  });

  it('a 401 ends the session instead of being shown as offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(401, { error: 'Nicht angemeldet', code: 'SESSION_INVALID' })));
    const expired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    renderView();
    await scan('9783551762931');
    window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(scanEntries()).toHaveLength(0);
    expect(toasts.messages('error')).toEqual([]);
  });

  it('a 401 the client did not announce (auth proxy) is reported instead of dropping the scan silently', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(401, { error: 'Anmeldung am Proxy erforderlich' }))
      .mockResolvedValueOnce(htmlResponse(401));
    vi.stubGlobal('fetch', fetchMock);
    const expired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    renderView();
    await scan('9783551762931');
    await scan('9783551762948');
    window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
    expect(expired).not.toHaveBeenCalled();
    expect(scanEntries()).toHaveLength(0);
    expect(toasts.messages('error')).toEqual(['Anmeldung am Proxy erforderlich', 'Sitzung abgelaufen – bitte neu anmelden.']);
  });

  it('online: a hit of the offline copy is shown at once as provisional and replaced by the server answer', async () => {
    localHits.set('9783551762931', {
      manga: { id: 4, title: 'Naruto' },
      volume: { id: 40, status: 'Fehlt', owned_by_me: false, owners: [], display_title: 'Band 3' },
      syncedAt: Date.now() - 3 * 60 * 1000
    });
    let answer;
    const fetchMock = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    renderView();
    await scan('9783551762931');
    let [entry] = scanEntries();
    expect(entry.dataset.kind).toBe('check');
    expect(entry.textContent).toContain('Naruto Band 3 (Status Fehlt) (Stand Offline-Kopie vor 3 Min.)');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await scan('9783551762931');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer(response(200, {
        found: true, matched_manga: { id: 4, title: 'Naruto' },
        matched_volume: { id: 40, volume_number: '3', status: 'Vorhanden', owned_by_me: true }, book: {}
      }));
    });
    await flush();
    [entry] = scanEntries();
    expect(entry.dataset.kind).toBe('owned');
    expect(entry.textContent).not.toContain('Offline-Kopie');
    expect(within(entry).queryByRole('button', { name: 'Erneut prüfen' })).toBeNull();
  });

  it('offline: the offline copy answers alone', async () => {
    localHits.set('9783551762931', {
      manga: { id: 4, title: 'Naruto' },
      volume: { id: 40, status: 'Vorhanden', owned_by_me: true, owners: ['ed'], display_title: 'Band 3' },
      syncedAt: null
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      renderView();
      await scan('9783551762931');
    } finally {
      onLine.mockRestore();
    }
    const [entry] = scanEntries();
    expect(entry.dataset.kind).toBe('owned');
    expect(entry.textContent).toContain('Naruto Band 3 (offline geprüft)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a scan the server cannot answer falls back to the offline copy', async () => {
    localHits.set('9783551762931', {
      manga: { id: 4, title: 'Naruto' }, volume: { id: 40, status: 'Vorhanden', owned_by_me: true, display_title: 'Band 3' }, syncedAt: null
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    renderView();
    await scan('9783551762931');
    await flush();
    const [entry] = scanEntries();
    fireEvent.click(within(entry).getByRole('button', { name: 'Erneut prüfen' }));
    await flush();
    await flush();
    expect(scanEntries()[0].textContent).toContain('Naruto Band 3 (offline geprüft)');
  });

  it('keeps the scan list in localStorage, so it survives the app being killed', async () => {
    renderView();
    await scan('9783551000011');
    const saved = JSON.parse(localStorage.getItem(SCAN_LIST_KEY));
    expect(saved.entries.map((e) => e.isbn)).toEqual(['9783551000011']);
    expect(sessionStorage.getItem(SCAN_LIST_KEY)).toBeNull();
  });

  it('ignores a second scan of an ISBN that is still being looked up', async () => {
    let resolve;
    const fetchMock = vi.fn(() => new Promise((r) => { resolve = r; }));
    vi.stubGlobal('fetch', fetchMock);
    renderView();
    await scan('9783551762931');
    expect(scanEntries()[0].dataset.kind).toBe('pending');
    await scan('9783551762931');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(response(200, { found: false }));
    await flush();
    await flush();
    expect(scanEntries()[0].dataset.kind).toBe('unknown');
  });
});

describe('ShoppingListView app shortcut and foreground', () => {
  it('?scan=1 shows a big photo button that scans and can be closed', async () => {
    renderView(props(), { path: '/?view=shopping&scan=1' });
    expect(document.getElementById('shop-scan-start')).toBeTruthy();
    nextScan = '9783551000011';
    fireEvent.click(screen.getByRole('button', { name: 'Foto aufnehmen' }));
    await flush();
    expect(scanEntries()[0].textContent).toContain('Berserk Band 1');
    fireEvent.click(screen.getByRole('button', { name: 'Scan-Hinweis schließen' }));
    expect(document.getElementById('shop-scan-start')).toBeNull();
    expect(screen.getByTestId('search').textContent).toBe('?view=shopping');
  });

  it('reloads the list when the app returns after more than a minute in the background', () => {
    vi.useFakeTimers();
    const p = props();
    renderView(p);
    const setVisibility = (state) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    try {
      setVisibility('hidden');
      vi.advanceTimersByTime(30 * 1000);
      setVisibility('visible');
      expect(p.fetchShoppingList).not.toHaveBeenCalled();
      setVisibility('hidden');
      vi.advanceTimersByTime(61 * 1000);
      setVisibility('visible');
      expect(p.fetchShoppingList).toHaveBeenCalledTimes(1);
    } finally {
      delete document.visibilityState;
    }
  });
});

describe('ShoppingListView states and filters', () => {
  it('shows an error card, not "Alles komplett", when the first load failed', () => {
    const p = props({ shoppingData: null, shoppingError: 'server' });
    renderView(p);
    expect(screen.queryByText('Alles komplett im Regal!')).toBeNull();
    expect(screen.getByText('Einkaufsliste konnte nicht geladen werden')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(p.fetchShoppingList).toHaveBeenCalled();
  });

  it('shows the error card after a load without data even when the hook reports no error', () => {
    const p = props({ shoppingData: null, loadingShopping: true });
    const view = renderView(p);
    expect(screen.getByText('Einkaufsliste wird geladen...')).toBeTruthy();
    view.rerenderWith({ ...p, loadingShopping: false });
    expect(screen.getByText('Einkaufsliste konnte nicht geladen werden')).toBeTruthy();
    expect(screen.queryByText('Alles komplett im Regal!')).toBeNull();
  });

  it('shows "Alles komplett" only for a loaded empty list', () => {
    renderView(props({ shoppingData: list([]) }));
    expect(screen.getByText('Alles komplett im Regal!')).toBeTruthy();
  });

  it('shows a no-match card with a reset when the search hides every item', () => {
    const p = props({ shoppingSearch: 'zzzz' });
    renderView(p);
    expect(screen.getByText('Keine Treffer für diese Filter')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(p.setShoppingSearch).toHaveBeenCalledWith('');
    expect(p.setShoppingPublisherFilter).toHaveBeenCalledWith('ALL');
  });

  it('falls back to all publishers when the selected chip is gone and recounts chips', () => {
    const data = list([row()], { publishers: [{ publisher: 'Carlsen Manga', count: 3 }, { publisher: 'Panini Verlags GmbH', count: 1 }] });
    const p = props({ shoppingData: data, shoppingPublisherFilter: 'Panini Verlags GmbH' });
    renderView(p);
    expect(p.setShoppingPublisherFilter).toHaveBeenCalledWith('ALL');
    expect(screen.getAllByText('Berserk').length).toBeGreaterThan(0);
    expect(screen.queryByText('Panini Verlags GmbH')).toBeNull();
    const chip = screen.getByRole('button', { name: /Carlsen Manga/ });
    expect(chip.textContent).toContain('1');
  });

  it('shows the day of an older offline copy', () => {
    const ts = new Date(2020, 0, 5, 9, 30).getTime();
    renderView(props({ isOfflineMode: true, offlineLastUpdated: ts }));
    expect(screen.getByText(/Stand: 05\.01\.2020, 09:30 Uhr/)).toBeTruthy();
  });

  it('links to the series with the shopping list as the way back', () => {
    renderView();
    fireEvent.click(screen.getAllByRole('link', { name: 'Berserk' })[0]);
    expect(screen.getByTestId('detail').textContent).toContain('/?view=shopping');
  });
});

describe('ShoppingListView quick buy', () => {
  it('undo inside the window sends nothing; otherwise the buy is sent after the window', async () => {
    vi.useFakeTimers();
    const p = props();
    renderView(p);
    fireEvent.click(screen.getAllByRole('button', { name: /Gekauft/ })[0]);
    expect(screen.getByText(/„Berserk Band 1“ als gekauft markiert/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Gekauft/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }));
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(p.handleQuickBuy).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: /Gekauft/ })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: /Gekauft/ })[1]);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(p.handleQuickBuy).toHaveBeenCalledWith(2);
  });

  it('five quick buys keep the three newest undos; the two oldest are bought at once', async () => {
    vi.useFakeTimers();
    const items = [1, 2, 3, 4, 5].map((id) => row({ id, volume_number: String(id), isbn: `978355100000${id}` }));
    const p = props({ shoppingData: list(items) });
    renderView(p);
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getAllByRole('button', { name: /^Gekauft/ })[0]);
    act(() => { notify.error('Kein Barcode erkannt'); });
    expect(screen.getByRole('alert').textContent).toContain('Kein Barcode erkannt');
    expect(screen.getAllByRole('button', { name: 'Rückgängig' })).toHaveLength(3);
    expect(p.handleQuickBuy.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    fireEvent.click(within(screen.getByText(/„Berserk Band 3“ als gekauft markiert/).closest('[data-toast]')).getByRole('button', { name: 'Rückgängig' }));
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(p.handleQuickBuy.mock.calls.map(([id]) => id)).toEqual([1, 2, 4, 5]);
  });

  it('the undo toast leaves once the buy is sent, even while the pointer rests on it', async () => {
    vi.useFakeTimers();
    const p = props();
    renderView(p);
    fireEvent.click(screen.getAllByRole('button', { name: /Gekauft/ })[0]);
    const toast = screen.getByText(/„Berserk Band 1“ als gekauft markiert/).closest('[data-toast]');
    expect(toast.closest('[role="status"]')).toBeTruthy();
    fireEvent.mouseEnter(toast);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(p.handleQuickBuy).toHaveBeenCalledWith(1);
    expect(screen.queryByText(/als gekauft markiert/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rückgängig' })).toBeNull();
  });

  it('a batch that stops early keeps the undo window of a later entry, which is then sent', async () => {
    vi.useFakeTimers();
    seedScans([
      { isbn: '9783551000011', kind: 'buy', label: 'Berserk Band 1', itemId: 1 },
      { isbn: '9783551000028', kind: 'buy', label: 'Berserk Band 2', itemId: 2 }
    ]);
    const p = props({
      handleQuickBuy: vi.fn(async (id, opts) => (opts?.batch ? { status: 'failed', error: 'weg', httpStatus: 403 } : 'ok'))
    });
    renderView(p);
    fireEvent.click(screen.getAllByRole('button', { name: /Gekauft/ })[1]);
    fireEvent.click(screen.getByRole('button', { name: '2 als gekauft abhaken' }));
    await act(async () => { await Promise.resolve(); });
    expect(p.handleQuickBuy).toHaveBeenCalledTimes(1);
    expect(p.handleQuickBuy).toHaveBeenCalledWith(1, { batch: true });
    expect(screen.getByText(/„Berserk Band 2“ als gekauft markiert/)).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(p.handleQuickBuy).toHaveBeenCalledTimes(2);
    expect(p.handleQuickBuy).toHaveBeenLastCalledWith(2);
  });

  it('a batch reaching an entry with a pending tap books it once and cancels the tap', async () => {
    vi.useFakeTimers();
    seedScans([{ isbn: '9783551000011', kind: 'buy', label: 'Berserk Band 1', itemId: 1 }]);
    const p = props({ handleQuickBuy: vi.fn(async () => ({ status: 'ok' })) });
    renderView(p);
    fireEvent.click(screen.getAllByRole('button', { name: /Gekauft/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: '1 als gekauft abhaken' }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(p.handleQuickBuy).toHaveBeenCalledTimes(1);
    expect(p.handleQuickBuy).toHaveBeenCalledWith(1, { batch: true });
  });

  it('a batch waits for a tap whose window already ended instead of buying twice', async () => {
    vi.useFakeTimers();
    seedScans([{ isbn: '9783551000011', kind: 'buy', label: 'Berserk Band 1', itemId: 1 }]);
    let finish;
    const p = props({ handleQuickBuy: vi.fn(() => new Promise((resolve) => { finish = resolve; })) });
    renderView(p);
    fireEvent.click(screen.getAllByRole('button', { name: /Gekauft/ })[0]);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(p.handleQuickBuy).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: '1 als gekauft abhaken' }));
    await act(async () => { finish('ok'); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(p.handleQuickBuy).toHaveBeenCalledTimes(1);
    expect(scanEntries()[0].querySelector('.line-through')).not.toBeNull();
  });

  it('before a logout, pending buys are sent and the logout waits for them', async () => {
    vi.useFakeTimers();
    let finish;
    const p = props({ handleQuickBuy: vi.fn(() => new Promise((resolve) => { finish = resolve; })) });
    renderView(p);
    fireEvent.click(screen.getAllByRole('button', { name: /Gekauft/ })[0]);
    let done = false;
    let logout;
    act(() => { logout = runBeforeLogout().then(() => { done = true; }); });
    expect(p.handleQuickBuy).toHaveBeenCalledWith(1);
    await act(async () => { await Promise.resolve(); });
    expect(done).toBe(false);
    await act(async () => { finish('ok'); await logout; });
    expect(done).toBe(true);
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(p.handleQuickBuy).toHaveBeenCalledTimes(1);
  });

  it('a logout also waits for a buy whose window already ended and is still running', async () => {
    vi.useFakeTimers();
    let finish;
    const p = props({ handleQuickBuy: vi.fn(() => new Promise((resolve) => { finish = resolve; })) });
    renderView(p);
    fireEvent.click(screen.getAllByRole('button', { name: /Gekauft/ })[0]);
    await act(async () => { vi.advanceTimersByTime(5000); });
    let done = false;
    let logout;
    act(() => { logout = runBeforeLogout().then(() => { done = true; }); });
    await act(async () => { await Promise.resolve(); });
    expect(done).toBe(false);
    await act(async () => { finish('ok'); await logout; });
    expect(done).toBe(true);
    expect(p.handleQuickBuy).toHaveBeenCalledTimes(1);
  });

  it('sends a pending buy right away when the view closes', () => {
    vi.useFakeTimers();
    const p = props();
    const view = renderView(p);
    fireEvent.click(screen.getAllByRole('button', { name: /Gekauft/ })[0]);
    view.unmount();
    expect(p.handleQuickBuy).toHaveBeenCalledWith(1);
  });
});

describe('ShoppingListView "Ich habe ihn auch"', () => {
  const others = [{ id: 50, manga_id: 9, manga_title: 'Berserk', volume_number: '5', type: 'volume', notes: null, owned_by_others: 'ed' }];

  it('shows the server error and stays usable', async () => {
    const fetchMock = vi.fn(async () => response(409, { error: 'Band wurde geändert' }));
    vi.stubGlobal('fetch', fetchMock);
    const p = props({ shoppingData: list(undefined, { others }) });
    renderView(p);
    const button = screen.getByRole('button', { name: 'Ich habe ihn auch' });
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    await flush();
    expect(screen.getByText('Band wurde geändert')).toBeTruthy();
    expect(button.disabled).toBe(false);
    expect(p.fetchShoppingList).not.toHaveBeenCalled();
  });

  it('refreshes list and collection on success and hides the entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { success: true })));
    const p = props({ shoppingData: list(undefined, { others }) });
    renderView(p);
    fireEvent.click(screen.getByRole('button', { name: 'Ich habe ihn auch' }));
    await flush();
    expect(p.fetchShoppingList).toHaveBeenCalled();
    expect(p.fetchMangas).toHaveBeenCalled();
    expect(screen.queryByText('Bei anderen vorhanden')).toBeNull();
  });

  it('is disabled offline', () => {
    renderView(props({ isOfflineMode: true, shoppingData: list(undefined, { others }) }));
    expect(screen.getByRole('button', { name: 'Ich habe ihn auch' }).disabled).toBe(true);
  });
});

describe('ShoppingListView wished series', () => {
  const wished = (over = {}) => ({
    id: 40, title: 'Vinland Saga', cover_image: null, publisher: 'Carlsen Manga', wish_priority: 3, total_volumes: 14,
    manga_passion_id: null, known_missing_count: 2, known_missing_cost: 30, ...over
  });
  const withWished = (series, items) => list(items, { wished_series: series, total_wished_series: series.length });

  it('shows the section above the volume cards with cover, publisher, priority and known cost', () => {
    renderView(props({ shoppingData: withWished([wished(), wished({ id: 41, title: 'Akira', wish_priority: 0, known_missing_count: 0, known_missing_cost: 0, publisher: 'Panini Verlags GmbH' })]) }));
    const section = document.getElementById('shop-wished-series');
    expect(within(section).getByRole('heading', { name: /Gewünschte Reihen/ })).toBeTruthy();
    const cards = within(section).getAllByRole('listitem');
    expect(cards.map((c) => within(c).getByText(/Vinland Saga|Akira/).textContent)).toEqual(['Akira', 'Vinland Saga']);
    expect(within(cards[1]).getByText('★★★ hoch')).toBeTruthy();
    expect(within(cards[1]).getByText(/2 Bände bekannt · 30,00\s€/)).toBeTruthy();
    expect(within(cards[0]).getByText('Noch keine Bände bekannt')).toBeTruthy();
    expect(section.compareDocumentPosition(screen.getAllByRole('button', { name: /^Gekauft/ })[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'Zur Reihe Vinland Saga' }).getAttribute('href')).toBe('/manga/40');
  });

  it('"Wichtigste zuerst" sorts the section, publisher chips and search filter it, chips count wished series', () => {
    const data = withWished([wished({ id: 41, title: 'Akira', wish_priority: 1, publisher: 'Panini Verlags GmbH' }), wished()]);
    renderView(props({ shoppingData: data }));
    const titles = () => within(document.getElementById('shop-wished-series')).getAllByRole('listitem').map((c) => c.querySelector('p').textContent);
    expect(titles()).toEqual(['Akira', 'Vinland Saga']);
    fireEvent.click(screen.getByRole('button', { name: /Wichtigste zuerst/ }));
    expect(titles()).toEqual(['Vinland Saga', 'Akira']);
    expect(screen.getByRole('button', { name: /Panini Verlags GmbH/ }).textContent).toContain('1');
    expect(screen.getByRole('button', { name: /^Carlsen Manga/ }).textContent).toContain('3');
  });

  it('filters by the chosen publisher chip and the search', () => {
    const data = withWished([wished({ id: 41, title: 'Akira', wish_priority: 1, publisher: 'Panini Verlags GmbH' }), wished()]);
    const view = renderView(props({ shoppingData: data, shoppingPublisherFilter: 'Panini Verlags GmbH' }));
    expect(within(document.getElementById('shop-wished-series')).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Gekauft/ })).toBeNull();
    view.rerenderWith({ ...view.props, shoppingPublisherFilter: 'ALL', shoppingSearch: 'vinland' });
    expect(within(document.getElementById('shop-wished-series')).getAllByRole('listitem').map((c) => c.querySelector('p').textContent)).toEqual(['Vinland Saga']);
  });

  it('only wished series: no "Alles komplett", the section is shown', () => {
    renderView(props({ shoppingData: withWished([wished()], []) }));
    expect(screen.queryByText('Alles komplett im Regal!')).toBeNull();
    expect(document.getElementById('shop-wished-series')).toBeTruthy();
  });

  it('"Von der Wunschliste" clears wish_priority, hides the card and reloads list and collection', async () => {
    const fetchMock = vi.fn(async () => response(200, { success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const p = props({ shoppingData: withWished([wished()]) });
    renderView(p);
    fireEvent.click(screen.getByRole('button', { name: 'Vinland Saga von der Wunschliste nehmen' }));
    await flush();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/mangas/40');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ wish_priority: null });
    expect(document.getElementById('shop-wished-series')).toBeNull();
    expect(p.fetchShoppingList).toHaveBeenCalled();
    expect(p.fetchMangas).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('visitors and offline mode get no remove button', () => {
    const view = renderView(props({ shoppingData: withWished([wished()]), canEdit: false }));
    expect(screen.queryByRole('button', { name: /von der Wunschliste nehmen/ })).toBeNull();
    view.rerenderWith({ ...view.props, canEdit: true, isOfflineMode: true });
    expect(screen.queryByRole('button', { name: /von der Wunschliste nehmen/ })).toBeNull();
  });
});

describe('ShoppingListView long lists', () => {
  it('renders 50 cards first with "Zeige N von M", more on demand; a broken cover falls back per card', () => {
    const items = Array.from({ length: 120 }, (_, i) => row({ id: i + 1, volume_number: String(i + 1), isbn: '', manga_cover: i === 0 ? '/uploads/kaputt.jpg' : null }));
    renderView(props({ shoppingData: list(items) }));
    expect(screen.getAllByRole('button', { name: /^Gekauft/ })).toHaveLength(50);
    expect(screen.getByText('Zeige 50 von 120')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Weitere anzeigen' }));
    expect(screen.getAllByRole('button', { name: /^Gekauft/ })).toHaveLength(100);
    const img = document.querySelector('img[src="/uploads/kaputt.jpg"]');
    fireEvent.error(img);
    expect(document.querySelector('img[src="/uploads/kaputt.jpg"]')).toBeNull();
  });
});

describe('ShoppingListView provisional scans', () => {
  it('a buy found only in the offline copy cannot be booked until the server answered', async () => {
    const item = row({ id: 40, isbn: null, manga_title: 'Naruto', volume_number: '3' });
    localHits.set('9783551762931', {
      manga: { id: 4, title: 'Naruto' }, volume: { id: 40, status: 'Fehlt', owned_by_me: false, owners: [], display_title: 'Band 3' }, syncedAt: null
    });
    let answer;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answer = resolve; })));
    const p = props({ shoppingData: list([item]) });
    renderView(p);
    await scan('9783551762931');
    const [entry] = scanEntries();
    expect(entry.dataset.kind).toBe('buy');
    expect(entry.textContent).toContain('Naruto Band 3 (Stand Offline-Kopie)');
    expect(screen.queryByRole('button', { name: /als gekauft abhaken/ })).toBeNull();

    await act(async () => {
      answer(response(200, {
        found: true, matched_manga: { id: 4, title: 'Naruto' }, matched_volume: { id: 40, volume_number: '3', status: 'Fehlt' }, book: {}
      }));
    });
    await flush();
    expect(scanEntries()[0].textContent).not.toContain('Offline-Kopie');
    fireEvent.click(screen.getByRole('button', { name: '1 als gekauft abhaken' }));
    await flush();
    expect(p.handleQuickBuy).toHaveBeenCalledWith(40, { batch: true });
  });
});

describe('ShoppingListView share and print', () => {
  const restore = [];
  const setNavigator = (key, value) => {
    const had = Object.prototype.hasOwnProperty.call(navigator, key);
    const old = navigator[key];
    Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
    restore.push(() => {
      if (had) Object.defineProperty(navigator, key, { value: old, configurable: true, writable: true });
      else delete navigator[key];
    });
  };
  afterEach(() => {
    while (restore.length) restore.pop()();
  });
  // formatEuro puts a no-break space before the euro sign
  const plain = (text) => text.replace(/\u00a0/g, ' ');

  const items = () => [
    row({ id: 1, manga_title: 'Berserk', volume_number: '41', price: 7.5, priority: 3, effective_publisher: 'Panini Verlags GmbH', isbn: null }),
    row({ id: 2, manga_title: 'Frieren', volume_number: '14', price: 7, effective_publisher: 'Egmont Manga', target_price: 6, isbn: '9783770400001' }),
    row({ id: 3, manga_title: 'Berserk', volume_number: '42', price: null, effective_publisher: 'Panini Verlags GmbH', isbn: null })
  ];
  const data = () => list(items(), {
    total_missing: 3,
    publishers: [{ publisher: 'Panini Verlags GmbH', count: 2 }, { publisher: 'Egmont Manga', count: 1 }],
    wished_series: [{ id: 50, title: 'Dandadan', publisher: 'Panini Verlags GmbH', wish_priority: 2, known_missing_count: 0 }]
  });

  it('copies the visible list as text grouped by publisher, with boxes, prices, priority and wished series', async () => {
    const writeText = vi.fn(async () => {});
    setNavigator('clipboard', { writeText });
    renderView(props({ shoppingData: data() }));
    expect(screen.queryByRole('button', { name: 'Liste teilen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Liste als Text kopieren' }));
    await flush();
    const text = plain(writeText.mock.calls[0][0]);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Einkaufsliste – Manga Shelf \(\d{2}\.\d{2}\.\d{4}\)$/);
    expect(lines[1]).toBe('3 Bände · ca. 14,50 €');
    expect(text.indexOf('Egmont Manga')).toBeLessThan(text.indexOf('Panini Verlags GmbH\n'));
    expect(text).toContain('☐ Berserk Band 41 – 7,50 € · Prio hoch');
    expect(text).toContain('☐ Berserk Band 42\n');
    expect(text).toContain('☐ Frieren Band 14 – 7,00 € · max. 6,00 € · ISBN 9783770400001');
    expect(text).toContain('Gewünschte Reihen\n♡ Dandadan (Panini Verlags GmbH) · Prio mittel');
    expect(toasts.messages()).toContain('Einkaufsliste als Text kopiert');
  });

  it('respects the search filter and says so', async () => {
    const writeText = vi.fn(async () => {});
    setNavigator('clipboard', { writeText });
    renderView(props({ shoppingData: data(), shoppingSearch: 'Frieren' }));
    fireEvent.click(screen.getByRole('button', { name: 'Liste als Text kopieren' }));
    await flush();
    const text = writeText.mock.calls[0][0];
    expect(text.split('\n')[0]).toMatch(/, gefiltert$/);
    expect(text).toContain('Frieren Band 14');
    expect(text).not.toContain('Berserk');
    expect(text).not.toContain('Dandadan');
  });

  it('uses the share sheet when there is one; closing it is not an error', async () => {
    const share = vi.fn(async () => {});
    setNavigator('share', share);
    renderView(props({ shoppingData: data() }));
    fireEvent.click(screen.getByRole('button', { name: 'Liste teilen' }));
    await flush();
    expect(share).toHaveBeenCalledWith({ title: 'Einkaufsliste', text: expect.stringContaining('☐ Frieren Band 14') });

    share.mockImplementationOnce(async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }); });
    const writeText = vi.fn(async () => {});
    setNavigator('clipboard', { writeText });
    fireEvent.click(screen.getByRole('button', { name: 'Liste teilen' }));
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(toasts.messages().some((m) => /kopiert|Textdatei|nicht weitergegeben/.test(m))).toBe(false);
  });

  it('falls back to a text file without clipboard access', async () => {
    setNavigator('clipboard', { writeText: vi.fn(async () => { throw new Error('denied'); }) });
    const created = vi.fn(() => 'blob:liste');
    const revoked = vi.fn();
    const oldCreate = URL.createObjectURL;
    const oldRevoke = URL.revokeObjectURL;
    URL.createObjectURL = created;
    URL.revokeObjectURL = revoked;
    restore.push(() => { URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; });
    const clicks = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicks.push(this.download); });
    restore.push(() => click.mockRestore());
    renderView(props({ shoppingData: data() }));
    fireEvent.click(screen.getByRole('button', { name: 'Liste als Text kopieren' }));
    await flush();
    expect(created).toHaveBeenCalled();
    expect(clicks).toEqual(['einkaufsliste.txt']);
    expect(toasts.messages()).toContain('Einkaufsliste als Textdatei gespeichert (einkaufsliste.txt)');
  });

  it('prints a sheet grouped by publisher and removes it after printing; the browser print command shows it too', async () => {
    const print = vi.fn();
    const oldPrint = window.print;
    window.print = print;
    restore.push(() => { window.print = oldPrint; });
    renderView(props({ shoppingData: data() }));
    expect(document.getElementById('shopping-print-sheet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Liste drucken' }));
    await flush();
    const sheet = document.getElementById('shopping-print-sheet');
    expect(sheet).toBeTruthy();
    expect(sheet.parentElement).toBe(document.body);
    expect(print).toHaveBeenCalledTimes(1);
    expect([...sheet.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Egmont Manga', 'Panini Verlags GmbH', 'Gewünschte Reihen']);
    expect(plain(sheet.textContent)).toContain('☐ Berserk Band 41 – 7,50 € · Prio hoch');
    expect(sheet.querySelector('style').textContent).toContain('@media print');
    act(() => { window.dispatchEvent(new Event('afterprint')); });
    expect(document.getElementById('shopping-print-sheet')).toBeNull();

    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    expect(document.getElementById('shopping-print-sheet')).toBeTruthy();
    await flush();
    expect(print).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new Event('afterprint')); });
    expect(document.getElementById('shopping-print-sheet')).toBeNull();
  });

  it('disables share, copy and print while nothing is on the list', () => {
    renderView(props({ shoppingData: list([]) }));
    expect(screen.getByRole('button', { name: 'Liste als Text kopieren' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Liste drucken' }).disabled).toBe(true);
  });
});
