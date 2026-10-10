// SystemModal: server info, source API keys and guides, formatBytes and formatUptime.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';
import SystemModal, { formatBytes, formatUptime } from '../components/modals/SystemModal';
import DashboardHeader from '../components/dashboard/DashboardHeader';

const GUIDES = JSON.parse(JSON.stringify(createRequire(import.meta.url)('../../../core/sources/guides.js').GUIDES));
const keyState = (provider, extra = {}) => ({ provider, configured: false, from_env: false, label: null, last4: null, allow_background: false, last_ok_at: null, last_error: null, ...extra });
const MB = 1024 * 1024;

const systemInfo = (over = {}) => ({
  version: '2.19.1',
  node: 'v24.1.0',
  platform: 'linux/x64',
  uptime: 2 * 86400 + 3 * 3600,
  memory_rss: 80 * MB,
  data_dir: '/srv/manga/data',
  health: { status: 'degraded', checks: { db: 'ok', writable: 'ok', disk: 'low', backup: 'ok', restoring: false } },
  database: { bytes: 12 * MB, wal_bytes: 2 * MB, freelist_bytes: 0, schema_version: 20, latest_schema_version: 20, counts: { mangas: 120, volumes: 2400, users: 3, animes: 5 } },
  storage: { free_bytes: 3 * 1024 * MB, total_bytes: 20 * 1024 * MB, uploads: { count: 900, bytes: 300 * MB } },
  orphans: { count: 4, bytes: 3 * MB, skipped: false, checked_at: '2026-10-04T10:00:00Z' },
  backups: {
    count: 7, bytes: 700 * MB,
    latest: { filename: 'manual-1.zip', size: MB, created_at: '2026-10-04T09:00:00Z', category: 'manual', verify_error: null },
    last_verified: { filename: 'manual-1.zip', size: MB, created_at: '2026-10-04T09:00:00Z', category: 'manual', verify_error: null },
    last_failed: null,
    daily_due: false,
    schedule: { hour: 3, time_zone: 'Europe/Berlin' }
  },
  jobs: { running: [], restore_running: false },
  sources: { users_with_keys: 2 },
  update: { enabled: true, current: '2.19.1', latest: '2.20.0', available: true, url: 'https://github.com/LixNix-Swap-Org/manga-shelf/releases/tag/v2.20.0', checked_at: '2026-10-04T08:00:00Z', releases: [] },
  ...over
});
const pool = (used, extra = {}) => ({ enabled: true, name: 'x', limit: 30, remaining: 30, reset_at: null, paused_until: null, circuit: 'closed', used_last_hour: used, slow_recently: false, own: null, key_disabled: false, ...extra });

