// Standalone core on the device: persistence, restore, windows, locks and imports.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import { createLocalRuntime, DB_KEY, SAVE_SEQ_KEY, STAGED_PREFIX, BUSY_TEXT, PENDING_PROFILE_ID, ensureProfileRow, trackWrites } from '../local/runtime.js';
import coreRoutes from '../../../core/routes.js';
import { memoryStore, LOCAL_STORE_EVENT } from '../local/store.js';
import { fillFromSnapshot, pullFromServer, pulledUploadName } from '../app/takeover.js';
import { sanitizeImportedDatabase } from '../local/sanitize.js';
import { flakyStore, fakeLocks, fakeChannels } from './localFakes.js';
import { createRequire } from 'module';
import { zipSync } from 'fflate';

// the instance core/routes.js uses (Vitest loads an ESM import of core/lib a second time)
const publishers = createRequire(import.meta.url)('../../../core/lib/publishers.js');
import { createBrowserHttp, corsText, ERROR_BODY_BYTES } from '../local/http.js';
import { buildBackupZip, readBackupZip, restorableUploadName } from '../local/backupZip.js';
import { useLocalRuntime, resetLocalRuntime, localUploadUrl, windowLocks } from '../local/localTransport.js';
import { enterLocalMode, leaveLocalMode } from '../local/profile.js';
import api, { apiFetch, assetUrl, assetImgProps, downloadFile, isLocalMode, ApiError } from '../utils/api';
import { getConnection } from '../app/connection';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const offline = { fetch: async () => { throw new TypeError('offline'); }, fetchText: async () => { throw new Error('offline'); }, fetchImage: async () => { throw new Error('offline'); } };

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const newRuntime = (options = {}) => createLocalRuntime({ SQL, store: memoryStore(), http: offline, profile: { name: 'Felix' }, persistDelayMs: 0, ...options });

