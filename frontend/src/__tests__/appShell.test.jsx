// Covers the app shell: login and logout flow, routing, session handling and offline start.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useParams, useLocation, MemoryRouter } from 'react-router-dom';

vi.mock('../utils/offlineStore', () => ({
  saveUser: vi.fn(async () => {}),
  loadUser: vi.fn(async () => null),
  loadMeta: vi.fn(async () => null),
  loadMangaList: vi.fn(async () => []),
  clearOfflineData: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true),
  formatAge: vi.fn(() => 'vor 5 Min.')
}));

const shelf = vi.hoisted(() => ({ takesAccountEvent: false }));

// the real shelf scroll hook: it stores the position when the shelf unmounts
vi.mock('../Dashboard', async () => {
  const { useShelfScroll } = await vi.importActual('../components/dashboard/MangaCollectionGrid');
  return {
    default: function DashboardStub({ user, onLogout, onLocalReplaced }) {
      useShelfScroll(true);
      const { state, search } = useLocation();
      const [opened, setOpened] = useState('-');
      useEffect(() => {
        if (!shelf.takesAccountEvent) return undefined;
        const onOpen = (event) => { event.preventDefault(); setOpened(event.detail); };
        window.addEventListener('mangashelf:open-account', onOpen);
        return () => window.removeEventListener('mangashelf:open-account', onOpen);
      }, []);
      return (
        <div>
          <p>Dashboard von {user.username}{user.offline ? ' (offline)' : ''}</p>
          <p data-testid="dashboard-wiring">{`${state?.openAccount || '-'} ${search || '-'} ${typeof onLocalReplaced}`}</p>
          <p data-testid="dashboard-opened">{opened}</p>
          <button type="button" onClick={onLogout}>Abmelden</button>
        </div>
      );
    }
  };
});

vi.mock('../MangaDetail', () => ({
  default: function MangaDetailStub({ onUnauthorized }) {
    const { id } = useParams();
    return <p>Reihe {id} {typeof onUnauthorized === 'function' ? 'mit 401-Handler' : ''}</p>;
  }
}));

import App from '../App';
import Login from '../Login';
import Setup from '../Setup';
import AppErrorBoundary from '../AppErrorBoundary';
import { SESSION_EXPIRED_EVENT } from '../hooks/useMangaList';
import { SCAN_LIST_KEY } from '../utils/scanHelpers';
import { SHELF_SCROLL_KEY, SHELF_COUNT_KEY } from '../components/dashboard/MangaCollectionGrid';
import { loadUser, loadMeta, clearOfflineData, syncOfflineCopy } from '../utils/offlineStore';
import {
  MESSAGES, LOGOUT_PENDING_KEY,
  safeRedirectTarget, isChunkLoadError, reloadForStaleChunk, clearUploadsCache, shouldRegisterServiceWorker, readJson,
  BEFORE_LOGOUT_EVENT, runBeforeLogout, STARTUP_TIMEOUT_MS
} from '../appShell';
import { getToken, setToken, setActiveBase, resetConnection, activateServer } from '../app/connection';
import { resetServers, saveServer, setStorageAdapter, getActiveServer, getServer, getPendingLogouts } from '../app/serverStore';
import { receiveDeepLink, takePendingShare } from '../app/deepLink';
import { getOutbox, outboxScope, resetOutbox, WEB_SERVER_ID } from '../utils/outbox';
import { notify } from '../utils/notify';
import { startDownload, downloadsRunning } from '../app/downloadManager';
import { INSECURE_URL_TEXT } from '../app/serverStore';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status = 200) => new Response('<!doctype html><title>Portal</title>', { status, headers: { 'Content-Type': 'text/html' } });
const admin = { id: 1, username: 'admin', role: 'admin' };
const sessionGone = () => json(401, { error: 'Sitzung abgelaufen oder ungültig – bitte neu anmelden', code: 'SESSION_INVALID' });

/** fetch stub routed by "METHOD /path"; a function value is called with (url, init). */
function routes(table) {
  const calls = [];
  const fn = vi.fn(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const key = `${(init.method || 'GET').toUpperCase()} ${new URL(url, 'http://localhost').pathname}`;
    calls.push(key);
    const handler = table[key];
    if (handler === undefined) throw new TypeError(`unexpected fetch ${key}`);
    return typeof handler === 'function' ? handler(url, init) : handler.clone();
  });
  fn.calls = calls;
  return fn;
}

const go = (path) => window.history.replaceState(null, '', path);