function serve({ info = systemInfo(), extra = () => undefined } = {}) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const custom = extra(url, init);
    if (custom) return custom;
    const method = init.method || 'GET';
    if (url.startsWith('/api/system') && method === 'GET') return fakeResponse(200, typeof info === 'function' ? info() : info);
    if (url === '/api/anime/sources') return fakeResponse(200, { anilist: pool(42), mal: { ...pool(7), adapter: 'jikan' }, credential: {}, slow_recently: false, background_waiting: 0 });
    if (url === '/api/sources/guides') return fakeResponse(200, GUIDES);
    if (url === '/api/admin/api-keys') return fakeResponse(200, { keys: [keyState('mal', { configured: true, from_env: true }), keyState('google_books')], users_with_keys: 2 });
    if (url === '/api/backups/create') return fakeResponse(200, { success: true, snapshot: { verified: true } });
    if (url === '/api/system/orphans/clean') return fakeResponse(200, { success: true, removed: 4, bytes: 3 * MB, skipped: false });
    if (url === '/api/system/sessions/end-all') return fakeResponse(200, { success: true, users: 3 });
    return fakeResponse(404, { error: 'Nicht gefunden' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calls = (fetchMock, url, method = 'POST') => fetchMock.mock.calls.filter(([u, i]) => u === url && (i?.method || 'GET') === method);

let toasts;
beforeEach(() => { toasts = recordToasts(); });
afterEach(() => {
  toasts.stop();
  vi.unstubAllGlobals();
});

describe('SystemModal', () => {
  it('shows version, update, health, storage, backups, orphans and the sources', async () => {
    serve();
    render(<SystemModal isOpen onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: 'System' });
    await screen.findByText('v2.19.1');
    expect(document.getElementById('system-update').textContent).toContain('Neue Version verfügbar: v2.20.0');
    expect(within(dialog).getByRole('region', { name: 'Updates' }).contains(document.getElementById('system-update'))).toBe(true);
    expect(within(dialog).getByRole('link', { name: /Versionshinweise/ }).getAttribute('href')).toMatch(/^https:\/\/github\.com\//);
    expect(screen.getByTestId('system-health').textContent).toBe('Eingeschränkt: wenig freier Speicher');
    expect(dialog.textContent).toContain('2 Tage, 3 Std.');
    expect(dialog.textContent).toContain('/srv/manga/data');
    expect(dialog.textContent).toContain('12,0 MB + 2,0 MB WAL');
    expect(dialog.textContent).toContain('900 · 300,0 MB');
    expect(dialog.textContent).toContain('3,00 GB von 20,00 GB');
    expect(dialog.textContent).toContain('120 Reihen · 2.400 Bände · 5 Anime · 3 Benutzer');
    expect(dialog.textContent).toContain('täglich ab 3 Uhr (Europe/Berlin)');
    expect(screen.getByTestId('system-orphans').textContent).toContain('4 Bilder ohne Verwendung (3,0 MB)');

    const sources = within(dialog).getByRole('region', { name: 'Quellen' });
    await waitFor(() => expect(sources.textContent).toContain('42 Anfragen in der letzten Stunde'));
    expect(sources.textContent).toContain('MyAnimeList (Jikan, Pool)');
    expect(sources.textContent).toMatch(/Benutzer mit eigenem Schlüssel\s*2/);
    const cards = await within(sources).findByTestId('system-instance-keys');
    expect(within(cards).getByRole('heading', { name: /Google Books/ })).toBeTruthy();
    expect(within(cards).getByRole('heading', { name: /MyAnimeList/ })).toBeTruthy();
  });

  it('"Backup jetzt" creates a snapshot and reloads the page data', async () => {
    let created = false;
    const fetchMock = serve({ info: () => systemInfo({ backups: { ...systemInfo().backups, count: created ? 8 : 7 } }), extra: (url) => {
      if (url === '/api/backups/create') {
        created = true;
        return fakeResponse(200, { success: true, snapshot: { verified: true } });
      }
      return undefined;
    } });
    render(<SystemModal isOpen onClose={vi.fn()} />);
    await screen.findByText('v2.19.1');
    fireEvent.click(screen.getByRole('button', { name: /Backup jetzt/ }));
    await waitFor(() => expect(toasts.messages('success')).toContain('Snapshot erstellt und geprüft'));
    expect(calls(fetchMock, '/api/backups/create')).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('8 · 700,0 MB'));
  });

  it('"Waisen aufräumen" asks first, then removes; nothing to clean disables it', async () => {
    const fetchMock = serve();
    const { unmount } = render(<SystemModal isOpen onClose={vi.fn()} />);
    await screen.findByText('v2.19.1');
    fireEvent.click(screen.getByRole('button', { name: /Waisen aufräumen/ }));
    expect(calls(fetchMock, '/api/system/orphans/clean')).toHaveLength(0);
    const question = screen.getByRole('group', { name: '4 Dateien endgültig löschen?' });
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Ja, löschen' }));
    fireEvent.click(within(question).getByRole('button', { name: 'Abbrechen' }));
    expect(calls(fetchMock, '/api/system/orphans/clean')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Waisen aufräumen/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ja, löschen' }));
    await waitFor(() => expect(toasts.messages('success')).toContain('4 verwaiste Dateien entfernt (3,0 MB)'));
    expect(calls(fetchMock, '/api/system/orphans/clean')).toHaveLength(1);
    unmount();

    serve({ info: systemInfo({ orphans: { count: 0, bytes: 0, skipped: false } }) });
    render(<SystemModal isOpen onClose={vi.fn()} />);
    await screen.findByText('v2.19.1');
    expect(screen.getByRole('button', { name: /Waisen aufräumen/ }).disabled).toBe(true);
  });

  it('"Alle Sitzungen beenden" asks first and reports how many users were signed out', async () => {
    const fetchMock = serve();
    render(<SystemModal isOpen onClose={vi.fn()} />);
    await screen.findByText('v2.19.1');
    fireEvent.click(screen.getByRole('button', { name: /Alle Sitzungen beenden/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ja, beenden' }));
    await waitFor(() => expect(toasts.messages('success')[0]).toMatch(/^Alle Sitzungen beendet \(3 Benutzer\)/));
    expect(calls(fetchMock, '/api/system/sessions/end-all')).toHaveLength(1);
  });

  it('shows the server error with a retry when the page cannot load', async () => {
    let fail = true;
    serve({ extra: (url) => (url === '/api/system' && fail ? fakeResponse(403, { error: 'Keine Berechtigung', code: 'FORBIDDEN' }) : undefined) });
    render(<SystemModal isOpen onClose={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Keine Berechtigung');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await screen.findByText('v2.19.1');
  });

  it('opens on "Schließen"; "Neu laden" keeps the focus while it loads and ignores repeated presses', async () => {
    let release;
    const fetchMock = serve({ extra: (url) => (url === '/api/system?refresh=1' ? new Promise((r) => { release = () => r(fakeResponse(200, systemInfo())); }) : undefined) });
    render(<SystemModal isOpen onClose={vi.fn()} />);
    await screen.findByText('v2.19.1');
    const close = screen.getByRole('button', { name: 'Schließen' });
    expect(close.hasAttribute('data-autofocus')).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(close));
    const reload = screen.getByRole('button', { name: 'Neu laden' });
    reload.focus();
    fireEvent.click(reload);
    await waitFor(() => expect(reload.getAttribute('aria-disabled')).toBe('true'));
    expect(reload.disabled).toBe(false);
    expect(document.activeElement).toBe(reload);
    fireEvent.click(reload);
    expect(fetchMock.mock.calls.filter(([u]) => u === '/api/system?refresh=1')).toHaveLength(1);
    release();
    await waitFor(() => expect(reload.getAttribute('aria-disabled')).toBeNull());
    expect(document.activeElement).toBe(reload);
  });

  it('formats bytes and uptime', () => {
    expect(formatBytes(null)).toBe('–');
    expect(formatBytes(1500)).toBe('2 KB');
    expect(formatBytes(5.25 * MB)).toBe('5,3 MB');
    expect(formatBytes(1536 * MB)).toBe('1,50 GB');
    expect(formatUptime(59)).toBe('0 Min.');
    expect(formatUptime(3 * 3600 + 120)).toBe('3 Std., 2 Min.');
    expect(formatUptime(86400 + 3600)).toBe('1 Tag, 1 Std.');
  });
});

const headerProps = (overrides = {}) => ({
  activeMainView: 'shelf', canEdit: true, handleBarcodeDetected: vi.fn(), handleInstallClick: vi.fn(), handleOpenCsvModal: vi.fn(),
  handleOpenModal: vi.fn(), handleOpenPasswordModal: vi.fn(), handleOpenRestoreModal: vi.fn(), handleOpenStats: vi.fn(),
  handleOpenUsersModal: vi.fn(), isInstallable: false, isInstalledApp: false, isOfflineMode: false, isVisitor: false,
  mobileMenuOpen: false, onLogout: vi.fn(), radarData: null, search: '', searchInputRef: { current: null },
  setMobileMenuOpen: vi.fn(), setSearch: vi.fn(), setView: vi.fn(), shoppingData: null,
  user: { id: 1, username: 'root', role: 'admin' },
  ...overrides
});

describe('DashboardHeader: System entry', () => {
  it('is admin-only on desktop and in the menu, and opens the system page', async () => {
    serve();
    const { rerender } = render(<DashboardHeader {...headerProps({ user: { id: 2, username: 'ed', role: 'editor' }, mobileMenuOpen: true })} />);
    expect(document.getElementById('btn-open-system')).toBeNull();
    expect(document.getElementById('btn-mobile-menu-system')).toBeNull();

    rerender(<DashboardHeader {...headerProps({ mobileMenuOpen: true })} />);
    expect(document.getElementById('btn-mobile-menu-system')).toBeTruthy();
    fireEvent.click(document.getElementById('btn-open-system'));
    const dialog = await screen.findByRole('dialog', { name: 'System' });
    expect(dialog.parentElement).toBe(document.body);
    await within(dialog).findByText('v2.19.1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schließen' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'System' })).toBeNull());

    rerender(<DashboardHeader {...headerProps({ user: { id: 1, username: 'root', role: 'admin', offline: true } })} />);
    expect(document.getElementById('btn-open-system')).toBeNull();
  });
});