describe('local runtime (standalone core on the device)', () => {
  it('answers like the server: the profile is an admin without login, server-only areas say they need a server', async () => {
    const rt = await newRuntime();
    expect((await rt.request('GET', '/api/auth/me')).body.user).toEqual({ id: 1, username: 'Felix', role: 'admin', local: true });
    expect((await rt.request('GET', '/api/setup/status')).body).toEqual({ needsSetup: false });
    const created = await rt.request('POST', '/api/mangas', { title: 'Lokal' });
    expect(created.status).toBe(200);
    expect((await rt.request('POST', '/api/volumes', { manga_id: created.body.id, volume_number: '1' })).status).toBe(200);
    const dup = await rt.request('POST', '/api/volumes', { manga_id: created.body.id, volume_number: 'Band 1' });
    expect([dup.status, dup.body.code]).toEqual([409, 'VOLUME_DUPLICATE']);
    expect((await rt.request('GET', '/api/users/1/stats')).status).toBe(200);
    expect((await rt.request('GET', '/api/backups')).body).toEqual({ error: 'Im Modus ohne Server nicht verfügbar', code: 'NOT_AVAILABLE_LOCALLY' });
    expect((await rt.request('GET', '/api/gibt-es-nicht')).status).toBe(404);
    expect((await rt.request('GET', '/api/users')).body.map((u) => [u.username, u.role])).toEqual([['Felix', 'admin']]);
  });

  it('persists the database to the store (new profile at once, then after a change) and opens it again', async () => {
    const store = memoryStore();
    const rt = await newRuntime({ store });
    expect(store.data.db.get(DB_KEY)).toBeInstanceOf(Uint8Array);
    store.data.db.delete(DB_KEY);
    await rt.request('POST', '/api/mangas', { title: 'Bleibt' });
    await rt.flush();
    expect(store.data.db.get(DB_KEY)).toBeInstanceOf(Uint8Array);
    await rt.close();
    const again = await createLocalRuntime({ SQL, store, http: offline, profile: { id: 1 } });
    expect((await again.request('GET', '/api/mangas')).body.map((m) => m.title)).toEqual(['Bleibt']);
    expect(again.getProfile().username).toBe('Felix');
  });

  it('refuses database bytes that are no Manga-Shelf database and keeps the collection', async () => {
    const rt = await newRuntime();
    await rt.request('POST', '/api/mangas', { title: 'Sicher' });
    const other = new SQL.Database();
    other.exec('CREATE TABLE fremd (x)');
    await expect(rt.replaceDatabase(other.export())).rejects.toThrow('Keine Manga-Shelf-Datenbank');
    await expect(rt.replaceDatabase(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect((await rt.request('GET', '/api/mangas')).body.map((m) => m.title)).toEqual(['Sicher']);
  });

  it('API keys live outside manga.db, flagged as not secure in the browser build', async () => {
    const store = memoryStore();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { Viewer: { id: 7, name: 'felix_al' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const rt = await newRuntime({ store, http: createBrowserHttp({ fetchImpl }) });
    const token = `${'a'.repeat(40)}.${'b'.repeat(40)}.${'c'.repeat(40)}`;
    const saved = await rt.request('PUT', '/api/auth/api-keys/anilist', { secret: token });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ provider: 'anilist', configured: true, label: 'felix_al', last4: 'cccc', insecure_storage: true });
    expect(JSON.stringify(saved.body)).not.toContain(token);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
    expect(rt.getContext().db.prepare('SELECT count(*) AS n FROM user_api_credentials').get().n).toBe(0);
    expect(store.data.secrets.get('1:anilist').secret).toBe(token);
    expect(rt.getContext().credentials.get(1, 'anilist')).toEqual({ secret: token, allowBackground: false });
    const bad = await rt.request('PUT', '/api/auth/api-keys/anilist', { secret: 'kurz' });
    expect(bad.status).toBe(400);
    expect((await rt.request('DELETE', '/api/auth/api-keys/anilist')).body).toEqual({ success: true, removed: true });
    expect(store.data.secrets.size).toBe(0);
  });

  it('replacing the AniList key makes the list sync resolve the account again; removing it switches the sync off', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { Viewer: { id: 7, name: 'felix_al' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const rt = await newRuntime({ http: createBrowserHttp({ fetchImpl }) });
    const token = (c) => `${c.repeat(40)}.${'b'.repeat(40)}.${'c'.repeat(40)}`;
    expect((await rt.request('PUT', '/api/auth/api-keys/anilist', { secret: token('a') })).status).toBe(200);
    const on = await rt.request('PUT', '/api/anime/sync', { anilist: { enabled: true } });
    expect(on.body.anilist).toMatchObject({ enabled: true, external_user_id: '7' });
    expect((await rt.request('PUT', '/api/auth/api-keys/anilist', { secret: token('d') })).status).toBe(200);
    expect((await rt.request('GET', '/api/anime/sync')).body.anilist).toMatchObject({ enabled: true, external_user_id: null });
    expect((await rt.request('DELETE', '/api/auth/api-keys/anilist')).body.removed).toBe(true);
    expect((await rt.request('GET', '/api/anime/sync')).body.anilist).toMatchObject({ enabled: false, external_user_id: null, last_error: null });
  });

  it('a source blocked by CORS fails with a German text and is reported once per host', async () => {
    const onBlocked = vi.fn();
    const http = createBrowserHttp({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, onBlocked, isOnline: () => true });
    await expect(http.fetch('https://www.manga-passion.de/api/x')).rejects.toMatchObject({ code: 'CORS_BLOCKED', message: corsText('www.manga-passion.de') });
    await expect(http.fetchText('https://www.manga-passion.de/api/y')).rejects.toMatchObject({ code: 'CORS_BLOCKED' });
    expect(onBlocked).toHaveBeenCalledTimes(1);
    const offlineHttp = createBrowserHttp({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, onBlocked, isOnline: () => false });
    await expect(offlineHttp.fetch('https://x.example')).rejects.toBeInstanceOf(TypeError);
    await expect(http.fetchImage('http://bilder.example/a.png')).rejects.toThrow('Nur https-Adressen');
  });

  it('a quiet text fetch (the page of a shared link) fails without the CORS notice; a later normal call still reports', async () => {
    const onBlocked = vi.fn();
    const http = createBrowserHttp({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, onBlocked, isOnline: () => true });
    await expect(http.fetchText('https://www.crunchyroll.com/watch/GG1U2Q5MW', 6000, { quiet: true })).rejects.toMatchObject({ code: 'CORS_BLOCKED' });
    expect(onBlocked).not.toHaveBeenCalled();
    await expect(http.fetchText('https://www.crunchyroll.com/watch/GG1U2Q5MW')).rejects.toMatchObject({ code: 'CORS_BLOCKED' });
    expect(onBlocked).toHaveBeenCalledWith('www.crunchyroll.com');
  });

  it('resolve-link runs in-process; in the browser build the blocked page read stays silent and only leaves the episode open', async () => {
    const onBlocked = vi.fn();
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const rt = await newRuntime({ http: createBrowserHttp({ fetchImpl, onBlocked, isOnline: () => true }) });
    const res = await rt.request('POST', '/api/anime/resolve-link', { url: 'https://www.crunchyroll.com/de/watch/GG1U2Q5MW/the-hero-party' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ service: 'crunchyroll', kind: 'episode', episode: null, page_checked: false, anime_id: null });
    expect(onBlocked).not.toHaveBeenCalled();
    const refused = await rt.request('POST', '/api/anime/resolve-link', { url: 'https://example.com/watch/1' });
    expect([refused.status, refused.body.code]).toEqual([400, 'UNSUPPORTED_LINK']);
  });

  it('fetchText rejects an error answer with "HTTP <status>", the status and its first 4 KB as err.body', async () => {
    const reason = JSON.stringify({ error: { errors: [{ reason: 'dailyLimitExceeded' }] } });
    const answers = {
      quota: () => new Response(reason, { status: 403 }),
      big: () => new Response('q'.repeat(20000), { status: 429 }),
      plain: () => ({ ok: false, status: 400, body: null, text: async () => 'x'.repeat(5000) })
    };
    const http = createBrowserHttp({ fetchImpl: async (url) => answers[url.split('/').pop()]() });
    const errorOf = (name) => http.fetchText(`https://www.googleapis.com/${name}`).then(() => { throw new Error('resolved'); }, (err) => err);
    expect(await errorOf('quota')).toMatchObject({ message: 'HTTP 403', status: 403, body: reason });
    const big = await errorOf('big');
    expect([big.message, big.body.length]).toEqual(['HTTP 429', ERROR_BODY_BYTES]);
    expect((await errorOf('plain')).body).toBe('x'.repeat(ERROR_BODY_BYTES));
    const image = createBrowserHttp({ fetchImpl: async () => new Response('nope', { status: 404 }) });
    await expect(image.fetchImage('https://bilder.example/a.png')).rejects.toMatchObject({ message: 'HTTP 404', status: 404 });
  });

  it('the backup ZIP has the server layout and restores into another device', async () => {
    const rt = await newRuntime();
    const form = new FormData();
    form.append('image', new Blob([PNG], { type: 'image/png' }), 'cover.png');
    const upload = await rt.request('POST', '/api/upload', form);
    expect(upload.body.url).toMatch(/^\/uploads\/[\w-]+\.png$/);
    await rt.request('POST', '/api/mangas', { title: 'Gesichert', cover_image: upload.body.url });
    const zip = readBackupZip(await buildBackupZip(rt, { appVersion: '9.9.9' }));
    expect(zip.manifest).toMatchObject({ format: 1, app: 'manga-shelf', app_version: '9.9.9', counts: { mangas: 1, volumes: 0, users: 1 }, uploads: { count: 1 } });
    expect(zip.manifest.db.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([...zip.uploads.keys()]).toEqual([upload.body.url.slice('/uploads/'.length)]);

    const other = await createLocalRuntime({ SQL, store: memoryStore(), http: offline, profile: { name: 'Lea' } });
    // no "Lea" in the backup: the device takes over its admin, whose ownership and reads are in it
    const profile = await other.replaceDatabase(zip.dbBytes, { uploads: zip.uploads, profileName: 'Lea' });
    expect(profile.username).toBe('Felix');
    expect((await other.request('GET', '/api/mangas')).body.map((m) => m.title)).toEqual(['Gesichert']);
    expect(other.listProfiles().map((p) => p.username)).toEqual(['Felix']);
    expect(await other.files.read(upload.body.url.slice('/uploads/'.length))).toEqual(PNG);
    expect(() => readBackupZip(new Uint8Array([1, 2, 3]))).toThrow('Ungültiges ZIP-Archiv');
  });
});

describe('utils/api.js in the local mode', () => {
  let rt;
  beforeEach(async () => {
    localStorage.clear();
    vi.stubEnv('VITE_APP_MODE', 'app');
    rt = await newRuntime();
    useLocalRuntime(rt);
    enterLocalMode({ id: rt.getProfile().id, name: 'Felix' });
  });
  afterEach(async () => {
    leaveLocalMode();
    useLocalRuntime(null);
    await resetLocalRuntime();
    vi.unstubAllEnvs();
  });

  it('requests below /api go to the device, never to the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(isLocalMode()).toBe(true);
    const created = await api.post('/api/mangas', { title: 'Ohne Server', total_volumes: 3 });
    expect((await api.get('/api/mangas')).map((m) => m.id)).toEqual([created.id]);
    const res = await apiFetch('/api/auth/me');
    expect([res.status, (await res.json()).user.username]).toEqual([200, 'Felix']);
    await expect(api.get('/api/backups')).rejects.toMatchObject({ status: 404, code: 'NOT_AVAILABLE_LOCALLY', message: 'Im Modus ohne Server nicht verfügbar' });
    await expect(api.post('/api/mangas', { title: ' ' })).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getConnection()).toMatchObject({ state: 'online', server: { name: 'Auf diesem Gerät · Felix', local: true } });
  });

  it('an abort of the caller still ends the request with an AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(api.get('/api/mangas', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uploads land in the device storage and show through blob URLs', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:cover-1');
    URL.revokeObjectURL = vi.fn();
    const form = new FormData();
    form.append('image', new Blob([PNG], { type: 'image/png' }), 'x.png');
    const { url } = await api.upload('/api/upload', form);
    expect(assetUrl(url)).toBe('blob:cover-1');
    expect(localUploadUrl(url)).toBe('blob:cover-1');
    expect(assetImgProps(url)).toEqual({ src: 'blob:cover-1' });
    expect(assetUrl('/uploads/fehlt.png')).toBe('/uploads/fehlt.png');
    const bad = new FormData();
    bad.append('image', new Blob(['kein bild']), 'x.png');
    await expect(api.upload('/api/upload', bad)).rejects.toMatchObject({ status: 400, code: 'INVALID_FILE_TYPE' });
  });

  it('downloads (CSV export) are saved from the device', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:csv');
    URL.revokeObjectURL = vi.fn();
    await api.post('/api/mangas', { title: 'Exportiert' });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const saved = await downloadFile('/api/export/csv', { filename: 'sammlung.csv' });
    expect(saved.filename).toMatch(/\.csv$/);
    expect(saved.bytes).toBeGreaterThan(20);
    expect(click).toHaveBeenCalled();
  });
});