describe('App shell', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    go('/');
    shelf.takesAccountEvent = false;
    loadUser.mockReset().mockResolvedValue(null);
    loadMeta.mockReset().mockResolvedValue(null);
    clearOfflineData.mockClear();
    syncOfflineCopy.mockClear();
    vi.stubGlobal('caches', { keys: vi.fn(async () => ['mangashelf-uploads-v2', 'mangashelf-app-1.0.0']), delete: vi.fn(async () => true) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mounts one toaster that keeps its toasts across the switch from the start screen to the page', async () => {
    let release;
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': () => new Promise((resolve) => { release = () => resolve(json(200, { needsSetup: false })); }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    render(<App />);
    expect(screen.getByText('Manga Shelf wird geladen...')).toBeTruthy();
    act(() => { notify.error('Früh gemeldet'); });
    expect(screen.getByRole('alert').textContent).toContain('Früh gemeldet');
    await waitFor(() => expect(release).toBeTypeOf('function'));
    await act(async () => { release(); });
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Früh gemeldet');
  });

  it('a runtime 401 event clears the offline copy and the cover cache and sends the user to the login', async () => {
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    render(<App />);
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    sessionStorage.setItem(SCAN_LIST_KEY, JSON.stringify({ savedAt: Date.now(), userId: 1, entries: [] }));
    sessionStorage.setItem('mangashelf_search', JSON.stringify({ user: '1', search: 'Berserk' }));

    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { url: '/api/mangas', status: 401 } }));
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { url: '/api/stats', status: 401 } }));
    });

    expect(await screen.findByText(MESSAGES.sessionExpired)).toBeTruthy();
    expect(window.location.pathname).toBe('/login');
    expect(clearOfflineData).toHaveBeenCalledTimes(1);
    expect(caches.delete).toHaveBeenCalledWith('mangashelf-uploads-v2');
    expect(caches.delete).not.toHaveBeenCalledWith('mangashelf-app-1.0.0');
    expect(sessionStorage.getItem(SCAN_LIST_KEY)).toBeNull();
    expect(sessionStorage.getItem('mangashelf_search')).toBeNull();
  });

  it('a logout clears the store scan list, the shelf search and the scroll positions of this tab', async () => {
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin }),
      'POST /api/auth/logout': json(200, { success: true })
    }));
    render(<App />);
    await screen.findByText('Dashboard von admin');
    sessionStorage.setItem(SCAN_LIST_KEY, JSON.stringify({ savedAt: Date.now(), userId: 1, entries: [] }));
    sessionStorage.setItem('mangashelf_search', JSON.stringify({ user: '1', search: 'Berserk' }));
    localStorage.setItem(SCAN_LIST_KEY, JSON.stringify({ savedAt: Date.now(), userId: 1, entries: [] }));
    const { DETAIL_SCROLL_KEY } = await vi.importActual('../MangaDetail');
    sessionStorage.setItem(SHELF_SCROLL_KEY, '900');
    sessionStorage.setItem(SHELF_COUNT_KEY, JSON.stringify({ key: '[]', count: 120 }));
    sessionStorage.setItem(DETAIL_SCROLL_KEY, JSON.stringify({ abc: 300 }));
    window.scrollY = 900;
    fireEvent.scroll(window);
    fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    await screen.findByLabelText('Passwort');
    expect(sessionStorage.getItem(SCAN_LIST_KEY)).toBeNull();
    expect(localStorage.getItem(SCAN_LIST_KEY)).toBeNull();
    expect(sessionStorage.getItem('mangashelf_search')).toBeNull();
    for (const key of [SHELF_SCROLL_KEY, SHELF_COUNT_KEY, DETAIL_SCROLL_KEY]) expect(sessionStorage.getItem(key), key).toBeNull();
    window.scrollY = 0;
  });

  it('a runtime 401 does not let the unmounting shelf store its scroll position', async () => {
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    render(<App />);
    await screen.findByText('Dashboard von admin');
    window.scrollY = 700;
    fireEvent.scroll(window);
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { url: '/api/mangas', status: 401 } }));
    });
    await screen.findByText(MESSAGES.sessionExpired);
    expect(sessionStorage.getItem(SHELF_SCROLL_KEY)).toBeNull();
    window.scrollY = 0;
  });

  it('a logout first lets open views send pending purchases, then ends the session', async () => {
    let releasePurchase;
    const fetchMock = routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin }),
      'POST /api/volumes/5/owners': () => new Promise((resolve) => { releasePurchase = () => resolve(json(200, { success: true })); }),
      'POST /api/auth/logout': json(200, { success: true })
    });
    vi.stubGlobal('fetch', fetchMock);
    const onBeforeLogout = (event) => event.detail.waitUntil(fetch('/api/volumes/5/owners', { method: 'POST' }));
    window.addEventListener(BEFORE_LOGOUT_EVENT, onBeforeLogout);
    try {
      render(<App />);
      await screen.findByText('Dashboard von admin');
      fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
      await waitFor(() => expect(fetchMock.calls).toContain('POST /api/volumes/5/owners'));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      expect(fetchMock.calls).not.toContain('POST /api/auth/logout');
      releasePurchase();
      await screen.findByLabelText('Passwort');
      expect(fetchMock.calls.indexOf('POST /api/auth/logout')).toBeGreaterThan(fetchMock.calls.indexOf('POST /api/volumes/5/owners'));
    } finally {
      window.removeEventListener(BEFORE_LOGOUT_EVENT, onBeforeLogout);
    }
  });

  it('checks the session when the tab comes back and logs out on a 401 even if the sync is throttled', async () => {
    let meCalls = 0;
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': () => (++meCalls === 1 ? json(200, { user: admin }) : sessionGone())
    }));
    render(<App />);
    await screen.findByText('Dashboard von admin');

    act(() => { document.dispatchEvent(new Event('visibilitychange')); });

    expect(await screen.findByText(MESSAGES.sessionExpired)).toBeTruthy();
    expect(clearOfflineData).toHaveBeenCalled();
  });

  it('passes the 401 handler to the detail page', async () => {
    go('/manga/7');
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    render(<App />);
    expect(await screen.findByText('Reihe 7 mit 401-Handler')).toBeTruthy();
  });

  it('the desktop menu "Quellen & Schlüssel…" opens the keys from any route of a signed-in user; signed out it stays unhandled', async () => {
    // the listener is attached in a passive effect once the user is known: fire until the event is handled
    const fire = () => waitFor(() => expect(window.dispatchEvent(new CustomEvent('mangashelf:open-api-keys', { cancelable: true }))).toBe(false));
    go('/manga/7');
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    const view = render(<App />);
    expect(await screen.findByText(/Reihe 7/)).toBeTruthy();
    await fire();
    expect((await screen.findByTestId('dashboard-wiring')).textContent).toBe('keys - function');

    view.unmount();
    go('/?view=shopping');
    render(<App />);
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    await fire();
    await waitFor(() => expect(screen.getByTestId('dashboard-wiring').textContent).toBe('keys ?view=shopping function'));
  });

  it('on the shelf the menu opens the keys in place: no history write, an open dialog keeps its entry', async () => {
    shelf.takesAccountEvent = true;
    go('/?view=shopping');
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    render(<App />);
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    window.history.pushState({ ...window.history.state, mangashelfDialogs: ['dialog-1'] }, '');
    const length = window.history.length;
    await waitFor(() => expect(window.dispatchEvent(new CustomEvent('mangashelf:open-api-keys', { cancelable: true }))).toBe(false));
    expect(screen.getByTestId('dashboard-opened').textContent).toBe('keys');
    expect(screen.getByTestId('dashboard-wiring').textContent).toBe('- ?view=shopping function');
    expect(window.history.length).toBe(length);
    expect(window.history.state.mangashelfDialogs).toEqual(['dialog-1']);
    expect(window.location.search).toBe('?view=shopping');
  });

  it('from another route the menu replaces the entry only when a dialog entry is on top', async () => {
    const fire = () => waitFor(() => expect(window.dispatchEvent(new CustomEvent('mangashelf:open-api-keys', { cancelable: true }))).toBe(false));
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    go('/manga/7');
    const view = render(<App />);
    expect(await screen.findByText(/Reihe 7/)).toBeTruthy();
    window.history.pushState({ ...window.history.state, mangashelfDialogs: ['dialog-2'] }, '');
    let length = window.history.length;
    await fire();
    expect((await screen.findByTestId('dashboard-wiring')).textContent).toBe('keys - function');
    expect(window.history.length).toBe(length);
    expect(window.history.state?.mangashelfDialogs).toBeUndefined();
    view.unmount();

    go('/manga/8');
    render(<App />);
    expect(await screen.findByText(/Reihe 8/)).toBeTruthy();
    length = window.history.length;
    await fire();
    expect((await screen.findByTestId('dashboard-wiring')).textContent).toBe('keys - function');
    expect(window.history.length).toBe(length + 1);
  });

  it('signed out the menu event stays unhandled (the desktop asks to sign in); offline it says why nothing opens', async () => {
    const fire = () => window.dispatchEvent(new CustomEvent('mangashelf:open-api-keys', { cancelable: true }));
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': sessionGone()
    }));
    const view = render(<App />);
    expect(await screen.findByLabelText('Benutzername')).toBeTruthy();
    expect(fire()).toBe(true);
    view.unmount();

    loadUser.mockResolvedValue(admin);
    vi.stubGlobal('fetch', routes({ 'GET /api/setup/status': html(), 'GET /api/auth/me': html() }));
    go('/manga/5');
    render(<App />);
    expect(await screen.findByText(/Reihe 5/)).toBeTruthy();
    let unhandled;
    act(() => { unhandled = fire(); });
    expect(unhandled).toBe(false);
    expect(await screen.findByText('Quellen & Schlüssel lassen sich nur mit Verbindung zum Server bearbeiten.')).toBeTruthy();
    expect(screen.getByText(/Reihe 5/)).toBeTruthy();
  });

  it('an offline logout stays pending and is sent before /auth/me on the next start', async () => {
    const fetchMock = routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin }),
      'POST /api/auth/logout': () => Promise.reject(new TypeError('Failed to fetch'))
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abmelden' }));

    expect(await screen.findByText(MESSAGES.logoutPending)).toBeTruthy();
    expect(localStorage.getItem(LOGOUT_PENDING_KEY)).toBe('1');
    expect(clearOfflineData).toHaveBeenCalled();
    first.unmount();

    // Next start: the cookie would still be valid, but the outstanding logout goes first and /me is never used
    const next = routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin }),
      'POST /api/auth/logout': json(200, { success: true })
    });
    vi.stubGlobal('fetch', next);
    go('/');
    render(<App />);
    expect(await screen.findByLabelText('Passwort')).toBeTruthy();
    expect(next.calls).toContain('POST /api/auth/logout');
    expect(next.calls).not.toContain('GET /api/auth/me');
    expect(localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it('a 502 from the proxy on logout also counts as not logged out', async () => {
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin }),
      'POST /api/auth/logout': html(502)
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abmelden' }));
    expect(await screen.findByText(MESSAGES.logoutPending)).toBeTruthy();
    expect(localStorage.getItem(LOGOUT_PENDING_KEY)).toBe('1');
  });

  it('a successful logout clears the flag; a later login clears a stale flag before the session check', async () => {
    const fetchMock = routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin }),
      'POST /api/auth/logout': json(200, { success: true })
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abmelden' }));
    await screen.findByLabelText('Passwort');
    expect(localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();

    localStorage.setItem(LOGOUT_PENDING_KEY, '1');
    fetchMock.calls.length = 0;
    vi.stubGlobal('fetch', routes({
      'POST /api/auth/login': json(200, { success: true, user: admin }),
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /Anmelden/ }));

    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    expect(localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it('redirects unknown paths instead of rendering an empty page', async () => {
    go('/index.html');
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    const first = render(<App />);
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    expect(window.location.pathname).toBe('/');
    first.unmount();

    go('/nope');
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(401, { error: 'Nicht angemeldet', code: 'AUTH_REQUIRED' })
    }));
    render(<App />);
    expect(await screen.findByLabelText('Passwort')).toBeTruthy();
    expect(window.location.pathname).toBe('/login');
  });

  it('a deep link survives the login and the redirects replace history entries', async () => {
    go('/manga/5?tab=volumes');
    const lengthBefore = window.history.length;
    let loggedIn = false;
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': () => (loggedIn ? json(200, { user: admin }) : json(401, { error: 'Nicht angemeldet', code: 'AUTH_REQUIRED' })),
      'POST /api/auth/login': () => { loggedIn = true; return json(200, { success: true, user: admin }); }
    }));
    render(<App />);
    await screen.findByLabelText('Passwort');
    expect(window.location.pathname).toBe('/login');

    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /Anmelden/ }));

    expect(await screen.findByText(/Reihe 5/)).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe('/manga/5?tab=volumes');
    expect(window.history.length).toBe(lengthBefore);
  });

  it('a hung /auth/me falls back to the offline copy after the startup timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    loadUser.mockResolvedValue(admin);
    loadMeta.mockResolvedValue({ synced_at: Date.now() });
    const hang = (url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    vi.stubGlobal('fetch', routes({ 'GET /api/setup/status': hang, 'GET /api/auth/me': hang }));
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS + 100); });
    expect(await screen.findByText('Dashboard von admin (offline)')).toBeTruthy();
    expect(clearOfflineData).not.toHaveBeenCalled();
  });

  it('the offline-copy download waits until the page has made its own requests', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    render(<App />);
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    expect(syncOfflineCopy).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    expect(syncOfflineCopy).toHaveBeenCalledTimes(1);
  });

  it('index.html shows the same loading screen as the app before the script runs', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const html = fs.readFileSync(path.resolve(import.meta.dirname, '../../index.html'), 'utf8');
    const staticShell = new DOMParser().parseFromString(html, 'text/html').getElementById('root').innerHTML.trim();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { container } = render(<App />);
    const rendered = container.firstElementChild.outerHTML;
    const normalise = (markup) => markup.replace(/\s+/g, ' ').replace(/="([^"]*)"/g, (_, v) => `="${v.trim()}"`);
    expect(normalise(staticShell)).toBe(normalise(rendered));
    // env(safe-area-inset-*) is only non-zero in the iOS WebView with viewport-fit=cover
    expect(new DOMParser().parseFromString(html, 'text/html').querySelector('meta[name="viewport"]').content).toMatch(/viewport-fit=cover/);
  });

  it('a captive portal answering 200 HTML keeps the offline copy instead of showing the login', async () => {
    loadUser.mockResolvedValue(admin);
    vi.stubGlobal('fetch', routes({ 'GET /api/setup/status': html(), 'GET /api/auth/me': html() }));
    render(<App />);
    expect(await screen.findByText('Dashboard von admin (offline)')).toBeTruthy();
    expect(clearOfflineData).not.toHaveBeenCalled();
  });

  it('on phones the offline banner sits above the bottom bars of the shelf and of a series page', async () => {
    loadUser.mockResolvedValue(admin);
    vi.stubGlobal('fetch', routes({ 'GET /api/setup/status': html(), 'GET /api/auth/me': html() }));
    go('/manga/5');
    render(<App />);
    expect(await screen.findByText(/Reihe 5/)).toBeTruthy();
    const banner = screen.getByText(/Offline – Stand der Sammlung/).closest('[role="status"]');
    expect(banner.className).toContain('max-sm:bottom-[calc(3.5rem+env(safe-area-inset-bottom))]');
  });

  it('a non-JSON 401 (basic-auth proxy) does not wipe the offline copy', async () => {
    loadUser.mockResolvedValue(admin);
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': html(401),
      'GET /api/auth/me': new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain' } })
    }));
    render(<App />);
    expect(await screen.findByText('Dashboard von admin (offline)')).toBeTruthy();
    expect(clearOfflineData).not.toHaveBeenCalled();
  });

  it('a JSON 401 at startup clears the offline copy', async () => {
    loadUser.mockResolvedValue(admin);
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': sessionGone()
    }));
    render(<App />);
    await screen.findByLabelText('Passwort');
    expect(clearOfflineData).toHaveBeenCalled();
  });

  it('setup: ADMIN_EXISTS moves on to the login with a German hint', async () => {
    let setupDone = false;
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': () => json(200, { needsSetup: !setupDone }),
      'GET /api/auth/me': json(401, { error: 'Nicht angemeldet', code: 'AUTH_REQUIRED' }),
      'POST /api/setup': () => { setupDone = true; return json(400, { error: 'Es gibt bereits einen Administrator – bitte anmelden', code: 'ADMIN_EXISTS' }); }
    }));
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Admin-Benutzername'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /Admin-Konto anlegen/ }));

    expect(await screen.findByText(MESSAGES.adminExists)).toBeTruthy();
    expect(screen.getByLabelText('Benutzername')).toBeTruthy();
  });
});

