// Capacitor native bridge: secure storage, standalone adapters, downloads and shell.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import {
  createServerStorage, migrateLocalStorage, installExternalLinks, installLinkClicks, backButtonHandler, installHaptics,
  saveFile, installCapacitorShell, nativeBridge, installObjectUrls, TOKEN_PREFIX
} from '../app/shell/capacitor.js';
import { createNativeStore, createNativeFiles, createNativeHttp, createCapacitorAdapters, bytesToBase64, base64ToBytes, SECRET_PREFIX } from '../local/capacitor.js';
import { createLocalRuntime } from '../local/runtime.js';
import {
  setStorageAdapter, resetServers, saveServer, getActiveServer, setActiveServerId, beginLogout, SERVERS_KEY, ACTIVE_KEY, PENDING_LOGOUTS_KEY
} from '../app/serverStore.js';
import { setToken, checkConnection } from '../app/connection.js';
import { openExternal, setOpenExternal } from '../app/openExternal.js';
import { takePendingDeepLink } from '../app/deepLink.js';
import LiveScanner, { scanNative, NATIVE_TEXTS } from '../components/common/LiveScanner';
import BarcodeScannerButton from '../components/common/BarcodeScannerButton';

vi.mock('../app/connection.js', async (importOriginal) => ({ ...(await importOriginal()), checkConnection: vi.fn(async () => ({})) }));

const ISBN = '9783551762931';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.geheim.signatur';

/** In-memory stand-ins for the plugins of mobile/src/native-bridge.mjs. */
function fakeBridge({ platform = 'ios' } = {}) {
  const listeners = {};
  const prefs = new Map();
  const secure = new Map();
  const files = new Map();
  const on = (plugin) => vi.fn(async (event, fn) => {
    (listeners[`${plugin}:${event}`] ||= []).push(fn);
    return { remove: vi.fn() };
  });
  const at = (directory, path) => `${directory}/${path}`;
  const missing = () => Object.assign(new Error('File does not exist'), { code: 'OS-PLUG-FILE-0008' });
  const plugins = {
    Preferences: {
      get: vi.fn(async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null })),
      set: vi.fn(async ({ key, value }) => { prefs.set(key, value); }),
      remove: vi.fn(async ({ key }) => { prefs.delete(key); })
    },
    SecureStorage: {
      getItem: vi.fn(async (key) => (secure.has(key) ? secure.get(key) : null)),
      setItem: vi.fn(async (key, value) => { secure.set(key, String(value)); }),
      removeItem: vi.fn(async (key) => { secure.delete(key); }),
      keys: vi.fn(async () => [...secure.keys()])
    },
    Filesystem: {
      readFile: vi.fn(async ({ path, directory }) => {
        if (!files.has(at(directory, path))) throw missing();
        return { data: files.get(at(directory, path)) };
      }),
      writeFile: vi.fn(async ({ path, directory, data }) => { files.set(at(directory, path), data); return { uri: `file:///${at(directory, path)}` }; }),
      deleteFile: vi.fn(async ({ path, directory }) => {
        if (!files.delete(at(directory, path))) throw missing();
      }),
      stat: vi.fn(async ({ path, directory }) => {
        if (!files.has(at(directory, path))) throw missing();
        return { type: 'file', size: base64ToBytes(files.get(at(directory, path))).length };
      }),
      rename: vi.fn(async ({ from, to, directory }) => {
        if (files.has(at(directory, to))) throw new Error('Ziel existiert');
        files.set(at(directory, to), files.get(at(directory, from)));
        files.delete(at(directory, from));
      }),
      readdir: vi.fn(async ({ path, directory }) => {
        const prefix = `${at(directory, path)}/`;
        const names = [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
        if (!names.length) throw missing();
        return { files: names.map((name) => ({ name, type: 'file' })) };
      }),
      rmdir: vi.fn(async ({ path, directory }) => {
        for (const key of [...files.keys()]) if (key.startsWith(`${at(directory, path)}/`)) files.delete(key);
      }),
      getUri: vi.fn(async ({ path, directory }) => ({ uri: `file:///${at(directory, path)}` }))
    },
    Browser: { open: vi.fn(async () => {}), addListener: on('Browser') },
    App: { addListener: on('App'), getLaunchUrl: vi.fn(async () => null), minimizeApp: vi.fn(async () => {}), exitApp: vi.fn() },
    Network: { addListener: on('Network') },
    Share: { share: vi.fn(async () => ({})) },
    Haptics: { notification: vi.fn(async () => {}), impact: vi.fn(async () => {}) },
    StatusBar: { setStyle: vi.fn(async () => {}), setOverlaysWebView: vi.fn(async () => {}), setBackgroundColor: vi.fn(async () => {}) },
    BarcodeScanner: {
      scan: vi.fn(async () => ({ barcodes: [] })),
      requestPermissions: vi.fn(async () => ({ camera: 'granted' })),
      isGoogleBarcodeScannerModuleAvailable: vi.fn(async () => ({ available: true })),
      installGoogleBarcodeScannerModule: vi.fn(async () => {})
    },
    CapacitorHttp: {}
  };
  const bridge = {
    version: 1,
    platform,
    convertFileSrc: (uri) => uri,
    plugins,
    constants: {
      Directory: { Data: 'DATA', Cache: 'CACHE' },
      Encoding: {},
      ImpactStyle: { Light: 'LIGHT' },
      NotificationType: { Success: 'SUCCESS', Error: 'ERROR' },
      StatusBarStyle: { Dark: 'DARK' },
      BarcodeFormat: { Ean13: 'EAN_13', Ean8: 'EAN_8', UpcA: 'UPC_A' }
    }
  };
  const emit = (key, payload) => Promise.all((listeners[key] || []).map((fn) => fn(payload)));
  return { bridge, plugins, prefs, secure, files, emit, listeners };
}