const titles = async (rt) => (await rt.request('GET', '/api/mangas')).body.map((m) => m.title).sort();

describe('device persistence never acknowledges what it cannot keep', () => {
  it('a failing store is remembered: flush rejects, writes answer 507, the status reports it, and a later save clears it', async () => {
    let failing = false;
    const store = flakyStore((s) => failing && s === 'db');
    const events = [];
    const rt = await newRuntime({ store });
    rt.subscribe((e) => events.push(e));
    failing = true;
    expect((await rt.request('POST', '/api/mangas', { title: 'Wackelt' })).status).toBe(200);
    await expect(rt.flush()).rejects.toThrow('Daten konnten nicht gespeichert werden');
    expect(rt.status()).toMatchObject({ saveError: 'Speicher voll', follower: false, conflict: false });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: { saveError: 'Speicher voll' } });
    const refused = await rt.request('POST', '/api/mangas', { title: 'Abgelehnt' });
    expect([refused.status, refused.body.code, refused.body.error]).toEqual([507, 'LOCAL_SAVE_FAILED', 'Daten konnten nicht gespeichert werden']);
    expect((await rt.request('GET', '/api/mangas')).status).toBe(200);

    failing = false;
    await rt.flush();
    expect(rt.status().saveError).toBeNull();
    expect(events.at(-1).status.saveError).toBeNull();
    expect((await rt.request('POST', '/api/mangas', { title: 'Wieder da' })).status).toBe(200);
    await rt.close();
    const again = await createLocalRuntime({ SQL, store, http: offline, profile: { id: 1 } });
    expect(await titles(again)).toEqual(['Wackelt', 'Wieder da']);
  });

  it('a failed save is retried with backoff on its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let failing = true;
      const store = flakyStore((s, key) => failing && key === DB_KEY);
      const rt = await createLocalRuntime({ SQL, store: memoryStore(), http: offline, profile: { name: 'Felix' }, persistDelayMs: 0 });
      await rt.close();
      const live = await createLocalRuntime({ SQL, store, http: offline, profile: { name: 'Felix' }, persistDelayMs: 0 });
      expect(live.status().saveError).toBe('Speicher voll');
      failing = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(live.status().saveError).toBeNull();
      expect(store.data.db.get(DB_KEY)).toBeInstanceOf(Uint8Array);
    } finally {
      vi.useRealTimers();
    }
  });

  it('every write to the database is saved, also one made during a GET (write hook instead of the HTTP method)', async () => {
    const store = memoryStore();
    const rt = await newRuntime({ store, persistDelayMs: 5 });
    await rt.request('POST', '/api/mangas', { title: 'Vorher' });
    await rt.flush();
    const puts = vi.spyOn(store, 'put');
    await rt.request('GET', '/api/mangas');
    await new Promise((r) => setTimeout(r, 20));
    expect(puts).not.toHaveBeenCalled();
    rt.getContext().db.prepare("UPDATE mangas SET title = 'Im Hintergrund'").run();
    await vi.waitFor(() => expect(puts).toHaveBeenCalledWith('db', DB_KEY, expect.any(Uint8Array)));
    const again = await createLocalRuntime({ SQL, store, http: offline, profile: { id: 1 } });
    expect(await titles(again)).toEqual(['Im Hintergrund']);
  });

  it('pagehide and a hidden page save at once instead of after the delay', async () => {
    const store = memoryStore();
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const rt = await newRuntime({ store, persistDelayMs: 60000, win, doc });
    const saved = () => createLocalRuntime({ SQL, store, http: offline, profile: { id: 1 }, win: null, doc: null }).then(titles);
    await rt.request('POST', '/api/mangas', { title: 'Vor dem Wechsel' });
    expect(await saved()).toEqual([]);
    win.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(async () => expect(await saved()).toEqual(['Vor dem Wechsel']));
    await rt.request('POST', '/api/mangas', { title: 'Im Hintergrund' });
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(async () => expect(await saved()).toEqual(['Im Hintergrund', 'Vor dem Wechsel']));
  });

  it('the status reaches the window as an event', async () => {
    const win = new EventTarget();
    const seen = [];
    win.addEventListener(LOCAL_STORE_EVENT, (e) => seen.push(e.detail));
    let failing = false;
    const rt = await newRuntime({ store: flakyStore(() => failing), win });
    failing = true;
    await rt.request('POST', '/api/mangas', { title: 'x' });
    await expect(rt.flush()).rejects.toThrow();
    expect(seen.at(-1)).toMatchObject({ type: 'status', status: { saveError: 'Speicher voll', follower: false, conflict: false } });
  });
});

