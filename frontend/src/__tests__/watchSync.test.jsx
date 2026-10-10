// Crunchyroll history sync of the apps: feature detection, the secret, login, the sync run and the foreground scheduler.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { renderHook, waitFor, act } from '@testing-library/react';
import { fakeResponse } from './fakeResponse';
import { COOKIE, ROTATED, ACCESS, EDITOR, historyRecord, fakeBridge, fakeDesktopBridge } from './watchFakes';
import { setServer } from '../utils/api';
import { notify } from '../utils/notify';
import { SECRET_KEY, readSecret, writeSecret, deleteSecret } from '../app/watch/crunchyrollSecret';
import useCrunchyroll from '../app/watch/useCrunchyroll';
import {
  runWatchSync, startWatchSync, connectCrunchyroll, disconnectCrunchyroll, syncNow, refreshWatch, watchConnected, SYNC_FLOOR_MS, SYNC_TEXTS,
  scopeOf, isSyncRunning
} from '../app/watch/crunchyrollSync';
import {
  watchBridge, watchAvailable, canSync, readState, patchState, STATE_KEY, UNMATCHED_KEY, SKIPPED_KEY, WATCH_SYNC_EVENT, loadUnmatched,
  resetUnmatchedView, skipUnmatched, pendingUnmatched, saveUnmatched
} from '../app/watch/watchState';

const crunchyroll = createRequire(import.meta.url)('../../../core/watch/crunchyroll.js');

const connect = async (fake, now = () => 1_000_000) => {
  await writeSecret(fake.bridge, { etp_rt: COOKIE, client_id: 'webClient_123', device_id: 'device-0001-abcd', account_id: null }, now());
  await patchState(fake.bridge, { enabled: true, connected_at: now() });
};

const okPost = (answer = { applied: [{ anime_id: 5, episodes_watched: 7, status: 'Schaue' }], unmatched: [] }) => vi.fn(async () => answer);
const tokenCalls = (fake) => fake.calls.filter((c) => c.url.endsWith('/auth/v1/token')).length;

beforeEach(() => {
  vi.stubEnv('VITE_APP_MODE', 'app');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetUnmatchedView();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.mangashelfNative;
  delete window.mangashelfDesktop;
  localStorage.clear();
});

describe('feature detection', () => {
  it('needs the app build, the WebLogin plugin and the flag not set to off', () => {
    const { bridge } = fakeBridge();
    const { native } = bridge;
    expect(watchBridge({})).toBeNull();
    expect(watchBridge({ mangashelfNative: native })).toEqual(bridge);
    expect(watchBridge({ mangashelfNative: native })).toBe(watchBridge({ mangashelfNative: native }));
    expect(watchBridge({ mangashelfNative: { ...native, platform: 'android' } })).toMatchObject({ kind: 'capacitor', platform: 'android' });
    expect(watchAvailable({ mangashelfNative: native })).toBe(true);
    expect(watchAvailable({ mangashelfNative: { ...native, plugins: { ...native.plugins, WebLogin: undefined } } })).toBe(false);
    vi.stubEnv('VITE_WATCH_CRUNCHYROLL', 'off');
    expect(watchBridge({ mangashelfNative: native })).toBeNull();
    vi.stubEnv('VITE_WATCH_CRUNCHYROLL', 'on');
    vi.stubEnv('VITE_APP_MODE', '');
    expect(watchBridge({ mangashelfNative: native })).toBeNull();
  });

  it('the desktop bridge wins when window.mangashelfDesktop.watch exists, in the app build and in the desktop web build', () => {
    const desktop = fakeDesktopBridge({ platform: 'windows' });
    const { native } = fakeBridge().bridge;
    const win = { mangashelfDesktop: { platform: 'win32', watch: desktop.watch }, mangashelfNative: native };
    expect(watchBridge(win)).toEqual({ kind: 'desktop', platform: 'windows', watch: desktop.watch });
    expect(watchBridge(win)).toBe(watchBridge({ mangashelfDesktop: { watch: desktop.watch } }));
    expect(watchBridge({ mangashelfDesktop: { platform: 'darwin' } })).toBeNull();
    vi.stubEnv('VITE_APP_MODE', '');
    expect(watchBridge(win)).toBeNull();
    vi.stubEnv('VITE_WATCH_DESKTOP', '1');
    expect(watchBridge(win)).toMatchObject({ kind: 'desktop' });
    expect(watchBridge({ mangashelfNative: native })).toBeNull();
    vi.stubEnv('VITE_WATCH_CRUNCHYROLL', 'off');
    expect(watchAvailable(win)).toBe(false);
  });

  it('only editors and admins online sync', () => {
    expect(canSync(EDITOR)).toBe(true);
    expect(canSync({ id: 1, role: 'admin', local: true })).toBe(true);
    expect(canSync({ id: 2, role: 'visitor' })).toBe(false);
    expect(canSync({ id: 3, role: 'visitor', realRole: 'editor', offline: true })).toBe(false);
    expect(canSync(null)).toBe(false);
  });
});

describe('the secret', () => {
  it('goes to the secure storage with this-device-only access and no iCloud sync, never to Preferences', async () => {
    const fake = fakeBridge();
    await writeSecret(fake.bridge, { etp_rt: COOKIE, client_id: 'webClient_123', device_id: 'device-0001-abcd' }, 42);
    const [key, data, convertDate, sync, access] = fake.bridge.native.plugins.SecureStorage.set.mock.calls[0];
    expect([key, convertDate, sync, access]).toEqual([SECRET_KEY, false, false, 1]);
    expect(data).toMatchObject({ etp_rt: COOKIE, client_id: 'webClient_123', saved_at: 42 });
    expect(await readSecret(fake.bridge)).toMatchObject({ etp_rt: COOKIE });
    expect(fake.bridge.native.plugins.Preferences.set).not.toHaveBeenCalled();
    await deleteSecret(fake.bridge);
    expect(fake.secure.size).toBe(0);
  });

  it('falls back to access 1 without the constant and counts an unreadable item as not connected', async () => {
    const fake = fakeBridge();
    fake.bridge.native.constants = {};
    await writeSecret(fake.bridge, { etp_rt: COOKIE, client_id: 'webClient_123' });
    expect(fake.bridge.native.plugins.SecureStorage.set.mock.calls[0][4]).toBe(1);
    fake.bridge.native.plugins.SecureStorage.get.mockRejectedValueOnce(new Error('errSecInteractionNotAllowed'));
    expect(await readSecret(fake.bridge)).toBeNull();
    await expect(writeSecret(fake.bridge, { etp_rt: '' })).rejects.toThrow();
  });

  it('a server switch (createServerStorage only removes server-token:*) cannot reach its key', () => {
    expect(SECRET_KEY.startsWith('server-token:')).toBe(false);
    expect(SECRET_KEY.startsWith('local-secret:')).toBe(false);
  });
});

