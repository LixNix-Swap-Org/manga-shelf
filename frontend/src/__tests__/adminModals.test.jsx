// Covers the admin modals: users, backups, sessions and offline-data clearing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('../utils/offlineStore', () => ({
  clearOfflineData: vi.fn(async () => {})
}));

import { clearOfflineData } from '../utils/offlineStore';
import BackupRestoreModal from '../components/modals/BackupRestoreModal';
import { httpErrorMessage } from '../components/modals/backup/backupHelpers';
import { decodeCsvBytes } from '../components/modals/backup/CsvImportPanel';
import UserManagementModal from '../components/modals/UserManagementModal';
import { getToken, setActiveBase, setToken } from '../app/connection';
import { formatDay } from '../utils/format';
import { recordToasts } from './toastLog';
import fs from 'node:fs';
import path from 'node:path';

let toasts;
beforeEach(() => { toasts = recordToasts(); });
afterEach(() => { toasts.stop(); });

const ADMIN = { id: 1, username: 'admin', role: 'admin' };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status) => new Response(`<html><body><h1>${status}</h1>nginx</body></html>`, { status, headers: { 'Content-Type': 'text/html' } });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** routes: { 'GET /api/backups': fn(init) => Response | Promise<Response> } */
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

const csvFile = (text, name = 'liste.csv') => new File([text], name, { type: 'text/csv' });
const backups = (list = []) => () => json(200, { backups: list });

function renderBackup(props = {}) {
  return render(<BackupRestoreModal isOpen onClose={vi.fn()} user={ADMIN} onRestoreSuccess={vi.fn()} {...props} />);
}

beforeEach(() => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  clearOfflineData.mockClear();
});

describe('decodeCsvBytes / httpErrorMessage', () => {
  it('falls back to Windows-1252 for German Excel CSV, keeps UTF-8 with and without BOM', () => {
    const cp1252 = new Uint8Array([0x4d, 0xe4, 0x64, 0x63, 0x68, 0x65, 0x6e, 0x3b, 0x80]);
    expect(decodeCsvBytes(cp1252.buffer)).toEqual({ text: 'Mädchen;€', encoding: 'windows-1252' });
    const utf8 = new TextEncoder().encode('Mädchen;1');
    expect(decodeCsvBytes(utf8.buffer)).toEqual({ text: 'Mädchen;1', encoding: 'utf-8' });
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
    expect(decodeCsvBytes(bom.buffer).text).toBe('Mädchen;1');
    const utf16 = new Uint8Array([0xff, 0xfe, 0x4d, 0x00, 0xe4, 0x00]);
    expect(decodeCsvBytes(utf16.buffer)).toEqual({ text: 'Mä', encoding: 'utf-16le' });
  });

  it('maps proxy statuses to German texts and prefers the server text', () => {
    expect(httpErrorMessage(413, {}, 'x', { tooLarge: 'zu groß' })).toBe('zu groß');
    expect(httpErrorMessage(504, {}, 'x')).toMatch(/nicht rechtzeitig geantwortet/);
    expect(httpErrorMessage(503, { error: 'Rollback fehlgeschlagen' }, 'x')).toBe('Rollback fehlgeschlagen');
    expect(httpErrorMessage(401, { error: 'egal' }, 'x')).toMatch(/Sitzung ist abgelaufen/);
    expect(httpErrorMessage(500, {}, 'Fehler')).toBe('Fehler (HTTP 500)');
  });
});

