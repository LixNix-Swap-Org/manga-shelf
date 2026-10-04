// App in standalone mode (no server): device database, transfer and offers.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import initSqlJs from 'sql.js/dist/sql-wasm.js';

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
        <p>Dashboard von {user.username}{user.local ? ' (lokal)' : ''}</p>
        <button type="button" onClick={onLogout}>Abmelden</button>
      </div>
    );
  }
}));

const outboxSpy = vi.hoisted(() => ({ starts: [] }));
vi.mock('../utils/outbox', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    startOutboxSync: (options) => {
      outboxSpy.starts.push(options.userId);
      return original.startOutboxSync(options);
    }
  };
});

import App from '../App';
import LocalOffer from '../app/LocalOffer';
import { MemoryRouter } from 'react-router-dom';
import { flakyStore, fakeLocks } from './localFakes.js';
import BackupExportModal from '../components/modals/BackupExportModal';
import { buildBackupZip } from '../local/backupZip.js';
import { createLocalRuntime, DB_KEY, SAVE_SEQ_KEY } from '../local/runtime.js';
import { memoryStore } from '../local/store.js';
import { setLocalAdapters, resetLocalRuntime, getLocalRuntime } from '../local/localTransport.js';
import { MODE_KEY, PROFILE_KEY, enterLocalMode, leaveLocalMode } from '../local/profile.js';
import { resetServers, setStorageAdapter, getServers, getActiveServer } from '../app/serverStore';
import { resetConnection } from '../app/connection';
import { resetOutbox } from '../utils/outbox';
import { syncOfflineCopy, clearOfflineData } from '../utils/offlineStore';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const offline = { fetch: async () => { throw new TypeError('offline'); }, fetchText: async () => { throw new Error('offline'); }, fetchImage: async () => { throw new Error('offline'); } };

let SQL;
let store;
beforeAll(async () => { SQL = await initSqlJs(); });

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  setStorageAdapter(null);
  resetServers();
  resetConnection();
  resetOutbox();
  await resetLocalRuntime();
  store = memoryStore();
  setLocalAdapters({ boot: ({ profile }) => createLocalRuntime({ SQL, store, http: offline, profile: profile || {}, persistDelayMs: 0 }) });
  vi.stubEnv('VITE_APP_MODE', 'app');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  outboxSpy.starts = [];
});

afterEach(async () => {
  leaveLocalMode();
  await resetLocalRuntime();
  setLocalAdapters(null);
  vi.unstubAllEnvs();
});