describe('connecting', () => {
  it('opens the native login with the core options and stores cookie, client id and a device id', async () => {
    const fake = fakeBridge();
    expect(await connectCrunchyroll({ bridge: fake.bridge, now: () => 5 })).toEqual({ connected: true });
    expect(fake.bridge.native.plugins.WebLogin.open).toHaveBeenCalledWith(crunchyroll.LOGIN_OPTIONS);
    const secret = await readSecret(fake.bridge);
    expect(secret).toMatchObject({ etp_rt: COOKIE, client_id: 'webClient_123' });
    expect(secret.device_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readState(fake.bridge)).toMatchObject({ enabled: true, connected_at: 5, last_error: null });
    expect([...fake.prefs.values()].join(' ')).not.toContain(COOKIE);
  });

  it('a closed login sheet changes nothing and shows no error', async () => {
    const fake = fakeBridge();
    fake.bridge.native.plugins.WebLogin.open.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    expect(await connectCrunchyroll({ bridge: fake.bridge })).toEqual({ cancelled: true });
    expect(fake.secure.size).toBe(0);
    expect(await readState(fake.bridge)).toEqual({});
  });

  it('a failed login, an open login or a missing cookie ends in the state', async () => {
    const fake = fakeBridge();
    fake.bridge.native.plugins.WebLogin.open.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'busy' }));
    await expect(connectCrunchyroll({ bridge: fake.bridge })).rejects.toThrow(SYNC_TEXTS.loginBusy);
    expect(SYNC_TEXTS.loginBusy).toBe('Die Crunchyroll-Anmeldung ist schon offen');
    fake.bridge.native.plugins.WebLogin.open.mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 'failed' }));
    await expect(connectCrunchyroll({ bridge: fake.bridge })).rejects.toThrow(SYNC_TEXTS.loginFailed);
    fake.bridge.native.plugins.WebLogin.open.mockResolvedValueOnce({ cookie: { value: '' }, scriptResult: null });
    await expect(connectCrunchyroll({ bridge: fake.bridge })).rejects.toThrow(SYNC_TEXTS.noCookie);
    expect((await readState(fake.bridge)).last_error).toBe(SYNC_TEXTS.noCookie);
    expect(fake.secure.size).toBe(0);
  });

  it('keeps the device id on a new login and the opt-out removes secret and list', async () => {
    const fake = fakeBridge();
    await connectCrunchyroll({ bridge: fake.bridge });
    const first = (await readSecret(fake.bridge)).device_id;
    await connectCrunchyroll({ bridge: fake.bridge });
    expect((await readSecret(fake.bridge)).device_id).toBe(first);
    fake.prefs.set(UNMATCHED_KEY, JSON.stringify({ scope: 'x', items: [] }));
    await disconnectCrunchyroll({ bridge: fake.bridge, optOut: true });
    expect(fake.secure.size).toBe(0);
    expect(fake.prefs.has(UNMATCHED_KEY)).toBe(false);
    expect(await readState(fake.bridge)).toMatchObject({ enabled: false, connected_at: null, last_ok: null });
  });
});