describe('BackupRestoreModal', () => {
  it('CSV help names the "Gelesen von" column and that only admins can name other people', async () => {
    mockFetch({ 'GET /api/backups': backups() });
    renderBackup();
    fireEvent.click(screen.getByRole('tab', { name: /CSV/ }));
    const help = screen.getByText(/Spalten: Reihe und Bandnummer/);
    expect(help.textContent).toMatch(/Gelesen von und Besitzer/);
    expect(help.textContent).toMatch(/Nur Admins können andere Personen als Besitzer oder Leser eintragen/);
  });

  it('states the per-prefix retention and no longer names Pterodactyl', async () => {
    mockFetch({ 'GET /api/backups': backups() });
    renderBackup();
    expect(screen.getByText(/die letzten 7 Tage und die letzten 10 manuellen Snapshots/)).toBeTruthy();
    expect(await screen.findByText(/Noch keine Server-Snapshots/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Pterodactyl/);
  });

  it('a11y: named close button, tabs with aria-selected and arrow keys, keyboard-operable ZIP picker', async () => {
    mockFetch({ 'GET /api/backups': backups() });
    const { container } = renderBackup();
    expect(screen.getAllByRole('button', { name: 'Schließen' })).toHaveLength(2);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(screen.getByRole('tabpanel')).toBeTruthy();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    const uploadTab = screen.getByRole('tab', { name: 'ZIP-Datei hochladen' });
    expect(uploadTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(uploadTab);

    const picker = screen.getByRole('button', { name: /Backup auszuwählen/i });
    const input = container.querySelector('#backup-file-input');
    const click = vi.spyOn(input, 'click');
    picker.focus();
    expect(document.activeElement).toBe(picker);
    fireEvent.click(picker);
    expect(click).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { files: [new File(['zip'], 'b.zip')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Andere Datei auswählen' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /Backup auszuwählen/i })));
  });

  it('snapshot list: a 500 shows an error with retry instead of the empty state, the tab count reads ?', async () => {
    const replies = [json(500, { error: 'Fehler beim Lesen der Snapshots' }), json(200, { backups: [{ filename: 'manual-2026-10-02T10-00-00.zip', size: 2048, created_at: '2026-10-02T10:00:00Z', category: 'manual', verified: true, verify_error: null, manifest: null }] })];
    mockFetch({ 'GET /api/backups': () => replies.shift() });
    renderBackup();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Fehler beim Lesen der Snapshots/);
    expect(screen.queryByText(/Noch keine Server-Snapshots/)).toBeNull();
    expect(screen.getByRole('tab', { name: 'Server-Snapshots (?)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Erneut laden/ }));
    expect(await screen.findByText('manual-2026-10-02T10-00-00.zip')).toBeTruthy();
    expect(screen.getByText('Manuell')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Server-Snapshots (1)' })).toBeTruthy();
  });

  it('snapshot list: a 401 shows the session message', async () => {
    mockFetch({ 'GET /api/backups': () => json(401, { error: 'Nicht angemeldet', code: 'AUTH_REQUIRED' }) });
    renderBackup();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Sitzung ist abgelaufen/);
  });

  it('deleting a snapshot that is already gone (404) removes the row without an error', async () => {
    const name = 'manual-2026-10-02T10-00-00.zip';
    mockFetch({
      'GET /api/backups': backups([{ filename: name, size: 1, created_at: '2026-10-02T10:00:00Z' }]),
      [`DELETE /api/backups/${name}`]: () => json(404, { error: 'Snapshot-Datei nicht gefunden' })
    });
    renderBackup();
    fireEvent.click(await screen.findByRole('button', { name: `Snapshot ${name} löschen` }));
    await waitFor(() => expect(screen.queryByText(name)).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(toasts.messages('error')).toEqual([]);
  });

  it('snapshot create: an HTML 502 does not surface a parse error', async () => {
    mockFetch({ 'GET /api/backups': backups(), 'POST /api/backups/create': () => html(502) });
    renderBackup();
    fireEvent.click(await screen.findByRole('button', { name: /Neuen Snapshot erstellen/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/nicht rechtzeitig geantwortet/);
  });

  it('CSV: a late dry run of an earlier file does not replace the preview, and the import sends the previewed text', async () => {
    const first = deferred();
    const bodies = [];
    mockFetch({
      'GET /api/backups': backups(),
      'POST /api/import/csv': (init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (body.dry_run && body.csv.startsWith('A')) return first.promise;
        if (body.dry_run) return json(200, { created_volumes: 2, created_series: 1, skipped_existing: 0, errors: [], warnings: [] });
        return json(200, { created_volumes: 2, created_series: 1, skipped_existing: 0, errors: [] });
      }
    });
    const onRestoreSuccess = vi.fn();
    renderBackup({ onRestoreSuccess });
    fireEvent.click(screen.getByRole('tab', { name: 'CSV' }));
    const input = screen.getByLabelText('CSV-Datei auswählen');
    fireEvent.change(input, { target: { files: [csvFile('A;1\n')] } });
    await waitFor(() => expect(bodies).toHaveLength(1));
    fireEvent.change(input, { target: { files: [csvFile('B;1\nB;2\n')] } });
    expect(await screen.findByRole('button', { name: '2 Bände importieren' })).toBeTruthy();
    await act(async () => { first.resolve(json(200, { created_volumes: 9, created_series: 9, skipped_existing: 0, errors: [], warnings: [] })); });
    expect(screen.queryByText(/9 neue Bände/)).toBeNull();
    expect(screen.getByText(/2 neue Bände \(1 neue Reihe\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '2 Bände importieren' }));
    expect(await screen.findByText(/Import fertig: 2 Bände, 1 neue Reihe, 0 schon vorhanden/)).toBeTruthy();
    expect(bodies[2]).toEqual({ csv: 'B;1\nB;2\n', dry_run: false });
    expect(onRestoreSuccess).toHaveBeenCalledTimes(1);
  });

  it('CSV: singular wording, warnings listed, series-only files can be imported', async () => {
    mockFetch({
      'GET /api/backups': backups(),
      'POST /api/import/csv': () => json(200, {
        created_volumes: 0, created_series: 1, skipped_existing: 0,
        errors: [{ line: 3, message: 'Bandnummer fehlt' }],
        warnings: [{ line: 2, message: 'Unbekannter Besitzer "x" ignoriert' }]
      })
    });
    renderBackup();
    fireEvent.click(screen.getByRole('tab', { name: 'CSV' }));
    fireEvent.change(screen.getByLabelText('CSV-Datei auswählen'), { target: { files: [csvFile('Reihe\nNeu\n')] } });
    const button = await screen.findByRole('button', { name: '1 Reihe anlegen' });
    expect(button.disabled).toBe(false);
    expect(screen.getByText(/0 neue Bände \(1 neue Reihe\), 0 schon vorhanden, 1 fehlerhafte Zeile, 1 Hinweis\./)).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Hinweise' })).getByText('Zeile 2: Unbekannter Besitzer "x" ignoriert')).toBeTruthy();
    expect(screen.getByText(/Besitzer \(Benutzernamen/)).toBeTruthy();
  });

  it('CSV: a Windows-1252 file is sent with correct umlauts and the fallback is mentioned', async () => {
    const bodies = [];
    mockFetch({
      'GET /api/backups': backups(),
      'POST /api/import/csv': (init) => {
        bodies.push(JSON.parse(init.body));
        return json(200, { created_volumes: 1, created_series: 1, skipped_existing: 0, errors: [], warnings: [] });
      }
    });
    renderBackup();
    fireEvent.click(screen.getByRole('tab', { name: 'CSV' }));
    const bytes = new Uint8Array([0x52, 0x65, 0x69, 0x68, 0x65, 0x3b, 0x42, 0x0a, 0x4d, 0xe4, 0x64, 0x63, 0x68, 0x65, 0x6e, 0x3b, 0x31]);
    fireEvent.change(screen.getByLabelText('CSV-Datei auswählen'), { target: { files: [new File([bytes], 'excel.csv')] } });
    expect(await screen.findByText(/als Windows-1252 \(Excel\) gelesen/)).toBeTruthy();
    expect(bodies[0].csv).toBe('Reihe;B\nMädchen;1');
    expect(screen.getByRole('button', { name: '1 Band importieren' })).toBeTruthy();
  });

  it('CSV: files over 10 MB are rejected before upload; an HTML 413 gives the German size text', async () => {
    const fetchMock = mockFetch({ 'GET /api/backups': backups(), 'POST /api/import/csv': () => html(413) });
    renderBackup();
    fireEvent.click(screen.getByRole('tab', { name: 'CSV' }));
    const input = screen.getByLabelText('CSV-Datei auswählen');
    const big = csvFile('x');
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect((await screen.findByRole('alert')).textContent).toBe('CSV-Datei ist zu groß (max. 10 MB).');
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/import/csv')).toHaveLength(0);

    fireEvent.change(input, { target: { files: [csvFile('Reihe;Bandnummer\nA;1\n')] } });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/import/csv')).toHaveLength(1));
    expect((await screen.findByRole('alert')).textContent).toBe('CSV-Datei ist zu groß (max. 10 MB).');
  });

  it('CSV: an unreadable file shows a message', async () => {
    mockFetch({ 'GET /api/backups': backups() });
    renderBackup();
    fireEvent.click(screen.getByRole('tab', { name: 'CSV' }));
    const broken = csvFile('x');
    broken.arrayBuffer = () => Promise.reject(new DOMException('NotReadableError'));
    fireEvent.change(screen.getByLabelText('CSV-Datei auswählen'), { target: { files: [broken] } });
    expect(await screen.findByText('Datei konnte nicht gelesen werden.')).toBeTruthy();
  });

  it('reopening the dialog clears the CSV preview', async () => {
    mockFetch({
      'GET /api/backups': backups(),
      'POST /api/import/csv': () => json(200, { created_volumes: 1, created_series: 0, skipped_existing: 0, errors: [], warnings: [] })
    });
    const { rerender } = renderBackup();
    fireEvent.click(screen.getByRole('tab', { name: 'CSV' }));
    fireEvent.change(screen.getByLabelText('CSV-Datei auswählen'), { target: { files: [csvFile('A;1')] } });
    expect(await screen.findByRole('button', { name: '1 Band importieren' })).toBeTruthy();
    rerender(<BackupRestoreModal isOpen={false} onClose={vi.fn()} user={ADMIN} />);
    rerender(<BackupRestoreModal isOpen onClose={vi.fn()} user={ADMIN} />);
    fireEvent.click(screen.getByRole('tab', { name: 'CSV' }));
    expect(screen.queryByRole('button', { name: /importieren/ })).toBeNull();
    expect(screen.queryByText(/Vorschau:/)).toBeNull();
  });
});

describe('UserManagementModal', () => {
  const USERS = [
    { id: 1, username: 'admin', role: 'admin', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, username: 'erika', role: 'editor', created_at: '2026-02-01T00:00:00Z' }
  ];

  function renderUsers(props = {}) {
    return render(<UserManagementModal isOpen onClose={vi.fn()} currentUser={ADMIN} {...props} />);
  }

  it('a11y and autofill: named close button, labelled fields, new-password hint', async () => {
    mockFetch({ 'GET /api/users': () => json(200, USERS) });
    renderUsers();
    expect(screen.getAllByRole('button', { name: 'Schließen' })).toHaveLength(2);
    expect(document.getElementById('btn-close-users-modal-x').getAttribute('aria-label')).toBe('Schließen');
    const name = screen.getByLabelText('Benutzername');
    const password = screen.getByLabelText('Passwort');
    expect(screen.getByRole('combobox', { name: 'Rolle' })).toBeTruthy();
    expect(name.getAttribute('autocomplete')).toBe('off');
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    expect(password.getAttribute('minlength')).toBe('8');
    expect(name.id).not.toBe(password.id);
    expect(await screen.findByText('Registrierte Benutzer (2)', { exact: false })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Gast (Nur Lesezugriff)' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Besucher/);
  });

  it('the own-password hint names the lock control and tab that exist in the header and the account dialog', async () => {
    mockFetch({ 'GET /api/users': () => json(200, USERS) });
    renderUsers();
    await screen.findByText('Registrierte Benutzer (2)', { exact: false });
    const hint = screen.getByText(/Dein eigenes Passwort/).textContent;
    expect(hint).not.toMatch(/„Passwort ändern“/);
    const [, control, tab] = hint.match(/„([^“]+)“, Reiter „([^“]+)“/);
    const read = (file) => fs.readFileSync(path.resolve(import.meta.dirname, file), 'utf8');
    expect(read('../components/dashboard/DashboardHeader.jsx')).toContain(`'${control}'`);
    expect(read('../components/modals/AccountModal.jsx')).toContain(`label: '${tab}'`);
  });

  it('create: validation errors go to an alert region and replace an older success banner', async () => {
    mockFetch({
      'GET /api/users': () => json(200, USERS),
      'POST /api/users': () => json(201, { id: 3 })
    });
    renderUsers();
    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'neu' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'langes-passwort' } });
    fireEvent.click(screen.getByRole('button', { name: /Benutzer erstellen/ }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Benutzer "neu" erfolgreich angelegt/);
    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'kurz' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'kurz' } });
    fireEvent.submit(screen.getByRole('button', { name: /Benutzer erstellen/ }).closest('form'));
    expect(screen.getByRole('alert').textContent).toMatch(/mindestens 8 Zeichen/);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('the loading panel is not a second live region next to the persistent status', async () => {
    const slow = deferred();
    mockFetch({ 'GET /api/users': () => slow.promise });
    renderUsers();
    const loading = screen.getByText('Lade Benutzerliste...');
    expect(loading.getAttribute('role')).toBeNull();
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    await act(async () => { slow.resolve(json(200, USERS)); });
    expect(await screen.findByText('erika')).toBeTruthy();
  });

  it('a failed list load shows an error with retry instead of "(0)"', async () => {
    const replies = [html(500), json(200, USERS)];
    mockFetch({ 'GET /api/users': () => replies.shift() });
    renderUsers();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Benutzerliste konnte nicht geladen werden/);
    expect(screen.getByText(/Registrierte Benutzer \(\?\)/)).toBeTruthy();
    expect(screen.queryByText(/\(0\)/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Erneut laden/ }));
    expect(await screen.findByText('erika')).toBeTruthy();
    expect(screen.getByText(/Registrierte Benutzer \(2\)/)).toBeTruthy();
  });

  it('ignores a late list response from before a reopen', async () => {
    const slow = deferred();
    const replies = [() => slow.promise, () => json(200, [USERS[0]])];
    mockFetch({ 'GET /api/users': () => replies.shift()() });
    const { rerender } = renderUsers();
    rerender(<UserManagementModal isOpen={false} onClose={vi.fn()} currentUser={ADMIN} />);
    rerender(<UserManagementModal isOpen onClose={vi.fn()} currentUser={ADMIN} />);
    expect(await screen.findByText(/Registrierte Benutzer \(1\)/)).toBeTruthy();
    await act(async () => { slow.resolve(json(200, USERS)); });
    expect(screen.queryByText('erika')).toBeNull();
  });

  it('role change: PUT {role}, German labels, no select on the own row, server errors shown', async () => {
    const puts = [];
    const replies = [
      json(200, { success: true, user: { id: 2, username: 'erika', role: 'visitor' } }),
      json(400, { error: 'Der letzte Administrator kann nicht herabgestuft werden' })
    ];
    mockFetch({
      'GET /api/users': () => json(200, USERS),
      'PUT /api/users/2': (init) => { puts.push(JSON.parse(init.body)); return replies.shift(); }
    });
    renderUsers();
    const select = await screen.findByRole('combobox', { name: 'Rolle von erika' });
    expect(screen.queryByRole('combobox', { name: 'Rolle von admin' })).toBeNull();
    expect(screen.getByText('Admin', { selector: 'span' })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'visitor' } });
    expect((await screen.findByRole('status')).textContent).toMatch(/Rolle von "erika" ist jetzt Gast/);
    expect(puts[0]).toEqual({ role: 'visitor' });
    expect(screen.getByRole('combobox', { name: 'Rolle von erika' }).value).toBe('visitor');

    fireEvent.change(screen.getByRole('combobox', { name: 'Rolle von erika' }), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Passwort zur Bestätigung'), { target: { value: 'mein-passwort' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/letzte Administrator/);
    expect(puts[1]).toEqual({ role: 'admin', current_password: 'mein-passwort' });
    expect(screen.queryByLabelText('Passwort zur Bestätigung')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Rolle von erika' }).value).toBe('visitor');
  });

  it('promotion to admin asks for the own password first: current-password field, inline WRONG_PASSWORD, focus stays', async () => {
    const puts = [];
    const replies = [
      json(403, { error: 'Das aktuelle Passwort stimmt nicht', code: 'WRONG_PASSWORD' }),
      json(200, { success: true, user: { id: 2, username: 'erika', role: 'admin' } })
    ];
    const fetchMock = mockFetch({
      'GET /api/users': () => json(200, USERS),
      'PUT /api/users/2': (init) => { puts.push(JSON.parse(init.body)); return replies.shift(); }
    });
    renderUsers();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Rolle von erika' }), { target: { value: 'admin' } });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    const field = screen.getByLabelText('Passwort zur Bestätigung');
    expect(field.getAttribute('type')).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('current-password');
    expect(document.activeElement).toBe(field);
    expect(document.querySelector('input[autocomplete="username"]').value).toBe('admin');
    expect(screen.getByText('Rolle von "erika" auf Admin ändern')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Rolle von erika' }).value).toBe('admin');

    fireEvent.submit(field.closest('form'));
    expect(screen.getByRole('alert').textContent).toBe('Bitte das aktuelle Passwort eingeben');
    expect(puts).toEqual([]);

    fireEvent.change(field, { target: { value: 'falsch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }));
    const alert = await screen.findByText('Das aktuelle Passwort stimmt nicht');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby').split(' ')).toContain(alert.id);
    expect(document.activeElement).toBe(field);
    expect(puts).toEqual([{ role: 'admin', current_password: 'falsch' }]);

    fireEvent.change(field, { target: { value: 'richtig-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Rolle von "erika" ist jetzt Admin/);
    expect(puts[1]).toEqual({ role: 'admin', current_password: 'richtig-123' });
    expect(screen.queryByLabelText('Passwort zur Bestätigung')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Rolle von erika' }).value).toBe('admin');
  });

  it('Escape or Abbrechen cancels only the promotion and returns focus to the role select', async () => {
    const fetchMock = mockFetch({ 'GET /api/users': () => json(200, USERS) });
    renderUsers();
    const select = await screen.findByRole('combobox', { name: 'Rolle von erika' });
    select.focus();
    fireEvent.change(select, { target: { value: 'admin' } });
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    try {
      fireEvent.keyDown(screen.getByLabelText('Passwort zur Bestätigung'), { key: 'Escape' });
    } finally {
      window.removeEventListener('keydown', outside);
    }
    expect(outside).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Passwort zur Bestätigung')).toBeNull();
    expect(select.value).toBe('editor');
    expect(document.activeElement).toBe(select);

    fireEvent.change(select, { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByLabelText('Passwort zur Bestätigung')).toBeNull();
    expect(document.activeElement).toBe(select);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method || 'GET') === 'GET')).toBe(true);
  });

  it('creating an admin asks for the own password; other roles send none', async () => {
    const posts = [];
    const replies = [
      json(200, { success: true, user: { id: 3 } }),
      json(403, { error: 'Das aktuelle Passwort stimmt nicht', code: 'WRONG_PASSWORD' }),
      json(200, { success: true, user: { id: 4 } })
    ];
    mockFetch({
      'GET /api/users': () => json(200, USERS),
      'POST /api/users': (init) => { posts.push(JSON.parse(init.body)); return replies.shift(); }
    });
    renderUsers();
    await screen.findByText('erika');
    const fill = (name) => {
      fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: name } });
      fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'langes-passwort' } });
    };
    fill('redakteur');
    expect(screen.queryByLabelText('Passwort zur Bestätigung')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Benutzer erstellen/ }));
    await screen.findByText(/Benutzer "redakteur" erfolgreich angelegt/);
    expect(posts[0]).toEqual({ username: 'redakteur', password: 'langes-passwort', role: 'editor' });

    fill('chefin');
    fireEvent.change(screen.getByRole('combobox', { name: 'Rolle' }), { target: { value: 'admin' } });
    const field = screen.getByLabelText('Passwort zur Bestätigung');
    expect(field.getAttribute('autocomplete')).toBe('current-password');
    fireEvent.submit(field.closest('form'));
    expect(screen.getByRole('alert').textContent).toBe('Bitte das aktuelle Passwort eingeben');
    expect(posts).toHaveLength(1);

    fireEvent.change(field, { target: { value: 'falsch' } });
    fireEvent.click(screen.getByRole('button', { name: /Benutzer erstellen/ }));
    const alert = await screen.findByText('Das aktuelle Passwort stimmt nicht');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby').split(' ')).toContain(alert.id);
    expect(document.activeElement).toBe(field);

    fireEvent.change(field, { target: { value: 'richtig-123' } });
    fireEvent.click(screen.getByRole('button', { name: /Benutzer erstellen/ }));
    await screen.findByText(/Benutzer "chefin" erfolgreich angelegt/);
    expect(posts[2]).toEqual({ username: 'chefin', password: 'langes-passwort', role: 'admin', current_password: 'richtig-123' });
    expect(screen.queryByLabelText('Passwort zur Bestätigung')).toBeNull();
  });

  it('resetting another admin asks for the own password; resetting an editor does not', async () => {
    const puts = [];
    const replies = [
      json(429, { error: 'Zu viele Versuche, das Passwort zu ändern. Bitte in einigen Minuten erneut versuchen.', code: 'TOO_MANY_ATTEMPTS' }),
      json(200, { success: true, user: { id: 3, username: 'boss', role: 'admin' } })
    ];
    mockFetch({
      'GET /api/users': () => json(200, [...USERS, { id: 3, username: 'boss', role: 'admin', created_at: '2026-03-01T00:00:00Z' }]),
      'PUT /api/users/3': (init) => { puts.push(JSON.parse(init.body)); return replies.shift(); }
    });
    renderUsers();
    fireEvent.click(await screen.findByRole('button', { name: 'Passwort von erika zurücksetzen' }));
    expect(screen.queryByLabelText('Passwort zur Bestätigung')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Passwort von boss zurücksetzen' }));
    fireEvent.change(screen.getByLabelText('Neues Passwort für boss'), { target: { value: 'ganz-neues-passwort' } });
    const field = screen.getByLabelText('Passwort zur Bestätigung');
    expect(field.getAttribute('autocomplete')).toBe('current-password');
    fireEvent.submit(field.closest('form'));
    expect(screen.getByRole('alert').textContent).toBe('Bitte das aktuelle Passwort eingeben');
    expect(puts).toEqual([]);

    fireEvent.change(field, { target: { value: 'mein-passwort' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zurücksetzen' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Zu viele Versuche/);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Zurücksetzen' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Neues Passwort für "boss" gesetzt/);
    expect(puts).toEqual([
      { password: 'ganz-neues-passwort', current_password: 'mein-passwort' },
      { password: 'ganz-neues-passwort', current_password: 'mein-passwort' }
    ]);
    expect(screen.queryByLabelText('Passwort zur Bestätigung')).toBeNull();
  });

  it('password reset: client minimum length, then PUT {password} and a logout notice', async () => {
    const puts = [];
    const fetchMock = mockFetch({
      'GET /api/users': () => json(200, USERS),
      'PUT /api/users/2': (init) => { puts.push(JSON.parse(init.body)); return json(200, { success: true, user: { id: 2, username: 'erika', role: 'editor' } }); }
    });
    renderUsers();
    expect(screen.queryByRole('button', { name: 'Passwort von admin zurücksetzen' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Passwort von erika zurücksetzen' }));
    const input = screen.getByLabelText('Neues Passwort für erika');
    expect(input.getAttribute('autocomplete')).toBe('new-password');
    fireEvent.change(input, { target: { value: 'kurz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zurücksetzen' }));
    expect(screen.getByRole('alert').textContent).toMatch(/mindestens 8 Zeichen/);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    fireEvent.change(input, { target: { value: 'ganz-neues-passwort' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zurücksetzen' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Neues Passwort für "erika" gesetzt.*abgemeldet/);
    expect(puts).toEqual([{ password: 'ganz-neues-passwort' }]);
    expect(screen.queryByLabelText('Neues Passwort für erika')).toBeNull();
  });

  it('password reset: the app build keeps the token an own reset answers with; the browser build ignores it', async () => {
    const reset = async (key) => {
      mockFetch({
        [`GET ${key}/api/users`]: () => json(200, USERS),
        [`PUT ${key}/api/users/2`]: () => json(200, { success: true, token: 'jwt-after-reset' })
      });
      const view = renderUsers();
      fireEvent.click(await screen.findByRole('button', { name: 'Passwort von erika zurücksetzen' }));
      fireEvent.change(screen.getByLabelText('Neues Passwort für erika'), { target: { value: 'ganz-neues-passwort' } });
      fireEvent.click(screen.getByRole('button', { name: 'Zurücksetzen' }));
      await screen.findByText(/Neues Passwort für "erika" gesetzt/);
      view.unmount();
    };
    localStorage.clear();
    await reset('');
    expect(getToken()).toBe('');

    vi.stubEnv('VITE_APP_MODE', 'app');
    try {
      setActiveBase('https://shelf.example.org');
      setToken('jwt-before-reset');
      await reset('https://shelf.example.org');
      expect(getToken()).toBe('jwt-after-reset');
    } finally {
      vi.unstubAllEnvs();
      localStorage.clear();
    }
  });

  it('reads the creation date as UTC (SQLite CURRENT_TIMESTAMP) and shows "unbekannt" without one', async () => {
    mockFetch({
      'GET /api/users': () => json(200, [
        { id: 1, username: 'admin', role: 'admin', created_at: '2026-10-02 23:30:00' },
        { id: 2, username: 'erika', role: 'editor', created_at: null }
      ])
    });
    renderUsers();
    expect(await screen.findByText(`Erstellt am ${formatDay(new Date(Date.UTC(2026, 9, 2, 23, 30)))}`)).toBeTruthy();
    expect(screen.getByText('Erstellt am unbekannt')).toBeTruthy();
  });

  it('delete: confirm names the consequences, an old success banner is replaced, errors use the banner', async () => {
    const replies = [json(500, { error: 'Fehler beim Löschen des Benutzers' }), json(200, { success: true })];
    mockFetch({
      'GET /api/users': () => json(200, USERS),
      'POST /api/users': () => json(201, { id: 3 }),
      'DELETE /api/users/2': () => replies.shift()
    });
    renderUsers();
    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'neu' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'langes-passwort' } });
    fireEvent.click(screen.getByRole('button', { name: /Benutzer erstellen/ }));
    expect((await screen.findByRole('status')).textContent).toMatch(/erfolgreich angelegt/);

    const deleteButton = await screen.findByTitle('Benutzer "erika" löschen');
    fireEvent.click(deleteButton);
    expect(window.confirm.mock.calls[0][0]).toMatch(/Lesestatus wird gelöscht; Bände, die nur dieser Benutzer besitzt, gehen an dich über/);
    expect((await screen.findByRole('alert')).textContent).toBe('Fehler beim Löschen des Benutzers');
    expect(screen.getByRole('status').textContent).toBe('');
    expect(toasts.messages('error')).toEqual([]);

    fireEvent.click(screen.getByTitle('Benutzer "erika" löschen'));
    expect((await screen.findByRole('status')).textContent).toBe('Benutzer "erika" wurde gelöscht.');
    expect(screen.queryByText('erika')).toBeNull();
  });

  it('long usernames truncate with the full name in the title', async () => {
    const long = 'a'.repeat(64);
    mockFetch({ 'GET /api/users': () => json(200, [USERS[0], { id: 5, username: long, role: 'guest' }]) });
    renderUsers();
    const nameEl = await screen.findByText(long);
    expect(nameEl.className).toMatch(/truncate/);
    expect(nameEl.getAttribute('title')).toBe(long);
    expect(screen.getByRole('combobox', { name: `Rolle von ${long}` }).value).toBe('guest');
  });
});