const noNetwork = () => {
  const fetchMock = vi.fn(async (url) => { throw new TypeError(`unexpected fetch ${url}`); });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

describe('App without a server (standalone mode)', () => {
  it('first start: "Ohne Server nutzen", profile name, optional sources, then the collection; nothing goes to a network', async () => {
    const fetchMock = noNetwork();
    render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: 'Ohne Server nutzen' }));
    expect(await screen.findByText('Schritt 2 von 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Sammlung anlegen/ }));
    expect(await screen.findByText('Bitte einen Namen für dein Profil eingeben.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Felix' } });
    fireEvent.click(screen.getByRole('button', { name: /Sammlung anlegen/ }));
    const sources = await screen.findByRole('heading', { name: 'Quellen verbinden (optional)' });
    await waitFor(() => expect(document.activeElement).toBe(sources));
    expect(await screen.findByText(/nicht sicher, nur für Tests/)).toBeTruthy();
    expect(screen.getAllByText(/AniList/).length).toBeGreaterThan(0);
    expect(document.querySelectorAll('#local-sources h3').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('#local-sources h4')).toHaveLength(0);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(293);
    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(await screen.findByText('Dashboard von Felix (lokal)')).toBeTruthy();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(localStorage.getItem(MODE_KEY)).toBe('local');
    expect(JSON.parse(localStorage.getItem(PROFILE_KEY))).toEqual({ id: 1, name: 'Felix' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(syncOfflineCopy).not.toHaveBeenCalled();
  });

  it('a stored local mode opens the collection at once; "Abmelden" keeps it and "Modus wechseln" leads to the servers', async () => {
    noNetwork();
    enterLocalMode({ id: null, name: 'Lea' });
    render(<App />);
    expect(await screen.findByText('Dashboard von Lea (lokal)')).toBeTruthy();
    const rt = await getLocalRuntime();
    await rt.request('POST', '/api/mangas', { title: 'Bleibt' });
    fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sammlung öffnen' }));
    expect(await screen.findByText('Dashboard von Lea (lokal)')).toBeTruthy();
    expect((await rt.request('GET', '/api/mangas')).body.map((m) => m.title)).toEqual(['Bleibt']);

    window.history.pushState(null, '', '/server');
    fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    fireEvent.click(await screen.findByRole('button', { name: /Mit Server verbinden/ }));
    expect(await screen.findByRole('heading', { name: 'Server hinzufügen' })).toBeTruthy();
    expect(localStorage.getItem(MODE_KEY)).toBeNull();
    // the local collection stays and is offered again
    expect(await screen.findByRole('button', { name: 'Lokale Sammlung öffnen (Lea)' })).toBeTruthy();
    expect([...store.data.db.keys()].sort()).toEqual([DB_KEY, SAVE_SEQ_KEY]);
  });

  it('the device screen exports the collection as a ZIP', async () => {
    noNetwork();
    URL.createObjectURL = vi.fn(() => 'blob:zip');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    enterLocalMode({ id: null, name: 'Felix' });
    render(<App />);
    await screen.findByText('Dashboard von Felix (lokal)');
    fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sammlung öffnen' }));
    await screen.findByText('Dashboard von Felix (lokal)');
    window.history.pushState(null, '', '/server');
    window.dispatchEvent(new PopStateEvent('popstate'));
    fireEvent.click(await screen.findByRole('button', { name: /Sicherung exportieren\/importieren/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Sicherung exportieren$/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(URL.createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
  });

  it('"Auf Server übertragen": admin login, server numbers with a warning, restore, then the app is connected', async () => {
    enterLocalMode({ id: null, name: 'Felix' });
    const admin = { id: 1, username: 'admin', role: 'admin' };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const key = `${(init.method || 'GET').toUpperCase()} ${new URL(url).pathname}`;
      calls.push([key, init.headers?.Authorization]);
      switch (key) {
        case 'POST /api/auth/login': return json(200, { user: admin, token: calls.filter(([k]) => k === key).length > 1 ? 'tok-2' : 'tok-1' });
        case 'POST /api/backup/inspect': return json(200, {
          success: true, staging_id: 'stage-1', counts: { mangas: 1, volumes: 0, users: 1, uploads: 0 },
          current_counts: { mangas: 4, volumes: 9, users: 1 }, warnings: ['Alle anderen Sitzungen werden beendet.'], relogin: false
        });
        case 'POST /api/backup/restore/stage-1': return json(200, { success: true });
        case 'GET /api/health': return json(200, { name: 'Manga Shelf', status: 'ok', instance_id: 'inst-1' });
        case 'GET /api/setup/status': return json(200, { needsSetup: false });
        case 'GET /api/auth/me': return json(200, { user: admin });
        default: throw new TypeError(`unexpected fetch ${key}`);
      }
    }));
    render(<App />);
    await screen.findByText('Dashboard von Felix (lokal)');
    const rt = await getLocalRuntime();
    await rt.request('POST', '/api/mangas', { title: 'Wandert' });
    window.history.pushState(null, '', '/server');
    window.dispatchEvent(new PopStateEvent('popstate'));
    fireEvent.click(await screen.findByRole('button', { name: /Auf Server übertragen/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Serveradresse'), { target: { value: 'https://shelf.example' } });
    fireEvent.change(within(dialog).getByLabelText('Benutzername'), { target: { value: 'admin' } });
    fireEvent.change(within(dialog).getByLabelText('Passwort'), { target: { value: 'password123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Anmelden' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Prüfen' }));
    expect(await within(dialog).findByText(/Auf dem Server liegen schon Daten/)).toBeTruthy();
    expect(within(dialog).getByText('Alle anderen Sitzungen werden beendet.')).toBeTruthy();
    // the server holds data: no transfer before the confirmation
    expect(within(dialog).queryByRole('button', { name: 'Übertragen' })).toBeNull();
    fireEvent.click(within(dialog).getByLabelText('Daten auf dem Server trotzdem ersetzen'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Übertragen' }));
    expect(await screen.findByText('Dashboard von admin')).toBeTruthy();
    expect(localStorage.getItem(MODE_KEY)).toBeNull();
    expect(getServers()).toHaveLength(1);
    expect(getActiveServer()).toMatchObject({ urls: ['https://shelf.example'], token: 'tok-2', tokenOrigins: ['https://shelf.example'] });
    expect(calls.find(([k]) => k === 'POST /api/backup/inspect')[1]).toBe('Bearer tok-1');
    expect(calls.filter(([k]) => k === 'GET /api/auth/me').every(([, auth]) => auth === 'Bearer tok-2')).toBe(true);
  }, 15000);

  it('"Sicherung importieren" shows what the ZIP holds and replaces the collection only after the confirmation', async () => {
    noNetwork();
    enterLocalMode({ id: null, name: 'Felix' });
    const rt = await getLocalRuntime();
    await rt.request('POST', '/api/mangas', { title: 'Wird ersetzt' });
    const source = await createLocalRuntime({ SQL, store: memoryStore(), http: offline, profile: { name: 'Felix' }, persistDelayMs: 0 });
    await source.request('POST', '/api/mangas', { title: 'Aus der Sicherung' });
    const zip = await buildBackupZip(source);
    const onReplaced = vi.fn();
    const { container } = render(<BackupExportModal onClose={() => {}} onReplaced={onReplaced} />);
    const file = new File([zip], 'sicherung.zip', { type: 'application/zip' });
    fireEvent.change(container.ownerDocument.querySelector('input[type="file"]'), { target: { files: [file] } });
    expect(await screen.findByText(/1 Reihe, 0 Bände, 0 Bilder/)).toBeTruthy();
    const restore = screen.getByRole('button', { name: 'Einspielen' });
    expect(restore.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Sammlung auf diesem Gerät ersetzen'));
    fireEvent.click(restore);
    await waitFor(() => expect(onReplaced).toHaveBeenCalled());
    expect((await rt.request('GET', '/api/mangas')).body.map((m) => m.title)).toEqual(['Aus der Sicherung']);
    fireEvent.change(container.ownerDocument.querySelector('input[type="file"]'), { target: { files: [new File(['kein zip'], 'x.zip')] } });
    expect(await screen.findByText('Ungültiges ZIP-Archiv: Datei kann nicht gelesen werden')).toBeTruthy();
  });

  it('"Sicherung importieren" of a server backup ZIP keeps no foreign hash, API key or feed token; the export text names the password reset', async () => {
    noNetwork();
    enterLocalMode({ id: null, name: 'Felix' });
    const rt = await getLocalRuntime();
    const hash = '$2b$10$kimKimKimKimKimKimKimKimKimKimKimKimKimKimKimKimKimK';
    const source = await createLocalRuntime({ SQL, store: memoryStore(), http: offline, profile: { name: 'admin' }, persistDelayMs: 0 });
    const dbBytes = source.databaseCopy((conn) => {
      conn.prepare("UPDATE users SET password_hash = '$2b$10$adminhash' WHERE username = 'admin'").run();
      conn.prepare("INSERT INTO users (username, password_hash, role) VALUES ('kim', ?, 'editor')").run(hash);
      conn.prepare("INSERT INTO user_api_credentials (user_id, provider, secret_enc, last4) VALUES (2, 'anilist', 'sealed-kim-key', 'abcd')").run();
      conn.prepare("INSERT INTO app_settings (key, value) VALUES ('calendar_feed:ab12', 'sealed-feed-token')").run();
      conn.prepare("INSERT INTO mangas (title) VALUES ('Vom Server')").run();
    });
    const zip = await buildBackupZip(source, { dbBytes });
    await source.close();
    const onReplaced = vi.fn();
    const { container } = render(<BackupExportModal onClose={() => {}} onReplaced={onReplaced} />);
    expect(screen.getByText(/brauchen nach der Wiederherstellung auf einem Server einen Passwort-Reset/)).toBeTruthy();
    fireEvent.change(container.ownerDocument.querySelector('input[type="file"]'), { target: { files: [new File([zip], 'server.zip', { type: 'application/zip' })] } });
    fireEvent.click(await screen.findByLabelText('Sammlung auf diesem Gerät ersetzen'));
    fireEvent.click(screen.getByRole('button', { name: 'Einspielen' }));
    await waitFor(() => expect(onReplaced).toHaveBeenCalled());
    await rt.flush();
    const saved = new TextDecoder('latin1').decode(store.data.db.get(DB_KEY));
    for (const secret of ['$2b$10$', 'sealed-kim-key', 'sealed-feed-token']) expect(saved.includes(secret), secret).toBe(false);
    const db = rt.getContext().db;
    expect(db.prepare("SELECT count(*) AS n FROM users WHERE password_hash <> '!local-profile'").get().n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM user_api_credentials').get().n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM app_settings WHERE key LIKE 'calendar_feed:%'").get().n).toBe(0);
    expect((await rt.request('GET', '/api/mangas')).body.map((m) => m.title)).toEqual(['Vom Server']);
  });

  it('with several profiles (a restored server backup) the device screen switches between them', async () => {
    noNetwork();
    enterLocalMode({ id: null, name: 'Felix' });
    const rt = await getLocalRuntime();
    rt.getContext().db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('Kim', 'x', 'editor')").run();
    rt.exportDatabase();
    await rt.flush();
    window.history.replaceState(null, '', '/server');
    render(<App />);
    const select = await screen.findByLabelText('Profil wechseln');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Felix', 'Kim']);
    fireEvent.change(select, { target: { value: '2' } });
    expect(await screen.findByText('Dashboard von Kim (lokal)')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(PROFILE_KEY))).toEqual({ id: 2, name: 'Kim' });
  });

  it('the local profile gets no outbox sync: queued server changes never replay into the device core', async () => {
    noNetwork();
    enterLocalMode({ id: null, name: 'Felix' });
    render(<App />);
    await screen.findByText('Dashboard von Felix (lokal)');
    await new Promise((r) => setTimeout(r, 20));
    expect(outboxSpy.starts).toEqual([]);
  });

  it('a restore started outside the device screen (dashboard header) reloads the collection and its profile', async () => {
    noNetwork();
    enterLocalMode({ id: null, name: 'Felix' });
    render(<App />);
    await screen.findByText('Dashboard von Felix (lokal)');
    const source = await createLocalRuntime({ SQL, store: memoryStore(), http: offline, profile: { name: 'Kim' }, persistDelayMs: 0 });
    await source.request('POST', '/api/mangas', { title: 'Aus der Sicherung' });
    clearOfflineData.mockClear();
    const rt = await getLocalRuntime();
    await rt.replaceDatabase(source.exportDatabase());
    expect(await screen.findByText('Dashboard von Kim (lokal)')).toBeTruthy();
    expect(clearOfflineData).toHaveBeenCalledTimes(1);
  });

  it('a device database that cannot be saved shows a lasting notice until a save works again', async () => {
    noNetwork();
    let failing = false;
    const flaky = flakyStore((s) => failing && s === 'db');
    setLocalAdapters({ boot: ({ profile }) => createLocalRuntime({ SQL, store: flaky, http: offline, profile: profile || {}, persistDelayMs: 0 }) });
    enterLocalMode({ id: null, name: 'Felix' });
    render(<App />);
    await screen.findByText('Dashboard von Felix (lokal)');
    const rt = await getLocalRuntime();
    failing = true;
    await rt.request('POST', '/api/mangas', { title: 'Wackelt' });
    expect(await screen.findByText('Daten konnten nicht gespeichert werden')).toBeTruthy();
    failing = false;
    await rt.flush();
    await waitFor(() => expect(screen.queryByText('Daten konnten nicht gespeichert werden')).toBeNull());
  });

  it('a second window of the same device database says so and offers a reload', async () => {
    noNetwork();
    const locks = fakeLocks();
    const shared = { ...memoryStore(), lockName: 'app-test' };
    let release;
    locks.request('app-test:manga.db', {}, () => new Promise((r) => { release = r; }));
    setLocalAdapters({ boot: ({ profile }) => createLocalRuntime({ SQL, store: shared, http: offline, profile: profile || {}, persistDelayMs: 0, locks, channel: () => null }) });
    enterLocalMode({ id: null, name: 'Felix' });
    render(<App />);
    await screen.findByText('Dashboard von Felix (lokal)');
    expect(await screen.findByText('Sammlung ist in einem anderen Fenster geöffnet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neu laden' })).toBeTruthy();
    const rt = await getLocalRuntime();
    expect((await rt.request('POST', '/api/mangas', { title: 'x' })).status).toBe(423);
    release();
    await waitFor(() => expect(screen.queryByText('Sammlung ist in einem anderen Fenster geöffnet')).toBeNull());
    expect((await rt.request('POST', '/api/mangas', { title: 'x' })).status).toBe(200);
  });

  it('in the desktop app "Ohne Server nutzen" switches to its local server instead of the device core', () => {
    const setMode = vi.fn();
    window.mangashelfDesktop = { setMode };
    try {
      enterLocalMode({ id: 1, name: 'Felix' });
      render(<MemoryRouter><LocalOffer user={null} onUseLocal={() => {}} onPull={() => {}} /></MemoryRouter>);
      expect(screen.queryByRole('button', { name: /Lokale Sammlung öffnen/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Ohne Server nutzen' }));
      expect(setMode).toHaveBeenCalledWith('local');
    } finally {
      delete window.mangashelfDesktop;
    }
  });
});