describe('Login', () => {
  it('binds the labels and sets the autocomplete hints', () => {
    render(<Login onLogin={vi.fn()} />);
    const user = screen.getByLabelText('Benutzername');
    const pass = screen.getByLabelText('Passwort');
    expect(user.getAttribute('autocomplete')).toBe('username');
    expect(user.getAttribute('name')).toBe('username');
    expect(pass.getAttribute('type')).toBe('password');
    expect(pass.getAttribute('autocomplete')).toBe('current-password');
  });

  it('announces a wrong password', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'Ungültige Anmeldedaten' })));
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: /Anmelden/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Ungültige Anmeldedaten');
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('app build: the login stores the bearer token the server returns; the browser build ignores it', async () => {
    const answer = () => json(200, { user: admin, token: 'jwt-app' });
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    const submit = async () => {
      const onLogin = vi.fn(async () => ({ status: 'online', user: admin }));
      const view = render(<MemoryRouter><Login onLogin={onLogin} /></MemoryRouter>);
      fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'a' } });
      fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'b' } });
      fireEvent.click(screen.getByRole('button', { name: /Anmelden/ }));
      await waitFor(() => expect(onLogin).toHaveBeenCalled());
      view.unmount();
    };
    await submit();
    expect(getToken()).toBe('');

    vi.stubEnv('VITE_APP_MODE', 'app');
    setActiveBase('https://shelf.example.org');
    try {
      await submit();
      expect(getToken()).toBe('jwt-app');
      expect(fetchMock.mock.calls[1][0]).toBe('https://shelf.example.org/api/auth/login');
      expect(fetchMock.mock.calls[1][1].headers['X-Client']).toBe('app');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a runtime session expiry also drops the stored bearer token', async () => {
    setToken('jwt-old');
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    render(<App />);
    await screen.findByText('Dashboard von admin');
    act(() => { window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { url: '/api/mangas', status: 401 } })); });
    expect(await screen.findByText(MESSAGES.sessionExpired)).toBeTruthy();
    expect(getToken()).toBe('');
  });

  it('reports a session cookie the browser did not keep instead of staying silent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { success: true, user: admin })));
    render(<Login onLogin={vi.fn(async () => ({ status: 'unauthorized', user: null }))} />);
    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: /Anmelden/ }));
    expect((await screen.findByRole('alert')).textContent).toBe(MESSAGES.cookieRejected);
  });

  it('shows a German error for an HTML error page instead of a JSON parse error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => html(502)));
    render(<Login onLogin={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: /Anmelden/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Anmeldung fehlgeschlagen');
  });
});

