import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import { createLocalRuntime, DB_KEY } from '../local/runtime.js';
import { memoryStore } from '../local/store.js';
import { createBrowserHttp, corsText } from '../local/http.js';
import { buildBackupZip, readBackupZip } from '../local/backupZip.js';
import { useLocalRuntime, resetLocalRuntime, localUploadUrl } from '../local/localTransport.js';
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
