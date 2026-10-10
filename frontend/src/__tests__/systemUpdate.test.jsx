import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';
import SystemModal from '../components/modals/SystemModal';
import UpdateInstructions, { instructionSteps } from '../components/system/UpdateInstructions';
import { __setCatalogForTests, resetI18nForTests } from '../i18n/index.js';
import { getUpdateWatch, stopUpdateWatch } from '../utils/updateWatcher';
import { formatTime } from '../utils/format';

const MB = 1024 * 1024;
const IDENTITY = 'https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/heads/main';
const EXPIRES = '2026-10-10T12:15:00Z';
const page = (version) => `https://github.com/LixNix-Swap-Org/manga-shelf/releases/tag/v${version}`;

const release = (version, extra = {}) => ({
  version, tag: `v${version}`, published_at: '2026-10-10T12:00:00Z', url: page(version), signed: true, installable: true,
  reason: null, has_admin_notes: false, ...extra
});

const pterodactyl = { mode: 'pterodactyl', can_install: true, reason: null, supervisor: 'wings', restart: 'pterodactyl', asset: 'pterodactyl-manga-shelf.zip', instructions: null, image: null };

const updateInfo = (over = {}) => ({
  enabled: true, current: '3.0.0', latest: '3.2.0', available: true, url: page('3.2.0'), checked_at: '2026-10-10T08:00:00Z',
  install: pterodactyl,
  releases: [
    release('3.2.0'),
    release('3.1.0', { has_admin_notes: true }),
    release('3.0.0', { installable: false, reason: 'installed', signed: false }),
    release('2.19.1', { installable: false, reason: 'older', signed: false })
  ],
  releases_error: null, next_try_at: null, staging: null, status: { phase: 'idle' }, last: null,
  ...over
});

const systemInfo = (update = updateInfo()) => ({
  version: update.current, node: 'v24.1.0', platform: 'linux/x64', instance_id: 'inst-1', uptime: 3600, memory_rss: 80 * MB,
  data_dir: '/srv/manga/data', health: { status: 'ok', checks: {} }, database: null, storage: null,
  orphans: { count: 0, bytes: 0, skipped: false }, backups: null, jobs: { running: [] }, sources: { users_with_keys: 0 }, update
});

const readyStatus = (over = {}) => ({
  phase: 'ready', version: '3.2.0', bytes: 40 * MB, total: 40 * MB, staging_id: 'st-1', expires_at: EXPIRES,
  verified: { identity: IDENTITY, log_index: 42 }, asset: 'pterodactyl-manga-shelf.zip', admin_notes: null, error: null, ...over
});

