import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';
import SystemModal from '../components/modals/SystemModal';
import PasswordConfirm from '../components/system/PasswordConfirm';
import RollbackPanel from '../components/system/RollbackPanel';
import { instructionSteps } from '../components/system/UpdateInstructions';
import { releaseLabel, ROLLBACK_REASON_TEXT } from '../components/system/updateModel';
import { resetI18nForTests } from '../i18n/index.js';
import {
  getUpdateWatch, startUpdateWatch, stopUpdateWatch, watchStatusText, UPDATE_RESULT_KEY, UPDATE_WATCH_KEY
} from '../utils/updateWatcher';
import { formatDateTime } from '../utils/format';

const MB = 1024 * 1024;
const IDENTITY = 'https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/heads/main';
const EXPIRES = '2026-10-11T12:15:00Z';
const BACKUP = 'vor-update-v3.2.0-auf-v3.3.0-2026-10-01T10-00-00-000Z.zip';
const BACKUP_AT = '2026-10-01T10:00:00Z';
const page = (version) => `https://github.com/LixNix-Swap-Org/manga-shelf/releases/tag/v${version}`;
const dl = (version, file) => `https://github.com/LixNix-Swap-Org/manga-shelf/releases/download/v${version}/${file}`;

const release = (version, extra = {}) => ({
  version, tag: `v${version}`, published_at: '2026-10-10T12:00:00Z', url: page(version), signed: true, installable: true,
  reason: null, has_admin_notes: false, ...extra
});

const pterodactyl = { mode: 'pterodactyl', can_install: true, reason: null, supervisor: 'wings', restart: 'pterodactyl', asset: 'pterodactyl-manga-shelf.zip', instructions: null, image: null };

const rollbackInfo = (over = {}) => ({
  version: '3.2.0', current: '3.3.0', available: true, reason: null, method: 'download',
  schema: { then: 27, now: 27, changed: false }, backup: { file: BACKUP, at: BACKUP_AT, present: true }, since: BACKUP_AT, ...over
});

const updateInfo = (over = {}) => ({
  enabled: true, current: '3.3.0', latest: '3.3.0', available: false, url: page('3.3.0'), checked_at: '2026-10-11T08:00:00Z',
  install: pterodactyl,
  releases: [
    release('3.3.0', { installable: false, reason: 'installed' }),
    release('3.2.0', { installable: false, reason: 'older', rollback: true }),
    release('3.1.0', { installable: false, reason: 'older' })
  ],
  releases_error: null, next_try_at: null, staging: null, status: { phase: 'idle' },
  last: { from: '3.2.0', to: '3.3.0', at: BACKUP_AT, result: 'ok', backup: BACKUP, direction: 'upgrade' },
  rollback: rollbackInfo(),
  ...over
});

const systemInfo = (update = updateInfo()) => ({
  version: update.current, node: 'v24.1.0', platform: 'linux/x64', instance_id: 'inst-1', uptime: 3600, memory_rss: 80 * MB,
  data_dir: '/srv/manga/data', health: { status: 'ok', checks: {} }, database: null, storage: null,
  orphans: { count: 0, bytes: 0, skipped: false }, backups: null, jobs: { running: [] }, sources: { users_with_keys: 0 }, update
});

