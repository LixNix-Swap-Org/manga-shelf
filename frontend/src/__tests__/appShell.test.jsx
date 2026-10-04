import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { useParams } from 'react-router-dom';

vi.mock('../utils/offlineStore', () => ({
  saveUser: vi.fn(async () => {}),
  loadUser: vi.fn(async () => null),
  loadMeta: vi.fn(async () => null),
  loadMangaList: vi.fn(async () => []),
  clearOfflineData: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true),
  formatAge: vi.fn(() => 'vor 5 Min.')
}));

vi.mock('../Dashboard', () => ({
  default: function DashboardStub({ user, onLogout }) {
    return (
      <div>
        <p>Dashboard von {user.username}{user.offline ? ' (offline)' : ''}</p>
        <button type="button" onClick={onLogout}>Abmelden</button>
      </div>
    );
  }
}));

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
  MESSAGES, LOGOUT_PENDING_KEY, UPDATE_AVAILABLE_EVENT,
  safeRedirectTarget, isChunkLoadError, reloadForStaleChunk, clearUploadsCache, shouldRegisterServiceWorker, readJson,
  BEFORE_LOGOUT_EVENT, runBeforeLogout, STARTUP_TIMEOUT_MS
} from '../appShell';
import { getToken, setToken } from '../app/connection';
import { notify } from '../utils/notify';

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
    fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    await screen.findByLabelText('Passwort');
    expect(sessionStorage.getItem(SCAN_LIST_KEY)).toBeNull();
    expect(localStorage.getItem(SCAN_LIST_KEY)).toBeNull();
    expect(sessionStorage.getItem('mangashelf_search')).toBeNull();
    for (const key of [SHELF_SCROLL_KEY, SHELF_COUNT_KEY, DETAIL_SCROLL_KEY]) expect(sessionStorage.getItem(key), key).toBeNull();
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
  });

  it('a captive portal answering 200 HTML keeps the offline copy instead of showing the login', async () => {
    loadUser.mockResolvedValue(admin);
    vi.stubGlobal('fetch', routes({ 'GET /api/setup/status': html(), 'GET /api/auth/me': html() }));
    render(<App />);
    expect(await screen.findByText('Dashboard von admin (offline)')).toBeTruthy();
    expect(clearOfflineData).not.toHaveBeenCalled();
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

  it('shows a reload hint when a new service worker version is ready', async () => {
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: admin })
    }));
    render(<App />);
    await screen.findByText('Dashboard von admin');
    act(() => { window.dispatchEvent(new CustomEvent(UPDATE_AVAILABLE_EVENT)); });
    expect(await screen.findByText('Neue Version verfügbar')).toBeTruthy();
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
      const view = render(<Login onLogin={onLogin} />);
      fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'a' } });
      fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'b' } });
      fireEvent.click(screen.getByRole('button', { name: /Anmelden/ }));
      await waitFor(() => expect(onLogin).toHaveBeenCalled());
      view.unmount();
    };
    await submit();
    expect(getToken()).toBe('');

    vi.stubEnv('VITE_APP_MODE', 'app');
    localStorage.setItem('mangashelf_server_base', 'https://shelf.example.org');
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