describe('replacing the collection on the device is failure-safe', () => {
  const zipOf = async (build) => {
    const source = await newRuntime();
    await build(source);
    return readBackupZip(await buildBackupZip(source));
  };
  const upload = async (rt, bytes = PNG) => {
    const form = new FormData();
    form.append('image', new Blob([bytes], { type: 'image/png' }), 'cover.png');
    return (await rt.request('POST', '/api/upload', form)).body.url.slice('/uploads/'.length);
  };

  it('a file that cannot be written leaves the old collection with all its uploads; the new files are removed again', async () => {
    let writes = 0;
    let limit = Infinity;
    const store = flakyStore((s) => s === 'files' && ++writes > limit);
    const rt = await newRuntime({ store });
    const old = await upload(rt);
    await rt.request('POST', '/api/mangas', { title: 'Alt', cover_image: `/uploads/${old}` });
    const zip = await zipOf(async (src) => {
      const a = await upload(src);
      const b = await upload(src);
      await src.request('POST', '/api/mangas', { title: 'Neu', cover_image: `/uploads/${a}`, banner_image: `/uploads/${b}` });
    });
    writes = 0;
    limit = 1;
    await expect(rt.replaceDatabase(zip.dbBytes, { uploads: zip.uploads })).rejects.toThrow('Speicher voll');
    expect(await titles(rt)).toEqual(['Alt']);
    expect(await rt.files.list()).toEqual([old]);
    expect(await rt.files.read(old)).toEqual(PNG);
    await rt.flush();
    const again = await createLocalRuntime({ SQL, store, http: offline, profile: { id: 1 } });
    expect(await titles(again)).toEqual(['Alt']);
  });

  it('a database that cannot be saved leaves everything as it was', async () => {
    let failDb = false;
    const store = flakyStore((s) => failDb && s === 'db');
    const rt = await newRuntime({ store });
    const old = await upload(rt);
    await rt.request('POST', '/api/mangas', { title: 'Alt', cover_image: `/uploads/${old}` });
    await rt.flush();
    const zip = await zipOf(async (src) => { await src.request('POST', '/api/mangas', { title: 'Neu', cover_image: `/uploads/${await upload(src)}` }); });
    failDb = true;
    await expect(rt.replaceDatabase(zip.dbBytes, { uploads: zip.uploads })).rejects.toThrow('Speicher voll');
    expect(await titles(rt)).toEqual(['Alt']);
    expect(await rt.files.list()).toEqual([old]);
  });

  it('a name already in use is staged first; after the swap only the new set of uploads is left', async () => {
    const store = memoryStore();
    const rt = await newRuntime({ store });
    const kept = await upload(rt);
    const dropped = await upload(rt);
    await rt.request('POST', '/api/mangas', { title: 'Alt', cover_image: `/uploads/${dropped}` });
    const changed = Uint8Array.from([...PNG, 0]);
    const zip = await zipOf(async (src) => { await src.request('POST', '/api/mangas', { title: 'Neu', cover_image: `/uploads/${kept}` }); });
    zip.uploads.set(kept, changed);
    const puts = vi.spyOn(store, 'put');
    await rt.replaceDatabase(zip.dbBytes, { uploads: zip.uploads });
    const order = puts.mock.calls.map(([s, key]) => `${s}:${key}`);
    expect(order.indexOf(`files:${STAGED_PREFIX}${kept}`)).toBeLessThan(order.indexOf(`db:${DB_KEY}`));
    expect(order.indexOf(`db:${DB_KEY}`)).toBeLessThan(order.lastIndexOf(`files:${kept}`));
    expect(await titles(rt)).toEqual(['Neu']);
    expect(await rt.files.list()).toEqual([kept]);
    expect(await rt.files.read(kept)).toEqual(changed);
  });

  it('publisher aliases follow the live database only, never a copy or a failed replace', async () => {
    const rt = await newRuntime();
    expect((await rt.request('POST', '/api/publishers/merge', { from: ['Kazé'], to: 'Crunchyroll' })).status).toBe(200);
    expect(publishers.normalizePublisher('Kazé')).toBe('Crunchyroll');
    const empty = rt.databaseCopy(() => {}, { from: 'empty' });
    expect(publishers.normalizePublisher('Kazé')).toBe('Crunchyroll');
    await expect(rt.replaceDatabase(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect(publishers.normalizePublisher('Kazé')).toBe('Crunchyroll');
    const again = await createLocalRuntime({ SQL, store: memoryStore(), http: offline, profile: { name: 'X' } });
    expect(publishers.normalizePublisher('Kazé')).toBe('Kazé');
    await again.close();
    await rt.replaceDatabase(rt.databaseCopy(() => {}));
    expect(publishers.normalizePublisher('Kazé')).toBe('Crunchyroll');
    await rt.replaceDatabase(empty);
    expect(publishers.normalizePublisher('Kazé')).toBe('Kazé');
  });
});

describe('two windows on one device database', () => {
  it('the first window holds the database; the second only reads, follows its saves and takes over when it closes', async () => {
    const store = { ...memoryStore(), lockName: 'test-local' };
    const locks = fakeLocks();
    const channel = fakeChannels();
    const make = (name) => createLocalRuntime({ SQL, store, http: offline, profile: { name }, persistDelayMs: 0, locks, channel, win: null, doc: null });
    const first = await make('Felix');
    await first.request('POST', '/api/mangas', { title: 'Eins' });
    await first.flush();
    const second = await make('Felix');
    expect(second.status()).toMatchObject({ saveError: null, follower: true, conflict: false });
    const refused = await second.request('POST', '/api/mangas', { title: 'Zwei' });
    expect([refused.status, refused.body.code, refused.body.error]).toEqual([423, 'LOCAL_LOCKED', 'Sammlung ist in einem anderen Fenster geöffnet']);
    expect(await titles(second)).toEqual(['Eins']);

    const reloaded = new Promise((resolve) => second.subscribe((e) => { if (e.type === 'reloaded') resolve(); }));
    await first.request('POST', '/api/mangas', { title: 'Drei' });
    await first.flush();
    await reloaded;
    expect(await titles(second)).toEqual(['Drei', 'Eins']);

    const promoted = new Promise((resolve) => second.subscribe((e) => { if (e.type === 'status' && !e.status.follower) resolve(); }));
    await first.close();
    await promoted;
    expect((await second.request('POST', '/api/mangas', { title: 'Vier' })).status).toBe(200);
    await second.flush();
    expect(await titles(second)).toEqual(['Drei', 'Eins', 'Vier']);
    await second.close();
  });

  it('a database that does not open gives the lock back', async () => {
    const store = { ...memoryStore(), lockName: 'test-broken' };
    const locks = fakeLocks();
    store.data.db.set(DB_KEY, new Uint8Array([1, 2, 3]));
    const make = () => createLocalRuntime({ SQL, store, http: offline, profile: { name: 'Felix' }, persistDelayMs: 0, locks, channel: () => null, win: null, doc: null });
    await expect(make()).rejects.toThrow();
    store.data.db.delete(DB_KEY);
    const rt = await make();
    expect(rt.status().follower).toBe(false);
    await rt.close();
  });

  it('without navigator.locks the save counter refuses to overwrite a newer save of another window', async () => {
    const store = memoryStore();
    const first = await newRuntime({ store, locks: null });
    const second = await createLocalRuntime({ SQL, store, http: offline, profile: { id: 1 }, persistDelayMs: 0, locks: null });
    await first.request('POST', '/api/mangas', { title: 'Zuerst' });
    await first.flush();
    await second.request('POST', '/api/mangas', { title: 'Veraltet' });
    await expect(second.flush()).rejects.toThrow('in einem anderen Fenster geändert');
    expect(second.status().conflict).toBe(true);
    expect((await second.request('POST', '/api/mangas', { title: 'x' })).status).toBe(409);
    const again = await createLocalRuntime({ SQL, store, http: offline, profile: { id: 1 } });
    expect(await titles(again)).toEqual(['Zuerst']);
    expect(new TextDecoder().decode(store.data.db.get(SAVE_SEQ_KEY))).toMatch(/^\d+$/);
  });
});

describe('housekeeping of the device', () => {
  it('purges trash entries older than 30 days at the start and daily, then drops uploads nothing references', async () => {
    let now = new Date('2026-01-01T12:00:00Z');
    const store = memoryStore();
    const rt = await newRuntime({ store, now: () => now });
    const form = (bytes) => { const f = new FormData(); f.append('image', new Blob([bytes], { type: 'image/png' }), 'c.png'); return f; };
    const gone = (await rt.request('POST', '/api/upload', form(PNG))).body.url;
    const live = (await rt.request('POST', '/api/upload', form(Uint8Array.from([...PNG, 1])))).body.url;
    await rt.request('POST', '/api/upload', form(Uint8Array.from([...PNG, 2])));
    const doomed = (await rt.request('POST', '/api/mangas', { title: 'Weg', cover_image: gone })).body.id;
    await rt.request('POST', '/api/mangas', { title: 'Bleibt', cover_image: live });
    await rt.request('DELETE', `/api/mangas/${doomed}`);
    await rt.close();
    const name = (url) => url.slice('/uploads/'.length);

    now = new Date('2026-01-20T12:00:00Z');
    const early = await createLocalRuntime({ SQL, store, http: offline, profile: { id: 1 }, now: () => now });
    await early.housekeeping();
    expect((await early.request('GET', '/api/trash')).body.items).toHaveLength(1);
    expect((await early.files.list()).sort()).toEqual([name(gone), name(live)].sort());
    await early.close();

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const daily = await createLocalRuntime({ SQL, store, http: offline, profile: { id: 1 }, now: () => now });
      await daily.housekeeping();
      now = new Date('2026-02-02T12:00:00Z');
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      await vi.waitFor(async () => expect(await daily.files.list()).toEqual([name(live)]));
      expect((await daily.request('GET', '/api/trash')).body.items).toHaveLength(0);
      await daily.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a shell can bring its own files adapter (no preload of every upload)', async () => {
    const written = new Map();
    const files = {
      write: async (name, bytes) => { written.set(name, bytes); },
      read: async (name) => written.get(name),
      stat: async (name) => (written.has(name) ? { size: written.get(name).length } : null),
      touch: async () => {},
      remove: async (name) => { written.delete(name); },
      list: async () => [...written.keys()],
      urlFor: (name) => `capacitor://localhost/_capacitor_file_/uploads/${name}`
    };
    const rt = await newRuntime({ files });
    const f = new FormData();
    f.append('image', new Blob([PNG], { type: 'image/png' }), 'c.png');
    const { url } = (await rt.request('POST', '/api/upload', f)).body;
    expect(rt.files.urlFor(url.slice('/uploads/'.length))).toBe(`capacitor://localhost/_capacitor_file_/uploads/${url.slice('/uploads/'.length)}`);
    expect(written.size).toBe(1);
  });
});

describe('"Vom Server holen" through the offline snapshot', () => {
  const snapshot = {
    user: { id: 2, username: 'lea', role: 'editor' },
    details: {
      7: {
        id: 7, title: 'Geholt', owned_volumes: 2, wished: 0, total_value: 14, full_value: 21, cover_image: '/uploads/ok.png',
        banner_image: '/uploads/..%2Fmanga.db', reader_stats: [], updated_by: 1,
        volumes: [
          {
            id: 70, manga_id: 7, volume_number: '1', status: 'Vorhanden', price: 7, cover_image: '/uploads/text.png', images: ['/uploads/text.png'],
            owners: [{ user_id: 2, username: 'lea', price: 6.5, purchase_date: '2025-03-01', condition: 'gut', created_at: '2025-03-02 10:00:00' }],
            read_by: [2], read_users: [{ id: 2, user_id: 2, username: 'lea', read_at: '2025-04-01 20:00:00' }]
          },
          {
            id: 71, manga_id: 7, volume_number: '2', status: 'Vorhanden', price: 7, images: [],
            owners: [{ user_id: 1, username: 'admin', price: 7, purchase_date: null }], read_by: [2], read_users: [{ id: 2, user_id: 2, username: 'lea' }]
          },
          { id: 72, manga_id: 7, volume_number: '3', status: 'Fehlt', price: 7, images: ['/uploads/a.png', '/uploads/b.png'], cover_image: '/uploads/a.png', owners: [], read_by: [] }
        ]
      }
    }
  };

  it('keeps read dates (NULL when unknown, never the time of the pull), owner details and derives the counters itself', async () => {
    const rt = await newRuntime();
    const bytes = rt.databaseCopy((conn) => fillFromSnapshot(conn, snapshot), { from: 'empty' });
    const copy = new SQL.Database(bytes);
    const rows = (sql) => { const r = copy.exec(sql)[0]; return r ? r.values : []; };
    expect(rows('SELECT owned_volumes FROM mangas')).toEqual([[1]]);
    expect(rows('SELECT id, status FROM volumes ORDER BY id')).toEqual([[70, 'Vorhanden'], [71, 'Fehlt'], [72, 'Fehlt']]);
    expect(rows('SELECT volume_id, read_at FROM volume_reads ORDER BY volume_id')).toEqual([[70, '2025-04-01 20:00:00'], [71, null]]);
    expect(rows('SELECT volume_id, user_id, price, purchase_date, condition, created_at FROM volume_owners')).toEqual([[70, 2, 6.5, '2025-03-01', 'gut', '2025-03-02 10:00:00']]);
    expect(rows('SELECT id, images FROM volumes ORDER BY id')).toEqual([[70, null], [71, null], [72, '["/uploads/a.png","/uploads/b.png"]']]);
    expect(rows('SELECT updated_by FROM mangas')).toEqual([[null]]);
    copy.close();
  });

  it('one upload-name rule for pulled covers and backup ZIPs', async () => {
    const names = ['ok.png', 'A.JPEG', 'x.avif', '.hidden.png', 'a:b.png', 'a\\b.png', 'kein-bild.txt', 'x\n.png', '', 'manga.db'];
    for (const name of names) {
      expect(pulledUploadName(`/uploads/${encodeURIComponent(name)}`), name).toBe(restorableUploadName(name));
    }
    expect(restorableUploadName('ok.png')).toBe('ok.png');
    expect(restorableUploadName('a/b.png')).toBeNull();
    expect(restorableUploadName(null)).toBeNull();
    const zip = zipSync({ 'manga.db': new Uint8Array([1]), 'uploads/ok.png': new Uint8Array([2]), 'uploads/.x.png': new Uint8Array([3]), 'uploads/a:b.png': new Uint8Array([4]) });
    expect([...readBackupZip(zip).uploads.keys()]).toEqual(['ok.png']);
  });

  it('pulled cover names follow the restore rule and the bytes must be an image', async () => {
    expect(pulledUploadName('/uploads/ok.png')).toBe('ok.png');
    expect(pulledUploadName('/uploads/..%2Fmanga.db')).toBeNull();
    expect(pulledUploadName('/uploads/a%2Fb.png')).toBeNull();
    expect(pulledUploadName('/uploads/.hidden.png')).toBeNull();
    expect(pulledUploadName('/uploads/x%0A.png')).toBeNull();
    expect(pulledUploadName('/uploads/%E0%A4%A.png')).toBeNull();
    expect(pulledUploadName('/uploads/notiz.txt')).toBeNull();
    const requested = [];
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      requested.push(path);
      if (path === '/api/offline-snapshot') return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/uploads/ok.png' || path === '/uploads/a.png') return new Response(PNG, { status: 200 });
      return new Response('kein bild, nur text', { status: 200 });
    });
    const rt = await newRuntime();
    const result = await pullFromServer({ base: 'https://shelf.example', token: 't', user: snapshot.user, fetchImpl }, rt);
    expect(result).toMatchObject({ kind: 'snapshot', profile: { id: 2, username: 'lea' } });
    expect(requested.some((p) => p.includes('manga.db'))).toBe(false);
    expect((await rt.files.list()).sort()).toEqual(['a.png', 'ok.png']);
  });
});