describe('Setup', () => {
  it('binds labels, asks for a new password and enforces the minimum length', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<Setup onComplete={vi.fn()} />);
    const pass = screen.getByLabelText('Passwort');
    expect(pass.getAttribute('autocomplete')).toBe('new-password');
    expect(pass.getAttribute('minlength')).toBe('8');
    expect(document.getElementById(pass.getAttribute('aria-describedby')).textContent).toMatch(/8 Zeichen/);
    expect(screen.getByLabelText('Admin-Benutzername').getAttribute('autocomplete')).toBe('username');

    fireEvent.change(screen.getByLabelText('Admin-Benutzername'), { target: { value: 'admin' } });
    fireEvent.change(pass, { target: { value: 'short' } });
    fireEvent.submit(pass.closest('form'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/mindestens 8 Zeichen/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AppErrorBoundary', () => {
  const swallow = (e) => e.preventDefault();
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
  beforeEach(() => { window.addEventListener('error', swallow); });
  afterEach(() => { window.removeEventListener('error', swallow); });

  it('shows a reload screen for a stale route chunk instead of a blank page', async () => {
    quiet();
    sessionStorage.setItem('mangashelf_chunk_reload_at', String(Date.now()));
    const Broken = lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/MangaDetail-OLD.js')));
    render(
      <AppErrorBoundary>
        <Suspense fallback={null}><Broken /></Suspense>
      </AppErrorBoundary>
    );
    expect(await screen.findByText('Neue Version verfügbar')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Neu laden/ })).toBeTruthy();
  });

  it('shows a generic error screen for other render errors and resets on navigation', async () => {
    quiet();
    const Boom = () => { throw new Error('kaputt'); };
    const { rerender } = render(<AppErrorBoundary resetKey="/a"><Boom /></AppErrorBoundary>);
    expect(screen.getByText('Etwas ist schiefgelaufen')).toBeTruthy();
    rerender(<AppErrorBoundary resetKey="/b"><p>Andere Seite</p></AppErrorBoundary>);
    expect(screen.getByText('Andere Seite')).toBeTruthy();
  });
});