describe('one sync run', () => {
  it('token, history, then only the parsed items to POST /api/anime/watch-sync', async () => {
    const fake = fakeBridge({ discover: { data: [historyRecord({ series: 'GSERIES002', title: 'Dandadan', episode: 3, fully: false })] } });
    await connect(fake);
    const post = okPost();
    const seen = vi.fn();
    window.addEventListener(WATCH_SYNC_EVENT, seen);
    const result = await runWatchSync({ bridge: fake.bridge, user: EDITOR, post, now: () => 2_000_000 });
    window.removeEventListener(WATCH_SYNC_EVENT, seen);
    expect(result).toEqual({ ran: true, applied: 1, added: 0, unmatched: 0 });

    const [token, watch, discover] = fake.calls;
    expect(token).toMatchObject({ method: 'POST', url: 'https://www.crunchyroll.com/auth/v1/token' });
    expect(token.headers.Authorization).toBe(`Basic ${btoa('webClient_123:')}`);
    expect(token.headers.Cookie).toBe(`etp_rt=${COOKIE}`);
    expect(watch.url).toContain('/content/v2/acc-1/watch-history');
    expect(watch.headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(discover.url).toContain('/content/v2/discover/acc-1/history');
    expect(fake.calls).toHaveLength(3);

    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0];
    expect(path).toBe('/api/anime/watch-sync');
    expect(body.service).toBe('crunchyroll');
    expect(body.items.map((i) => [i.external_id, i.episode, i.fully_watched])).toEqual([['GSERIES001', 7, true], ['GSERIES002', 3, false]]);
    expect(Object.keys(body.items[0]).sort()).toEqual([
      'episode', 'external_id', 'fully_watched', 'resume_episode', 'resume_url', 'season', 'series_slug', 'series_title', 'watched_at'
    ]);
    expect(Object.keys(body).sort()).toEqual(['auto_add', 'items', 'platform', 'service', 'skip']);
    expect([body.skip, body.auto_add, body.platform]).toEqual([[], true, 'ios']);
    const sent = JSON.stringify(body);
    for (const secret of [COOKIE, ACCESS, 'webClient_123', 'device-0001-abcd', 'acc-1']) expect(sent).not.toContain(secret);

    expect(seen.mock.calls[0][0].detail).toEqual({ service: 'crunchyroll', applied: 1, added: 0, changed: true, watch: null });
    expect(await readState(fake.bridge)).toMatchObject({ last_attempt: 2_000_000, last_ok: 2_000_000, last_error: null });
    expect((await readSecret(fake.bridge)).account_id).toBe('acc-1');
  });

  it('goes to the collection through utils/api and never through window.fetch to crunchyroll.com', async () => {
    const fake = fakeBridge();
    await connect(fake);
    setServer({ base: 'https://shelf.example', token: 'server-token-1' });
    const fetchMock = vi.fn(async () => fakeResponse(200, { applied: [], unmatched: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await runWatchSync({ bridge: fake.bridge, user: EDITOR });
    expect(result.ran).toBe(true);
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://shelf.example/api/anime/watch-sync');
    const hosts = fetchMock.mock.calls.map(([u]) => new URL(String(u), 'https://shelf.example').hostname);
    expect(hosts.filter((host) => host === 'crunchyroll.com' || host.endsWith('.crunchyroll.com'))).toEqual([]);
    for (const secret of [COOKIE, ACCESS, 'etp_rt']) expect(String(init.body)).not.toContain(secret);
    expect(JSON.stringify(init.headers)).not.toContain(COOKIE);
    setServer({ base: '', token: null });
  });

  it('persists a rotated etp_rt at once (the platform cookie list first, then Set-Cookie)', async () => {
    const fake = fakeBridge({ token: { cookies: [{ name: 'etp_rt', value: ROTATED, expires: null }] } });
    await connect(fake);
    await runWatchSync({ bridge: fake.bridge, user: EDITOR, post: okPost() });
    expect((await readSecret(fake.bridge)).etp_rt).toBe(ROTATED);

    const other = fakeBridge({ token: { headers: { 'set-cookie': `__cf_bm=x; Path=/, etp_rt=${ROTATED}; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly` } } });
    await connect(other);
    await runWatchSync({ bridge: other.bridge, user: EDITOR, post: okPost() });
    expect((await readSecret(other.bridge)).etp_rt).toBe(ROTATED);
  });

  it('asks /accounts/v1/me only when neither the token answer nor the secret has the account', async () => {
    const fake = fakeBridge({ token: { text: JSON.stringify({ access_token: ACCESS }) } });
    await connect(fake);
    await runWatchSync({ bridge: fake.bridge, user: EDITOR, post: okPost() });
    expect(fake.calls.map((c) => c.url.split('crunchyroll.com')[1].split('?')[0])).toEqual([
      '/auth/v1/token', '/accounts/v1/me', '/content/v2/acc-1/watch-history', '/content/v2/discover/acc-1/history'
    ]);
  });

  it.each([
    ['401', { status: 401, text: '{}' }],
    ['invalid_grant', { status: 400, text: JSON.stringify({ error: 'invalid_grant' }) }],
    ['invalid_client', { status: 400, text: JSON.stringify({ error: 'invalid_client' }) }]
  ])('%s clears the secret and asks to reconnect, without a retry or a request to the collection', async (_name, token) => {
    const fake = fakeBridge({ token });
    await connect(fake);
    fake.prefs.set(UNMATCHED_KEY, JSON.stringify({ scope: 'a', items: [] }));
    const post = okPost();
    const result = await runWatchSync({ bridge: fake.bridge, user: EDITOR, post });
    expect(result).toEqual({ ran: true, error: 'Bitte erneut verbinden' });
    expect(fake.secure.size).toBe(0);
    expect(fake.prefs.has(UNMATCHED_KEY)).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(tokenCalls(fake)).toBe(1);
    expect(await readState(fake.bridge)).toMatchObject({ last_error: 'Bitte erneut verbinden', connected_at: null, enabled: true });
    expect(console.warn).toHaveBeenCalled();
    expect(JSON.stringify(console.warn.mock.calls)).not.toContain(COOKIE);
  });

  it('a Cloudflare block or a dead network keeps the secret and only notes the error', async () => {
    const fake = fakeBridge({ token: { status: 403, text: '<html>' } });
    await connect(fake);
    expect((await runWatchSync({ bridge: fake.bridge, user: EDITOR, post: okPost() })).error).toBe(crunchyroll.MESSAGES.blocked);
    expect(await readSecret(fake.bridge)).not.toBeNull();

    const down = fakeBridge();
    await connect(down);
    down.bridge.native.plugins.WebLogin.request.mockRejectedValue(Object.assign(new Error('offline'), { code: 'network' }));
    const result = await runWatchSync({ bridge: down.bridge, user: EDITOR, post: okPost() });
    expect(result.error).toBe(crunchyroll.MESSAGES.unavailable);
    expect((await readState(down.bridge)).last_error_at).toEqual(expect.any(Number));
  });

  it('one failing history list is fine when the other one answered', async () => {
    const fake = fakeBridge();
    fake.answers.discover = { status: 500, text: '', headers: {} };
    await connect(fake);
    const post = okPost();
    expect((await runWatchSync({ bridge: fake.bridge, user: EDITOR, post })).error).toBeUndefined();
    expect(post.mock.calls[0][1].items).toHaveLength(1);
  });

  it('an empty history sends nothing unless forced; collection errors are named', async () => {
    const fake = fakeBridge({ history: { data: [] } });
    await connect(fake);
    const post = okPost({ applied: [], unmatched: [] });
    expect(await runWatchSync({ bridge: fake.bridge, user: EDITOR, post })).toEqual({ ran: true, applied: 0, added: 0, unmatched: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(await runWatchSync({ bridge: fake.bridge, user: EDITOR, post, force: true })).toEqual({ ran: true, applied: 0, added: 0, unmatched: 0 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].items).toEqual([]);

    const old = fakeBridge();
    await connect(old);
    const missing = vi.fn(async () => { throw Object.assign(new Error('Nicht gefunden'), { status: 404 }); });
    expect((await runWatchSync({ bridge: old.bridge, user: EDITOR, post: missing })).error).toBe(SYNC_TEXTS.serverMissing);
    const offline = vi.fn(async () => { throw Object.assign(new Error('Netzwerkfehler'), { status: 0 }); });
    expect((await runWatchSync({ bridge: old.bridge, user: EDITOR, post: offline, force: true })).error).toBe(SYNC_TEXTS.serverUnreachable);
    expect(await readSecret(old.bridge)).not.toBeNull();
  });

  it('keeps the unmatched series per collection', async () => {
    const fake = fakeBridge();
    await connect(fake);
    const unmatched = [{ external_id: 'GSERIES001', series_title: 'Sousou no Frieren', season: 1, episode: 7, episodes_watched: 7, candidates: [] }];
    await runWatchSync({ bridge: fake.bridge, user: EDITOR, post: okPost({ applied: [], unmatched }) });
    const stored = JSON.parse(fake.prefs.get(UNMATCHED_KEY));
    expect(stored.scope).toBe(scopeOf(EDITOR));
    expect(stored.items).toHaveLength(1);
  });

  it('skips without any request: feature off, not connected, visitor, offline', async () => {
    const fake = fakeBridge();
    expect(await runWatchSync({ bridge: fake.bridge, user: EDITOR })).toEqual({ ran: false, reason: 'off' });
    await patchState(fake.bridge, { enabled: true });
    expect(await runWatchSync({ bridge: fake.bridge, user: EDITOR })).toEqual({ ran: false, reason: 'not_connected' });
    await connect(fake);
    expect(await runWatchSync({ bridge: fake.bridge, user: { id: 9, role: 'visitor' } })).toEqual({ ran: false, reason: 'role' });
    fake.bridge.native.plugins.Network.getStatus.mockResolvedValueOnce({ connected: false });
    expect(await runWatchSync({ bridge: fake.bridge, user: EDITOR })).toEqual({ ran: false, reason: 'offline' });
    expect(await runWatchSync({ bridge: null, user: EDITOR })).toEqual({ ran: false, reason: 'unavailable' });
    expect(fake.calls).toHaveLength(0);
  });

  it('a broken storage plugin ends the run quietly', async () => {
    const fake = fakeBridge();
    fake.bridge.native.plugins.Preferences.get.mockRejectedValue(new Error('io'));
    fake.bridge.native.plugins.Preferences.set.mockRejectedValue(new Error('io'));
    expect(await runWatchSync({ bridge: fake.bridge, user: EDITOR })).toEqual({ ran: false, reason: 'off' });
    fake.bridge.native.plugins.Preferences.get.mockResolvedValue({ value: JSON.stringify({ enabled: true }) });
    await writeSecret(fake.bridge, { etp_rt: COOKIE, client_id: 'webClient_123' });
    expect(await runWatchSync({ bridge: fake.bridge, user: EDITOR })).toEqual({ ran: false, reason: 'error' });
    expect(fake.calls).toHaveLength(0);
  });

  it('is single flight', async () => {
    const fake = fakeBridge();
    await connect(fake);
    const post = okPost();
    const [a, b] = await Promise.all([
      runWatchSync({ bridge: fake.bridge, user: EDITOR, post }), runWatchSync({ bridge: fake.bridge, user: EDITOR, post, force: true })
    ]);
    expect(a).toBe(b);
    expect(tokenCalls(fake)).toBe(1);
  });
});

/** Holds the next WebLogin.request to `match` until release(answer); `reached` resolves once it is pending. */
function holdRequest(fake, match) {
  const original = fake.bridge.native.plugins.WebLogin.request.getMockImplementation();
  let release;
  let arrived;
  const reached = new Promise((r) => { arrived = r; });
  fake.bridge.native.plugins.WebLogin.request.mockImplementation(async (req) => {
    if (!match(req.url)) return original(req);
    fake.calls.push(req);
    arrived();
    return new Promise((r) => { release = r; });
  });
  return { reached, release: (answer) => release(answer) };
}

describe("'Trennen' and the opt-out during a running sync", () => {
  const UNMATCHED = [{ external_id: 'GSERIES009', series_title: 'Oshi no Ko', season: 1, episode: 3, episodes_watched: 3, candidates: [] }];

  it.each([['Trennen', false], ['the opt-out', true]])('%s while the token request runs: the rotated login is not written back', async (_name, optOut) => {
    const fake = fakeBridge();
    await connect(fake);
    const hold = holdRequest(fake, (url) => url.endsWith('/auth/v1/token'));
    const post = okPost({ applied: [], unmatched: UNMATCHED });
    const run = runWatchSync({ bridge: fake.bridge, user: EDITOR, post });
    await hold.reached;
    expect(isSyncRunning()).toBe(true);
    await disconnectCrunchyroll({ bridge: fake.bridge, optOut });
    hold.release({ ...fake.answers.token, cookies: [{ name: 'etp_rt', value: ROTATED, expires: null }] });
    expect(await run).toEqual({ ran: false, reason: 'stale' });
    expect(isSyncRunning()).toBe(false);
    expect(fake.secure.size).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(fake.prefs.has(UNMATCHED_KEY)).toBe(false);
    expect(await readState(fake.bridge)).toMatchObject({ connected_at: null, last_ok: null, last_error: null, enabled: !optOut });
  });

  it('while the collection answers: the progress stays (list reload), but no unmatched list and no last_ok come back', async () => {
    const fake = fakeBridge();
    await connect(fake);
    let answer;
    const post = vi.fn(() => new Promise((r) => { answer = r; }));
    const seen = vi.fn();
    window.addEventListener(WATCH_SYNC_EVENT, seen);
    const run = runWatchSync({ bridge: fake.bridge, user: EDITOR, post });
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    await disconnectCrunchyroll({ bridge: fake.bridge });
    answer({ applied: [{ anime_id: 5, episodes_watched: 7, status: 'Schaue' }], unmatched: UNMATCHED });
    expect(await run).toEqual({ ran: false, reason: 'stale' });
    window.removeEventListener(WATCH_SYNC_EVENT, seen);
    expect(seen.mock.calls[0][0].detail).toMatchObject({ changed: true });
    expect(fake.secure.size).toBe(0);
    expect(fake.prefs.has(UNMATCHED_KEY)).toBe(false);
    expect((await readState(fake.bridge)).last_ok).toBeNull();
  });

  it("a write already on its way when 'Trennen' deletes is undone", async () => {
    const fake = fakeBridge({ token: { cookies: [{ name: 'etp_rt', value: ROTATED, expires: null }] } });
    await connect(fake);
    const { set } = fake.bridge.native.plugins.SecureStorage;
    const original = set.getMockImplementation();
    let disconnecting;
    set.mockImplementation(async (...args) => {
      // 'Trennen' bumps and deletes while this write is pending; the write lands after the delete
      if (!disconnecting) disconnecting = disconnectCrunchyroll({ bridge: fake.bridge });
      await disconnecting;
      return original(...args);
    });
    expect(await runWatchSync({ bridge: fake.bridge, user: EDITOR, post: okPost() })).toEqual({ ran: false, reason: 'stale' });
    expect(fake.secure.size).toBe(0);
  });

  it("disconnect clears the skipped series too, so a reconnect shows them again", async () => {
    const fake = fakeBridge();
    await connect(fake);
    await loadUnmatched(fake.bridge, 'srv:3');
    await skipUnmatched(fake.bridge, UNMATCHED[0]);
    expect(JSON.parse(fake.prefs.get(SKIPPED_KEY))).toEqual(['GSERIES009:1']);
    await disconnectCrunchyroll({ bridge: fake.bridge });
    expect(fake.prefs.has(SKIPPED_KEY)).toBe(false);
    fake.prefs.set(UNMATCHED_KEY, JSON.stringify({ scope: 'srv:3', items: UNMATCHED }));
    await loadUnmatched(fake.bridge, 'srv:3');
    expect(pendingUnmatched().map((u) => u.external_id)).toEqual(['GSERIES009']);
  });
});

describe('a server or user switch during a running sync', () => {
  it('drops the old run before its POST; the new session runs after it, not inside it', async () => {
    const fake = fakeBridge();
    await connect(fake);
    const fetchMock = vi.fn(async () => fakeResponse(200, { applied: [], unmatched: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const hold = holdRequest(fake, (url) => url.endsWith('/auth/v1/token'));
    const stopA = startWatchSync({ user: EDITOR, bridge: fake.bridge });
    await hold.reached;
    const first = runWatchSync({ bridge: fake.bridge, user: EDITOR });

    const OTHER = { id: 7, role: 'editor', username: 'lea' };
    stopA();
    const stopB = startWatchSync({ user: OTHER, bridge: fake.bridge });
    await new Promise((r) => setTimeout(r, 10));
    const second = runWatchSync({ bridge: fake.bridge, user: OTHER });
    expect(second).not.toBe(first);
    fake.bridge.native.plugins.WebLogin.request.mockImplementation(fakeBridge().bridge.native.plugins.WebLogin.request.getMockImplementation());
    hold.release(fake.answers.token);

    expect(await first).toEqual({ ran: false, reason: 'scope' });
    expect(await second).toMatchObject({ ran: true });
    const posts = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/anime/watch-sync'));
    expect(posts).toHaveLength(1);
    expect(JSON.parse(fake.prefs.get(UNMATCHED_KEY)).scope).toBe(scopeOf(OTHER));
    stopB();
  });
});

describe('the server limit (throttled)', () => {
  it('keeps the stored unmatched series and reports no change', async () => {
    const fake = fakeBridge();
    await connect(fake);
    const stored = { scope: scopeOf(EDITOR), items: [{ external_id: 'GSERIES001', series_title: 'Frieren', season: 1, episode: 7, episodes_watched: 7, candidates: [] }] };
    fake.prefs.set(UNMATCHED_KEY, JSON.stringify(stored));
    const seen = vi.fn();
    window.addEventListener(WATCH_SYNC_EVENT, seen);
    const result = await runWatchSync({ bridge: fake.bridge, user: EDITOR, post: okPost({ applied: [], unmatched: [], throttled: true }) });
    window.removeEventListener(WATCH_SYNC_EVENT, seen);
    expect(result).toEqual({ ran: false, reason: 'throttled', retryIn: 30 });
    expect(JSON.parse(fake.prefs.get(UNMATCHED_KEY)).items).toHaveLength(1);
    expect(seen).not.toHaveBeenCalled();
    expect((await readState(fake.bridge)).last_error ?? null).toBeNull();
  });
});

describe('the foreground scheduler', () => {
  it('runs on start and on return to the foreground, at most every 15 minutes', async () => {
    const fake = fakeBridge();
    let clock = 10_000_000;
    const now = () => clock;
    await connect(fake, now);
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, { applied: [], unmatched: [] })));
    const stop = startWatchSync({ user: EDITOR, bridge: fake.bridge, now });
    await vi.waitFor(() => expect(tokenCalls(fake)).toBe(1));
    await vi.waitFor(async () => expect((await readState(fake.bridge)).last_ok).toBe(clock));

    fake.emit('appStateChange', { isActive: true });
    clock += SYNC_FLOOR_MS - 60001;
    fake.emit('appStateChange', { isActive: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(tokenCalls(fake)).toBe(1);

    clock += 1;
    fake.emit('appStateChange', { isActive: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(tokenCalls(fake)).toBe(1);
    fake.emit('appStateChange', { isActive: true });
    await vi.waitFor(() => expect(tokenCalls(fake)).toBe(2));

    stop();
    await vi.waitFor(() => expect(fake.listeners.appStateChange).toHaveLength(0));
    clock += SYNC_FLOOR_MS;
    fake.emit('appStateChange', { isActive: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(tokenCalls(fake)).toBe(2);
  });

  it('a failed attempt also waits for the floor (no retry loop)', async () => {
    const fake = fakeBridge({ token: { status: 503, text: '' } });
    let clock = 50_000_000;
    await connect(fake);
    const stop = startWatchSync({ user: EDITOR, bridge: fake.bridge, now: () => clock });
    await vi.waitFor(async () => expect((await readState(fake.bridge)).last_error).toBe(crunchyroll.MESSAGES.unavailable));
    clock += 60_000;
    fake.emit('appStateChange', { isActive: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(tokenCalls(fake)).toBe(1);
    stop();
  });

  it('does nothing for visitors, offline users or without the bridge', async () => {
    const fake = fakeBridge();
    await connect(fake);
    startWatchSync({ user: { id: 1, role: 'visitor' }, bridge: fake.bridge })();
    startWatchSync({ user: { ...EDITOR, offline: true }, bridge: fake.bridge })();
    startWatchSync({ user: EDITOR, bridge: null })();
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.bridge.native.plugins.App.addListener).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it("'Jetzt abgleichen' ignores the floor and uses the scheduler's user", async () => {
    const fake = fakeBridge();
    await connect(fake);
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, { applied: [], unmatched: [] })));
    const stop = startWatchSync({ user: EDITOR, bridge: fake.bridge });
    await vi.waitFor(() => expect(tokenCalls(fake)).toBe(1));
    await vi.waitFor(async () => expect((await readState(fake.bridge)).last_ok).toEqual(expect.any(Number)));
    await syncNow({ bridge: fake.bridge });
    expect(tokenCalls(fake)).toBe(2);
    stop();
    expect(await syncNow({ bridge: fake.bridge })).toEqual({ ran: false, reason: 'role' });
  });

  it('loads the stored unmatched series of this collection only', async () => {
    const fake = fakeBridge();
    const item = { external_id: 'GSERIES001', series_title: 'Frieren', season: 1, episode: 7, episodes_watched: 7, candidates: [] };
    fake.prefs.set(UNMATCHED_KEY, JSON.stringify({ scope: 'other:3', items: [item] }));
    const { pendingUnmatched } = await import('../app/watch/watchState');
    await loadUnmatched(fake.bridge, scopeOf(EDITOR));
    expect(pendingUnmatched()).toEqual([]);
    fake.prefs.set(UNMATCHED_KEY, JSON.stringify({ scope: scopeOf(EDITOR), items: [item, { ...item, external_id: 'GZERO00001', episodes_watched: 0, episode: 0 }] }));
    await loadUnmatched(fake.bridge, scopeOf(EDITOR));
    expect(pendingUnmatched().map((u) => u.external_id)).toEqual(['GSERIES001']);
  });

  it('state writes keep each other (toggle during a sync)', async () => {
    const fake = fakeBridge();
    await Promise.all([patchState(fake.bridge, { enabled: true }), patchState(fake.bridge, { last_ok: 1 })]);
    expect(JSON.parse(fake.prefs.get(STATE_KEY))).toEqual({ enabled: true, last_ok: 1 });
  });
});

const ADDED = [
  { anime_id: 11, title: 'Dandadan', external_id: 'GSERIES002', season: 1, episodes_watched: 0, status: 'Schaue' },
  { anime_id: 12, title: 'Kaiju No. 8', external_id: 'GSERIES003', season: 2, episodes_watched: 3, status: 'Schaue' }
];

/** Toasts shown while `fn` runs. */
async function toastsOf(fn) {
  const shown = [];
  const stop = notify.subscribe((e) => { if (e.type === 'show') shown.push(e.toast); });
  try {
    await fn();
  } finally {
    stop();
  }
  return shown;
}

describe('series added by the server', () => {
  it('one toast with the title, 15 s and undo; the event carries the counts and the watch object', async () => {
    const fake = fakeBridge();
    await connect(fake);
    const watch = { auto_add: true, last_at: 5, last_platform: 'ios', last_applied: 1, last_added: 1 };
    const seen = vi.fn();
    window.addEventListener(WATCH_SYNC_EVENT, seen);
    let result;
    const toasts = await toastsOf(async () => {
      result = await runWatchSync({ bridge: fake.bridge, user: EDITOR, post: okPost({ applied: [], unmatched: [], added: [ADDED[0]], watch }) });
    });
    window.removeEventListener(WATCH_SYNC_EVENT, seen);
    expect(result).toEqual({ ran: true, applied: 0, added: 1, unmatched: 0 });
    expect(seen.mock.calls[0][0].detail).toEqual({ service: 'crunchyroll', applied: 0, added: 1, changed: true, watch });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: 'success', message: 'Neu in der Liste: Dandadan', duration: 15000, action: { label: 'Rückgängig' } });
  });

  it('several: counted; undo posts each key in turn, then reloads the list', async () => {
    const fake = fakeBridge();
    await connect(fake);
    const post = vi.fn(async (path) => (path === '/api/anime/watch-sync' ? { applied: [], unmatched: [], added: ADDED } : { removed: 'entry' }));
    const toasts = await toastsOf(() => runWatchSync({ bridge: fake.bridge, user: EDITOR, post }));
    expect(toasts[0].message).toBe('2 Serien neu in der Liste');
    const seen = vi.fn();
    window.addEventListener(WATCH_SYNC_EVENT, seen);
    toasts[0].action.onClick();
    await vi.waitFor(() => expect(seen).toHaveBeenCalled());
    window.removeEventListener(WATCH_SYNC_EVENT, seen);
    expect(post.mock.calls.slice(1)).toEqual([
      ['/api/anime/watch-sync/undo', { anime_id: 11, external_id: 'GSERIES002', season: 1 }],
      ['/api/anime/watch-sync/undo', { anime_id: 12, external_id: 'GSERIES003', season: 2 }]
    ]);
    expect(seen.mock.calls[0][0].detail).toEqual({ service: 'crunchyroll', applied: 0, added: 0, changed: true, watch: null });
  });

  it('a failed undo stops at once with one error; the list reloads only when one undo went through', async () => {
    const fake = fakeBridge();
    await connect(fake);
    const refused = Object.assign(new Error('Rückgängig geht nicht mehr'), { status: 409 });
    let undos = 0;
    const post = vi.fn(async (path) => {
      if (path === '/api/anime/watch-sync') return { applied: [], unmatched: [], added: ADDED };
      undos += 1;
      if (undos === 2) throw refused;
      return { removed: 'progress' };
    });
    const toasts = await toastsOf(() => runWatchSync({ bridge: fake.bridge, user: EDITOR, post }));
    const seen = vi.fn();
    window.addEventListener(WATCH_SYNC_EVENT, seen);
    const errors = await toastsOf(async () => {
      toasts[0].action.onClick();
      await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    });
    expect(errors.filter((e) => e.kind === 'error')).toHaveLength(1);

    post.mockClear();
    post.mockImplementation(async () => { throw refused; });
    toasts[0].action.onClick();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    window.removeEventListener(WATCH_SYNC_EVENT, seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('manual refresh', () => {
  it('posts the skipped keys and waits out the server limit per collection before touching Crunchyroll', async () => {
    const fake = fakeBridge();
    await connect(fake);
    fake.prefs.set(SKIPPED_KEY, JSON.stringify(['GSERIES009:1', 'GSERIES010:2']));
    let clock = 5_000_000;
    const now = () => clock;
    const throttled = okPost({ applied: [], unmatched: [], added: [], throttled: true, retry_after: 12 });
    expect(await runWatchSync({ bridge: fake.bridge, user: EDITOR, post: throttled, now, force: true })).toEqual({ ran: false, reason: 'throttled', retryIn: 12 });
    expect(throttled.mock.calls[0][1].skip).toEqual(['GSERIES009:1', 'GSERIES010:2']);
    expect(tokenCalls(fake)).toBe(1);

    clock += 4500;
    const post = okPost();
    expect(await runWatchSync({ bridge: fake.bridge, user: EDITOR, post, now, force: true })).toEqual({ ran: false, reason: 'throttled', retryIn: 8 });
    expect(tokenCalls(fake)).toBe(1);
    expect(post).not.toHaveBeenCalled();
    const OTHER = { id: 8, role: 'editor' };
    expect((await runWatchSync({ bridge: fake.bridge, user: OTHER, post, now, force: true })).ran).toBe(true);

    clock += 7500;
    expect((await runWatchSync({ bridge: fake.bridge, user: EDITOR, post, now, force: true })).ran).toBe(true);
    expect(tokenCalls(fake)).toBe(3);
  });

  it('refreshWatch is a forced run of the given user; watchConnected reads the secure storage', async () => {
    const fake = fakeBridge({ history: { data: [] } });
    window.mangashelfNative = fake.bridge.native;
    expect(await watchConnected()).toBe(false);
    await connect(fake);
    expect(await watchConnected()).toBe(true);
    const fetchMock = vi.fn(async () => fakeResponse(200, { applied: [], unmatched: [], added: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await patchState(fake.bridge, { last_attempt: Date.now() });
    expect(await refreshWatch({ user: EDITOR })).toEqual({ ran: true, applied: 0, added: 0, unmatched: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await refreshWatch({ user: { id: 2, role: 'visitor' } })).toEqual({ ran: false, reason: 'role' });
  });
});

describe('on the desktop (window.mangashelfDesktop.watch)', () => {
  const ITEM = { external_id: 'GSERIES001', series_title: 'Frieren', series_slug: 'frieren', season: 1, episode: 7, fully_watched: true,
    resume_url: null, resume_episode: null, watched_at: '2026-10-01T20:00:00.000Z' };
  const desktopFake = async (options) => {
    const fake = fakeDesktopBridge(options);
    await patchState(fake.bridge, { enabled: true, connected_at: 1 });
    return fake;
  };
  const syncCalls = (fake) => fake.calls.filter((c) => c.method === 'sync');

  it('keeps its state in the main-process prefs, never in the page', async () => {
    const fake = await desktopFake();
    expect(JSON.parse(fake.prefs.get(STATE_KEY))).toEqual({ enabled: true, connected_at: 1 });
    expect(await readState(fake.bridge)).toEqual({ enabled: true, connected_at: 1 });
    expect(localStorage.length).toBe(0);
  });

  it('a run: main fetches, the page posts the items with the platform and keeps the times', async () => {
    const fake = await desktopFake({ sync: { ok: true, items: [ITEM] } });
    const post = okPost();
    const result = await runWatchSync({ bridge: fake.bridge, user: EDITOR, post, now: () => 7_000_000 });
    expect(result).toEqual({ ran: true, applied: 1, added: 0, unmatched: 0 });
    expect(syncCalls(fake)).toEqual([{ method: 'sync', args: [{ force: false }] }]);
    const body = post.mock.calls[0][1];
    expect(body).toMatchObject({ service: 'crunchyroll', auto_add: true, platform: 'macos', skip: [] });
    expect(body.items).toEqual([ITEM]);
    expect(await readState(fake.bridge)).toMatchObject({ last_attempt: 7_000_000, last_ok: 7_000_000, last_error: null });
    await syncNow({ bridge: fake.bridge, user: EDITOR, post });
    expect(syncCalls(fake)[1].args).toEqual([{ force: true }]);
  });

  it.each([
    ['background', { ran: false, reason: 'background' }],
    ['locked', { ran: false, reason: 'locked' }],
    ['unreadable', { ran: false, reason: 'unreadable' }],
    ['not_connected', { ran: false, reason: 'not_connected' }],
    ['stale', { ran: false, reason: 'stale' }]
  ])('%s writes nothing', async (code, expected) => {
    const fake = await desktopFake({ sync: { ok: false, code } });
    const before = fake.prefs.get(STATE_KEY);
    const post = okPost();
    expect(await runWatchSync({ bridge: fake.bridge, user: EDITOR, post })).toEqual(expected);
    expect(fake.prefs.get(STATE_KEY)).toBe(before);
    expect(post).not.toHaveBeenCalled();
  });

  it('too_soon comes back with retryIn and stores nothing', async () => {
    const fake = await desktopFake({ sync: { ok: false, code: 'too_soon', retryIn: 21 } });
    const before = fake.prefs.get(STATE_KEY);
    expect(await refreshWatch({ user: EDITOR })).toEqual({ ran: false, reason: 'unavailable' });
    window.mangashelfDesktop = { watch: fake.watch };
    vi.stubEnv('VITE_APP_MODE', '');
    vi.stubEnv('VITE_WATCH_DESKTOP', '1');
    expect(await refreshWatch({ user: EDITOR })).toEqual({ ran: false, reason: 'too_soon', retryIn: 21 });
    expect(fake.prefs.get(STATE_KEY)).toBe(before);
  });

  it.each([
    ['reconnect', 'Bitte erneut verbinden'],
    ['blocked', crunchyroll.MESSAGES.blocked],
    ['rate_limited', crunchyroll.MESSAGES.rate_limited],
    ['unavailable', crunchyroll.MESSAGES.unavailable],
    ['bad_response', crunchyroll.MESSAGES.bad_response],
    ['network', crunchyroll.MESSAGES.unavailable]
  ])('%s is noted as the last error', async (code, message) => {
    const fake = await desktopFake({ sync: { ok: false, code } });
    fake.prefs.set(UNMATCHED_KEY, JSON.stringify({ scope: scopeOf(EDITOR), items: [] }));
    const result = await runWatchSync({ bridge: fake.bridge, user: EDITOR, post: okPost(), now: () => 9 });
    expect(result).toEqual({ ran: true, error: message });
    const state = await readState(fake.bridge);
    expect(state).toMatchObject({ last_error: message, last_error_at: 9, last_attempt: 9 });
    expect(state.connected_at).toBe(code === 'reconnect' ? null : 1);
    expect(fake.prefs.has(UNMATCHED_KEY)).toBe(code !== 'reconnect');
  });

  it('a broken bridge call ends as a plain failure', async () => {
    const fake = await desktopFake();
    fake.watch.sync.mockRejectedValueOnce(new Error('ipc'));
    expect(await runWatchSync({ bridge: fake.bridge, user: EDITOR, post: okPost() })).toEqual({ ran: true, error: SYNC_TEXTS.failed });
  });

  it("'Trennen' while main fetches: nothing comes back", async () => {
    let answer;
    const fake = await desktopFake({ sync: () => new Promise((r) => { answer = r; }) });
    const post = okPost();
    const run = runWatchSync({ bridge: fake.bridge, user: EDITOR, post });
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    await disconnectCrunchyroll({ bridge: fake.bridge });
    answer({ ok: true, items: [ITEM] });
    expect(await run).toEqual({ ran: false, reason: 'stale' });
    expect(post).not.toHaveBeenCalled();
    expect(fake.calls.map((c) => c.method)).toContain('logout');
    expect(await readState(fake.bridge)).toMatchObject({ connected_at: null, last_ok: null, last_attempt: null });
  });

  it('no run at start; each foreground signal is one run, at most every 14 minutes', async () => {
    const fake = await desktopFake();
    let clock = 20_000_000;
    const stop = startWatchSync({ user: EDITOR, bridge: fake.bridge, now: () => clock });
    await vi.waitFor(() => expect(fake.watch.onForeground).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(syncCalls(fake)).toHaveLength(0);
    fake.foreground();
    await vi.waitFor(async () => expect((await readState(fake.bridge)).last_ok).toBe(clock));
    expect(syncCalls(fake)).toHaveLength(1);
    clock += SYNC_FLOOR_MS - 60001;
    fake.foreground();
    await new Promise((r) => setTimeout(r, 20));
    expect(syncCalls(fake)).toHaveLength(1);
    clock += 1;
    fake.foreground();
    await vi.waitFor(() => expect(syncCalls(fake)).toHaveLength(2));
    stop();
    expect(fake.foregroundListeners.size).toBe(0);
  });

  it('login answers: ok connects, busy and failed are noted, the rest writes nothing', async () => {
    const fake = fakeDesktopBridge();
    expect(await connectCrunchyroll({ bridge: fake.bridge, now: () => 4 })).toEqual({ connected: true });
    expect(await readState(fake.bridge)).toMatchObject({ enabled: true, connected_at: 4, last_error: null });

    fake.watch.login.mockResolvedValueOnce({ ok: false, code: 'busy' });
    await expect(connectCrunchyroll({ bridge: fake.bridge })).rejects.toThrow(SYNC_TEXTS.loginBusy);
    expect((await readState(fake.bridge)).last_error).toBe('Die Crunchyroll-Anmeldung ist schon offen');
    fake.watch.login.mockResolvedValueOnce({ ok: false, code: 'failed' });
    await expect(connectCrunchyroll({ bridge: fake.bridge })).rejects.toThrow(SYNC_TEXTS.loginFailed);

    const quiet = fakeDesktopBridge();
    for (const code of ['cancelled', 'unavailable', 'locked', 'unreadable']) {
      quiet.watch.login.mockResolvedValueOnce({ ok: false, code });
      const result = await connectCrunchyroll({ bridge: quiet.bridge });
      expect(result).toEqual(code === 'cancelled' ? { cancelled: true } : { connected: false, reason: code });
    }
    expect(quiet.prefs.has(STATE_KEY)).toBe(false);
  });

  it('watchConnected asks main', async () => {
    const fake = fakeDesktopBridge({ status: { ok: true, available: false, reason: 'locked', connected: true } });
    expect(await watchConnected({ bridge: fake.bridge })).toBe(true);
    fake.watch.status.mockResolvedValueOnce({ ok: true, available: true, connected: false });
    expect(await watchConnected({ bridge: fake.bridge })).toBe(false);
  });

  it('an unmatched list too large for the store loses external candidates first, then its oldest series', async () => {
    const fake = fakeDesktopBridge();
    const external = (i) => ({ kind: 'external', anilist_id: i, mal_id: null, title: 'x'.repeat(50000), format: 'TV', season_year: 2024, episodes: 12, score: 0.9 });
    const entry = (n, candidates) => ({ external_id: `GSERIES${String(n).padStart(3, '0')}`, series_title: 'y'.repeat(150), season: 1, episode: 3,
      episodes_watched: 3, reason: 'no_match', candidates });
    const listed = { id: 4, title: 'Frieren', score: 0.8, episodes: 28, my_status: null, my_episodes: 0, season: 1 };
    await saveUnmatched(fake.bridge, 'srv:3', [entry(1, [listed, external(1), external(2), external(3)]), entry(2, [external(4), external(5), external(6)])]);
    const stored = JSON.parse(fake.prefs.get(UNMATCHED_KEY));
    expect(stored.items.map((u) => u.candidates)).toEqual([[listed], []]);

    const huge = Array.from({ length: 3 }, (_, i) => ({ ...entry(i + 1, []), series_title: 'z'.repeat(100000) }));
    await saveUnmatched(fake.bridge, 'srv:3', huge);
    expect(JSON.parse(fake.prefs.get(UNMATCHED_KEY)).items.map((u) => u.external_id)).toEqual(['GSERIES001', 'GSERIES002']);
  });
});

describe('useCrunchyroll (the card\'s data)', () => {
  const syncApi = (watch, { put } = {}) => vi.fn(async (url, init = {}) => {
    if (url.endsWith('/api/anime/sync') && (init.method || 'GET') === 'GET') return fakeResponse(200, { anilist: null, ...(watch ? { watch } : {}) });
    if (url.endsWith('/api/anime/sync') && init.method === 'PUT') return put ? put(JSON.parse(init.body)) : fakeResponse(500, { error: 'kaputt' });
    return fakeResponse(404, { error: 'Nicht gefunden' });
  });

  it('apps: platform, connected from the secure storage, autoAdd null without a watch object', async () => {
    const fake = fakeBridge();
    await connect(fake);
    vi.stubGlobal('fetch', syncApi(null));
    const { result } = renderHook(() => useCrunchyroll({ bridge: fake.bridge }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ platform: 'ios', connected: true, available: true, reason: null, autoAdd: null, enabled: true });
  });

  it('desktop: status from main (locked keeps connected), autoAdd from GET, setAutoAdd through act()', async () => {
    const fake = fakeDesktopBridge({ status: { ok: true, available: false, reason: 'locked', connected: true } });
    await patchState(fake.bridge, { enabled: true, connected_at: 3, last_ok: 4 });
    let release;
    const fetchMock = syncApi({ auto_add: true, last_at: null, last_platform: null, last_applied: 0, last_added: 0 }, {
      put: (body) => new Promise((r) => { release = () => r(fakeResponse(200, { anilist: null, watch: { ...body.watch, last_at: null } })); })
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCrunchyroll({ bridge: fake.bridge }));
    await waitFor(() => expect(result.current.autoAdd).toBe(true));
    expect(result.current).toMatchObject({ platform: 'macos', connected: true, available: false, reason: 'locked', state: { connected_at: 3, last_ok: 4 } });

    let done;
    act(() => { done = result.current.setAutoAdd(false); });
    await waitFor(() => expect(result.current.busy).toBe('autoAdd'));
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'PUT');
    expect(JSON.parse(init.body)).toEqual({ watch: { auto_add: false } });
    release();
    await act(() => done);
    expect(result.current.autoAdd).toBe(false);
    expect(result.current.busy).toBeNull();
    expect(fake.watch.login).not.toHaveBeenCalled();
  });

  it('a failed PUT keeps the previous value and never throws', async () => {
    const fake = fakeDesktopBridge();
    vi.stubGlobal('fetch', syncApi({ auto_add: true }));
    const { result } = renderHook(() => useCrunchyroll({ bridge: fake.bridge }));
    await waitFor(() => expect(result.current.autoAdd).toBe(true));
    await act(() => result.current.setAutoAdd(false));
    expect(result.current.autoAdd).toBe(true);
    expect(result.current.busy).toBeNull();
  });
});