describe('an imported server database keeps no server secrets on the device', () => {
  const HASHES = { admin: '$2b$10$adminAdminAdminAdminAdminAdminAdminAdminAdminAdminAd', anna: '$2b$10$annaAnnaAnnaAnnaAnnaAnnaAnnaAnnaAnnaAnnaAnnaAnnaAnnaA', ben: '$2a$10$benBenBenBenBenBenBenBenBenBenBenBenBenBenBenBenBenBe' };
  const SECRETS = [...Object.values(HASHES), 'sealed-anna-key', 'sealed-instance-key', 'sealed-feed-token', 'old-signing-secret'];
  async function serverZip() {
    const server = await newRuntime({ profile: { name: 'admin' } });
    const bytes = server.databaseCopy((conn) => {
      conn.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(HASHES.admin, 'admin');
      for (const name of ['anna', 'ben']) conn.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'editor')").run(name, HASHES[name]);
      const anna = conn.prepare("SELECT id FROM users WHERE username = 'anna'").get().id;
      conn.prepare("INSERT INTO user_api_credentials (user_id, provider, secret_enc, last4) VALUES (?, 'anilist', 'sealed-anna-key', 'abcd')").run(anna);
      conn.prepare("INSERT INTO user_api_credentials (user_id, provider, secret_enc, last4) VALUES (NULL, 'mal', 'sealed-instance-key', 'wxyz')").run();
      const settings = [['calendar_feed:5f2a', '{"user_id":2,"token":"sealed-feed-token"}'], ['revoked_sessions', '{"x":1}'], ['jwt_secret', 'old-signing-secret']];
      for (const [key, value] of settings) conn.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
      conn.prepare("INSERT INTO mangas (title) VALUES ('Berserk')").run();
    });
    await server.close();
    return zipSync({ 'manga.db': bytes, 'uploads/ok.png': PNG });
  }
  const has = (bytes, text) => new TextDecoder('latin1').decode(bytes).includes(text);
  const bcrypt = (bytes) => /\$2[aby]\$\d\d\$/.test(new TextDecoder('latin1').decode(bytes));
  function expectClean(bytes) {
    for (const secret of SECRETS) expect(has(bytes, secret), secret).toBe(false);
    expect(bcrypt(bytes)).toBe(false);
    const db = new SQL.Database(bytes);
    try {
      const all = (sql) => db.exec(sql)[0]?.values ?? [];
      expect(all('SELECT username, password_hash, role FROM users ORDER BY username')).toEqual([
        ['admin', '!local-profile', 'admin'], ['anna', '!local-profile', 'editor'], ['ben', '!local-profile', 'editor']
      ]);
      expect(all('SELECT count(*) FROM user_api_credentials')).toEqual([[0]]);
      expect(all("SELECT key FROM app_settings WHERE key LIKE 'calendar%' OR key IN ('revoked_sessions', 'jwt_secret')")).toEqual([]);
      expect(all('SELECT title FROM mangas')).toEqual([['Berserk']]);
    } finally {
      db.close();
    }
  }

  it(`"Vom Server holen": every hash, the pulling admin's too, becomes the marker, API keys, feed tokens, revoked sessions and the secret go, in the saved file and in a later export`, async () => {
    const zip = await serverZip();
    const store = memoryStore();
    const rt = await newRuntime({ store, win: null, doc: null });
    const fetchImpl = vi.fn(async (url) => (new URL(url).pathname === '/api/backup' ? new Response(zip, { status: 200 }) : new Response('{}', { status: 404 })));
    const result = await pullFromServer({ base: 'https://shelf.example', token: 't', user: { id: 1, username: 'Admin', role: 'admin' }, fetchImpl }, rt);
    expect(result).toMatchObject({ kind: 'backup', profile: { username: 'admin', role: 'admin' }, counts: { mangas: 1, users: 3 } });
    await rt.flush();
    expectClean(store.data.db.get(DB_KEY));
    expectClean(readBackupZip(await buildBackupZip(rt)).dbBytes);
    expect((await rt.request('GET', '/api/mangas')).body.map((m) => m.title)).toEqual(['Berserk']);
  });

  it('"Sicherung importieren" of a server ZIP, as the dialog calls it, is cleaned before the first save; `prepare` runs after that', async () => {
    const store = memoryStore();
    const rt = await newRuntime({ store, win: null, doc: null });
    const staged = readBackupZip(await serverZip());
    const seen = [];
    const profile = await rt.replaceDatabase(staged.dbBytes, {
      uploads: staged.uploads,
      profileName: rt.getProfile().username,
      prepare: (conn) => { seen.push(conn.prepare("SELECT count(*) AS n FROM users WHERE password_hash <> '!local-profile'").get().n); }
    });
    expect(seen).toEqual([0]);
    expect(profile).toMatchObject({ username: 'admin', role: 'admin' });
    const saved = store.data.db.get(DB_KEY);
    for (const secret of SECRETS) expect(has(saved, secret), secret).toBe(false);
    expect(bcrypt(saved)).toBe(false);
    expect(sanitizeImportedDatabase(rt.getContext().db)).toBe(0);
  });

  it('an imported database loses the AniList list sync state (it belongs to the server\'s keys)', async () => {
    const rt = await newRuntime();
    rt.databaseCopy((conn) => {
      conn.prepare('CREATE TABLE IF NOT EXISTS anime_sync (user_id INTEGER NOT NULL, service TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, service))').run();
      conn.prepare("INSERT INTO anime_sync (user_id, service, enabled) VALUES (1, 'anilist', 1)").run();
      expect(sanitizeImportedDatabase(conn)).toBe(1);
      expect(conn.prepare('SELECT count(*) AS n FROM anime_sync').get().n).toBe(0);
    });
  });

  it('leaves a database of the app itself as it is', async () => {
    const rt = await newRuntime();
    await rt.request('POST', '/api/mangas', { title: 'Lokal' });
    const bytes = rt.exportDatabase();
    let changed = null;
    rt.databaseCopy((conn) => { changed = sanitizeImportedDatabase(conn); });
    expect(changed).toBe(0);
    expect(rt.getContext().db.prepare('PRAGMA secure_delete').get()).toEqual({ secure_delete: 0 });
    await rt.replaceDatabase(bytes);
    expect((await rt.request('GET', '/api/mangas')).body.map((m) => m.title)).toEqual(['Lokal']);
  });
});