const anyTextHas = (map, text) => [...map.values()].some((value) => String(value).includes(text));

afterEach(() => {
  setStorageAdapter(null);
  delete window.mangashelfNative;
});

describe('server list in the app: Preferences without tokens, tokens in the secure storage', () => {
  it('splits tokens off, merges them back and drops them on logout', async () => {
    const { bridge, prefs, secure } = fakeBridge();
    const storage = createServerStorage(bridge);
    const list = [
      { id: 'a', name: 'Zuhause', urls: ['https://manga.example'], token: TOKEN, tokenOrigins: ['https://manga.example'] },
      { id: 'b', name: 'Ohne', urls: ['http://192.168.1.10:3000'] }
    ];
    await storage.set(SERVERS_KEY, JSON.stringify(list));
    expect(anyTextHas(prefs, TOKEN)).toBe(false);
    expect(JSON.parse(prefs.get(SERVERS_KEY))[0]).toEqual({ id: 'a', name: 'Zuhause', urls: ['https://manga.example'], tokenRef: true });
    expect(JSON.parse(secure.get(`${TOKEN_PREFIX}a`))).toEqual({ token: TOKEN, tokenOrigins: ['https://manga.example'] });
    expect(JSON.parse(await storage.get(SERVERS_KEY))).toEqual(list);

    // queued in order: a later write without the token can never be overtaken by the earlier one
    const first = storage.set(SERVERS_KEY, JSON.stringify(list));
    const second = storage.set(SERVERS_KEY, JSON.stringify([{ id: 'a', name: 'Zuhause', urls: ['https://manga.example'] }]));
    await Promise.all([first, second]);
    expect(secure.has(`${TOKEN_PREFIX}a`)).toBe(false);
    expect(JSON.parse(await storage.get(SERVERS_KEY))).toEqual([{ id: 'a', name: 'Zuhause', urls: ['https://manga.example'] }]);

    await storage.set(PENDING_LOGOUTS_KEY, JSON.stringify([{ serverId: 'a', token: TOKEN, urls: ['https://manga.example'] }]));
    expect(prefs.has(PENDING_LOGOUTS_KEY)).toBe(false);
    expect(await storage.get(PENDING_LOGOUTS_KEY)).toContain(TOKEN);
    await storage.set(ACTIVE_KEY, 'a');
    expect(prefs.get(ACTIVE_KEY)).toBe('a');
    await storage.remove(PENDING_LOGOUTS_KEY);
    expect(secure.size).toBe(0);
  });

  it('serverStore keeps working on top of it: login, logout, reload', async () => {
    const { bridge, prefs, secure } = fakeBridge();
    setStorageAdapter(createServerStorage(bridge));
    resetServers();
    const server = saveServer({ name: 'Zuhause', urls: ['https://manga.example'] });
    setActiveServerId(server.id);
    setToken(TOKEN);
    await vi.waitFor(() => expect(secure.has(`${TOKEN_PREFIX}${server.id}`)).toBe(true));
    expect(anyTextHas(prefs, TOKEN)).toBe(false);

    setStorageAdapter(createServerStorage(bridge));
    const { loadServers } = await import('../app/serverStore.js');
    await loadServers();
    expect(getActiveServer().token).toBe(TOKEN);

    beginLogout(server.id);
    await vi.waitFor(() => expect(secure.has(`${TOKEN_PREFIX}${server.id}`)).toBe(false));
    expect(secure.get(PENDING_LOGOUTS_KEY)).toContain(TOKEN);
    expect(anyTextHas(prefs, TOKEN)).toBe(false);
  });

  it('takes over a list an earlier app build kept in localStorage, once', async () => {
    const { bridge, prefs, secure } = fakeBridge();
    const storage = createServerStorage(bridge);
    localStorage.setItem(SERVERS_KEY, JSON.stringify([{ id: 'x', name: 'Alt', urls: ['https://alt.example'], token: TOKEN }]));
    localStorage.setItem(ACTIVE_KEY, 'x');
    expect(await migrateLocalStorage(storage, localStorage)).toBe(true);
    expect(localStorage.getItem(SERVERS_KEY)).toBeNull();
    expect(prefs.get(ACTIVE_KEY)).toBe('x');
    expect(JSON.parse(secure.get(`${TOKEN_PREFIX}x`)).token).toBe(TOKEN);
    expect(await migrateLocalStorage(storage, localStorage)).toBe(false);
  });
});

