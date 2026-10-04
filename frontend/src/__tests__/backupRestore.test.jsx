import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('../utils/offlineStore', () => ({
  clearOfflineData: vi.fn(async () => {})
}));

import { clearOfflineData } from '../utils/offlineStore';
import BackupRestoreModal from '../components/modals/BackupRestoreModal';
import {
  UNDO_KEY, UNDO_TTL_MS, manifestSummary, readRestoreUndo, saveRestoreUndo, versionSummary
} from '../components/modals/backup/backupHelpers';
import { TIMEOUTS } from '../utils/api';

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

    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));
    const status = await screen.findByText(/Backup erfolgreich eingespielt!/);
    expect(status.textContent).toContain(`Rückgängig: Snapshot „${PRE}“`);
    expect(status.textContent).toMatch(/Die Seite wird neu geladen/);
    expect(JSON.parse(calls(fetchMock, 'POST', `/api/backup/restore/${STAGING}`)[0][1].body)).toEqual({});
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
    expect(screen.getByRole('button', { name: 'Wiederherstellen' }).disabled).toBe(false);
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
    expect(confirmButton.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Trotzdem einspielen (nicht empfohlen)' }));
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);
    await screen.findByText(/Die Seite wird neu geladen/);
    expect(JSON.parse(calls(fetchMock, 'POST', `/api/backup/restore/${STAGING}`)[0][1].body)).toEqual({ allow_newer_schema: true });
  });

  it('a SCHEMA_NEWER refusal in step 2 shows the override', async () => {
    mockFetch({
      'GET /api/backups': () => json(200, { backups: [snapshot()] }),
      'POST /api/backup/inspect': () => json(200, inspection()),
      [`POST /api/backup/restore/${STAGING}`]: () => json(400, { error: 'Backup stammt aus einer neueren Version.', code: 'SCHEMA_NEWER' })
    });
    renderBackup();
    await openConfirmation();
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
    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));
    expect((await screen.findByRole('alert')).textContent).toBe(text);
    expect(screen.queryByRole('heading', { name: 'Wiederherstellung bestätigen' })).toBeNull();
    expect(screen.getByRole('tablist')).toBeTruthy();
    await waitFor(() => expect(calls(fetchMock, 'GET', '/api/backups')).toHaveLength(2));
    expect(calls(fetchMock, 'DELETE', `/api/backup/restore/${STAGING}`)).toHaveLength(0);
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
