// Covers backup creation and restore in the backup modal.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('../utils/offlineStore', () => ({
  clearOfflineData: vi.fn(async () => {})
}));

import { clearOfflineData } from '../utils/offlineStore';
import BackupRestoreModal, { withPasswordWarnings } from '../components/modals/BackupRestoreModal';
import {
  UNDO_KEY, UNDO_TTL_MS, manifestSummary, readRestoreUndo, saveRestoreUndo, versionSummary
} from '../components/modals/backup/backupHelpers';
import { TIMEOUTS, setServer } from '../utils/api';
import { uploadAndInspectBackup } from '../utils/backupUpload';
import { downloadProgressText } from '../components/modals/backup/DownloadLink';

const ADMIN = { id: 1, username: 'admin', role: 'admin' };
const SNAP = 'manual-2026-10-02T10-00-00.zip';
const PRE = 'vor-wiederherstellung-2026-10-03T12-00-00.zip';
const STAGING = '3f6c1a2e-0000-4000-8000-000000000001';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status) => new Response(`<html><body><h1>${status}</h1>nginx</body></html>`, { status, headers: { 'Content-Type': 'text/html' } });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function mockFetch(routes) {
  const fn = vi.fn(async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    return handler(init);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const calls = (fetchMock, method, url) => fetchMock.mock.calls.filter(([u, init = {}]) => u === url && (init.method || 'GET') === method);

const snapshot = (overrides = {}) => ({
  filename: SNAP, size: 2048, created_at: '2026-10-02T10:00:00Z', category: 'manual',
  verified: true, verify_error: null, manifest: null, ...overrides
});

const inspection = (overrides = {}) => ({
  success: true,
  staging_id: STAGING,
  expires_at: '2026-10-03T12:15:00.000Z',
  source: { type: 'snapshot', filename: SNAP, size: 2048 },
  created_at: '2026-10-02T10:00:00.000Z',
  created_at_source: 'manifest',
  app_version: '2.20.0',
  current_app_version: '2.21.0',
  schema_version: 14,
  current_schema_version: 14,
  schema_newer: false,
  has_manifest: true,
  counts: { mangas: 120, volumes: 2400, users: 3, admins: 1, uploads: 35 },
  uploads_bytes: 3 * 1024 * 1024,
  current_counts: { mangas: 121, volumes: 2410, users: 3 },
  current_user: { username: 'admin', exists: true, role: 'admin' },
  relogin: false,
  warnings: ['Alle anderen Sitzungen (andere Geräte und Benutzer) werden beendet.'],
  ...overrides
});

const restored = (overrides = {}) => json(200, {
  success: true, message: 'Backup erfolgreich eingespielt!', mangaCount: 120, restoredImagesCount: 35,
  relogin: false, preRestoreSnapshot: PRE, ...overrides
});

function renderBackup(props = {}) {
  return render(<BackupRestoreModal isOpen onClose={vi.fn()} user={ADMIN} onRestoreSuccess={vi.fn()} {...props} />);
}

async function openConfirmation() {
  fireEvent.click(await screen.findByRole('button', { name: `Snapshot ${SNAP} wiederherstellen` }));
  return screen.findByRole('heading', { name: 'Wiederherstellung bestätigen' });
}

const typePassword = (value = 'password123') => fireEvent.change(screen.getByLabelText('Passwort zur Bestätigung'), { target: { value } });

beforeEach(() => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  clearOfflineData.mockClear();
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe('backup helpers', () => {
  it('summarises a manifest with German numbers and "nur Datenbank" without images', () => {
    const manifest = { app_version: '2.20.0', schema_version: 14, counts: { mangas: 120, volumes: 2400, users: 2 }, uploads: { count: 35, bytes: 0 } };
    expect(manifestSummary(manifest)).toBe('120 Reihen · 2.400 Bände · 35 Bilder');
    expect(manifestSummary({ ...manifest, counts: { mangas: 1, volumes: 1 }, uploads: null })).toBe('1 Reihe · 1 Band · nur Datenbank');
    expect(manifestSummary(null)).toBe('');
    expect(versionSummary(manifest)).toBe('App 2.20.0 · Schema v14');
  });

  it('keeps the undo entry for 30 minutes only', () => {
    saveRestoreUndo(PRE, 1000);
    expect(readRestoreUndo(1000 + UNDO_TTL_MS - 1)).toEqual({ filename: PRE, at: 1000 });
    expect(readRestoreUndo(1000 + UNDO_TTL_MS)).toBeNull();
    expect(sessionStorage.getItem(UNDO_KEY)).toBeNull();
    sessionStorage.setItem(UNDO_KEY, '{kaputt');
    expect(readRestoreUndo()).toBeNull();
  });
});

describe('BackupRestoreModal snapshot list', () => {
  it('shows category, verification and manifest details', async () => {
    mockFetch({
      'GET /api/backups': () => json(200, {
        backups: [
          snapshot({
            filename: 'daily-auto-2026-10-02T03-00-00.zip', category: 'daily',
            manifest: { app_version: '2.20.0', schema_version: 14, counts: { mangas: 120, volumes: 2400, users: 3 }, uploads: { count: 35, bytes: 0 } }
          }),
          snapshot({ filename: PRE, category: 'pre-restore', verified: false, verify_error: 'manga.db fehlt', manifest: { counts: { mangas: 2, volumes: 3 }, uploads: null } }),
          snapshot({ filename: 'vor-update-2.20.0-2026-10-01T00-00-00.zip', category: 'pre-update', verified: null }),
          snapshot({ filename: 'irgendwas.zip', category: 'other', verified: null })
        ]
      })
    });
    renderBackup();
    const list = await screen.findByRole('list', { name: 'Server-Snapshots' });
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[0]).getByText('Täglich')).toBeTruthy();
    expect(within(rows[0]).getByText('geprüft ✓')).toBeTruthy();
    expect(within(rows[0]).getByText('120 Reihen · 2.400 Bände · 35 Bilder')).toBeTruthy();
    expect(rows[0].textContent).toMatch(/App 2\.20\.0 · Schema v14/);
    expect(within(rows[1]).getByText('Vor Wiederherstellung')).toBeTruthy();
    expect(within(rows[1]).getByText('beschädigt').getAttribute('title')).toBe('manga.db fehlt');
    expect(within(rows[1]).getByText('2 Reihen · 3 Bände · nur Datenbank')).toBeTruthy();
    expect(within(rows[2]).getByText('Vor Update')).toBeTruthy();
    expect(within(rows[2]).getByText('ungeprüft')).toBeTruthy();
    expect(rows[3].textContent).not.toMatch(/Täglich|Manuell|Sonstige/);
  });

  it('create: shows the warning of a snapshot that failed its restore test and reloads the list', async () => {
    const lists = [[], [snapshot({ verified: false, verify_error: 'Prüfung fehlgeschlagen' })]];
    mockFetch({
      'GET /api/backups': () => json(200, { backups: lists.shift() }),
      'POST /api/backups/create': () => json(200, {
        success: true, snapshot: snapshot({ verified: false }),
        warning: 'Der Snapshot wurde erstellt, hat aber die Prüfung nicht bestanden: Prüfung fehlgeschlagen'
      })
    });
    renderBackup();
    fireEvent.click(await screen.findByRole('button', { name: /Neuen Snapshot erstellen/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/hat aber die Prüfung nicht bestanden/);
    expect(await screen.findByText('beschädigt')).toBeTruthy();
  });

  it('create: 507 shows the server text', async () => {
    mockFetch({
      'GET /api/backups': () => json(200, { backups: [] }),
      'POST /api/backups/create': () => json(507, { error: 'Nicht genug Speicherplatz für den Snapshot.', code: 'INSUFFICIENT_SPACE' })
    });
    renderBackup();
    fireEvent.click(await screen.findByRole('button', { name: /Neuen Snapshot erstellen/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Nicht genug Speicherplatz für den Snapshot.');
  });

  it('create: a client timeout reloads the list and warns against a second snapshot', async () => {
    const saved = TIMEOUTS.long;
    TIMEOUTS.long = 20;
    try {
      const fetchMock = mockFetch({
        'GET /api/backups': () => json(200, { backups: [] }),
        'POST /api/backups/create': (init) => new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
      });
      renderBackup();
      fireEvent.click(await screen.findByRole('button', { name: /Neuen Snapshot erstellen/ }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/Snapshot wird eventuell noch geschrieben.*nicht erneut erstellen/);
      await waitFor(() => expect(calls(fetchMock, 'GET', '/api/backups')).toHaveLength(2));
    } finally {
      TIMEOUTS.long = saved;
    }
  });
  it('second location: while a copy runs the dialog follows its status until it ends', async () => {
    const copy = { dir: '/mnt/usb', from_env: false, ok_at: null, error: null, error_msg: null, error_at: null, copies: 0, bytes: 0, free_bytes: 1e9, same_disk_hint: false };
    const lists = [
      { backups: [snapshot()], copy: { ...copy, running: true } },
      { backups: [snapshot()], copy: { ...copy, running: false, ok_at: '2026-11-25T10:00:00Z', copies: 1, bytes: 1024 } }
    ];
    const fetchMock = mockFetch({ 'GET /api/backups': () => json(200, lists.length > 1 ? lists.shift() : lists[0]) });
    renderBackup();
    expect(await screen.findByText(/Noch keine Kopie/)).toBeTruthy();
    expect(await screen.findByText(/Letzte Kopie/, {}, { timeout: 4000 })).toBeTruthy();
    expect(calls(fetchMock, 'GET', '/api/backups')).toHaveLength(2);
  });
});

describe('BackupRestoreModal two-step restore', () => {
  it('snapshot: inspect, in-modal confirmation with counts, then restore, undo hint, offline copy dropped and reload', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const onRestoreSuccess = vi.fn();
    const fetchMock = mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection()),
      [`POST /api/backup/restore/${STAGING}`]: () => restored()
    });
    renderBackup({ onRestoreSuccess });
    await openConfirmation();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(JSON.parse(calls(fetchMock, 'POST', '/api/backup/inspect')[0][1].body)).toEqual({ filename: SNAP });
    expect(screen.queryByRole('tablist')).toBeNull();

    const table = screen.getByRole('table');
    const row = (name) => within(table).getByRole('rowheader', { name }).closest('tr').textContent;
    expect(row('Reihen')).toMatch(/120.*121/);
    expect(row('Bände')).toMatch(/2\.400.*2\.410/);
    expect(row('Benutzer')).toMatch(/3.*3/);
    expect(row('Bilder')).toMatch(/35 \(3,00 MB\)/);
    expect(screen.getByText(/2\.20\.0/).textContent).toMatch(/aktuell 2\.21\.0/);
    expect(within(screen.getByRole('list', { name: 'Hinweise zur Wiederherstellung' })).getByText(/Alle anderen Sitzungen/)).toBeTruthy();

    const field = screen.getByLabelText('Passwort zur Bestätigung');
    expect([field.type, field.getAttribute('autocomplete'), field.getAttribute('aria-invalid')]).toEqual(['password', 'current-password', null]);
    const account = document.querySelector('input[name="username"]');
    expect([account.value, account.getAttribute('autocomplete'), account.hidden, account.className]).toEqual(['admin', 'username', true, 'text-base']);
    expect(screen.getByRole('button', { name: 'Wiederherstellen' }).disabled).toBe(true);
    typePassword();
    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));
    const status = await screen.findByText(/Backup erfolgreich eingespielt!/);
    expect(status.textContent).toContain(`Rückgängig: Snapshot „${PRE}“`);
    expect(status.textContent).toMatch(/Die Seite wird neu geladen/);
    expect(JSON.parse(calls(fetchMock, 'POST', `/api/backup/restore/${STAGING}`)[0][1].body)).toEqual({ current_password: 'password123' });
    expect(JSON.parse(sessionStorage.getItem(UNDO_KEY)).filename).toBe(PRE);
    expect(screen.getByRole('dialog').getAttribute('data-busy')).toBe('true');
    expect(document.getElementById('btn-close-restore-modal').disabled).toBe(true);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3500 });
    expect(clearOfflineData).toHaveBeenCalledTimes(1);
    expect(onRestoreSuccess).not.toHaveBeenCalled();
    expect(calls(fetchMock, 'DELETE', `/api/backup/restore/${STAGING}`)).toHaveLength(0);
  });

  it('upload: multipart inspect with the field "backup"; an HTML 413 gives the German size text', async () => {
    const replies = [html(413), json(200, inspection({ source: { type: 'upload', filename: 'b.zip', size: 3 } }))];
    const fetchMock = mockFetch({
      'GET /api/backups': () => json(200, { backups: [] }),
      'POST /api/backup/inspect': () => replies.shift()
    });
    const { container } = renderBackup();
    fireEvent.click(screen.getByRole('tab', { name: 'ZIP-Datei hochladen' }));
    const file = new File(['zip'], 'b.zip');
    fireEvent.change(container.querySelector('#backup-file-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /Backup prüfen/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Backup zu groß für den Server oder Proxy/);
    expect(alert.textContent).not.toMatch(/Unexpected token|JSON/);
    const body = calls(fetchMock, 'POST', '/api/backup/inspect')[0][1].body;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('backup').name).toBe('b.zip');

    fireEvent.click(screen.getByRole('button', { name: /Backup prüfen/ }));
    expect(await screen.findByRole('heading', { name: 'Wiederherstellung bestätigen' })).toBeTruthy();
    expect(screen.getByText(/Datei „b\.zip“/)).toBeTruthy();
  });

  it('cancel discards the staging and returns to the list', async () => {
    const fetchMock = mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection()),
      [`DELETE /api/backup/restore/${STAGING}`]: () => json(200, { success: true })
    });
    renderBackup();
    await openConfirmation();
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('heading', { name: 'Wiederherstellung bestätigen' })).toBeNull();
    expect(screen.getByRole('tablist')).toBeTruthy();
    await waitFor(() => expect(calls(fetchMock, 'DELETE', `/api/backup/restore/${STAGING}`)).toHaveLength(1));
    expect(calls(fetchMock, 'POST', `/api/backup/restore/${STAGING}`)).toHaveLength(0);
  });

  it('closing the dialog with a staged backup discards it; a late inspect answer is discarded too', async () => {
    const late = deferred();
    const replies = [() => json(200, inspection()), () => late.promise];
    const fetchMock = mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => replies.shift()(),
      [`DELETE /api/backup/restore/${STAGING}`]: () => json(200, { success: true }),
      'DELETE /api/backup/restore/late-id': () => json(200, { success: true })
    });
    const { rerender } = renderBackup();
    await openConfirmation();
    rerender(<BackupRestoreModal isOpen={false} onClose={vi.fn()} user={ADMIN} />);
    await waitFor(() => expect(calls(fetchMock, 'DELETE', `/api/backup/restore/${STAGING}`)).toHaveLength(1));

    rerender(<BackupRestoreModal isOpen onClose={vi.fn()} user={ADMIN} />);
    fireEvent.click(await screen.findByRole('button', { name: `Snapshot ${SNAP} wiederherstellen` }));
    await waitFor(() => expect(calls(fetchMock, 'POST', '/api/backup/inspect')).toHaveLength(2));
    rerender(<BackupRestoreModal isOpen={false} onClose={vi.fn()} user={ADMIN} />);
    await act(async () => { late.resolve(json(200, inspection({ staging_id: 'late-id' }))); });
    await waitFor(() => expect(calls(fetchMock, 'DELETE', '/api/backup/restore/late-id')).toHaveLength(1));
  });

  it('unmounting during a pending inspect aborts it and discards the late answer', async () => {
    const late = deferred();
    let signal;
    const fetchMock = mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': (init) => { signal = init.signal; return late.promise; },
      'DELETE /api/backup/restore/late-id': () => json(200, { success: true })
    });
    const { unmount } = renderBackup();
    fireEvent.click(await screen.findByRole('button', { name: `Snapshot ${SNAP} wiederherstellen` }));
    await waitFor(() => expect(calls(fetchMock, 'POST', '/api/backup/inspect')).toHaveLength(1));
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { late.resolve(json(200, inspection({ staging_id: 'late-id' }))); });
    await waitFor(() => expect(calls(fetchMock, 'DELETE', '/api/backup/restore/late-id')).toHaveLength(1));
  });

  it('unmounting during an upload inspect aborts the upload', async () => {
    let signal;
    mockFetch({
      'GET /api/backups': () => json(200, { backups: [] }),
      'POST /api/backup/inspect': (init) => { signal = init.signal; return new Promise(() => {}); }
    });
    const { unmount } = renderBackup();
    fireEvent.click(screen.getByRole('tab', { name: 'ZIP-Datei hochladen' }));
    fireEvent.change(document.getElementById('backup-file-input'), { target: { files: [new File(['zip'], 'b.zip')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Backup prüfen' }));
    await waitFor(() => expect(signal).toBeTruthy());
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('app build: snapshot and ZIP downloads go through the token-carrying download with progress', async () => {
    vi.stubEnv('VITE_APP_MODE', 'app');
    setServer({ base: 'https://shelf.example.org', token: 'tok' });
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const file = deferred();
    try {
      const fetchMock = mockFetch({
        'GET https://shelf.example.org/api/backups': () => json(200, { backups: [snapshot()] }),
        [`GET https://shelf.example.org/api/backups/${SNAP}/download`]: () => file.promise
      });
      renderBackup();
      const link = await screen.findByRole('link', { name: `Snapshot ${SNAP} herunterladen` });
      fireEvent.click(link);
      expect(await within(link).findByText('Lädt… 0 MB')).toBeTruthy();
      const [, init] = calls(fetchMock, 'GET', `https://shelf.example.org/api/backups/${SNAP}/download`)[0];
      expect(init.headers.Authorization).toBe('Bearer tok');
      await act(async () => { file.resolve(new Response('zip', { status: 200 })); });
      await waitFor(() => expect(within(link).queryByText(/Lädt/)).toBeNull());
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      Object.assign(URL, { createObjectURL, revokeObjectURL });
      clickSpy.mockRestore();
      vi.unstubAllEnvs();
      setServer({ base: '', token: '' });
    }
  });

  it('app build: a running download keeps the dialog from closing by backdrop or Escape, the X lets it go on', async () => {
    vi.stubEnv('VITE_APP_MODE', 'app');
    setServer({ base: 'https://shelf.example.org', token: 'tok' });
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const file = deferred();
    try {
      const fetchMock = mockFetch({
        'GET https://shelf.example.org/api/backups': () => json(200, { backups: [snapshot()] }),
        'GET https://shelf.example.org/api/backup': () => file.promise
      });
      const onClose = vi.fn();
      const { unmount } = renderBackup({ onClose });
      const dialog = screen.getByRole('dialog');
      fireEvent.click(screen.getByRole('link', { name: /Direkt-ZIP/ }));
      await waitFor(() => expect(dialog.getAttribute('data-busy')).toBe('true'));
      fireEvent.click(dialog);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(document.getElementById('btn-close-restore-modal-x'));
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
      const [, init] = calls(fetchMock, 'GET', 'https://shelf.example.org/api/backup')[0];
      expect(init.signal.aborted).toBe(false);
      await act(async () => {
        file.resolve(new Response('zip', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="backup.zip"' } }));
      });
      await waitFor(() => expect(clickSpy).toHaveBeenCalled());
      expect(clickSpy.mock.contexts[0].download).toBe('backup.zip');
    } finally {
      Object.assign(URL, { createObjectURL, revokeObjectURL });
      clickSpy.mockRestore();
      vi.unstubAllEnvs();
      setServer({ base: '', token: '' });
    }
  });

  it('browser build: the download links stay plain links', async () => {
    mockFetch({ 'GET /api/backups': () => json(200, { backups: [snapshot()] }) });
    renderBackup();
    const link = await screen.findByRole('link', { name: `Snapshot ${SNAP} herunterladen` });
    expect(link.getAttribute('href')).toBe(`/api/backups/${SNAP}/download`);
    let prevented = null;
    const stop = (e) => { prevented = e.defaultPrevented; e.preventDefault(); };
    window.addEventListener('click', stop);
    fireEvent.click(link);
    window.removeEventListener('click', stop);
    expect(prevented).toBe(false);
    expect(screen.getByRole('link', { name: /Direkt-ZIP/ }).getAttribute('href')).toBe('/api/backup');
  });

  it('download progress text', () => {
    expect(downloadProgressText({ loaded: 3.2 * 1024 * 1024, total: 10 * 1024 * 1024 })).toBe('Lädt… 3,2 von 10 MB');
    expect(downloadProgressText({ loaded: 0, total: 0 })).toBe('Lädt… 0 MB');
    expect(downloadProgressText(null)).toBe('');
  });

  it('relogin: the line about the own account is prominent', async () => {
    const userLine = 'Dein Benutzer „admin“ ist im Backup nicht vorhanden: Du wirst danach abgemeldet.';
    mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection({
        relogin: true,
        current_user: { username: 'admin', exists: false, role: null },
        warnings: [userLine, 'Alle anderen Sitzungen (andere Geräte und Benutzer) werden beendet.']
      }))
    });
    renderBackup();
    await openConfirmation();
    const line = screen.getByText(userLine);
    expect(line.parentElement.className).toMatch(/font-semibold/);
    expect(within(screen.getByRole('list', { name: 'Hinweise zur Wiederherstellung' })).queryByText(userLine)).toBeNull();
    typePassword();
    expect(screen.getByRole('button', { name: 'Wiederherstellen' }).disabled).toBe(false);
  });

  it('accounts without a password: the server line shows once in the confirmation, the own account gets its own line', async () => {
    const serverLine = '2 Konten brauchen nach der Wiederherstellung einen Passwort-Reset (kein Passwort in der Sicherung): Admin, anna.';
    mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection({
        accounts_without_password: ['Admin', 'anna'],
        warnings: ['Alle anderen Sitzungen (andere Geräte und Benutzer) werden beendet.', serverLine]
      }))
    });
    renderBackup();
    await openConfirmation();
    const list = within(screen.getByRole('list', { name: 'Hinweise zur Wiederherstellung' }));
    expect(list.getAllByText(serverLine)).toHaveLength(1);
    expect(list.getByText('Auch dein Konto „admin“ hat darin kein Passwort: ein neues setzt danach nur ein anderer Admin in der Benutzerverwaltung oder der Konsolenbefehl „passwort-reset admin“ auf dem Server.')).toBeTruthy();
    typePassword();
    expect(screen.getByRole('button', { name: 'Wiederherstellen' }).disabled).toBe(false);
  });

  it('accounts without a password: the line comes from the field when the server sends no text; nobody left to sign in is said', async () => {
    mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection({
        counts: { mangas: 1, volumes: 2, users: 1, admins: 1, uploads: 0 },
        relogin: true,
        current_user: { username: 'admin', exists: false, role: null },
        accounts_without_password: ['kim'],
        warnings: ['Alle anderen Sitzungen (andere Geräte und Benutzer) werden beendet.']
      }))
    });
    renderBackup();
    await openConfirmation();
    const list = within(screen.getByRole('list', { name: 'Hinweise zur Wiederherstellung' }));
    expect(list.getByText('1 Konto braucht nach der Wiederherstellung einen Passwort-Reset (kein Passwort in der Sicherung): kim.')).toBeTruthy();
    expect(list.getByText(/Danach kann sich niemand anmelden: ein neues Passwort setzt dann nur der Konsolenbefehl „passwort-reset <name>“/)).toBeTruthy();
  });

  it('no password lines without such accounts', () => {
    const plain = inspection({ accounts_without_password: [] });
    expect(withPasswordWarnings(plain)).toBe(plain);
    expect(withPasswordWarnings(inspection()).warnings).toEqual(['Alle anderen Sitzungen (andere Geräte und Benutzer) werden beendet.']);
  });

  it('newer schema: red box, restore disabled until the override is ticked, then allow_newer_schema is sent', async () => {
    const schemaLine = 'Backup stammt aus einer neueren Version (Schema v15 > v14) – erst Manga Shelf aktualisieren.';
    vi.stubGlobal('location', { ...window.location, reload: vi.fn() });
    const fetchMock = mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection({ schema_version: 15, schema_newer: true, warnings: [schemaLine] })),
      [`POST /api/backup/restore/${STAGING}`]: () => restored()
    });
    renderBackup();
    await openConfirmation();
    expect(screen.getByText(schemaLine)).toBeTruthy();
    const confirmButton = screen.getByRole('button', { name: 'Wiederherstellen' });
    typePassword();
    expect(confirmButton.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Trotzdem einspielen (nicht empfohlen)' }));
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);
    await screen.findByText(/Die Seite wird neu geladen/);
    expect(JSON.parse(calls(fetchMock, 'POST', `/api/backup/restore/${STAGING}`)[0][1].body)).toEqual({ current_password: 'password123', allow_newer_schema: true });
  });

  it('a SCHEMA_NEWER refusal in step 2 shows the override', async () => {
    mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection()),
      [`POST /api/backup/restore/${STAGING}`]: () => json(400, { error: 'Backup stammt aus einer neueren Version.', code: 'SCHEMA_NEWER' })
    });
    renderBackup();
    await openConfirmation();
    typePassword();
    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Backup stammt aus einer neueren Version.');
    expect(screen.getByRole('checkbox', { name: 'Trotzdem einspielen (nicht empfohlen)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Wiederherstellen' }).disabled).toBe(true);
  });

  it('step 2: a 504 says the restore may still run, a 409 shows the server text, both stay on the confirmation; no reload', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const replies = [html(504), json(409, { error: 'Es läuft bereits eine Wiederherstellung.' })];
    mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection()),
      [`POST /api/backup/restore/${STAGING}`]: () => replies.shift()
    });
    renderBackup();
    await openConfirmation();
    typePassword();
    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/nicht rechtzeitig geantwortet.*Seite neu laden/);
    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));
    expect(await screen.findByText('Es läuft bereits eine Wiederherstellung.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Wiederherstellung bestätigen' })).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('step 2: an expired staging returns to the selection with the server text', async () => {
    const text = 'Die Prüfung ist abgelaufen oder unbekannt. Bitte das Backup erneut auswählen und prüfen.';
    const fetchMock = mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection()),
      [`POST /api/backup/restore/${STAGING}`]: () => json(404, { error: text, code: 'STAGING_NOT_FOUND' })
    });
    renderBackup();
    await openConfirmation();
    typePassword();
    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));
    expect((await screen.findByRole('alert')).textContent).toBe(text);
    expect(screen.queryByRole('heading', { name: 'Wiederherstellung bestätigen' })).toBeNull();
    expect(screen.getByRole('tablist')).toBeTruthy();
    await waitFor(() => expect(calls(fetchMock, 'GET', '/api/backups')).toHaveLength(2));
    expect(calls(fetchMock, 'DELETE', `/api/backup/restore/${STAGING}`)).toHaveLength(0);
  });

  it('step 2: a wrong or missing password stays in the confirmation with the error at the field; the staging is kept', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const replies = [
      json(403, { error: 'Das aktuelle Passwort stimmt nicht', code: 'WRONG_PASSWORD' }),
      json(400, { error: 'Bitte das aktuelle Passwort eingeben', code: 'BAD_REQUEST' }),
      restored()
    ];
    const fetchMock = mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection()),
      [`POST /api/backup/restore/${STAGING}`]: () => replies.shift()
    });
    renderBackup();
    await openConfirmation();
    typePassword('falsch-falsch');
    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Das aktuelle Passwort stimmt nicht');
    const field = screen.getByLabelText('Passwort zur Bestätigung');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby').split(' ')).toContain(alert.id);
    expect(document.activeElement).toBe(field);
    expect(screen.getByRole('heading', { name: 'Wiederherstellung bestätigen' })).toBeTruthy();

    fireEvent.submit(field.form);
    expect((await screen.findByRole('alert')).textContent).toBe('Bitte das aktuelle Passwort eingeben');
    expect(screen.getByRole('heading', { name: 'Wiederherstellung bestätigen' })).toBeTruthy();

    typePassword();
    fireEvent.submit(field.form);
    await screen.findByText(/Die Seite wird neu geladen/);
    expect(calls(fetchMock, 'POST', `/api/backup/restore/${STAGING}`).map(([, init]) => JSON.parse(init.body).current_password))
      .toEqual(['falsch-falsch', 'falsch-falsch', 'password123']);
    expect(calls(fetchMock, 'DELETE', `/api/backup/restore/${STAGING}`)).toHaveLength(0);
  });

  it('step 2: a locked account shows until when, at the field', async () => {
    const locked = new Response(JSON.stringify({ error: 'Zu viele fehlgeschlagene Anmeldeversuche für diesen Benutzer. Bitte in einigen Minuten erneut versuchen.', code: 'TOO_MANY_ATTEMPTS' }), {
      status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '600' }
    });
    mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection()),
      [`POST /api/backup/restore/${STAGING}`]: () => locked
    });
    renderBackup();
    await openConfirmation();
    typePassword();
    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));
    expect((await screen.findByRole('alert')).textContent)
      .toMatch(/^Zu viele Fehlversuche\. Erneut möglich ab \d{2}:\d{2} Uhr; so lange ist auch die Anmeldung mit diesem Konto gesperrt\.$/);
    expect(screen.getByLabelText('Passwort zur Bestätigung').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Wiederherstellung bestätigen' })).toBeTruthy();
  });

  it('marks the dialog busy while step 2 runs and blocks the close buttons', async () => {
    const pending = deferred();
    mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection()),
      [`POST /api/backup/restore/${STAGING}`]: () => pending.promise
    });
    const onClose = vi.fn();
    renderBackup({ onClose });
    await openConfirmation();
    expect(screen.getByRole('dialog').getAttribute('data-busy')).toBeNull();
    typePassword();
    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));
    await waitFor(() => expect(screen.getByRole('dialog').getAttribute('data-busy')).toBe('true'));
    expect(screen.getByRole('button', { name: 'Abbrechen' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('dialog'));
    fireEvent.click(document.getElementById('btn-close-restore-modal-x'));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(json(400, { error: 'Ungültiges ZIP-Archiv' })); });
    expect(await screen.findByText('Ungültiges ZIP-Archiv')).toBeTruthy();
    expect(screen.getByRole('dialog').getAttribute('data-busy')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Wiederherstellung bestätigen' })).toBeNull();
  });
});

