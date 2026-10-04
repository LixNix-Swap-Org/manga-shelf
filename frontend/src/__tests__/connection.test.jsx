// Covers server connection management, tokens, probing and stored server entries.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  normalizeBase, getActiveBase, setActiveBase, getToken, setToken, activateServer, probeUrl, probeServer, checkConnection,
  getConnection, startConnectionManager, resetConnection, RECHECK_INTERVAL_MS, needsLoginAtAddress, dropRejectedToken
} from '../app/connection';
import {
  SERVERS_KEY, ACTIVE_KEY, LEGACY_BASE_KEY, LEGACY_TOKEN_KEY, PENDING_LOGOUTS_KEY, getServers, getServer, getActiveServer,
  saveServer, updateServer, removeServer, resetServers, setStorageAdapter, loadServers, localStorageAdapter,
  findServerByInstance, isSecureEnough, beginLogout, getPendingLogouts, settlePendingLogout
} from '../app/serverStore';
import { apiFetch } from '../utils/api';
import { parseConnectLink, buildConnectLink, receiveDeepLink, takePendingDeepLink, installDeepLinkBridge, DEEP_LINK_EVENT, OPEN_URL_EVENT } from '../app/deepLink';
import { encodeQr, qrPath } from '../app/qr';
import {
  BinaryBitmap, HybridBinarizer, RGBLuminanceSource, QRCodeReader, DecodeHintType
} from '@zxing/library';

const health = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const HEALTHY = { name: 'Manga Shelf', status: 'ok', instance_id: 'inst-1', version: '2.20.0' };

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  setStorageAdapter(null);
  resetServers();
  resetConnection();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('server store', () => {
  it('normalizes a server address to origin plus path without trailing slash', () => {
    expect(normalizeBase('https://shelf.example.org/')).toBe('https://shelf.example.org');
    expect(normalizeBase('  http://192.168.1.20:3000/manga//  ')).toBe('http://192.168.1.20:3000/manga');
    expect(normalizeBase('https://shelf.example.org/manga?x=1#y')).toBe('https://shelf.example.org/manga');
    expect(normalizeBase('ftp://shelf.example.org')).toBe('');
    expect(normalizeBase('kein server')).toBe('');
    expect(normalizeBase(null)).toBe('');
  });

  it('saves a server with several addresses, persists it and keeps the active id separately', async () => {
    const saved = saveServer({ name: ' Zuhause ', urls: ['https://manga.example.org/', 'http://192.168.1.10:3000', 'nonsense', 'https://manga.example.org'] });
    expect(saved).toMatchObject({ name: 'Zuhause', urls: ['https://manga.example.org', 'http://192.168.1.10:3000'] });
    expect(saved.id).toBeTruthy();
    activateServer(saved.id);
    await flush();
    expect(JSON.parse(localStorage.getItem(SERVERS_KEY))).toEqual([saved]);
    expect(localStorage.getItem(ACTIVE_KEY)).toBe(saved.id);
    expect(() => saveServer({ name: 'x', urls: ['kein server'] })).toThrow(/gültige Adresse/);
  });

  it('a server without a name is named after its host; an update keeps the token unless the addresses move away', () => {
    const s = saveServer({ urls: 'https://a.example\nhttp://10.0.0.2:3000' });
    expect(s.name).toBe('a.example');
    updateServer(s.id, { token: 'tok' });
    expect(saveServer({ id: s.id, name: 'Neu', urls: ['https://a.example', 'http://10.0.0.3:3000'] }).token).toBe('tok');
    expect(saveServer({ id: s.id, urls: ['https://b.example'] }).token).toBeUndefined();
  });

  it('removing the active server clears the active id', () => {
    const s = saveServer({ urls: ['https://a.example'] });
    activateServer(s.id);
    expect(removeServer(s.id)).toBe(true);
    expect(getActiveServer()).toBeNull();
    expect(getServers()).toEqual([]);
  });

  it('migrates the single-server format of the first app builds once', async () => {
    localStorage.setItem(LEGACY_BASE_KEY, 'https://old.example/');
    localStorage.setItem(LEGACY_TOKEN_KEY, JSON.stringify({ origin: 'https://old.example', token: 'old-token' }));
    setStorageAdapter(null);
    expect(getActiveServer()).toMatchObject({ name: 'old.example', urls: ['https://old.example'], token: 'old-token' });
    await flush();
    expect(localStorage.getItem(LEGACY_BASE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(SERVERS_KEY))).toHaveLength(1);
  });

  it('a token of the old format bound to another origin is not migrated', () => {
    localStorage.setItem(LEGACY_BASE_KEY, 'https://b.example');
    localStorage.setItem(LEGACY_TOKEN_KEY, JSON.stringify({ origin: 'https://a.example', token: 'for-a' }));
    setStorageAdapter(null);
    expect(getActiveServer().token).toBeUndefined();
  });

  it('an async adapter (secure storage of the shells) is read with loadServers', async () => {
    const store = new Map([[SERVERS_KEY, JSON.stringify([{ id: 's1', name: 'Home', urls: ['https://home.example'], token: 't' }])], [ACTIVE_KEY, 's1']]);
    const adapter = {
      get: vi.fn(async (k) => store.get(k) ?? null),
      set: vi.fn(async (k, v) => { store.set(k, v); }),
      remove: vi.fn(async (k) => { store.delete(k); })
    };
    setStorageAdapter(adapter);
    expect(getActiveServer()).toBeNull();
    await loadServers();
    expect(getActiveServer()).toMatchObject({ id: 's1', token: 't' });
    updateServer('s1', { name: 'Zuhause' });
    await flush();
    expect(JSON.parse(store.get(SERVERS_KEY))[0].name).toBe('Zuhause');
  });

  it('works without usable storage', () => {
    setStorageAdapter(localStorageAdapter(() => { throw new Error('blocked'); }));
    expect(getToken()).toBe('');
    expect(() => setToken('x')).not.toThrow();
    expect(getActiveBase()).toBe('');
    expect(() => saveServer({ urls: ['https://a.example'] })).not.toThrow();
  });
});