describe('native standalone adapters', () => {
  let SQL;
  beforeAll(async () => { SQL = await initSqlJs(); });

  it('base64 round trip', () => {
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('stores manga.db as a file (via .new), uploads under uploads/, secrets in the secure storage', async () => {
    const { bridge, files, secure } = fakeBridge();
    const store = createNativeStore(bridge);
    expect(await store.get('db', 'manga.db')).toBeUndefined();
    await store.put('db', 'manga.db', new Uint8Array([1, 2, 3]));
    await store.put('db', 'manga.db', new Uint8Array([4, 5]));
    expect([...files.keys()]).toEqual(['DATA/manga.db']);
    expect(await store.get('db', 'manga.db')).toEqual(new Uint8Array([4, 5]));
    expect(await store.keys('db')).toEqual(['manga.db']);

    expect(await store.keys('files')).toEqual([]);
    await store.put('files', 'a.png', new Blob([new Uint8Array([9, 9])]));
    expect(await store.keys('files')).toEqual(['a.png']);
    expect(await store.get('files', 'a.png')).toEqual(new Uint8Array([9, 9]));
    await expect(store.put('files', '../x', new Uint8Array([1]))).rejects.toThrow('Ungültiger Dateiname');
    await store.clear('files');
    expect(await store.keys('files')).toEqual([]);

    await store.put('secrets', '1:anilist', { secret: 'abc' });
    expect(secure.get(`${SECRET_PREFIX}1:anilist`)).toBe('{"secret":"abc"}');
    expect(await store.keys('secrets')).toEqual(['1:anilist']);
    expect(await store.get('secrets', '1:anilist')).toEqual({ secret: 'abc' });
    await store.clear('secrets');
    expect(secure.size).toBe(0);
  });

  it('a leftover manga.db.tmp is promoted before the next write, so a second interrupted save keeps the collection', async () => {
    const { bridge, plugins, files } = fakeBridge();
    const full = new Uint8Array([7, 7, 7, 7, 7, 7]);
    files.set('DATA/manga.db.tmp', bytesToBase64(full));
    const store = createNativeStore(bridge);
    expect(await store.get('db', 'manga.db')).toEqual(full);
    expect([...files.keys()]).toEqual(['DATA/manga.db']);

    plugins.Filesystem.writeFile.mockImplementationOnce(async ({ path, directory }) => {
      files.set(`${directory}/${path}`, bytesToBase64(new Uint8Array([1])));
      throw new Error('App beendet');
    });
    await expect(store.put('db', 'manga.db', new Uint8Array([9, 9, 9]))).rejects.toThrow('App beendet');
    expect(await createNativeStore(bridge).get('db', 'manga.db')).toEqual(full);
    expect([...files.keys()]).toEqual(['DATA/manga.db']);
  });

  it('after a crash between the two renames the new copy wins; .old alone is the fallback; a lone .new is dropped', async () => {
    const enc = (...b) => bytesToBase64(new Uint8Array(b));
    const states = [
      [{ 'manga.db.new': enc(2, 2), 'manga.db.old': enc(1) }, [2, 2]],
      [{ 'manga.db.old': enc(1) }, [1]],
      [{ 'manga.db.new': enc(5) }, undefined],
      [{ 'manga.db': enc(3), 'manga.db.new': enc(4), 'manga.db.old': enc(1), 'manga.db.tmp': enc(0) }, [3]]
    ];
    for (const [state, expected] of states) {
      const { bridge, files } = fakeBridge();
      for (const [name, data] of Object.entries(state)) files.set(`DATA/${name}`, data);
      const got = await createNativeStore(bridge).get('db', 'manga.db');
      expect(got && [...got]).toEqual(expected);
      expect([...files.keys()]).toEqual(expected ? ['DATA/manga.db'] : []);
    }
  });

  it('a read during a save waits for it and never removes the copy being written', async () => {
    const { bridge, plugins, files } = fakeBridge();
    const store = createNativeStore(bridge);
    await store.put('db', 'manga.db', new Uint8Array([1]));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = plugins.Filesystem.writeFile.getMockImplementation();
    plugins.Filesystem.writeFile.mockImplementationOnce(async (args) => { await gate; return original(args); });
    const saving = store.put('db', 'manga.db', new Uint8Array([2, 2]));
    const reading = store.get('db', 'manga.db');
    release();
    await saving;
    expect(await reading).toEqual(new Uint8Array([2, 2]));
    expect([...files.keys()]).toEqual(['DATA/manga.db']);
  });

  it('native uploads: <img> through convertFileSrc, read/stat/list on demand, nothing read at start', async () => {
    const { bridge, plugins, files } = fakeBridge();
    bridge.convertFileSrc = (uri) => uri.replace('file:///', 'capacitor://localhost/_capacitor_file_/');
    files.set('DATA/uploads/alt.png', bytesToBase64(new Uint8Array([1, 2, 3])));
    const adapters = await createCapacitorAdapters(bridge);
    expect(adapters.files).toBeTruthy();
    plugins.Filesystem.readFile.mockClear();
    const rt = await createLocalRuntime({ SQL, store: adapters.store, files: adapters.files, http: adapters.http, secureCredentials: true, profile: { name: 'Felix' } });
    expect(rt.files.urlFor('alt.png')).toBe('capacitor://localhost/_capacitor_file_/DATA/uploads/alt.png');
    expect(rt.files.urlFor('../x')).toBeNull();
    await rt.housekeeping();
    expect(plugins.Filesystem.readFile.mock.calls.filter(([a]) => a.path.startsWith('uploads/'))).toEqual([]);
    expect(await rt.files.list(), 'the unreferenced upload went in the start cleanup without being read').toEqual([]);
    await rt.files.write('neu.png', new Uint8Array([1, 2, 3]));
    expect(await rt.files.stat('neu.png')).toEqual({ size: 3 });
    expect(await rt.files.stat('fehlt.png')).toBeNull();
    expect(await rt.files.read('neu.png')).toEqual(new Uint8Array([1, 2, 3]));
    expect(rt.files.urlFor('neu.png')).toBe('capacitor://localhost/_capacitor_file_/DATA/uploads/neu.png?v=1');
    await rt.files.write('neu.png', new Uint8Array([4]));
    expect(rt.files.urlFor('neu.png')).toMatch(/\?v=2$/);
    expect(await rt.files.list()).toEqual(['neu.png']);
    await rt.files.remove('neu.png');
    expect(await rt.files.list()).toEqual([]);
    await rt.close();

    const old = fakeBridge().bridge;
    delete old.convertFileSrc;
    expect(await createNativeFiles(old)).toBeNull();
    expect((await createCapacitorAdapters(old)).files).toBeUndefined();
  });

  it('the device core keeps API keys in the secure storage, never in manga.db or Preferences, and reopens its file', async () => {
    const { bridge, prefs, secure, files } = fakeBridge();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { Viewer: { id: 7, name: 'felix_al' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const store = createNativeStore(bridge);
    const rt = await createLocalRuntime({ SQL, store, http: createNativeHttp(fetchImpl), secureCredentials: true, profile: { name: 'Felix' }, persistDelayMs: 0 });
    const key = `${'a'.repeat(40)}.${'b'.repeat(40)}.${'c'.repeat(40)}`;
    const saved = await rt.request('PUT', '/api/auth/api-keys/anilist', { secret: key });
    expect(saved.body).toMatchObject({ configured: true, last4: 'cccc' });
    expect(saved.body.insecure_storage).toBeFalsy();
    await rt.request('POST', '/api/mangas', { title: 'Auf dem Handy' });
    await rt.close();

    expect(JSON.parse(secure.get(`${SECRET_PREFIX}1:anilist`)).secret).toBe(key);
    expect(anyTextHas(prefs, key)).toBe(false);
    const dbBytes = base64ToBytes(files.get('DATA/manga.db'));
    expect(new TextDecoder('latin1').decode(dbBytes)).not.toContain(key);

    const again = await createLocalRuntime({ SQL, store: createNativeStore(bridge), http: createNativeHttp(fetchImpl), secureCredentials: true, profile: { id: 1 } });
    expect((await again.request('GET', '/api/mangas')).body.map((m) => m.title)).toEqual(['Auf dem Handy']);
    expect(again.getContext().credentials.get(1, 'anilist').secret).toBe(key);
    await again.close();
  });

  it('native HTTP failures stay network errors (no CORS notice in the app)', async () => {
    const http = createNativeHttp(async () => { throw new TypeError('Failed to fetch'); });
    await expect(http.fetch('https://portal.dnb.de/x')).rejects.toBeInstanceOf(TypeError);
    expect(http.blockedHosts()).toEqual([]);
  });

  it('createCapacitorAdapters needs the bridge', async () => {
    await expect(createCapacitorAdapters(null)).rejects.toThrow('Capacitor-Plugins fehlen');
    const adapters = await createCapacitorAdapters(fakeBridge().bridge);
    expect(adapters.secureCredentials).toBe(true);
    expect(typeof adapters.store.get).toBe('function');
    expect(typeof adapters.http.fetchImage).toBe('function');
  });
});

describe('links, downloads, back button, haptics', () => {
  it('opens links in the in-app browser and gives the key field its focus back afterwards', async () => {
    const { bridge, plugins, emit } = fakeBridge();
    const links = installExternalLinks(bridge, { doc: document });
    const { container } = render(
      <section data-provider="anilist">
        <a href="https://anilist.co/settings/developer" target="_blank" rel="noreferrer">Anleitung</a>
        <input type="password" aria-label="Schlüssel" />
      </section>
    );
    const unlisten = installLinkClicks(bridge, { doc: document, win: window });
    try {
      fireEvent.pointerDown(screen.getByText('Anleitung'));
      fireEvent.click(screen.getByText('Anleitung'));
      expect(plugins.Browser.open).toHaveBeenCalledWith({ url: 'https://anilist.co/settings/developer' });
      expect(document.activeElement).not.toBe(screen.getByLabelText('Schlüssel'));
      await emit('Browser:browserFinished');
      expect(document.activeElement).toBe(screen.getByLabelText('Schlüssel'));

      plugins.Browser.open.mockClear();
      expect(openExternal('javascript:alert(1)')).toBe(false);
      expect(plugins.Browser.open).not.toHaveBeenCalled();
      expect(container).toBeTruthy();
    } finally {
      unlisten();
      links.stop();
      setOpenExternal((url) => window.open(url, '_blank', 'noopener,noreferrer'));
    }
  });

  it('a click the app handled itself is left alone', () => {
    const { bridge, plugins } = fakeBridge();
    const unlisten = installLinkClicks(bridge, { doc: document, win: window });
    try {
      render(<a href="https://example.org" target="_blank" rel="noreferrer" onClick={(e) => e.preventDefault()}>Selbst</a>);
      fireEvent.click(screen.getByText('Selbst'));
      expect(plugins.Browser.open).not.toHaveBeenCalled();
    } finally {
      unlisten();
    }
  });

  it('<a download> with a blob goes to a file in the cache and the share sheet', async () => {
    const { bridge, plugins, files } = fakeBridge();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('id;titel\n1;Lokal', { headers: { 'Content-Type': 'text/csv' } }));
    const unlisten = installLinkClicks(bridge, { doc: document, win: window });
    try {
      const link = document.createElement('a');
      link.href = 'blob:https://localhost/1234';
      link.download = 'manga-shelf:export?.csv';
      document.body.appendChild(link);
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      link.remove();
      expect(click.defaultPrevented).toBe(true);
      await waitFor(() => expect(plugins.Share.share).toHaveBeenCalled());
      expect(fetchSpy).toHaveBeenCalledWith('blob:https://localhost/1234');
      expect(plugins.Share.share).toHaveBeenCalledWith({ title: 'manga-shelf_export_.csv', files: ['file:///CACHE/downloads/manga-shelf_export_.csv'] });
      expect(atob(files.get('CACHE/downloads/manga-shelf_export_.csv'))).toBe('id;titel\n1;Lokal');
    } finally {
      unlisten();
    }
  });

  it('a blob: download never fetches: the CSP blocks it and CapacitorHttp\'s fetch fails it ("Load failed")', async () => {
    const { bridge, plugins, files } = fakeBridge();
    const revoke = vi.fn();
    const urlApi = { createObjectURL: vi.fn(() => 'blob:capacitor://localhost/42'), revokeObjectURL: revoke };
    expect(installObjectUrls(urlApi)).toBe(true);
    expect(installObjectUrls(urlApi)).toBe(false);
    const patchedFetch = vi.fn(async () => { throw new TypeError('Load failed'); });
    vi.stubGlobal('fetch', patchedFetch);
    const unlisten = installLinkClicks(bridge, { doc: document, win: window });
    try {
      const url = urlApi.createObjectURL(new Blob(['PK-zip'], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'manga-shelf-backup.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      urlApi.revokeObjectURL(url);
      await waitFor(() => expect(plugins.Share.share).toHaveBeenCalledWith({ title: 'manga-shelf-backup.zip', files: ['file:///CACHE/downloads/manga-shelf-backup.zip'] }));
      expect(atob(files.get('CACHE/downloads/manga-shelf-backup.zip'))).toBe('PK-zip');
      expect(patchedFetch).not.toHaveBeenCalled();
      expect(revoke).toHaveBeenCalledWith(url);
    } finally {
      unlisten();
      vi.unstubAllGlobals();
    }
  });

  it('data: URLs are decoded in place; an unknown blob: URL goes to WebKit\'s fetch, not CapacitorHttp\'s', async () => {
    const { bridge, files } = fakeBridge();
    await saveFile(bridge, 'data:text/csv;base64,aWQ7dGl0ZWw=', 'a.csv', { fetchImpl: vi.fn() });
    expect(atob(files.get('CACHE/downloads/a.csv'))).toBe('id;titel');
    await saveFile(bridge, 'data:text/plain,K%C3%A4fer', 'b.txt', { fetchImpl: vi.fn() });
    expect(new TextDecoder().decode(base64ToBytes(files.get('CACHE/downloads/b.txt')))).toBe('Käfer');

    const patchedFetch = vi.fn(async () => { throw new TypeError('Load failed'); });
    const webFetch = vi.fn(async () => new Response('alt'));
    vi.stubGlobal('fetch', patchedFetch);
    vi.stubGlobal('CapacitorWebFetch', webFetch);
    try {
      await saveFile(bridge, 'blob:capacitor://localhost/unbekannt', 'c.txt');
      expect(webFetch).toHaveBeenCalledWith('blob:capacitor://localhost/unbekannt');
      expect(patchedFetch).not.toHaveBeenCalled();
      expect(atob(files.get('CACHE/downloads/c.txt'))).toBe('alt');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a cancelled share sheet is no error', async () => {
    const { bridge, plugins } = fakeBridge();
    plugins.Share.share.mockRejectedValue(new Error('Share canceled'));
    await expect(saveFile(bridge, new Blob(['x']), 'a.zip')).resolves.toBe('file:///CACHE/downloads/a.zip');
    plugins.Share.share.mockRejectedValue(new Error('Kein Speicher'));
    await expect(saveFile(bridge, new Blob(['x']), 'a.zip')).rejects.toThrow('Kein Speicher');
  });

  it('Android back: back in the app while there is history, else to the background', () => {
    const { bridge, plugins } = fakeBridge({ platform: 'android' });
    const win = { history: { back: vi.fn() } };
    const onBack = backButtonHandler(bridge, win);
    onBack({ canGoBack: true });
    expect(win.history.back).toHaveBeenCalledTimes(1);
    onBack({ canGoBack: false });
    expect(plugins.App.minimizeApp).toHaveBeenCalledTimes(1);
  });

  it('iOS has no navigator.vibrate: the haptics patterns go to the Haptics plugin', () => {
    const { bridge, plugins } = fakeBridge();
    const nav = {};
    expect(installHaptics(bridge, nav)).toBe(true);
    nav.vibrate([25, 40, 25]);
    nav.vibrate([60, 50, 60]);
    nav.vibrate(12);
    expect(plugins.Haptics.notification.mock.calls.map(([o]) => o.type)).toEqual(['SUCCESS', 'ERROR']);
    expect(plugins.Haptics.impact).toHaveBeenCalledWith({ style: 'LIGHT' });
    expect(installHaptics(bridge, { vibrate: () => true })).toBe(false);
  });
});

describe('installCapacitorShell', () => {
  it('does nothing outside the apps', async () => {
    expect(nativeBridge(window)).toBeNull();
    expect(await installCapacitorShell({ win: window, doc: document })).toBe(false);
  });

  it('wires storage, deep links, network and foreground checks', async () => {
    const { bridge, plugins, emit, prefs } = fakeBridge({ platform: 'android' });
    plugins.App.getLaunchUrl.mockResolvedValue({ url: 'manga-shelf://connect?url=https%3A%2F%2Fmanga.example&name=Zuhause' });
    window.mangashelfNative = bridge;
    expect(await installCapacitorShell({ win: window, doc: document })).toBe(true);

    expect(takePendingDeepLink()).toEqual({ url: 'https://manga.example', name: 'Zuhause', instanceId: null });
    await emit('App:appUrlOpen', { url: 'manga-shelf://connect?url=http%3A%2F%2F192.168.1.10%3A3000' });
    expect(takePendingDeepLink()).toMatchObject({ url: 'http://192.168.1.10:3000' });

    checkConnection.mockClear();
    await emit('Network:networkStatusChange', { connected: true, connectionType: 'wifi' });
    await emit('App:appStateChange', { isActive: false });
    await emit('App:appStateChange', { isActive: true });
    expect(checkConnection).toHaveBeenCalledTimes(2);

    saveServer({ id: 's1', name: 'Zuhause', urls: ['https://manga.example'], token: TOKEN });
    await vi.waitFor(() => expect(prefs.has(SERVERS_KEY)).toBe(true));
    expect(anyTextHas(prefs, TOKEN)).toBe(false);

    expect(plugins.StatusBar.setStyle).toHaveBeenCalledWith({ style: 'DARK' });
    await vi.waitFor(() => expect(plugins.StatusBar.setOverlaysWebView).toHaveBeenCalledWith({ overlay: false }));
    expect(Object.keys(await import('../local/localTransport.js'))).toContain('setLocalAdapters');
  });
});

describe('LiveScanner in the app (ML Kit)', () => {
  it('reports the scanned ISBN and closes without continuous mode', async () => {
    const { bridge, plugins } = fakeBridge();
    plugins.BarcodeScanner.scan.mockResolvedValue({ barcodes: [{ rawValue: ISBN, format: 'EAN_13' }] });
    const onDetected = vi.fn();
    const onClose = vi.fn();
    render(<LiveScanner native={bridge} onDetected={onDetected} onClose={onClose} />);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDetected).toHaveBeenCalledWith(ISBN);
    expect(plugins.BarcodeScanner.scan).toHaveBeenCalledWith({ formats: ['EAN_13', 'EAN_8', 'UPC_A'] });
    expect(plugins.BarcodeScanner.requestPermissions).toHaveBeenCalled();
  });

  it('continuous mode stays open with the list and scans again on request; a cancel keeps it open', async () => {
    const { bridge, plugins } = fakeBridge();
    plugins.BarcodeScanner.scan
      .mockResolvedValueOnce({ barcodes: [{ rawValue: ISBN, format: 'EAN_13' }] })
      .mockResolvedValueOnce({ barcodes: [{ rawValue: '4006381333931', format: 'EAN_13' }] })
      .mockRejectedValueOnce(new Error('scan canceled.'));
    const onDetected = vi.fn();
    const onClose = vi.fn();
    render(<LiveScanner native={bridge} continuous onDetected={onDetected} onClose={onClose}><p>Liste</p></LiveScanner>);
    expect(await screen.findByText(`Erkannt: ${ISBN}`)).toBeTruthy();
    expect(screen.getByText('Liste')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nächsten Barcode scannen' }));
    expect(await screen.findByText(NATIVE_TEXTS.noIsbn)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nächsten Barcode scannen' }));
    await waitFor(() => expect(plugins.BarcodeScanner.scan).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a cancelled scan closes the single-scan dialog', async () => {
    const { bridge } = fakeBridge();
    const onClose = vi.fn();
    render(<LiveScanner native={bridge} onDetected={vi.fn()} onClose={onClose} />);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Android without the Google scanner module installs it and says so; a refused camera offers the photo', async () => {
    const android = fakeBridge({ platform: 'android' });
    android.plugins.BarcodeScanner.isGoogleBarcodeScannerModuleAvailable.mockResolvedValue({ available: false });
    await expect(scanNative(android.bridge)).rejects.toThrow(NATIVE_TEXTS.installing);
    expect(android.plugins.BarcodeScanner.installGoogleBarcodeScannerModule).toHaveBeenCalled();
    expect(android.plugins.BarcodeScanner.requestPermissions).not.toHaveBeenCalled();

    const ios = fakeBridge();
    ios.plugins.BarcodeScanner.requestPermissions.mockResolvedValue({ camera: 'denied' });
    const onClose = vi.fn();
    const onPhotoFallback = vi.fn();
    render(<LiveScanner native={ios.bridge} onDetected={vi.fn()} onClose={onClose} onPhotoFallback={onPhotoFallback} />);
    expect((await screen.findByRole('alert')).textContent).toContain(NATIVE_TEXTS.denied);
    expect(ios.plugins.BarcodeScanner.scan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Foto aufnehmen' }));
    expect(onClose).toHaveBeenCalled();
    expect(onPhotoFallback).toHaveBeenCalled();
  });

  it('the scan button opens the native scanner even without a secure context', async () => {
    const { bridge, plugins } = fakeBridge();
    plugins.BarcodeScanner.scan.mockResolvedValue({ barcodes: [{ rawValue: ISBN, format: 'EAN_13' }] });
    window.mangashelfNative = bridge;
    const onDetected = vi.fn();
    render(<BarcodeScannerButton buttonText="Scannen" onDetected={onDetected} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scannen' }));
    await waitFor(() => expect(onDetected).toHaveBeenCalledWith(ISBN));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