describe('BackupRestoreModal undo', () => {
  it('offers "Rückgängig machen" within 30 minutes for a listed pre-restore snapshot and restores it two-step', async () => {
    saveRestoreUndo(PRE, Date.now() - 60 * 1000);
    const fetchMock = mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot({ filename: PRE, category: 'pre-restore' })] }),
      'POST /api/backup/inspect': () => json(200, inspection({ source: { type: 'snapshot', filename: PRE, size: 10 } }))
    });
    renderBackup();
    expect(await screen.findByText(/Wiederherstellung rückgängig machen/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig machen' }));
    expect(await screen.findByRole('heading', { name: 'Wiederherstellung bestätigen' })).toBeTruthy();
    expect(JSON.parse(calls(fetchMock, 'POST', '/api/backup/inspect')[0][1].body)).toEqual({ filename: PRE });
  });

  it('no banner when the entry is older than 30 minutes or the snapshot is gone; "Ausblenden" forgets it', async () => {
    saveRestoreUndo(PRE, Date.now() - UNDO_TTL_MS - 1000);
    mockFetch({ 'GET /api/backups': () => json(200, { backups: [snapshot({ filename: PRE, category: 'pre-restore' })] }) });
    const first = renderBackup();
    await screen.findByText(PRE);
    expect(screen.queryByRole('button', { name: 'Rückgängig machen' })).toBeNull();
    first.unmount();

    saveRestoreUndo(PRE);
    mockFetch({ 'GET /api/backups': () => json(200, { backups: [snapshot()] }) });
    const second = renderBackup();
    await screen.findByText(SNAP);
    expect(screen.queryByRole('button', { name: 'Rückgängig machen' })).toBeNull();
    second.unmount();

    mockFetch({ 'GET /api/backups': () => json(200, { backups: [snapshot({ filename: PRE, category: 'pre-restore' })] }) });
    renderBackup();
    fireEvent.click(await screen.findByRole('button', { name: 'Ausblenden' }));
    expect(screen.queryByRole('button', { name: 'Rückgängig machen' })).toBeNull();
    expect(sessionStorage.getItem(UNDO_KEY)).toBeNull();
  });
});