function serve({ info = systemInfo(), routes = {} } = {}) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const route = routes[`${method} ${url}`];
    if (route) return route(init);
    if ((url === '/api/system' || url === '/api/system?refresh=1') && method === 'GET') return fakeResponse(200, typeof info === 'function' ? info() : info);
    if (url === '/api/anime/sources') return fakeResponse(200, { anilist: null, mal: null });
    if (url === '/api/sources/guides') return fakeResponse(200, []);
    if (url === '/api/admin/api-keys') return fakeResponse(200, { keys: [] });
    if (url === '/api/auth/me') return fakeResponse(200, { user: { id: 1, username: 'root', role: 'admin' } });
    return fakeResponse(404, { error: 'Nicht gefunden' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calls = (fetchMock, url, method = 'POST') => fetchMock.mock.calls.filter(([u, i]) => u === url && (i?.method || 'GET') === method);
const bodyOf = (call) => JSON.parse(call[1].body);

async function openPage(options) {
  const fetchMock = serve(options);
  render(<SystemModal isOpen onClose={vi.fn()} />);
  const region = await screen.findByRole('region', { name: 'Updates' });
  return { fetchMock, region };
}

let toasts;
beforeEach(() => {
  toasts = recordToasts();
  sessionStorage.clear();
});
afterEach(() => {
  stopUpdateWatch();
  resetI18nForTests();
  toasts.stop();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('System page: updates', () => {
  it('the banner button downloads and checks the newest version; the dialog stays closable; ready shows the check, backup and admin notes', async () => {
    const statuses = [
      { phase: 'downloading', version: '3.2.0', bytes: 12 * MB, total: 40 * MB, staging_id: 'st-1', expires_at: EXPIRES },
      readyStatus({ admin_notes: [{ version: '3.1.0', text: 'Egg im Panel neu importieren.' }] })
    ];
    const { fetchMock, region } = await openPage({ routes: {
      'POST /api/system/update/prepare': () => fakeResponse(202, { staging_id: 'st-1', expires_at: EXPIRES }),
      'GET /api/system/update/status': () => fakeResponse(200, statuses.length > 1 ? statuses.shift() : statuses[0])
    } });
    expect(document.getElementById('system-update').textContent).toContain('Neue Version verfügbar: v3.2.0 (installiert: v3.0.0)');
    fireEvent.click(within(region).getByRole('button', { name: 'Auf v3.2.0 aktualisieren' }));
    const progress = await screen.findByTestId('update-progress');
    await waitFor(() => expect(progress.textContent).toContain('Lädt… 12 von 40 MB'));
    expect(bodyOf(calls(fetchMock, '/api/system/update/prepare')[0])).toEqual({ version: '3.2.0' });
    expect(within(progress).getByRole('status').textContent).toBe('Download läuft (v3.2.0)');
    expect(within(progress).getByRole('progressbar').getAttribute('aria-valuetext')).toBe('Lädt… 12 von 40 MB');
    expect(document.activeElement).toBe(within(progress).getByRole('button', { name: 'Abbrechen' }));
    expect(progress.textContent).toContain(`Diese Prüfung gilt bis ${formatTime(EXPIRES)} Uhr.`);
    expect(screen.getByRole('button', { name: 'Schließen' }).disabled).toBe(false);

    const ready = await screen.findByTestId('update-ready', {}, { timeout: 4000 });
    expect(ready.textContent).toContain(`Geprüft: signiert von GitHub Actions (${IDENTITY}), SHA-256 ✓`);
    expect(ready.textContent).toContain('Datei: pterodactyl-manga-shelf.zip (40,00 MB)');
    expect(ready.textContent).toContain('Vorher wird ein geprüftes Backup der Datenbank angelegt.');
    expect(ready.textContent).toContain('Die Panel-Konsole zeigt dabei einen Absturz mit Exit 75 – das ist beabsichtigt');
    const notes = within(ready).getByTestId('update-admin-notes');
    expect(notes.textContent).toContain('Vor dem Update beachten');
    expect(notes.textContent).toContain('v3.1.0Egg im Panel neu importieren.');
    expect(within(notes).getByRole('link', { name: /Hinweise zu v3\.1\.0/ }).getAttribute('href')).toBe(page('3.1.0'));
    expect(document.activeElement).toBe(within(ready).getByRole('button', { name: 'Installieren' }));
  });

  it('lists every release with the reason of the disabled ones; another version is downloaded on request; skipped releases are linked', async () => {
    const info = systemInfo(updateInfo({
      current: '3.0.0', latest: '3.3.0',
      releases: [
        release('3.3.0', { installable: false, reason: 'no_asset' }),
        release('3.2.0'),
        release('3.1.5', { installable: false, reason: 'unsigned', signed: false }),
        release('3.1.0'),
        release('3.0.0', { installable: false, reason: 'installed' }),
        release('2.19.1', { installable: false, reason: 'older' })
      ]
    }));
    const { fetchMock, region } = await openPage({ info, routes: {
      'POST /api/system/update/prepare': () => fakeResponse(202, { staging_id: 'st-2', expires_at: EXPIRES }),
      'GET /api/system/update/status': () => fakeResponse(200, { phase: 'downloading', version: '3.1.0', bytes: 0, total: 0, staging_id: 'st-2' })
    } });
    const select = within(region).getByLabelText('Andere Version wählen');
    const options = within(select).getAllByRole('option');
    expect(options.map((o) => [o.textContent, o.disabled])).toEqual([
      ['v3.3.0 – 10.10.2026 – keine Datei für dieses System', true],
      ['v3.2.0 – 10.10.2026', false],
      ['v3.1.5 – 10.10.2026 – ohne Signatur', true],
      ['v3.1.0 – 10.10.2026', false],
      ['v3.0.0 – 10.10.2026 – installiert', true],
      ['v2.19.1 – 10.10.2026 – älter: kein Zurück per Klick', true]
    ]);
    expect(select.value).toBe('3.2.0');
    expect(region.textContent).toContain('Ältere Versionen lassen sich nicht per Klick installieren: Die Datenbank wird nur vorwärts migriert.');
    expect(within(region).getByRole('link', { name: 'Weg zurück (README)' }).getAttribute('href')).toBe('https://github.com/LixNix-Swap-Org/manga-shelf#updating');
    expect(within(region).getByRole('link', { name: /Versionshinweise \(v3\.2\.0\)/ }).getAttribute('href')).toBe(page('3.2.0'));
    expect(within(region).getByRole('link', { name: 'v3.1.5' }).getAttribute('href')).toBe(page('3.1.5'));
    expect(within(region).getByRole('link', { name: 'v3.1.0' })).toBeTruthy();

    fireEvent.change(select, { target: { value: '3.1.0' } });
    expect(within(region).getByRole('link', { name: /Versionshinweise \(v3\.1\.0\)/ })).toBeTruthy();
    expect(within(region).queryByText('Dazwischen liegen:')).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Auf v3.3.0 aktualisieren' })).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Herunterladen und prüfen' }));
    await screen.findByTestId('update-progress');
    expect(bodyOf(calls(fetchMock, '/api/system/update/prepare')[0])).toEqual({ version: '3.1.0' });
  });

  it('"Abbrechen" discards the staging; reopening resumes a running download from the server state', async () => {
    let status = { phase: 'downloading', version: '3.2.0', bytes: 5 * MB, total: 40 * MB, staging_id: 'st-9', expires_at: EXPIRES };
    const info = () => systemInfo(updateInfo({ status, staging: status.phase === 'idle' ? null : { staging_id: 'st-9', version: '3.2.0' } }));
    const { fetchMock, region } = await openPage({ info, routes: {
      'GET /api/system/update/status': () => fakeResponse(200, status),
      'DELETE /api/system/update/staging/st-9': () => {
        status = { phase: 'idle' };
        return fakeResponse(200, { success: true });
      }
    } });
    const progress = within(region).getByTestId('update-progress');
    await waitFor(() => expect(progress.textContent).toContain('Lädt… 5 von 40 MB'));
    expect(within(region).queryByRole('button', { name: 'Auf v3.2.0 aktualisieren' })).toBeNull();
    fireEvent.click(within(progress).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(calls(fetchMock, '/api/system/update/staging/st-9', 'DELETE')).toHaveLength(1));
    await waitFor(() => expect(within(region).queryByTestId('update-progress')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(within(region).getByRole('button', { name: 'Herunterladen und prüfen' })));
  });

  it('signature failures are red, final and offer the report link; nothing else is retried', async () => {
    const info = systemInfo(updateInfo({ status: { phase: 'failed', version: '3.2.0', error: { code: 'SIGNATURE_IDENTITY', message: 'Die Signatur stammt nicht aus dem Release-Workflow von manga-shelf.' } } }));
    const { region } = await openPage({ info });
    const failure = within(region).getByTestId('update-failure');
    expect(failure.textContent).toContain('Nicht installiert: Die Datei stammt nicht nachweislich aus dem Release-Workflow von manga-shelf. Nichts wurde verändert, die Datei wurde gelöscht. Bitte melden.');
    expect(failure.getAttribute('role')).toBeNull();
    expect(within(failure).getByRole('link', { name: /Problem melden/ }).getAttribute('href')).toBe('https://github.com/LixNix-Swap-Org/manga-shelf/issues');
    expect(within(failure).queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
  });

  it('a damaged download is retried once by itself, then offered; the signature service and space failures keep their texts', async () => {
    const mismatch = { phase: 'failed', version: '3.2.0', error: { code: 'CHECKSUM_MISMATCH', message: 'Download beschädigt: die Prüfsumme stimmt nicht.' } };
    const { fetchMock, region } = await openPage({ routes: {
      'POST /api/system/update/prepare': () => fakeResponse(202, { staging_id: 'st-3', expires_at: EXPIRES }),
      'GET /api/system/update/status': () => fakeResponse(200, mismatch)
    } });
    fireEvent.click(within(region).getByRole('button', { name: 'Auf v3.2.0 aktualisieren' }));
    await waitFor(() => expect(calls(fetchMock, '/api/system/update/prepare')).toHaveLength(2), { timeout: 3000 });
    const failure = await within(region).findByTestId('update-failure');
    expect(failure.getAttribute('role')).toBe('alert');
    expect(failure.textContent).toContain('Download beschädigt – erneut versuchen');
    expect(failure.textContent).toContain('Nichts wurde verändert.');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls(fetchMock, '/api/system/update/prepare')).toHaveLength(2);
    expect(document.activeElement).toBe(within(failure).getByRole('button', { name: 'Erneut versuchen' }));

    const cases = [
      [{ code: 'SIGSTORE_TRUST_UNAVAILABLE', message: 'x' }, 'Signaturdienst nicht erreichbar (tuf-repo-cdn.sigstore.dev)'],
      [{ code: 'NO_SPACE', message: 'Nicht genug Speicherplatz für das Update (frei: 10 MB, benötigt: 300 MB).' }, 'Nicht genug Speicherplatz für das Update (frei: 10 MB, benötigt: 300 MB).'],
      [{ code: 'GITHUB_UNAVAILABLE', message: 'GitHub ist nicht erreichbar.' }, 'GitHub ist nicht erreichbar.']
    ];
    for (const [error, text] of cases) {
      cleanup();
      const page2 = await openPage({ info: systemInfo(updateInfo({ status: { phase: 'failed', version: '3.2.0', error } })) });
      const box = within(page2.region).getByTestId('update-failure');
      expect(box.textContent).toContain(text);
      if (error.code === 'SIGSTORE_TRUST_UNAVAILABLE') expect(box.querySelector('code').textContent).toBe('tuf-repo-cdn.sigstore.dev');
      expect(within(box).getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy();
    }
  });

  it('a refused prepare shows the server text inline', async () => {
    const { region } = await openPage({ routes: {
      'POST /api/system/update/prepare': () => fakeResponse(409, { error: 'Gerade läuft ein Update – bitte warten, bis der Server neu gestartet ist.', code: 'UPDATE_RUNNING' })
    } });
    fireEvent.click(within(region).getByRole('button', { name: 'Auf v3.2.0 aktualisieren' }));
    const failure = await within(region).findByTestId('update-failure');
    expect(failure.textContent).toContain('Gerade läuft ein Update – bitte warten, bis der Server neu gestartet ist.');
  });

  it('PasswordConfirm: labelled field with focus, Escape cancels only the confirm, a wrong password stays inline, 429 names the wait', async () => {
    let answer = () => fakeResponse(403, { error: 'Das aktuelle Passwort stimmt nicht', code: 'WRONG_PASSWORD' });
    const { fetchMock, region } = await openPage({
      info: systemInfo(updateInfo({ status: readyStatus() })),
      routes: { 'POST /api/system/update/apply/st-1': () => answer() }
    });
    const ready = within(region).getByTestId('update-ready');
    const opener = within(ready).getByRole('button', { name: 'Installieren' });
    fireEvent.click(opener);
    const field = within(ready).getByLabelText('Passwort zur Bestätigung');
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('type')).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('current-password');
    await waitFor(() => expect(ready.querySelector('input[autocomplete="username"]')?.value).toBe('root'));

    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'System' })).toBeTruthy();
    expect(within(ready).queryByLabelText('Passwort zur Bestätigung')).toBeNull();
    expect(document.activeElement).toBe(within(ready).getByRole('button', { name: 'Installieren' }));

    fireEvent.click(within(ready).getByRole('button', { name: 'Installieren' }));
    const field2 = within(ready).getByLabelText('Passwort zur Bestätigung');
    fireEvent.change(field2, { target: { value: 'falsch' } });
    fireEvent.submit(field2.closest('form'));
    const alert = await within(ready).findByRole('alert');
    expect(alert.textContent).toBe('Das aktuelle Passwort stimmt nicht');
    expect(field2.getAttribute('aria-invalid')).toBe('true');
    expect(field2.getAttribute('aria-describedby').split(' ')).toContain(alert.id);
    expect(document.activeElement).toBe(field2);
    expect(bodyOf(calls(fetchMock, '/api/system/update/apply/st-1')[0])).toEqual({ current_password: 'falsch' });

    answer = () => new Response(JSON.stringify({ error: 'Zu viele Versuche', code: 'TOO_MANY_ATTEMPTS' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '600' } });
    const before = Date.now();
    fireEvent.submit(field2.closest('form'));
    await waitFor(() => expect(within(ready).getByRole('alert').textContent).toMatch(/^Zu viele Fehlversuche\. Erneut möglich ab/));
    const text = within(ready).getByRole('alert').textContent;
    expect([formatTime(before + 600000), formatTime(before + 660000)].some((time) => text.includes(`ab ${time} Uhr`))).toBe(true);
    expect(text).toContain('so lange ist auch die Anmeldung mit diesem Konto gesperrt');
  });

  it('install: the dialog is busy only for the request, then the restart wait takes over (manual restart shows the command)', async () => {
    let release202;
    const install = { mode: 'sea-user', can_install: true, supervisor: null, restart: 'manual', asset: 'manga-shelf-server-linux-x64', instructions: { kind: 'sea-user', argv: ['./manga-shelf-server-linux-x64', '--port', '3000'] } };
    const { region } = await openPage({
      info: systemInfo(updateInfo({ install, status: readyStatus({ asset: 'manga-shelf-server-linux-x64' }) })),
      routes: { 'POST /api/system/update/apply/st-1': () => new Promise((r) => { release202 = () => r(fakeResponse(202, { accepted: true, version: '3.2.0', restart: 'manual' })); }) }
    });
    const ready = within(region).getByTestId('update-ready');
    expect(ready.textContent).toContain('Dieser Server wird nicht automatisch neu gestartet – starte ihn danach mit: ./manga-shelf-server-linux-x64 --port 3000');
    fireEvent.click(within(ready).getByRole('button', { name: 'Installieren' }));
    const field = within(ready).getByLabelText('Passwort zur Bestätigung');
    fireEvent.change(field, { target: { value: 'geheim123' } });
    fireEvent.click(within(ready).getByRole('button', { name: 'Installieren und neu starten' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Schließen' }).disabled).toBe(true));
    release202();
    const wait = await within(region).findByTestId('update-wait');
    expect(screen.getByRole('button', { name: 'Schließen' }).disabled).toBe(false);
    expect(within(wait).getByRole('status').textContent).toBe('v3.2.0 ist installiert und wartet auf den Start von Hand');
    expect(wait.textContent).toContain('Server von Hand starten: ./manga-shelf-server-linux-x64 --port 3000');
    expect(document.activeElement).toBe(wait);
    expect(getUpdateWatch()).toMatchObject({ phase: 'pending_start', version: '3.2.0', restart: 'manual' });
    expect(toasts.list.filter((x) => x.kind === 'info')).toHaveLength(0);
  });

  it('the restart contract follows the install: a supervised service restarts by itself, without a known command the same command is asked for', async () => {
    const systemd = { mode: 'sea-user', can_install: true, supervisor: 'systemd', restart: 'supervised', asset: 'manga-shelf-server-linux-x64', instructions: null };
    const { region } = await openPage({ info: systemInfo(updateInfo({ install: systemd, status: readyStatus() })) });
    const ready = within(region).getByTestId('update-ready');
    expect(ready.textContent).toContain('Der Server startet danach automatisch neu. Er ist dabei kurz nicht erreichbar, die Apps zeigen so lange „offline“; alle bleiben angemeldet.');
    expect(within(ready).getByTestId('update-admin-notes').textContent).not.toContain('v3.2.0');
    cleanup();

    const unknown = { mode: 'sea-user', can_install: true, supervisor: null, restart: 'manual', asset: 'manga-shelf-server-linux-x64', instructions: { argv: ['--port', '3000'] } };
    const page2 = await openPage({ info: systemInfo(updateInfo({ install: unknown, status: readyStatus() })) });
    expect(within(page2.region).getByTestId('update-ready').textContent).toContain('Dieser Server wird nicht automatisch neu gestartet – starte ihn danach mit demselben Befehl.');
  });

  it('states of the release list: loading, rate limit with a retry, GitHub unreachable, up to date', async () => {
    const { region } = await openPage({ info: systemInfo(updateInfo({ available: false, latest: null, releases: null })) });
    expect(region.textContent).toContain('Versionen werden abgefragt…');
    expect(region.getAttribute('aria-busy')).toBe('true');
    cleanup();

    const next = new Date(Date.now() + 20 * 60000).toISOString();
    let limited = true;
    const info = () => systemInfo(updateInfo(limited
      ? { available: false, latest: null, releases: null, next_try_at: next }
      : { available: false, latest: '3.0.0', releases: [release('3.0.0', { installable: false, reason: 'installed' })] }));
    const page2 = await openPage({ info, routes: { 'POST /api/system/update/check': () => { limited = false; return fakeResponse(200, { success: true }); } } });
    expect(page2.region.textContent).toContain(`Abfragegrenze erreicht, nächster Versuch um ${formatTime(next)}`);
    fireEvent.click(within(page2.region).getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(page2.region.textContent).toContain('Du hast die neueste Version (v3.0.0).'));
    expect(calls(page2.fetchMock, '/api/system/update/check')).toHaveLength(1);
    cleanup();

    const page3 = await openPage({ info: systemInfo(updateInfo({ available: false, releases: null, releases_error: 'unreachable' })) });
    expect(page3.region.textContent).toContain('GitHub nicht erreichbar');
  });

  it('UPDATE_CHECK=false shows no card; the last result is shown, a rollback in red with backup and details', async () => {
    await openPage({ info: systemInfo(updateInfo({ last: { from: '2.19.1', to: '3.0.0', at: '2026-10-09T10:00:00Z', result: 'ok', backup: 'vor-update-app-2.19.1-auf-3.0.0.zip' } })) }).then(({ region }) => {
      expect(within(region).getByTestId('update-last').textContent).toContain('Zuletzt aktualisiert: v2.19.1 → v3.0.0');
      expect(within(region).getByTestId('update-last').textContent).toContain('Backup davor: vor-update-app-2.19.1-auf-3.0.0.zip');
    });
    cleanup();

    const { region } = await openPage({ info: systemInfo(updateInfo({ last: { from: '3.0.0', to: '3.1.0', at: '2026-10-09T10:00:00Z', result: 'rolled_back', error: 'START_FAILED: exit 1', backup: { file: 'vor-update-app-3.0.0-auf-3.1.0.zip' } } })) });
    const last = within(region).getByTestId('update-last');
    expect(last.className).toContain('rose');
    expect(last.textContent).toContain('v3.1.0 ist nicht gestartet; v3.0.0 läuft wieder, Code und Datenbank wurden zurückgesetzt');
    expect(last.textContent).toContain('Backup davor: vor-update-app-3.0.0-auf-3.1.0.zip');
    expect(within(last).getByText('Details')).toBeTruthy();
    expect(last.querySelector('[role="alert"]')).toBeNull();
    cleanup();

    serve({ info: systemInfo(updateInfo({ enabled: false })) });
    render(<SystemModal isOpen onClose={vi.fn()} />);
    await screen.findByText('v3.0.0');
    expect(screen.queryByRole('region', { name: 'Updates' })).toBeNull();
  });

  it('an install that cannot replace itself shows the copyable commands of the chosen version', async () => {
    const install = { mode: 'docker', can_install: false, reason: 'docker', supervisor: null, asset: null, image: 'ghcr.io/lixnix-swap-org/manga-shelf', instructions: { kind: 'docker' } };
    const releases = [release('3.2.0', { installable: false, reason: 'no_asset' }), release('3.1.0', { installable: false, reason: 'no_asset' }), release('3.0.0', { installable: false, reason: 'installed' })];
    const { region } = await openPage({ info: systemInfo(updateInfo({ install, releases })) });
    expect(within(region).queryByRole('button', { name: /aktualisieren/ })).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Herunterladen und prüfen' })).toBeNull();
    const steps = within(region).getByTestId('update-instructions');
    expect(steps.textContent).toContain('docker compose pull && docker compose up -d');
    const select = within(region).getByLabelText('Andere Version wählen');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['v3.2.0 – 10.10.2026', 'v3.1.0 – 10.10.2026', 'v3.0.0 – 10.10.2026 – installiert']);
    fireEvent.change(select, { target: { value: '3.1.0' } });
    expect(within(region).getByTestId('update-instructions').textContent).toContain('image: ghcr.io/lixnix-swap-org/manga-shelf:3.1.0\ndocker compose up -d');
    expect(within(region).getAllByRole('button', { name: 'Kopieren' }).length).toBeGreaterThan(0);
  });
});

describe('instructionSteps', () => {
  const base = { version: '3.2.0', latest: '3.2.0', releaseUrl: page('3.2.0'), platform: 'linux/x64' };
  const commands = (install, extra = {}) => instructionSteps({ ...base, install, ...extra }).map((s) => s.command).filter(Boolean);
  const dl = (file) => `https://github.com/LixNix-Swap-Org/manga-shelf/releases/download/v3.2.0/${file}`;

  it('packages: deb, rpm or both, by architecture', () => {
    expect(commands({ instructions: { kind: 'deb' } })).toEqual([`curl -LO ${dl('manga-shelf-server_3.2.0-1_amd64.deb')} && sudo apt install ./manga-shelf-server_3.2.0-1_amd64.deb`]);
    expect(commands({ instructions: { kind: 'rpm' } }, { platform: 'linux/arm64' })).toEqual([`curl -LO ${dl('manga-shelf-server-3.2.0-1.aarch64.rpm')} && sudo dnf install ./manga-shelf-server-3.2.0-1.aarch64.rpm`]);
    expect(instructionSteps({ ...base, install: { instructions: { kind: 'package' } } }).map((s) => s.lead)).toEqual(['Debian/Ubuntu', 'Fedora/RHEL']);
  });

  it('Linux service with the running options, Windows task, desktop, source and the server fallback', () => {
    expect(commands({ asset: 'manga-shelf-server-linux-x64', instructions: { kind: 'service', argv: ['--port', '8080', '--data-dir', '/srv/manga data'] } })).toEqual([
      `curl -LO ${dl('manga-shelf-server-linux-x64')} && chmod +x manga-shelf-server-linux-x64 && sudo ./manga-shelf-server-linux-x64 install-service --port 8080 --data-dir '/srv/manga data'`
    ]);
    expect(commands({ asset: 'manga-shelf-server-linux-arm64', instructions: { kind: 'install-service', argv: ['/home/me/manga-shelf-server-linux-arm64', '--port', '8080'] } })).toEqual([
      `curl -LO ${dl('manga-shelf-server-linux-arm64')} && chmod +x manga-shelf-server-linux-arm64 && sudo ./manga-shelf-server-linux-arm64 install-service --port 8080`
    ]);
    const windows = instructionSteps({ ...base, install: { asset: 'manga-shelf-server-windows-x64.exe', instructions: { kind: 'windows' } } })[0];
    expect(windows.lead).toBe('Datei laden, dann in einer Eingabeaufforderung als Administrator:');
    expect(windows.link.href).toBe(dl('manga-shelf-server-windows-x64.exe'));
    expect(windows.command).toBe('manga-shelf-server-windows-x64.exe install-service');
    const desktop = instructionSteps({ ...base, install: { mode: 'desktop', instructions: { kind: 'desktop' } } })[0];
    expect(desktop.lead).toBe('Dieser Server läuft in der Desktop-App. Dort die neue Version installieren:');
    expect(desktop.link).toEqual({ href: page('3.2.0'), title: 'Download-Seite von v3.2.0' });
    const source = instructionSteps({ ...base, install: { mode: 'source', instructions: { kind: 'source' } } })[0];
    expect(source.link.href).toBe(dl('pterodactyl-manga-shelf.zip'));
    expect(source.command).toBe('npm ci --omit=dev');
    expect(instructionSteps({ ...base, install: { mode: 'sea-system', instructions: { kind: 'other', command: 'do-it', url: 'http://insecure' } } }))
      .toEqual([{ key: 'manual', lead: 'So aktualisierst du diesen Server:', command: 'do-it', link: null }]);
    expect(instructionSteps({ ...base, install: { mode: 'sea-system' } })).toEqual([]);
  });

  it('docker: newest version pulls, another version pins the image, plus the README link', () => {
    const install = { mode: 'docker', image: 'ghcr.io/lixnix-swap-org/manga-shelf', instructions: { kind: 'docker' } };
    expect(commands(install)).toEqual(['docker compose pull && docker compose up -d']);
    expect(commands(install, { version: '3.1.0' })).toEqual(['image: ghcr.io/lixnix-swap-org/manga-shelf:3.1.0\ndocker compose up -d']);
    expect(instructionSteps({ ...base, install }).at(-1).link.href).toBe('https://github.com/LixNix-Swap-Org/manga-shelf#updating');
  });

  it('file names and commands in the leads stay outside the source keys, rendered as code', () => {
    const docker = { mode: 'docker', image: 'ghcr.io/lixnix-swap-org/manga-shelf', instructions: { kind: 'docker' } };
    const codes = (node) => [...node.querySelectorAll('p code, a code')].map((c) => c.textContent);
    let view = render(<UpdateInstructions {...base} version="3.1.0" install={docker} />);
    expect(view.container.textContent).toContain('In docker-compose.yml diese Zeile eintragen, dann den Container neu starten:');
    expect(view.container.textContent).toContain('Mit docker run gestartet: README');
    expect(codes(view.container)).toEqual(['docker-compose.yml', 'docker run']);
    cleanup();
    view = render(<UpdateInstructions {...base} install={{ mode: 'source', instructions: { kind: 'source' } }} />);
    expect(view.container.textContent).toContain('ZIP laden, über die Programmdateien entpacken (data/, .env und ssl/ bleiben), dann installieren');
    expect(codes(view.container)).toEqual(['data/', '.env', 'ssl/']);
    cleanup();

    __setCatalogForTests('en', {
      'In {file} diese Zeile eintragen, dann den Container neu starten:': 'Add this line to {file}, then restart the container:',
      'Mit {command} gestartet: README': 'Started with {command}: README'
    }, { languages: ['en-GB'] });
    view = render(<UpdateInstructions {...base} version="3.1.0" install={docker} />);
    expect(view.container.textContent).toContain('Add this line to docker-compose.yml, then restart the container:');
    expect(view.container.textContent).toContain('Started with docker run: README');
    expect(codes(view.container)).toEqual(['docker-compose.yml', 'docker run']);
  });
});