describe('appShell helpers', () => {
  it('readJson ignores non-JSON and broken bodies', async () => {
    expect(await readJson(html())).toBeNull();
    expect(await readJson(new Response('{broken', { headers: { 'Content-Type': 'application/json' } }))).toBeNull();
  });

  it('safeRedirectTarget keeps query and hash and rejects foreign or login targets', () => {
    expect(safeRedirectTarget({ pathname: '/manga/5', search: '?a=1', hash: '#x' })).toBe('/manga/5?a=1#x');
    expect(safeRedirectTarget({ pathname: '//evil.example/x' })).toBe('/');
    expect(safeRedirectTarget({ pathname: '/login' })).toBe('/');
    expect(safeRedirectTarget('https://evil.example')).toBe('/');
    expect(safeRedirectTarget(undefined)).toBe('/');
  });

  it('isChunkLoadError recognises the browser messages', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: x'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it('reloadForStaleChunk reloads at most once per 30 s', () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const reload = vi.fn();
    expect(reloadForStaleChunk({ storage, now: 100000, reload })).toBe(true);
    expect(reloadForStaleChunk({ storage, now: 110000, reload })).toBe(false);
    expect(reloadForStaleChunk({ storage, now: 140001, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(reloadForStaleChunk({ storage: null, reload })).toBe(false);
  });

  it('clearUploadsCache deletes only the cover caches and tolerates a missing Cache Storage', async () => {
    const cacheStorage = { keys: vi.fn(async () => ['mangashelf-uploads-v1', 'mangashelf-uploads-v2', 'mangashelf-app-2.0.0']), delete: vi.fn(async () => true) };
    await clearUploadsCache(cacheStorage);
    expect(cacheStorage.delete.mock.calls.map((c) => c[0])).toEqual(['mangashelf-uploads-v1', 'mangashelf-uploads-v2']);
    await expect(clearUploadsCache(null)).resolves.toBeUndefined();
    await expect(clearUploadsCache({ keys: async () => { throw new Error('SecurityError'); } })).resolves.toBeUndefined();
  });

  it('runBeforeLogout waits for handed-over work, but not longer than the timeout', async () => {
    await expect(runBeforeLogout()).resolves.toBeUndefined();
    vi.useFakeTimers();
    const target = new EventTarget();
    target.addEventListener(BEFORE_LOGOUT_EVENT, (e) => e.detail.waitUntil(new Promise(() => {})));
    let done = false;
    const run = runBeforeLogout({ target, timeoutMs: 1000 }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(done).toBe(true);
    vi.useRealTimers();
  });

  it('registers the service worker only for production builds on a secure origin', () => {
    expect(shouldRegisterServiceWorker({ prod: true, secure: true, supported: true })).toBe(true);
    expect(shouldRegisterServiceWorker({ prod: true, secure: false, supported: true })).toBe(false);
    expect(shouldRegisterServiceWorker({ prod: false, secure: true, supported: true })).toBe(false);
    expect(shouldRegisterServiceWorker({ prod: true, secure: true, supported: false })).toBe(false);
  });
});

describe('App: outbox on logout', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    go('/');
    resetOutbox();
    loadUser.mockReset().mockResolvedValue(null);
    loadMeta.mockReset().mockResolvedValue(null);
  });

  it('changes that could not be sent before the logout stay queued and the login says so', async () => {
    const fetchMock = routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin }),
      'POST /api/volumes/3/read': html(503),
      'POST /api/auth/logout': json(200, { success: true })
    });
    vi.stubGlobal('fetch', fetchMock);
    await getOutbox().add({ kind: 'read', volumeId: 3, userId: 1, serverId: WEB_SERVER_ID, value: true, deferred: true });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abmelden' }));
    expect(await screen.findByText(/Vorgemerkte Änderungen werden bei deiner nächsten Anmeldung/)).toBeTruthy();
    expect(fetchMock.calls).toContain('POST /api/volumes/3/read');
    expect(getOutbox().list(outboxScope(1))).toHaveLength(1);
  });

  it('after the login the queued changes are sent and announced', async () => {
    const fetchMock = routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin }),
      'POST /api/volumes/3/read': json(200, { success: true })
    });
    vi.stubGlobal('fetch', fetchMock);
    const shown = [];
    const stop = (await import('../utils/notify')).subscribe((e) => { if (e.type === 'show') shown.push(e.toast.message); });
    await getOutbox().add({ kind: 'read', volumeId: 3, userId: 1, serverId: WEB_SERVER_ID, value: true, deferred: true });
    try {
      render(<App />);
      await screen.findByText('Dashboard von admin');
      await waitFor(() => expect(getOutbox().list(outboxScope(1))).toEqual([]));
      expect(shown).toContain('1 Änderung übertragen');
    } finally {
      stop();
    }
  });
});