describe('BackupRestoreModal large chunked uploads', () => {
  function mockLargeFile(name, size) {
    const file = new File(['zip'], name, { type: 'application/zip' });
    Object.defineProperty(file, 'size', { value: size });
    file.slice = (start, end) => {
      const len = Math.max(0, end - start);
      const b = new Blob(['x']);
      Object.defineProperty(b, 'size', { value: len });
      return b;
    };
    return file;
  }

  it('splits files above 16 MB into chunks, shows live progress and stages via upload_id', async () => {
    const uploadId = 'chunk-up-1';
    const chunkDeferred = deferred();
    const callsLog = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      callsLog.push({ method, url, init });
      if (method === 'GET' && url === '/api/backups') return json(200, { backups: [] });
      if (method === 'POST' && url === '/api/backup/uploads') {
        return json(201, { upload_id: uploadId, chunk_size: 16 * 1024 * 1024 });
      }
      if (method === 'PUT' && url === `/api/backup/uploads/${uploadId}?offset=0`) {
        await chunkDeferred.promise;
        return json(200, { upload_id: uploadId, received: 16 * 1024 * 1024, size: 20 * 1024 * 1024, complete: false });
      }
      if (method === 'PUT' && url === `/api/backup/uploads/${uploadId}?offset=${16 * 1024 * 1024}`) {
        return json(200, { upload_id: uploadId, received: 20 * 1024 * 1024, size: 20 * 1024 * 1024, complete: true });
      }
      if (method === 'POST' && url === '/api/backup/inspect') {
        return json(200, inspection({ source: { type: 'upload', filename: 'big.zip', size: 20 * 1024 * 1024 } }));
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));

    renderBackup();
    fireEvent.click(screen.getByRole('tab', { name: 'ZIP-Datei hochladen' }));
    const file = mockLargeFile('big.zip', 20 * 1024 * 1024);
    fireEvent.change(document.getElementById('backup-file-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Backup prüfen' }));

    const bar = await screen.findByRole('progressbar', { name: 'Upload-Fortschritt' });
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeTruthy();

    await act(async () => { chunkDeferred.resolve(); });
    expect(await screen.findByRole('heading', { name: 'Wiederherstellung bestätigen' })).toBeTruthy();

    const inspectCall = callsLog.find((c) => c.method === 'POST' && c.url === '/api/backup/inspect');
    expect(JSON.parse(inspectCall.init.body)).toEqual({ upload_id: uploadId });
    expect(callsLog.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });

  it('cancelling during chunked upload aborts cleanly, deletes server upload and shows no error', async () => {
    const uploadId = 'chunk-up-cancel';
    const callsLog = [];
    vi.stubGlobal('fetch', vi.fn((url, init = {}) => {
      const method = init.method || 'GET';
      callsLog.push({ method, url, init });
      if (method === 'GET' && url === '/api/backups') return Promise.resolve(json(200, { backups: [] }));
      if (method === 'POST' && url === '/api/backup/uploads') {
        return Promise.resolve(json(201, { upload_id: uploadId, chunk_size: 16 * 1024 * 1024 }));
      }
      if (method === 'PUT' && url.startsWith(`/api/backup/uploads/${uploadId}`)) {
        return new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      if (method === 'DELETE' && url === `/api/backup/uploads/${uploadId}`) {
        return Promise.resolve(json(200, { success: true }));
      }
      return Promise.reject(new Error(`unexpected ${method} ${url}`));
    }));

    renderBackup();
    fireEvent.click(screen.getByRole('tab', { name: 'ZIP-Datei hochladen' }));
    const file = mockLargeFile('big.zip', 20 * 1024 * 1024);
    fireEvent.change(document.getElementById('backup-file-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Backup prüfen' }));

    const cancelBtn = await screen.findByRole('button', { name: 'Abbrechen' });
    fireEvent.click(cancelBtn);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Backup prüfen' }).disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(callsLog.some((c) => c.method === 'DELETE' && c.url === `/api/backup/uploads/${uploadId}`)).toBe(true);
  });

  it('retries transient chunk failures and resumes cleanly on OFFSET_MISMATCH', async () => {
    const bytes = new Uint8Array(25);
    const putUrls = [];
    let attempt = 0;
    const res = await uploadAndInspectBackup({
      file: bytes,
      filename: 'retry.zip',
      threshold: 5,
      chunkSize: 10,
      request: {
        postForm: vi.fn(),
        postJson: async (url) => (url === '/api/backup/uploads'
          ? { ok: true, status: 201, data: { upload_id: 'up-r', chunk_size: 10 }, res: null }
          : { ok: true, status: 200, data: { staging_id: STAGING }, res: null }),
        putChunk: async (url) => {
          putUrls.push(url);
          attempt++;
          if (attempt === 1) return { ok: false, status: 502, data: {}, res: null };
          if (attempt === 2) return { ok: true, status: 200, data: { received: 10 }, res: null };
          if (attempt === 3) return { ok: false, status: 409, data: { code: 'OFFSET_MISMATCH', expected: 15 }, res: null };
          return { ok: true, status: 200, data: { received: 25 }, res: null };
        },
        deleteUpload: vi.fn()
      }
    });
    expect(res.ok).toBe(true);
    expect(res.data.staging_id).toBe(STAGING);
    expect(putUrls).toEqual([
      '/api/backup/uploads/up-r?offset=0',
      '/api/backup/uploads/up-r?offset=0',
      '/api/backup/uploads/up-r?offset=10',
      '/api/backup/uploads/up-r?offset=15'
    ]);
  });
  it('a 429 on a chunk waits for Retry-After and tries again', async () => {
    vi.useFakeTimers();
    try {
      const putUrls = [];
      let attempt = 0;
      const pending = uploadAndInspectBackup({
        file: new Uint8Array(8),
        filename: 'limit.zip',
        threshold: 5,
        chunkSize: 10,
        request: {
          postForm: vi.fn(),
          postJson: async (url) => (url === '/api/backup/uploads'
            ? { ok: true, status: 201, data: { upload_id: 'up-l', chunk_size: 10 }, res: null }
            : { ok: true, status: 200, data: { staging_id: STAGING }, res: null }),
          putChunk: async (url) => {
            putUrls.push(url);
            attempt++;
            if (attempt === 1) return { ok: false, status: 429, data: {}, res: new Response(null, { status: 429, headers: { 'Retry-After': '5' } }) };
            return { ok: true, status: 200, data: { received: 8 }, res: null };
          },
          deleteUpload: vi.fn()
        }
      });
      await vi.advanceTimersByTimeAsync(4900);
      expect(putUrls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      const res = await pending;
      expect(res.ok).toBe(true);
      expect(putUrls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to one multipart upload when an older server has no chunked upload route', async () => {
    const bytes = new Uint8Array(25);
    const postForm = vi.fn(async () => ({ ok: true, status: 200, data: { staging_id: STAGING }, res: null }));
    const putChunk = vi.fn();
    const phases = [];
    const res = await uploadAndInspectBackup({
      file: bytes,
      filename: 'old-server.zip',
      threshold: 5,
      chunkSize: 10,
      onPhase: (p) => phases.push(p),
      request: {
        postForm,
        postJson: async () => ({ ok: false, status: 404, data: { error: 'Nicht gefunden' }, res: null }),
        putChunk,
        deleteUpload: vi.fn()
      }
    });
    expect(res.ok).toBe(true);
    expect(res.data.staging_id).toBe(STAGING);
    expect(putChunk).not.toHaveBeenCalled();
    expect(postForm).toHaveBeenCalledTimes(1);
    expect(postForm.mock.calls[0][0]).toBe('/api/backup/inspect');
    expect(postForm.mock.calls[0][1].get('backup')).toBeTruthy();
    expect(phases).toEqual(['upload', 'inspect']);
  });

  it('does not fall back to multipart when the chunked upload is refused for other reasons', async () => {
    const postForm = vi.fn();
    const res = await uploadAndInspectBackup({
      file: new Uint8Array(25),
      threshold: 5,
      request: {
        postForm,
        postJson: async () => ({ ok: false, status: 507, data: { code: 'INSUFFICIENT_SPACE' }, res: null }),
        putChunk: vi.fn(),
        deleteUpload: vi.fn()
      }
    });
    expect(res.status).toBe(507);
    expect(postForm).not.toHaveBeenCalled();
  });
});