const reopen = (store) => createLocalRuntime({ SQL, store, http: offline, profile: { id: 1 }, locks: null, win: null, doc: null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// windowLocks of one more window (the module's own holder is the window of this test file)
const otherWindow = () => {
  const kept = new Map();
  return { keep: (name, lock) => kept.set(name, lock), take: (name) => { const lock = kept.get(name) ?? null; kept.delete(name); return lock; } };
};

describe('every write of the device reaches the store', () => {
  it('a batch "ungelesen" (DELETE … RETURNING through get) survives a restart', async () => {
    const store = memoryStore();
    const rt = await newRuntime({ store, win: null, doc: null });
    const manga = (await rt.request('POST', '/api/mangas', { title: 'Reihe' })).body.id;
    for (const n of ['1', '2']) await rt.request('POST', '/api/volumes', { manga_id: manga, volume_number: n, status: 'Vorhanden' });
    await rt.request('POST', '/api/volumes/batch-read', { manga_id: manga, up_to_volume: 2, read: true });
    await rt.flush();
    const unread = await rt.request('POST', '/api/volumes/batch-read', { manga_id: manga, up_to_volume: 2, read: false });
    expect(unread.body.changed_ids).toHaveLength(2);
    await rt.close();
    const again = await reopen(store);
    expect((await again.request('GET', `/api/mangas/${manga}`)).body.volumes.map((v) => v.read_by)).toEqual([[], []]);
  });

  it('the write hook sees write statements through get() and all(), plain reads stay quiet', () => {
    const calls = [];
    const raw = { prepare: () => ({ get: () => ({ n: 1 }), all: () => [], run: () => ({ changes: 0 }) }), exec: () => {} };
    const conn = trackWrites(raw, () => calls.push('write'));
    conn.prepare('SELECT 1').get();
    conn.prepare('SELECT * FROM mangas').all();
    expect(calls).toEqual([]);
    conn.prepare('DELETE FROM volume_reads WHERE volume_id = ? RETURNING read_at').get(1);
    conn.prepare('  insert into x VALUES (1)').all();
    conn.prepare('WITH t AS (SELECT 1) UPDATE mangas SET title = title').get();
    expect(calls).toHaveLength(3);
  });

  it('a write request marks the database dirty when the connection changed, even past the write hook', async () => {
    const store = memoryStore();
    const rt = await newRuntime({ store, win: null, doc: null });
    await rt.request('POST', '/api/mangas', { title: 'Vorher' });
    await rt.flush();
    const dispatch = coreRoutes.dispatch;
    const spy = vi.spyOn(coreRoutes, 'dispatch').mockImplementation(async (ctx, req) => {
      try {
        return await dispatch(ctx, req);
      } finally {
        // no leading keyword the hook knows: only total_changes() sees it
        ctx.db.prepare("/* am Haken vorbei */ UPDATE mangas SET title = 'Nachher'").get();
      }
    });
    try {
      expect((await rt.request('PUT', '/api/mangas/999', { title: 'x' })).status).toBe(404);
    } finally {
      spy.mockRestore();
    }
    await rt.flush();
    expect(await titles(await reopen(store))).toEqual(['Nachher']);
  });

  it('a write during a retry that then succeeds is saved too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const base = memoryStore();
      let puts = 0;
      let release = null;
      const store = {
        ...base,
        put: async (s, key, value) => {
          if (key === DB_KEY) {
            puts += 1;
            if (puts === 2) throw new Error('Speicher voll');
            if (puts === 3) await new Promise((r) => { release = r; });
          }
          return base.put(s, key, value);
        }
      };
      const rt = await newRuntime({ store, win: null, doc: null, locks: null });
      await rt.request('POST', '/api/mangas', { title: 'Eins' });
      await vi.advanceTimersByTimeAsync(0);
      expect(rt.status().saveError).toBe('Speicher voll');
      await vi.advanceTimersByTimeAsync(1000);
      expect(release).toBeTypeOf('function');
      rt.useProfile({ name: 'Zweitprofil' });
      release();
      await vi.advanceTimersByTimeAsync(10);
      expect(rt.status().saveError).toBeNull();
      expect(puts).toBe(4);
      const again = await reopen(store);
      expect(again.listProfiles().map((p) => p.username)).toEqual(['Felix', 'Zweitprofil']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a restore on the device is fenced', () => {
  it('writes meanwhile answer 423 LOCAL_BUSY and the restored bytes win in the store', async () => {
    const base = memoryStore();
    let slow = false;
    const store = { ...base, put: async (s, key, value) => { if (slow && key === DB_KEY) await sleep(30); return base.put(s, key, value); } };
    const rt = await newRuntime({ store, locks: null, win: null, doc: null });
    await rt.request('POST', '/api/mangas', { title: 'Alt' });
    await rt.flush();
    const bytes = rt.databaseCopy((c) => {
      c.prepare('DELETE FROM mangas').run();
      c.prepare('INSERT INTO mangas (title) VALUES (?)').run('Wiederhergestellt');
    });
    slow = true;
    const replaced = rt.replaceDatabase(bytes);
    const busy = await rt.request('POST', '/api/mangas', { title: 'Hintergrund' });
    expect([busy.status, busy.body.code, busy.body.error]).toEqual([423, 'LOCAL_BUSY', BUSY_TEXT]);
    expect((await rt.request('GET', '/api/mangas')).status).toBe(200);
    // a handler that was already running writes to the old database
    rt.getContext().db.prepare('INSERT INTO mangas (title) VALUES (?)').run('Nachzügler');
    await expect(rt.replaceDatabase(bytes)).rejects.toMatchObject({ code: 'LOCAL_BUSY' });
    await replaced;
    slow = false;
    await sleep(10);
    await rt.flush();
    expect(await titles(rt)).toEqual(['Wiederhergestellt']);
    expect(await titles(await reopen(store))).toEqual(['Wiederhergestellt']);
    expect((await rt.request('POST', '/api/mangas', { title: 'Danach' })).status).toBe(200);
    await rt.flush();
    expect(await titles(await reopen(store))).toEqual(['Danach', 'Wiederhergestellt']);
  });

  it('a failed restore lifts the fence and keeps the old collection with its pending changes', async () => {
    const store = memoryStore();
    const rt = await newRuntime({ store, locks: null, win: null, doc: null, persistDelayMs: 60000 });
    await rt.request('POST', '/api/mangas', { title: 'Ungespeichert' });
    await expect(rt.replaceDatabase(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect((await rt.request('POST', '/api/mangas', { title: 'Weiter' })).status).toBe(200);
    await rt.flush();
    expect(await titles(await reopen(store))).toEqual(['Ungespeichert', 'Weiter']);
  });
});

describe('the database lock and the profile of a window', () => {
  afterEach(() => {
    leaveLocalMode();
    localStorage.clear();
  });

  it('a reopen in the same window keeps the lock: a waiting window stays a follower until this one leaves the local mode', async () => {
    const store = { ...memoryStore(), lockName: 'test-handover' };
    const locks = fakeLocks();
    const channel = fakeChannels();
    const make = (name, holder = windowLocks) => createLocalRuntime({ SQL, store, http: offline, profile: { name }, persistDelayMs: 0, locks, channel, win: null, doc: null, windowLocks: holder });
    const front = await make('Felix');
    const background = await make('Felix', otherWindow());
    expect(background.status().follower).toBe(true);

    enterLocalMode({ id: 1, name: 'Felix' });
    useLocalRuntime(front);
    await resetLocalRuntime();
    await sleep(10);
    expect(background.status().follower).toBe(true);
    const again = await make('Lea');
    expect(again.status().follower).toBe(false);
    expect((await again.request('POST', '/api/mangas', { title: 'Weiter' })).status).toBe(200);
    expect((await background.request('POST', '/api/mangas', { title: 'x' })).status).toBe(423);

    const promoted = new Promise((resolve) => background.subscribe((e) => { if (e.type === 'status' && !e.status.follower) resolve(); }));
    leaveLocalMode();
    useLocalRuntime(again);
    await resetLocalRuntime();
    await promoted;
    expect(await titles(background)).toEqual(['Weiter']);
    await background.close();
  });

  it('a kept lock is given back when the window leaves the local mode before it reopens', async () => {
    const store = { ...memoryStore(), lockName: 'test-kept' };
    const locks = fakeLocks();
    const make = (holder) => createLocalRuntime({ SQL, store, http: offline, profile: { name: 'Felix' }, persistDelayMs: 0, locks, channel: () => null, win: null, doc: null, windowLocks: holder });
    const front = await make(windowLocks);
    const background = await make(otherWindow());
    enterLocalMode({ id: 1, name: 'Felix' });
    useLocalRuntime(front);
    await resetLocalRuntime();
    const promoted = new Promise((resolve) => background.subscribe((e) => { if (e.type === 'status' && !e.status.follower) resolve(); }));
    leaveLocalMode();
    await resetLocalRuntime();
    await promoted;
    expect(windowLocks.take('test-kept:manga.db')).toBeNull();
    await background.close();
  });

  it('a follower keeps a new profile out of the database and never takes over another profile that got its id', async () => {
    const store = { ...memoryStore(), lockName: 'test-profile' };
    const locks = fakeLocks();
    const channel = fakeChannels();
    const make = (profile, holder) => createLocalRuntime({ SQL, store, http: offline, profile, persistDelayMs: 0, locks, channel, win: null, doc: null, windowLocks: holder });
    const a = await make({ name: 'Felix' }, otherWindow());
    const b = await make({ name: 'Lea' }, otherWindow());
    expect(b.status().follower).toBe(true);
    expect(b.getProfile()).toEqual({ id: PENDING_PROFILE_ID, username: 'Lea', role: 'admin' });
    expect(b.listProfiles().map((p) => p.username)).toEqual(['Felix']);

    const reloaded = new Promise((resolve) => b.subscribe((e) => { if (e.type === 'reloaded') resolve(); }));
    expect(a.useProfile({ name: 'Max' })).toMatchObject({ id: 2, username: 'Max' });
    await a.flush();
    await reloaded;
    expect(b.getProfile()).toMatchObject({ id: PENDING_PROFILE_ID, username: 'Lea' });

    const promoted = new Promise((resolve) => b.subscribe((e) => { if (e.type === 'status' && !e.status.follower) resolve(); }));
    await a.close();
    await promoted;
    expect(b.getProfile()).toEqual({ id: 3, username: 'Lea', role: 'admin' });
    await b.close();
    const again = await createLocalRuntime({ SQL, store, http: offline, profile: { id: 3 }, locks: null, win: null, doc: null });
    expect(again.listProfiles().map((p) => p.username)).toEqual(['Felix', 'Max', 'Lea']);
  });

  it('a follower whose profile id now names someone else finds its profile by name', async () => {
    const rt = await newRuntime();
    rt.useProfile({ name: 'Max' });
    rt.databaseCopy((conn) => {
      expect(ensureProfileRow(conn, { id: 2, name: 'max' }, { sameName: true })).toMatchObject({ id: 2, username: 'Max' });
      expect(ensureProfileRow(conn, { id: 2, name: 'Felix' }, { sameName: true })).toMatchObject({ id: 1, username: 'Felix' });
      expect(ensureProfileRow(conn, { id: 2, name: 'Lea' }, { sameName: true, create: false })).toBeNull();
      expect(ensureProfileRow(conn, { id: 2, name: 'Lea' })).toMatchObject({ id: 2, username: 'Max' });
    });
  });
});