describe('active base and token', () => {
  it('stores, reads and clears the active server', () => {
    expect(getActiveBase()).toBe('');
    expect(setActiveBase('https://shelf.example.org/')).toBe('https://shelf.example.org');
    expect(getActiveBase()).toBe('https://shelf.example.org');
    expect(getActiveServer().urls).toEqual(['https://shelf.example.org']);
    setActiveBase('');
    expect(getActiveBase()).toBe('');
    expect(getActiveServer()).toBeNull();
  });

  it('rejects an invalid address and keeps the previous one', () => {
    setActiveBase('https://a.example');
    expect(() => setActiveBase('javascript:alert(1)')).toThrow(/Ungültige Serveradresse/);
    expect(getActiveBase()).toBe('https://a.example');
  });

  it('the token is bound to the origins where the user signed in: another address of the server needs a new login', () => {
    const s = saveServer({ name: 'Home', urls: ['https://home.example', 'http://192.168.1.10:3000'] });
    activateServer(s.id);
    setToken('abc.def.ghi');
    expect(getToken()).toBe('abc.def.ghi');
    expect(getActiveServer().tokenOrigins).toEqual(['https://home.example']);
    setActiveBase('http://192.168.1.10:3000');
    expect(getActiveServer().id).toBe(s.id);
    expect(getToken()).toBe('');
    expect(needsLoginAtAddress()).toBe(true);
    // a 401 at the new address does not throw away the session of the old one
    dropRejectedToken();
    expect(getActiveServer().token).toBe('abc.def.ghi');
    setToken('lan.token');
    expect(getToken()).toBe('lan.token');
    expect(needsLoginAtAddress()).toBe(false);
    // the new session is only trusted where it was signed in, not at the address of the earlier one
    expect(getActiveServer().tokenOrigins).toEqual(['http://192.168.1.10:3000']);
    setActiveBase('https://home.example');
    expect(getToken()).toBe('');
    expect(needsLoginAtAddress()).toBe(true);
    setActiveBase('http://192.168.1.10:3000');
    dropRejectedToken();
    expect(getToken()).toBe('');
    expect(getActiveServer()).toMatchObject({ id: s.id, name: 'Home' });
    expect(getActiveServer().tokenOrigins).toBeUndefined();
  });

  it('a rotated token of the same session keeps the trusted addresses; only a new sign-in starts over', () => {
    const s = saveServer({ name: 'Home', urls: ['https://home.example', 'http://192.168.1.10:3000', 'https://third.example'], token: 'first', tokenOrigins: ['https://home.example', 'http://192.168.1.10:3000'] });
    activateServer(s.id);
    setActiveBase('https://home.example');
    // password change, "Alle Sitzungen beenden", user management: the session goes on with a new token
    setToken('rotated', { rotate: true });
    expect(getServer(s.id)).toMatchObject({ token: 'rotated', tokenOrigins: ['https://home.example', 'http://192.168.1.10:3000'] });
    setActiveBase('http://192.168.1.10:3000');
    expect(getToken()).toBe('rotated');
    // a rotation at an address the session was never trusted at is a new start there
    setActiveBase('https://third.example');
    setToken('elsewhere', { rotate: true });
    expect(getServer(s.id).tokenOrigins).toEqual(['https://third.example']);
    setActiveBase('https://home.example');
    setToken('relogin');
    expect(getServer(s.id).tokenOrigins).toEqual(['https://home.example']);
  });

  it('the sign-in origins leave together with the token: logout, then a login at the other address', () => {
    const s = saveServer({ name: 'Home', urls: ['http://192.168.1.10:3000', 'https://home.example'] });
    setActiveBase('http://192.168.1.10:3000');
    setToken('old');
    beginLogout(s.id);
    expect(getServer(s.id).token).toBeUndefined();
    expect(getServer(s.id).tokenOrigins).toBeUndefined();
    setActiveBase('https://home.example');
    setToken('new-at-b');
    expect(getServer(s.id).tokenOrigins).toEqual(['https://home.example']);
    setActiveBase('http://192.168.1.10:3000');
    expect(getToken()).toBe('');
    // stored entries: origins without a token are dropped, setToken(null) drops both
    expect(saveServer({ urls: ['https://x.example'], tokenOrigins: ['https://x.example'] }).tokenOrigins).toBeUndefined();
    setActiveBase('https://home.example');
    setToken(null);
    expect(getServer(s.id)).not.toHaveProperty('tokenOrigins');
  });

  it('an address added later (connect link) never receives the token of the earlier sign-in', async () => {
    vi.stubEnv('VITE_APP_MODE', 'app');
    const home = saveServer({ name: 'Zuhause', urls: ['http://192.168.1.10:3000'], instanceId: 'inst-1' });
    activateServer(home.id);
    setToken('secret-tok');
    saveServer({ id: home.id, urls: ['http://192.168.1.10:3000', 'https://evil.example'] });
    expect(getServer(home.id).token).toBe('secret-tok');
    const fetchMock = vi.fn(async (url) => {
      if (url.startsWith('http://192.168.1.10')) throw new TypeError('unreachable');
      return health({ ...HEALTHY, instance_id: 'inst-1' });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkConnection()).toMatchObject({ state: 'online', baseUrl: 'https://evil.example' });
    await apiFetch('/api/mangas');
    const [url, init] = fetchMock.mock.calls.at(-1);
    expect(url).toBe('https://evil.example/api/mangas');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('plain http only carries the token to home-network hosts', () => {
    for (const url of ['https://manga.example.org', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000',
      'http://10.0.0.2:3000', 'http://172.16.4.1', 'http://172.31.255.1', 'http://192.168.1.10:3000', 'http://169.254.3.4',
      'http://nas.local:3000', 'http://[fe80::1]:3000', 'http://[fd00::5]:3000', 'http://[fc12::1]', 'http://100.64.0.1',
      'http://100.101.102.103:3000', 'http://100.127.255.254', 'http://nas.fritz.box:3000', 'http://nas.lan:3000',
      'http://nas.home.arpa', 'http://shelf.internal:8080']) {
      expect(isSecureEnough(url), url).toBe(true);
    }
    for (const url of ['http://manga.example.org', 'http://172.32.0.1', 'http://8.8.8.8', 'http://192.169.1.1', 'http://local.example',
      'http://100.63.255.1', 'http://100.128.0.1', 'http://[2001:db8::1]', 'http://fritz.box.example.org', 'http://nas:3000',
      'ftp://nas.local', 'kein server']) {
      expect(isSecureEnough(url), url).toBe(false);
    }
    const s = saveServer({ urls: ['http://manga.example.org'], token: 'old', tokenOrigins: ['http://manga.example.org'] });
    activateServer(s.id);
    expect(getToken()).toBe('');
  });

  it('a stored token without its sign-in origins trusts only the address that answered last', () => {
    const s = saveServer({ urls: ['https://pub.example', 'http://10.0.0.2:3000'], token: 'tok', lastOkUrl: 'http://10.0.0.2:3000' });
    expect(s.tokenOrigins).toEqual(['http://10.0.0.2:3000']);
    activateServer(s.id);
    expect(getActiveBase()).toBe('http://10.0.0.2:3000');
    expect(getToken()).toBe('tok');
    setActiveBase('https://pub.example');
    expect(getToken()).toBe('');
  });

  it('a logout moves the token into a pending record of its server, kept in storage until it is settled', async () => {
    const a = saveServer({ name: 'A', urls: ['https://a.example', 'https://other-origin.example'], instanceId: 'inst-a' });
    activateServer(a.id);
    setToken('tok-a');
    const b = saveServer({ name: 'B', urls: ['https://b.example'] });
    expect(beginLogout(b.id)).toBeNull();
    const record = beginLogout(a.id);
    expect(record).toEqual({ serverId: a.id, token: 'tok-a', urls: ['https://a.example'], instanceId: 'inst-a' });
    expect(getServer(a.id).token).toBeUndefined();
    expect(getToken()).toBe('');
    await flush();
    expect(JSON.parse(localStorage.getItem(PENDING_LOGOUTS_KEY))).toEqual([record]);
    setStorageAdapter(null);
    expect(getPendingLogouts(a.id)).toEqual([record]);
    settlePendingLogout(record);
    expect(getPendingLogouts(a.id)).toEqual([]);
    await flush();
    expect(localStorage.getItem(PENDING_LOGOUTS_KEY)).toBeNull();
    activateServer(a.id);
    setToken('tok-a2');
    beginLogout(a.id);
    removeServer(a.id);
    expect(getPendingLogouts(a.id)).toEqual([]);
  });

  it('an address of no saved server becomes a new server without a token', () => {
    setActiveBase('https://home.example');
    setToken('home-token');
    setActiveBase('https://home.example/manga');
    expect(getToken()).toBe('');
    setActiveBase('http://192.168.1.10:3000');
    expect(getToken()).toBe('');
    setActiveBase('https://home.example');
    expect(getToken()).toBe('home-token');
    expect(getServers()).toHaveLength(3);
  });

  it('without a session address the last good address is the base, else the first', () => {
    const s = saveServer({ urls: ['https://pub.example', 'http://10.0.0.2:3000'] });
    activateServer(s.id);
    expect(getActiveBase()).toBe('https://pub.example');
    updateServer(s.id, { lastOkUrl: 'http://10.0.0.2:3000' });
    expect(getActiveBase()).toBe('http://10.0.0.2:3000');
  });
});

describe('connection manager', () => {
  it('probeUrl accepts ok and degraded, refuses other instances, foreign answers and errors', async () => {
    const fetchImpl = vi.fn(async () => health(HEALTHY));
    expect(await probeUrl('https://a.example/', { fetchImpl })).toMatchObject({ ok: true, url: 'https://a.example', instanceId: 'inst-1', version: '2.20.0' });
    expect(fetchImpl).toHaveBeenCalledWith('https://a.example/api/health', expect.objectContaining({ credentials: 'omit' }));
    expect(fetchImpl.mock.calls[0][1].headers).toBeUndefined();
    expect((await probeUrl('https://a.example', { fetchImpl: async () => health({ ...HEALTHY, status: 'degraded' }) })).ok).toBe(true);
    expect(await probeUrl('https://a.example', { instanceId: 'other', fetchImpl })).toMatchObject({ ok: false, error: 'other-instance' });
    expect(await probeUrl('https://a.example', { fetchImpl: async () => health({ ...HEALTHY, status: 'error' }, 503) })).toMatchObject({ ok: false, error: 'unhealthy' });
    expect(await probeUrl('https://a.example', { fetchImpl: async () => new Response('<html>', { status: 200 }) })).toMatchObject({ error: 'not-manga-shelf' });
    expect(await probeUrl('https://a.example', { fetchImpl: async () => health({ name: 'Jellyfin', status: 'ok' }) })).toMatchObject({ error: 'not-manga-shelf' });
    expect(await probeUrl('https://a.example', { fetchImpl: async () => { throw new TypeError('offline'); } })).toMatchObject({ error: 'unreachable' });
    expect(await probeUrl('kein server', { fetchImpl })).toMatchObject({ error: 'invalid' });
  });

  it('probeUrl gives up after 3 s', async () => {
    vi.useFakeTimers();
    const hanging = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))));
    const pending = probeUrl('https://slow.example', { fetchImpl: hanging });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('probeServer takes the first address that answers, in order', async () => {
    const fetchImpl = vi.fn(async (url) => (url.startsWith('http://10.') ? health(HEALTHY) : Promise.reject(new TypeError('x'))));
    const result = await probeServer({ urls: ['https://pub.example', 'http://10.0.0.2:3000', 'https://third.example'] }, { fetchImpl });
    expect(result).toMatchObject({ ok: true, url: 'http://10.0.0.2:3000' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('checkConnection is inert in the browser build', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkConnection()).toMatchObject({ state: 'online', baseUrl: '' });
    expect(getConnection().state).toBe('online');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checkConnection (app build) uses the address that answers, remembers it and the instance id', async () => {
    vi.stubEnv('VITE_APP_MODE', 'app');
    const s = saveServer({ name: 'Home', urls: ['https://pub.example', 'http://10.0.0.2:3000'] });
    activateServer(s.id);
    vi.stubGlobal('fetch', vi.fn(async (url) => (url.startsWith('http://10.') ? health(HEALTHY) : Promise.reject(new TypeError('x')))));
    const state = await checkConnection();
    expect(state).toMatchObject({ state: 'online', baseUrl: 'http://10.0.0.2:3000', lastError: null });
    expect(state.server).toMatchObject({ id: s.id, lastOkUrl: 'http://10.0.0.2:3000', instanceId: 'inst-1' });
    expect(getActiveBase()).toBe('http://10.0.0.2:3000');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await checkConnection()).toMatchObject({ state: 'offline', lastError: 'nicht erreichbar', baseUrl: 'http://10.0.0.2:3000' });
  });

  it('a known server must name itself and carry its instance id; a bare {status:"ok"} is not enough', async () => {
    const answer = (body) => async () => health(body);
    expect(await probeUrl('http://192.168.1.10:3000', { instanceId: 'inst-1', fetchImpl: answer({ status: 'ok' }) })).toMatchObject({ ok: false, error: 'not-manga-shelf' });
    expect(await probeUrl('http://192.168.1.10:3000', { instanceId: 'inst-1', fetchImpl: answer({ name: 'Manga Shelf', status: 'ok' }) })).toMatchObject({ ok: false, error: 'other-instance' });
    expect(await probeUrl('http://192.168.1.10:3000', { instanceId: 'inst-1', fetchImpl: answer({ status: 'ok', instance_id: 'inst-1' }) })).toMatchObject({ ok: false, error: 'not-manga-shelf' });
    expect(await probeUrl('http://192.168.1.10:3000', { instanceId: 'inst-1', fetchImpl: answer(HEALTHY) })).toMatchObject({ ok: true });
    // a server not seen before may answer without them (older releases)
    expect(await probeUrl('http://192.168.1.10:3000', { fetchImpl: answer({ status: 'ok' }) })).toMatchObject({ ok: true, instanceId: null });
  });

  it('a server that answers with another instance id is not used', async () => {
    vi.stubEnv('VITE_APP_MODE', 'app');
    const s = saveServer({ urls: ['http://192.168.1.10:3000'], instanceId: 'mine' });
    activateServer(s.id);
    vi.stubGlobal('fetch', vi.fn(async () => health({ ...HEALTHY, instance_id: 'neighbour' })));
    expect(await checkConnection()).toMatchObject({ state: 'offline', lastError: 'gehört zu einem anderen Manga-Shelf-Server' });
  });

  it('re-checks on online, marks offline on offline and re-checks on visibility at most every 30 s', async () => {
    vi.stubEnv('VITE_APP_MODE', 'app');
    const s = saveServer({ urls: ['https://a.example'] });
    activateServer(s.id);
    const fetchMock = vi.fn(async () => health(HEALTHY));
    vi.stubGlobal('fetch', fetchMock);
    let now = 1000;
    const stop = startConnectionManager({ now: () => now });
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(getConnection().state).toBe('online'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('offline'));
    expect(getConnection()).toMatchObject({ state: 'offline', lastError: 'Keine Netzwerkverbindung' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += RECHECK_INTERVAL_MS;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    stop();
    window.dispatchEvent(new Event('online'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('connect links', () => {
  it('parses manga-shelf://connect links and plain addresses', () => {
    expect(parseConnectLink('manga-shelf://connect?url=https%3A%2F%2Fmanga.example.org%2F&name=Zuhause&id=abc')).toEqual({
      url: 'https://manga.example.org', name: 'Zuhause', instanceId: 'abc'
    });
    expect(parseConnectLink(' http://192.168.1.10:3000/ ')).toEqual({ url: 'http://192.168.1.10:3000', name: '', instanceId: null });
    expect(parseConnectLink('manga-shelf://connect?url=javascript%3Aalert(1)')).toBeNull();
    expect(parseConnectLink('manga-shelf://other?url=https%3A%2F%2Fa.example')).toBeNull();
    expect(parseConnectLink('https://')).toBeNull();
    expect(parseConnectLink('')).toBeNull();
    const link = buildConnectLink({ url: 'https://a.example', name: 'Manga Shelf', instanceId: 'id-1' });
    expect(parseConnectLink(link)).toEqual({ url: 'https://a.example', name: 'Manga Shelf', instanceId: 'id-1' });
  });

  it('links from the shells wait until the app takes them and are announced', () => {
    const seen = vi.fn();
    window.addEventListener(DEEP_LINK_EVENT, seen);
    const stop = installDeepLinkBridge(window);
    window.dispatchEvent(new CustomEvent(OPEN_URL_EVENT, { detail: { url: 'manga-shelf://connect?url=https%3A%2F%2Fa.example' } }));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(takePendingDeepLink()).toMatchObject({ url: 'https://a.example' });
    expect(takePendingDeepLink()).toBeNull();
    expect(window.mangashelfOpenUrl('kein link')).toBeNull();
    expect(receiveDeepLink('manga-shelf://connect?url=https%3A%2F%2Fb.example')).toMatchObject({ url: 'https://b.example' });
    expect(takePendingDeepLink().url).toBe('https://b.example');
    stop();
    window.removeEventListener(DEEP_LINK_EVENT, seen);
    expect(window.mangashelfOpenUrl).toBeUndefined();
  });

  it('a link with a known instance id finds its server', () => {
    const s = saveServer({ urls: ['https://a.example'], instanceId: 'inst-9' });
    expect(findServerByInstance('inst-9').id).toBe(s.id);
    expect(findServerByInstance(null)).toBeNull();
  });
});

function decodeQr(modules) {
  const scale = 4;
  const border = 4;
  const size = (modules.length + 2 * border) * scale;
  const lum = new Uint8ClampedArray(size * size).fill(255);
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) lum[((y + border) * scale + dy) * size + (x + border) * scale + dx] = 0;
    }
  }));
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, size, size)));
  return new QRCodeReader().decode(bitmap, new Map([[DecodeHintType.PURE_BARCODE, true]])).getText();
}

describe('QR encoder', () => {
  it('encodes connect links, umlauts and long texts that a QR reader decodes again, with every mask', () => {
    const link = buildConnectLink({ url: 'https://manga.example.org', name: 'Manga Shelf', instanceId: '4f1c2d3e-aaaa-bbbb-cccc-0123456789ab' });
    for (const text of ['a', link, 'Bücher – ✓', 'x'.repeat(300)]) {
      expect(decodeQr(encodeQr(text))).toBe(text);
    }
    for (let mask = 0; mask < 8; mask++) expect(decodeQr(encodeQr(link, { mask }))).toBe(link);
    for (let len = 1; len <= 600; len += 37) expect(decodeQr(encodeQr('z'.repeat(len)))).toBe('z'.repeat(len));
  });

  it('size grows with the text and stops at version 20', () => {
    expect(encodeQr('a')).toHaveLength(21);
    expect(encodeQr('x'.repeat(300)).length).toBeGreaterThan(41);
    expect(() => encodeQr('x'.repeat(2000))).toThrow(RangeError);
    expect(qrPath([[true, false], [false, true]], 1)).toBe('M1,1h1v1h-1zM2,2h1v1h-1z');
  });
});