describe('App in the app build', () => {
  const healthy = () => json(200, { name: 'Manga Shelf', status: 'ok', instance_id: 'inst-1', version: '2.20.0' });

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    go('/');
    setStorageAdapter(null);
    resetServers();
    resetConnection();
    resetOutbox();
    loadUser.mockReset().mockResolvedValue(null);
    loadMeta.mockReset().mockResolvedValue(null);
    clearOfflineData.mockClear();
    vi.stubEnv('VITE_APP_MODE', 'app');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('without a saved server it opens the server screen; a saved reachable server leads to its login', async () => {
    vi.stubGlobal('fetch', routes({
      'GET /api/health': healthy(),
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(401, { error: 'Nicht angemeldet', code: 'AUTH_REQUIRED' })
    }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Server hinzufügen' })).toBeTruthy();
    expect(window.location.pathname).toBe('/server');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Zuhause' } });
    fireEvent.change(screen.getByLabelText('Adressen (eine pro Zeile)'), { target: { value: 'https://shelf.example' } });
    fireEvent.click(screen.getByRole('button', { name: /Speichern und verbinden/ }));
    expect(await screen.findByLabelText('Passwort')).toBeTruthy();
    expect(window.location.pathname).toBe('/login');
    expect(screen.getByText('Zuhause')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Server wechseln' })).toBeTruthy();
    expect(getActiveServer()).toMatchObject({ name: 'Zuhause', instanceId: 'inst-1', lastOkUrl: 'https://shelf.example' });
  });

  it('with a token of the server the collection opens at once and requests carry the bearer token', async () => {
    const s = saveServer({ name: 'Zuhause', urls: ['https://shelf.example'], token: 'tok-1' });
    activateServer(s.id);
    const fetchMock = routes({
      'GET /api/health': healthy(),
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    const me = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/auth/me'));
    expect(me[0]).toBe('https://shelf.example/api/auth/me');
    expect(me[1].headers.Authorization).toBe('Bearer tok-1');
    const probe = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/health'));
    expect(probe[1].headers).toBeUndefined();
  });

  it('a server that does not answer: the login says so and "Erneut verbinden" retries', async () => {
    const s = saveServer({ name: 'Zuhause', urls: ['https://shelf.example'], token: 'tok-1' });
    activateServer(s.id);
    let up = false;
    vi.stubGlobal('fetch', routes({
      'GET /api/health': () => (up ? healthy() : Promise.reject(new TypeError('Failed to fetch'))),
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    render(<App />);
    expect(await screen.findByText('Nicht erreichbar')).toBeTruthy();
    up = true;
    fireEvent.click(screen.getByRole('button', { name: /Erneut verbinden/ }));
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
  });

  it('a session expiry returns to the login of the same server and keeps the server entry', async () => {
    const s = saveServer({ name: 'Zuhause', urls: ['https://shelf.example'], token: 'tok-1' });
    activateServer(s.id);
    vi.stubGlobal('fetch', routes({
      'GET /api/health': healthy(),
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    render(<App />);
    await screen.findByText('Dashboard von admin');
    act(() => { window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { url: '/api/mangas', status: 401 } })); });
    expect(await screen.findByText(MESSAGES.sessionExpired)).toBeTruthy();
    expect(getActiveServer()).toMatchObject({ id: s.id, name: 'Zuhause' });
    expect(getActiveServer().token).toBeUndefined();
    expect(screen.getByText('Zuhause')).toBeTruthy();
  });

  it('a logout that failed on server A is never sent to server B; A gets it when it is reachable again', async () => {
    const a = saveServer({ name: 'Server A', urls: ['https://a.example'], token: 'tok-a' });
    const b = saveServer({ name: 'Server B', urls: ['https://b.example'], token: 'tok-b' });
    activateServer(a.id);
    const logouts = [];
    let aUp = false;
    vi.stubGlobal('fetch', routes({
      'GET /api/health': healthy(),
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': (url, init) => (init.headers?.Authorization ? json(200, { user: admin }) : json(401, { error: 'Nicht angemeldet', code: 'AUTH_REQUIRED' })),
      'POST /api/auth/logout': (url, init) => {
        logouts.push([new URL(url).host, init.headers?.Authorization]);
        if (url.startsWith('https://a.example') && !aUp) return Promise.reject(new TypeError('Failed to fetch'));
        return json(200, { success: true });
      }
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abmelden' }));
    expect(await screen.findByText(MESSAGES.logoutPending)).toBeTruthy();
    expect(getServer(a.id).token).toBeUndefined();
    expect(getPendingLogouts(a.id)).toHaveLength(1);

    fireEvent.click(screen.getByRole('link', { name: 'Server wechseln' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verbinden' }));
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    // tried again on the reconnect, but only ever at A with A's token
    expect(logouts.length).toBeGreaterThan(0);
    expect(logouts.every(([host, auth]) => host === 'a.example' && auth === 'Bearer tok-a')).toBe(true);
    expect(getServer(b.id).token).toBe('tok-b');
    expect(getPendingLogouts(a.id)).toHaveLength(1);

    aUp = true;
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(getPendingLogouts(a.id)).toEqual([]));
    expect(logouts.every(([host, auth]) => host === 'a.example' && auth === 'Bearer tok-a')).toBe(true);
    expect(getServer(a.id).token).toBeUndefined();
  });

  it('a new login while the old logout is still pending is accepted; the old token waits for its own logout', async () => {
    const a = saveServer({ name: 'Zuhause', urls: ['https://shelf.example'], token: 'tok-old' });
    activateServer(a.id);
    const authorizations = [];
    vi.stubGlobal('fetch', routes({
      'GET /api/health': healthy(),
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': (url, init) => (init.headers?.Authorization === 'Bearer tok-new'
        ? json(200, { user: admin })
        : json(401, { error: 'Nicht angemeldet', code: 'AUTH_REQUIRED' })),
      'POST /api/auth/logout': (url, init) => {
        authorizations.push(init.headers?.Authorization);
        return Promise.reject(new TypeError('Failed to fetch'));
      },
      'POST /api/auth/login': json(200, { user: admin, token: 'tok-new' })
    }));
    // the logout of tok-old did not arrive
    (await import('../app/serverStore')).beginLogout(a.id);
    render(<App />);
    expect(await screen.findByText(MESSAGES.logoutPending)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /Anmelden/ }));
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    expect(getToken()).toBe('tok-new');
    expect(getPendingLogouts(a.id)).toMatchObject([{ token: 'tok-old' }]);
    expect(authorizations.every((h) => h === 'Bearer tok-old')).toBe(true);
  });

  it('another address of the server needs a new login there: the login says so and the old session is kept', async () => {
    const s = saveServer({ name: 'Zuhause', urls: ['https://pub.example', 'http://10.0.0.2:3000'], token: 'tok-pub', tokenOrigins: ['https://pub.example'] });
    activateServer(s.id);
    const meAuth = [];
    vi.stubGlobal('fetch', routes({
      'GET /api/health': (url) => (url.startsWith('https://pub') ? Promise.reject(new TypeError('x')) : healthy()),
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': (url, init) => {
        meAuth.push(init.headers?.Authorization);
        return init.headers?.Authorization ? json(200, { user: admin }) : json(401, { error: 'Nicht angemeldet', code: 'AUTH_REQUIRED' });
      },
      'POST /api/auth/login': json(200, { user: admin, token: 'tok-lan' })
    }));
    render(<App />);
    expect(await screen.findByText('Neue Adresse – bitte erneut anmelden')).toBeTruthy();
    expect(meAuth).toEqual([undefined]);
    expect(getServer(s.id).token).toBe('tok-pub');
    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /Anmelden/ }));
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    // the new session is trusted only at the address it was signed in at
    expect(getServer(s.id)).toMatchObject({ token: 'tok-lan', tokenOrigins: ['http://10.0.0.2:3000'] });
  });

  it('a connect link opens the server screen with the new address filled in', async () => {
    const s = saveServer({ name: 'Zuhause', urls: ['https://shelf.example'], token: 'tok-1' });
    activateServer(s.id);
    vi.stubGlobal('fetch', routes({
      'GET /api/health': healthy(),
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    render(<App />);
    await screen.findByText('Dashboard von admin');
    act(() => { receiveDeepLink('manga-shelf://connect?url=https%3A%2F%2Fladen.example&name=Laden&id=other'); });
    expect(await screen.findByRole('heading', { name: 'Server hinzufügen' })).toBeTruthy();
    expect(screen.getByLabelText('Adressen (eine pro Zeile)').value).toBe('https://laden.example');
    expect(screen.getByLabelText('Name').value).toBe('Laden');
    expect(screen.getByRole('link', { name: 'Zurück zur Sammlung' })).toBeTruthy();
  });

  it('a shared Crunchyroll link never opens the server screen: from a series page it leads to the anime tab', async () => {
    const s = saveServer({ name: 'Zuhause', urls: ['https://shelf.example'], token: 'tok-1' });
    activateServer(s.id);
    go('/manga/3');
    vi.stubGlobal('fetch', routes({
      'GET /api/health': healthy(),
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    render(<App />);
    await screen.findByText(/Reihe 3/);
    act(() => { receiveDeepLink('https://www.crunchyroll.com/de/watch/GG1U2Q5MW/the-hero-party'); });
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    expect(screen.getByTestId('dashboard-wiring').textContent).toContain('?view=anime');
    expect(screen.queryByRole('heading', { name: 'Server hinzufügen' })).toBeNull();
    takePendingShare();
  });

  it('a logout cancels a running backup download, so it never completes for the signed-out user', async () => {
    const s = saveServer({ name: 'Zuhause', urls: ['https://shelf.example'], token: 'tok-1' });
    activateServer(s.id);
    let aborted = false;
    vi.stubGlobal('fetch', routes({
      'GET /api/health': healthy(),
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin }),
      'POST /api/auth/logout': json(200, { success: true }),
      'GET /api/backup': (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })
    }));
    render(<App />);
    await screen.findByText('Dashboard von admin');
    const download = startDownload('/api/backup', { filename: 'backup.zip' });
    expect(downloadsRunning()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    expect(await download).toBe(false);
    expect(aborted).toBe(true);
    expect(downloadsRunning()).toBe(false);
    await screen.findByLabelText('Passwort');
  });

  it('a saved server with a plain http address outside the home network: the login names it and asks for no token', async () => {
    const s = saveServer({ name: 'Alt', urls: ['http://manga.example.org'] });
    activateServer(s.id);
    const fetchMock = routes({
      'GET /api/health': healthy(),
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(401, { error: 'Nicht angemeldet', code: 'AUTH_REQUIRED' })
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText((text) => text.startsWith(INSECURE_URL_TEXT))).toBeTruthy();
    expect(screen.queryByText('Neue Adresse – bitte erneut anmelden')).toBeNull();
    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /Anmelden/ }));
    expect(await screen.findByText(INSECURE_URL_TEXT)).toBeTruthy();
    expect(fetchMock.calls).not.toContain('POST /api/auth/login');
    expect(getServer(s.id).token).toBeUndefined();
    fireEvent.click(screen.getByRole('link', { name: 'Server bearbeiten' }));
    expect(await screen.findByRole('heading', { name: 'Server bearbeiten' })).toBeTruthy();
    expect(screen.getByLabelText('Adressen (eine pro Zeile)').value).toBe('http://manga.example.org');
  });
});