const readyStatus = (over = {}) => ({
  phase: 'ready', version: '3.2.0', bytes: 40 * MB, total: 40 * MB, staging_id: 'st-1', expires_at: EXPIRES,
  verified: { identity: IDENTITY, log_index: 42 }, asset: 'pterodactyl-manga-shelf.zip', admin_notes: null, error: null,
  downgrade: true, data_loss: null, ...over
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

describe('rollback: system page', () => {
  it('without a schema change: panel, download with downgrade, ready box, password with the rollback label and the downgrade watch', async () => {
    const statuses = [
      { phase: 'downloading', version: '3.2.0', bytes: 1 * MB, total: 40 * MB, staging_id: 'st-1', expires_at: EXPIRES, downgrade: true, data_loss: null },
      readyStatus()
    ];
    const { fetchMock, region } = await openPage({ routes: {
      'POST /api/system/update/prepare': () => fakeResponse(202, { staging_id: 'st-1', expires_at: EXPIRES, downgrade: true }),
      'GET /api/system/update/status': () => fakeResponse(200, statuses.length > 1 ? statuses.shift() : statuses[0]),
      'POST /api/system/update/apply/st-1': () => fakeResponse(202, { accepted: true, version: '3.2.0', restart: 'pterodactyl', downgrade: true })
    } });
    const panel = within(region).getByTestId('update-rollback');
    expect(panel.textContent).toContain('Läuft v3.3.0 nicht wie gewünscht, kannst du zur Version vor dem letzten Update zurückkehren.');
    expect(within(region).getByTestId('update-last').textContent).toContain('Zuletzt aktualisiert: v3.2.0 → v3.3.0');
    const button = within(panel).getByRole('button', { name: 'Zurück zu v3.2.0' });
    expect(button.id).toBe('btn-update-rollback');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panel.textContent).toContain('Die Datenbank bleibt, wie sie ist: v3.3.0 hat sie nicht umgebaut, v3.2.0 öffnet sie unverändert. Es geht nichts verloren.');
    expect(within(panel).queryByTestId('update-data-loss')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Herunterladen und prüfen' }));
    await screen.findByTestId('update-progress');
    expect(bodyOf(calls(fetchMock, '/api/system/update/prepare')[0])).toEqual({ version: '3.2.0', downgrade: true });

    const ready = await screen.findByTestId('update-ready', {}, { timeout: 4000 });
    expect(within(ready).getByRole('status').textContent).toBe('Bereit zum Zurücksetzen auf v3.2.0');
    expect(ready.textContent).toContain(`Geprüft: signiert von GitHub Actions (${IDENTITY}), SHA-256 ✓`);
    expect(ready.textContent).toContain('Vorher wird ein geprüftes Backup der Datenbank angelegt.');
    fireEvent.click(within(ready).getByRole('button', { name: 'Zurück zu v3.2.0' }));
    fireEvent.change(within(ready).getByLabelText('Passwort zur Bestätigung'), { target: { value: 'geheim123' } });
    const submit = within(ready).getByRole('button', { name: 'Zurück zu v3.2.0 und neu starten' });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await within(region).findByTestId('update-wait');
    expect(bodyOf(calls(fetchMock, '/api/system/update/apply/st-1')[0])).toEqual({ current_password: 'geheim123', accept_data_loss: false });
    expect(getUpdateWatch()).toMatchObject({ version: '3.2.0', from: '3.3.0', direction: 'downgrade' });
    expect(JSON.parse(sessionStorage.getItem(UPDATE_WATCH_KEY))).toMatchObject({ version: '3.2.0', direction: 'downgrade' });
  });

  it('schema changed: the panel names the lost changes and both backups; the ready box gates the submit on the checkbox', async () => {
    const changed = rollbackInfo({ schema: { then: 27, now: 28, changed: true } });
    const status = readyStatus({ data_loss: { backup: BACKUP, at: BACKUP_AT, schema_then: 27, schema_now: 28 } });
    let info = systemInfo(updateInfo({ rollback: changed }));
    const { fetchMock, region } = await openPage({ info: () => info, routes: {
      'POST /api/system/update/apply/st-1': () => fakeResponse(202, { accepted: true, version: '3.2.0', restart: 'pterodactyl', downgrade: true })
    } });
    const date = formatDateTime(BACKUP_AT);
    fireEvent.click(within(region).getByRole('button', { name: 'Zurück zu v3.2.0' }));
    const loss = within(region).getByTestId('update-data-loss');
    expect(loss.className).toContain('rose');
    expect(loss.textContent).toContain('Änderungen seit dem Update gehen verloren');
    expect(loss.textContent).toContain(`v3.3.0 hat die Datenbank beim Update umgebaut (Schema v27 → v28); v3.2.0 kann sie so nicht öffnen. Zurück geht es nur mit dem Backup von vor dem Update: ${BACKUP} (${date}).`);
    expect(loss.textContent).toContain(`Alles, was seit ${date} geändert wurde, fehlt danach – neue Reihen und Bände, Lesestand, Anime-Fortschritt, Einkaufsliste, Benutzer und Einstellungen. Bilder in uploads/ bleiben.`);
    expect(loss.textContent).toContain('Der heutige Stand wird vorher als eigenes Backup gesichert (vor-update-v3.3.0-auf-v3.2.0-….zip) und lässt sich mit v3.3.0 oder neuer wieder einspielen.');
    expect(loss.textContent).toContain('Auf v3.2.0 fällt es unter die Aufbewahrung der Update-Backups (BACKUP_KEEP_PRE_UPDATE) – bei Bedarf herunterladen.');
    expect(within(loss).queryByRole('checkbox')).toBeNull();
    cleanup();

    info = systemInfo(updateInfo({ rollback: changed, status, staging: { staging_id: 'st-1', version: '3.2.0' } }));
    const page2 = await openPage({ info: () => info, routes: {
      'POST /api/system/update/apply/st-1': () => fakeResponse(202, { accepted: true, version: '3.2.0', restart: 'pterodactyl', downgrade: true })
    } });
    const ready = within(page2.region).getByTestId('update-ready');
    expect(within(ready).getByTestId('update-data-loss').textContent).toContain('Schema v27 → v28');
    fireEvent.click(within(ready).getByRole('button', { name: 'Zurück zu v3.2.0' }));
    fireEvent.change(within(ready).getByLabelText('Passwort zur Bestätigung'), { target: { value: 'geheim123' } });
    const submit = within(ready).getByRole('button', { name: 'Zurück zu v3.2.0 und neu starten' });
    expect(submit.disabled).toBe(true);
    fireEvent.submit(submit.closest('form'));
    expect(calls(page2.fetchMock, '/api/system/update/apply/st-1')).toHaveLength(0);
    fireEvent.click(within(ready).getByRole('checkbox', { name: `Ich habe verstanden, dass alle Änderungen seit ${date} verloren gehen.` }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls(page2.fetchMock, '/api/system/update/apply/st-1')).toHaveLength(1));
    expect(bodyOf(calls(page2.fetchMock, '/api/system/update/apply/st-1')[0])).toEqual({ current_password: 'geheim123', accept_data_loss: true });
    expect(calls(fetchMock, '/api/system/update/apply/st-1')).toHaveLength(0);
  });

  it('unavailable: the reason line and a disabled button; while the target is unknown only the disabled button', async () => {
    const { region } = await openPage({ info: systemInfo(updateInfo({ rollback: rollbackInfo({ available: false, reason: 'backup_changed' }) })) });
    const panel = within(region).getByTestId('update-rollback');
    expect(panel.textContent).toContain('Zurück zu v3.2.0 ist nicht möglich: das Backup von vor dem Update wurde verändert');
    expect(within(panel).getByRole('button', { name: 'Zurück zu v3.2.0' }).disabled).toBe(true);
    cleanup();

    const page2 = await openPage({ info: systemInfo(updateInfo({ rollback: rollbackInfo({ available: false, reason: null }) })) });
    const panel2 = within(page2.region).getByTestId('update-rollback');
    expect(within(panel2).getByRole('button', { name: 'Zurück zu v3.2.0' }).disabled).toBe(true);
    expect(panel2.textContent).not.toContain('nicht möglich');
    cleanup();

    const page3 = await openPage({ info: systemInfo(updateInfo({ rollback: null })) });
    expect(within(page3.region).queryByTestId('update-rollback')).toBeNull();
    expect(page3.region.textContent).toContain('Ältere Versionen lassen sich nicht per Klick installieren: Die Datenbank wird nur vorwärts migriert.');
  });

  it('a refused prepare names the reason and the retry keeps the downgrade', async () => {
    const { fetchMock, region } = await openPage({ routes: {
      'POST /api/system/update/prepare': () => fakeResponse(409, { error: 'Zurück zu dieser Version ist auf diesem Server nicht möglich.', code: 'DOWNGRADE_NOT_AVAILABLE', reason: 'not_previous' })
    } });
    const panel = within(region).getByTestId('update-rollback');
    fireEvent.click(within(panel).getByRole('button', { name: 'Zurück zu v3.2.0' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Herunterladen und prüfen' }));
    const failure = await within(region).findByTestId('update-failure');
    expect(failure.textContent).toContain('Zurück zu v3.2.0 ist nicht möglich: nicht die Version vor dem letzten Update');
    fireEvent.click(within(failure).getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(calls(fetchMock, '/api/system/update/prepare')).toHaveLength(2));
    expect(calls(fetchMock, '/api/system/update/prepare').map(bodyOf)).toEqual([{ version: '3.2.0', downgrade: true }, { version: '3.2.0', downgrade: true }]);
  });

  it('the picker labels the target and names it in the hint', async () => {
    const { region } = await openPage();
    const select = within(region).getByLabelText('Andere Version wählen');
    expect(within(select).getAllByRole('option').map((o) => [o.textContent, o.disabled])).toEqual([
      ['Keine installierbare Version', true],
      ['v3.3.0 – 10.10.2026 – installiert', true],
      ['v3.2.0 – 10.10.2026 – vorherige Version – „Zurück zu v3.2.0“', true],
      ['v3.1.0 – 10.10.2026 – älter: kein Zurück per Klick', true]
    ]);
    expect(region.textContent).toContain('Ältere Versionen lassen sich nicht per Klick installieren – nur die Version vor dem letzten Update („Zurück zu v3.2.0“).');
    expect(releaseLabel(release('3.2.0', { rollback: true }), true)).toBe('v3.2.0 – 10.10.2026');
  });

  it('the last result of a downgrade has its own texts', async () => {
    const at = '2026-10-11T09:00:00Z';
    const cases = [
      [{ result: 'ok' }, `Zurückgesetzt: v3.3.0 → v3.2.0 (${formatDateTime(at)})`],
      [{ result: 'failed', error: 'UPDATE_FAILED' }, `Zurücksetzen auf v3.2.0 fehlgeschlagen (${formatDateTime(at)}); v3.3.0 läuft weiter.`],
      [{ result: 'rolled_back', error: 'START_FAILED' }, `v3.2.0 ist nicht gestartet; v3.3.0 läuft wieder mit dem Stand von vor dem Zurücksetzen (${formatDateTime(at)}).`]
    ];
    for (const [over, text] of cases) {
      const last = { from: '3.3.0', to: '3.2.0', at, backup: 'vor-update-v3.3.0-auf-v3.2.0-x.zip', direction: 'downgrade', ...over };
      const { region } = await openPage({ info: systemInfo(updateInfo({ last, rollback: null })) });
      expect(within(region).getByTestId('update-last').textContent).toContain(text);
      cleanup();
    }
  });
});

describe('rollback: instruction modes', () => {
  const docker = { mode: 'docker', can_install: false, reason: 'docker', supervisor: null, asset: null, image: 'ghcr.io/lixnix-swap-org/manga-shelf', instructions: { kind: 'docker' } };

  it('the panel shows the steps, the instruction-mode backup sentence and the "do not start" line', () => {
    const rollback = rollbackInfo({ method: 'instructions', schema: { then: 27, now: 28, changed: true } });
    render(<RollbackPanel rollback={rollback} install={docker} platform="linux/x64" />);
    fireEvent.click(screen.getByRole('button', { name: 'Zurück zu v3.2.0' }));
    const panel = screen.getByTestId('update-rollback');
    expect(panel.textContent).toContain('Beim Einspielen sichert v3.2.0 den heutigen Stand als vor-wiederherstellung-….zip; er lässt sich mit v3.3.0 oder neuer wieder einspielen und fällt unter die Aufbewahrung BACKUP_KEEP_PRE_RESTORE – bei Bedarf herunterladen.');
    expect(panel.textContent).not.toContain('BACKUP_KEEP_PRE_UPDATE');
    expect(panel.textContent).toContain('nicht starten, bevor das Backup eingespielt ist');
    expect(within(panel).queryByRole('button', { name: 'Herunterladen und prüfen' })).toBeNull();
    expect(within(panel).getByTestId('update-instructions').textContent).toContain(`docker compose run --rm manga-shelf node scripts/admin.js wiederherstellen ${BACKUP}`);
    cleanup();

    render(<RollbackPanel rollback={rollback} install={{ mode: 'desktop', instructions: { kind: 'desktop' } }} platform="darwin/arm64" />);
    fireEvent.click(screen.getByRole('button', { name: 'Zurück zu v3.2.0' }));
    expect(screen.getByTestId('update-rollback').textContent).toContain('einmal mit ALLOW_NEWER_SCHEMA=1 starten, sofort das Backup einspielen, vorher nichts ändern');
    cleanup();

    render(<RollbackPanel rollback={rollbackInfo({ method: 'instructions' })} install={docker} platform="linux/x64" />);
    fireEvent.click(screen.getByRole('button', { name: 'Zurück zu v3.2.0' }));
    const plain = screen.getByTestId('update-rollback');
    expect(plain.textContent).not.toContain('nicht starten, bevor');
    expect(within(plain).getByTestId('update-instructions').textContent).toContain('image: ghcr.io/lixnix-swap-org/manga-shelf:3.2.0\ndocker compose up -d');
  });

  const steps = (install, downgrade, extra = {}) => instructionSteps({ install, version: '3.2.0', latest: '3.3.0', releaseUrl: page('3.2.0'), platform: 'linux/x64', downgrade, ...extra });
  const commands = (...args) => steps(...args).map((s) => s.command).filter(Boolean);
  const changed = { schemaChanged: true, backup: BACKUP };
  const same = { schemaChanged: false, backup: BACKUP };

  it('docker: stop, pin, restore before up; without a schema change only the pin', () => {
    expect(commands(docker, changed)).toEqual([
      'docker compose stop',
      'image: ghcr.io/lixnix-swap-org/manga-shelf:3.2.0',
      `docker compose run --rm manga-shelf node scripts/admin.js wiederherstellen ${BACKUP}`,
      'docker compose up -d'
    ]);
    expect(commands(docker, same)).toEqual(['image: ghcr.io/lixnix-swap-org/manga-shelf:3.2.0\ndocker compose up -d']);
  });

  it('deb/rpm: downgrade install, then stop, restore as the service user and start', () => {
    const deb = `curl -LO ${dl('3.2.0', 'manga-shelf-server_3.2.0-1_amd64.deb')} && sudo apt install --allow-downgrades ./manga-shelf-server_3.2.0-1_amd64.deb`;
    const rpm = `curl -LO ${dl('3.2.0', 'manga-shelf-server-3.2.0-1.x86_64.rpm')} && sudo dnf downgrade ./manga-shelf-server-3.2.0-1.x86_64.rpm`;
    expect(commands({ instructions: { kind: 'deb' } }, same)).toEqual([deb]);
    expect(commands({ instructions: { kind: 'rpm' } }, same)).toEqual([rpm]);
    expect(commands({ instructions: { kind: 'deb' } }, changed)).toEqual([
      deb,
      'sudo systemctl stop manga-shelf',
      `sudo -u manga-shelf /usr/bin/manga-shelf-server restore ${BACKUP} --data-dir /var/lib/manga-shelf`,
      'sudo systemctl start manga-shelf'
    ]);
    expect(commands({ instructions: { kind: 'package' } }, same)).toEqual([deb, rpm]);
  });

  it('service: stop, the old file restores as the service user, then install-service starts it', () => {
    const service = { asset: 'manga-shelf-server-linux-x64', instructions: { kind: 'service', argv: ['/usr/local/bin/manga-shelf-server', '--port', '8080', '--data-dir', '/srv/manga data'] } };
    expect(commands(service, changed)).toEqual([
      `curl -LO ${dl('3.2.0', 'manga-shelf-server-linux-x64')} && chmod +x manga-shelf-server-linux-x64`,
      'sudo systemctl stop manga-shelf',
      `sudo -u manga-shelf ./manga-shelf-server-linux-x64 restore ${BACKUP} --data-dir '/srv/manga data'`,
      "sudo ./manga-shelf-server-linux-x64 install-service --port 8080 --data-dir '/srv/manga data'"
    ]);
    expect(steps(service, changed).map((s) => s.lead)).toEqual([
      'Datei von v3.2.0 laden:', 'Server stoppen:', 'Backup von vor dem Update einspielen:', 'Dienst mit dieser Datei neu einrichten und starten:'
    ]);
    expect(commands(service, same)).toEqual([
      `curl -LO ${dl('3.2.0', 'manga-shelf-server-linux-x64')} && chmod +x manga-shelf-server-linux-x64`,
      "sudo ./manga-shelf-server-linux-x64 install-service --port 8080 --data-dir '/srv/manga data'"
    ]);
    expect(steps(service, same).map((s) => s.lead)).toEqual(['Datei von v3.2.0 laden:', 'Dienst mit dieser Datei neu einrichten und starten:']);
  });

  it('Windows: every command is quoted for cmd, also install-service and the update steps', () => {
    const windows = { asset: 'manga-shelf-server-windows-x64.exe', instructions: { kind: 'windows', argv: ['C:\\ms\\manga-shelf-server-windows-x64.exe', '--data-dir', 'C:\\Manga Daten'] } };
    const list = steps(windows, changed);
    expect(list[0].link.href).toBe(dl('3.2.0', 'manga-shelf-server-windows-x64.exe'));
    expect(list.map((s) => s.command).filter(Boolean)).toEqual([
      'schtasks /End /TN "Manga Shelf Server"',
      `manga-shelf-server-windows-x64.exe restore ${BACKUP} --data-dir "C:\\Manga Daten"`,
      'manga-shelf-server-windows-x64.exe install-service --data-dir "C:\\Manga Daten"'
    ]);
    expect(steps(windows, same).map((s) => s.lead)).toEqual(['Datei laden, dann in einer Eingabeaufforderung als Administrator:']);
    expect(commands(windows, same)).toEqual(['manga-shelf-server-windows-x64.exe install-service --data-dir "C:\\Manga Daten"']);

    const task = { asset: 'manga-shelf-server-windows-x64.exe', instructions: { kind: 'windows', argv: ['C:\\Program Files\\Manga Shelf Server\\manga-shelf-server.exe', '--port', '3000', '--data-dir', 'C:\\ProgramData\\manga-shelf\\data'] } };
    const install = 'manga-shelf-server-windows-x64.exe install-service --port 3000 --data-dir C:\\ProgramData\\manga-shelf\\data';
    expect(commands(task, changed)).toEqual([
      'schtasks /End /TN "Manga Shelf Server"',
      `manga-shelf-server-windows-x64.exe restore ${BACKUP} --data-dir C:\\ProgramData\\manga-shelf\\data`,
      install
    ]);
    expect(commands(task, same)).toEqual([install]);
    expect(commands(task, null, { version: '3.3.0' })).toEqual([install]);
    expect(commands(windows, null, { version: '3.3.0' })).toEqual(['manga-shelf-server-windows-x64.exe install-service --data-dir "C:\\Manga Daten"']);

    const sea = { mode: 'sea-user', asset: 'manga-shelf-server-windows-x64.exe', instructions: { kind: 'sea-user', argv: ['C:\\Users\\me\\manga-shelf-server-windows-x64.exe', '--port', '3000', '--data-dir', 'C:\\Users\\me\\Manga Daten'] } };
    expect(commands(sea, changed)).toEqual([
      `manga-shelf-server-windows-x64.exe restore ${BACKUP} --data-dir "C:\\Users\\me\\Manga Daten"`,
      'manga-shelf-server-windows-x64.exe --port 3000 --data-dir "C:\\Users\\me\\Manga Daten"'
    ]);
  });

  it('binary and sea-user: the old file restores before its first start', () => {
    const sea = { mode: 'sea-user', asset: 'manga-shelf-server-macos-universal', instructions: { kind: 'sea-user', argv: ['/Users/me/manga-shelf-server-macos-universal', '--port', '3000'] } };
    expect(commands(sea, changed)).toEqual([
      `curl -LO ${dl('3.2.0', 'manga-shelf-server-macos-universal')} && chmod +x manga-shelf-server-macos-universal`,
      `./manga-shelf-server-macos-universal restore ${BACKUP}`,
      './manga-shelf-server-macos-universal --port 3000'
    ]);
    expect(steps(sea, changed).map((s) => s.lead)).toEqual([
      'Datei von v3.2.0 laden:', 'Zuerst den Server stoppen.', 'Backup von vor dem Update einspielen:', 'Server mit dieser Datei starten:'
    ]);
    expect(commands({ ...sea, instructions: { kind: 'binary', argv: sea.instructions.argv } }, same)).toEqual([
      `curl -LO ${dl('3.2.0', 'manga-shelf-server-macos-universal')} && chmod +x manga-shelf-server-macos-universal`,
      './manga-shelf-server-macos-universal --port 3000'
    ]);
  });

  it('source, desktop and Pterodactyl', () => {
    const source = { mode: 'source', instructions: { kind: 'source' } };
    const build = '(cd frontend && npm ci && npm run build)';
    expect(commands(source, changed)).toEqual(['git checkout v3.2.0', 'npm ci --omit=dev', build, `node scripts/admin.js wiederherstellen ${BACKUP}`, 'npm start']);
    expect(steps(source, changed).find((s) => s.key === 'source').link.href).toBe(dl('3.2.0', 'pterodactyl-manga-shelf.zip'));
    expect(steps(source, changed).find((s) => s.key === 'build').lead).toBe('Im Git-Checkout zusätzlich das Web-Portal bauen:');
    expect(commands(source, same)).toEqual(['git checkout v3.2.0', 'npm ci --omit=dev', build, 'npm start']);

    const desktop = { mode: 'desktop', instructions: { kind: 'desktop' } };
    expect(steps(desktop, same).map((s) => s.link?.href)).toEqual([page('3.2.0')]);
    expect(commands(desktop, changed, { platform: 'darwin/arm64' })).toEqual(['ALLOW_NEWER_SCHEMA=1 "/Applications/Manga Shelf.app/Contents/MacOS/Manga Shelf"']);
    expect(commands(desktop, changed, { platform: 'win32/x64' })).toEqual(['set ALLOW_NEWER_SCHEMA=1\n"%LOCALAPPDATA%\\Programs\\Manga Shelf\\Manga Shelf.exe"']);
    expect(commands(desktop, changed, { platform: '' })).toHaveLength(3);

    const ptero = { mode: 'pterodactyl', instructions: { kind: 'pterodactyl' } };
    expect(commands(ptero, changed)).toEqual(['ALLOW_NEWER_SCHEMA=1']);
    expect(steps(ptero, same).map((s) => s.key)).toEqual(['pterodactyl', 'start']);
    expect(instructionSteps({ install: { mode: 'sea-system', instructions: { kind: 'other', command: 'x' } }, version: '3.2.0', downgrade: same })).toEqual([]);
  });
});

describe('rollback: parts', () => {
  it('PasswordConfirm: blocked keeps the submit off, the icon is replaceable', () => {
    const onSubmit = vi.fn();
    const Icon = (props) => <svg data-testid="custom-icon" {...props} />;
    const { rerender } = render(<PasswordConfirm submitLabel="Los" icon={Icon} blocked onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Passwort zur Bestätigung'), { target: { value: 'pw' } });
    const submit = screen.getByRole('button', { name: 'Los' });
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId('custom-icon')).toBeTruthy();
    fireEvent.submit(submit.closest('form'));
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(<PasswordConfirm submitLabel="Los" icon={Icon} onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Los' }));
    expect(onSubmit).toHaveBeenCalledWith('pw');
  });

  it('every refusal reason has a text', () => {
    expect(Object.keys(ROLLBACK_REASON_TEXT)).toEqual([
      'disabled', 'mode', 'no_update', 'already_downgraded', 'not_previous', 'too_old', 'backup_missing', 'backup_changed', 'unsigned', 'no_asset'
    ]);
  });

  it('the watcher keeps the direction: failure text, stored result', async () => {
    expect(watchStatusText({ phase: 'failed', version: '3.2.0', direction: 'downgrade' })).toBe('Zurücksetzen auf v3.2.0 nicht ausgeführt');
    expect(watchStatusText({ phase: 'failed', version: '3.2.0' })).toBe('Update auf v3.2.0 nicht installiert');
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async (url) => (url === '/api/health'
        ? fakeResponse(200, { name: 'Manga Shelf', instance_id: 'inst-1', status: 'ok', version: '3.2.0', uptime: 0, checks: {} })
        : fakeResponse(404, {}))));
      const reload = vi.fn();
      startUpdateWatch({ version: '3.2.0', from: '3.3.0', direction: 'downgrade' }, { reload });
      await vi.advanceTimersByTimeAsync(2000);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sessionStorage.getItem(UPDATE_RESULT_KEY))).toEqual({ result: 'ok', version: '3.2.0', from: '3.3.0', direction: 'downgrade' });
    } finally {
      vi.useRealTimers();
    }
  });
});
