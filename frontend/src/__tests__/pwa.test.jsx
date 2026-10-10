// @vitest-environment-options { "url": "http://192.168.1.20/" }
// PWA parts: service worker, updates, install guidance, manifest, haptics, pull to refresh.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { render, renderHook, act, screen } from '@testing-library/react';
import { subscribe } from '../utils/notify';
import { haptic, resetHaptics, HAPTIC_PATTERNS } from '../utils/haptics';
import usePullToRefresh, { useForegroundRefresh, FOREGROUND_REFRESH_MS } from '../hooks/usePullToRefresh';
import DashboardFooter, { formatStorageUsage, HTTPS_GUIDE_URL } from '../components/dashboard/DashboardFooter';
import {
  watchServiceWorkerUpdates, resetServiceWorkerWatcher, maybeShowIosInstallHint, isIosSafari, needsHttps,
  IOS_HINT_KEY, IOS_HINT_TEXT, UPDATE_TEXT, UPDATE_CHECK_INTERVAL_MS, WORKER_ANSWER_TIMEOUT_MS
} from '../hooks/usePwaInstall';

const swSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../public/manifest.json'), 'utf8'));
const ORIGIN = 'https://shelf.test';
const abs = (req) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;

function response(body, { status = 200, type = 'text/html', basic = true } = {}) {
  const res = new Response(body, { status, headers: { 'Content-Type': type } });
  if (basic) Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

class FakeCache {
  constructor(fetchImpl) { this.entries = new Map(); this.fetch = fetchImpl; }
  async match(req) { return this.entries.get(abs(req))?.clone(); }
  async put(req, res) { this.entries.set(abs(req), res); }
  async add(req) { await this.addAll([req]); }
  async addAll(reqs) {
    const results = await Promise.all(reqs.map(async (r) => [r, await this.fetch(abs(r))]));
    if (results.some(([, res]) => !res.ok)) throw new TypeError('addAll failed');
    for (const [r, res] of results) await this.put(r, res);
  }
}

function fakeCaches(fetchImpl) {
  const store = new Map();
  return {
    store,
    async open(name) {
      if (!store.has(name)) store.set(name, new FakeCache(fetchImpl));
      return store.get(name);
    },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async match(req) {
      for (const cache of store.values()) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      return undefined;
    }
  };
}

function loadWorker({ source = swSource, version = '1', fetchImpl, caches }) {
  const listeners = {};
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
    location: { origin: ORIGIN }
  };
  const code = source.replaceAll('__APP_VERSION__', version);
  new Function('self', 'caches', 'fetch', 'Response', 'URL', 'console', code)(self, caches, fetchImpl, Response, URL, { warn: () => {} });
  const lifecycle = async (type) => {
    let pending;
    listeners[type]({ waitUntil: (p) => { pending = p; } });
    return pending;
  };
  const request = (url, { mode = 'no-cors', method = 'GET' } = {}) => {
    let responded;
    const extra = [];
    listeners.fetch({ request: { url: abs(url), mode, method }, respondWith: (p) => { responded = p; }, waitUntil: (p) => extra.push(p) });
    if (!responded) return { response: Promise.resolve(undefined), settled: Promise.resolve() };
    return { response: responded, settled: responded.then(() => Promise.all(extra)) };
  };
  const fetchOnce = async (url, opts) => {
    const r = request(url, opts);
    const res = await r.response;
    await r.settled;
    return res;
  };
  return { install: () => lifecycle('install'), activate: () => lifecycle('activate'), request, fetchOnce, listeners, self };
}

const FILES = {
  '/': ['<script type="module" src="/assets/index-A.js"></script>', 'text/html'],
  '/manifest.json': ['{}', 'application/json'],
  '/favicon.svg': ['<svg/>', 'image/svg+xml'],
  '/icon-192.png': ['png', 'image/png'],
  '/icon-512.png': ['png', 'image/png'],
  '/assets/index-A.js': ['entry', 'text/javascript'],
  '/assets/zxing-A.js': ['zxing', 'text/javascript'],
  '/assets/index-A.css': ['css', 'text/css']
};
const serve = (files = FILES) => vi.fn(async (req) => {
  const file = files[new URL(abs(req)).pathname];
  return file ? response(file[0], { type: file[1] }) : response('Nicht gefunden', { status: 404, type: 'text/plain' });
});
const stamped = (files) => swSource.replaceAll('__APP_VERSION__', '9.9.9').replace('/*__PRECACHE__*/', files.map((f) => JSON.stringify(f)).join(', '));

describe('service worker', () => {
  it('precaches every stamped chunk atomically, also lazy ones the shell does not name', async () => {
    const net = serve();
    const caches = fakeCaches(net);
    const sw = loadWorker({ source: stamped(['/assets/index-A.js', '/assets/zxing-A.js', '/assets/index-A.css']), fetchImpl: net, caches });
    await sw.install();
    const cache = await caches.open('mangashelf-app-9.9.9');
    expect([...cache.entries.keys()]).toContain(abs('/assets/zxing-A.js'));

    const broken = fakeCaches(serve({ ...FILES, '/assets/zxing-A.js': undefined }));
    const sw2 = loadWorker({ source: stamped(['/assets/index-A.js', '/assets/zxing-A.js']), fetchImpl: vi.fn(), caches: broken });
    await expect(sw2.install()).rejects.toThrow();
    expect((await broken.open('mangashelf-app-9.9.9')).entries.size).toBe(0);
  });

  it('does not skip waiting on install; SKIP_WAITING from the page activates it', async () => {
    const net = serve();
    const sw = loadWorker({ fetchImpl: net, caches: fakeCaches(net) });
    await sw.install();
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    sw.listeners.message({ data: { type: 'OTHER' } });
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    sw.listeners.message({ data: { type: 'SKIP_WAITING' } });
    expect(sw.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('serves hashed build files from the cache without asking the network', async () => {
    const net = serve();
    const caches = fakeCaches(net);
    const sw = loadWorker({ source: stamped(['/assets/index-A.js']), fetchImpl: net, caches });
    await sw.install();
    net.mockClear();
    const res = await sw.fetchOnce('/assets/index-A.js');
    expect(await res.text()).toBe('entry');
    expect(net).not.toHaveBeenCalled();
  });

  it('a hanging navigation falls back to the cached shell after 3 s and keeps loading in the background', async () => {
    const net = serve();
    const caches = fakeCaches(net);
    const sw = loadWorker({ fetchImpl: net, caches });
    await sw.install();
    vi.useFakeTimers();
    try {
      let finish;
      net.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const { response: pending, settled } = sw.request('/manga/5', { mode: 'navigate' });
      let done = false;
      pending.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(2900);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(await (await pending).text()).toContain('index-A.js');
      finish(response('late', { type: 'text/html' }));
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 5xx page from a proxy is replaced by the cached shell; without a shell it is passed on', async () => {
    const net = serve();
    const caches = fakeCaches(net);
    const sw = loadWorker({ fetchImpl: net, caches });
    net.mockResolvedValueOnce(response('Bad Gateway', { status: 502 }));
    expect((await sw.fetchOnce('/', { mode: 'navigate' })).status).toBe(502);
    await sw.install();
    net.mockResolvedValueOnce(response('Bad Gateway', { status: 502 }));
    const res = await sw.fetchOnce('/', { mode: 'navigate' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('index-A.js');
  });

  it('does not store a page of a newer release whose chunks are not cached', async () => {
    const net = serve();
    const caches = fakeCaches(net);
    const sw = loadWorker({ fetchImpl: net, caches });
    await sw.install();
    net.mockResolvedValueOnce(response('<script src="/assets/index-NEW.js"></script>'));
    await sw.fetchOnce('/manga/9', { mode: 'navigate' });
    const cache = await caches.open('mangashelf-app-1');
    expect(await (await cache.match('/')).text()).not.toContain('index-NEW.js');
    net.mockResolvedValueOnce(response('<script src="/assets/index-A.js"></script><!-- neu -->'));
    await sw.fetchOnce('/manga/5', { mode: 'navigate' });
    expect(await (await cache.match('/')).text()).toContain('<!-- neu -->');
    expect([...cache.entries.keys()]).not.toContain(abs('/manga/5'));
  });

  it('leaves cross-origin requests alone', async () => {
    const net = vi.fn();
    const sw = loadWorker({ fetchImpl: net, caches: fakeCaches(net) });
    expect(await sw.fetchOnce('https://covers.example.com/a.jpg')).toBeUndefined();
    expect(await sw.fetchOnce('https://fonts.example.com/assets/x.woff2')).toBeUndefined();
    expect(net).not.toHaveBeenCalled();
  });
});

function fakeContainer({ controller = {}, registration } = {}) {
  const listeners = {};
  return {
    controller,
    listeners,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    getRegistration: vi.fn(async () => registration)
  };
}

function fakeRegistration() {
  const listeners = {};
  return { listeners, waiting: null, installing: null, update: vi.fn(async () => {}), addEventListener: (t, fn) => { listeners[t] = fn; } };
}

function fakeWorker() {
  const listeners = {};
  return { listeners, state: 'installing', postMessage: vi.fn(), addEventListener: (t, fn) => { listeners[t] = fn; } };
}

describe('service worker updates in the page', () => {
  let toasts;
  let unsubscribe;
  beforeEach(() => {
    resetServiceWorkerWatcher();
    toasts = [];
    unsubscribe = subscribe((e) => { if (e.type === 'show') toasts.push(e.toast); });
  });
  afterEach(() => unsubscribe());

  it('offers a waiting worker as a toast; Neu laden sends SKIP_WAITING and the takeover reloads once', async () => {
    const reg = fakeRegistration();
    reg.waiting = fakeWorker();
    const container = fakeContainer({ registration: reg });
    const reload = vi.fn();
    await watchServiceWorkerUpdates({ container, win: window, doc: document, reload });
    expect(toasts.map((t) => [t.message, t.action?.label, t.duration])).toEqual([[UPDATE_TEXT, 'Neu laden', 0]]);
    toasts[0].action.onClick();
    expect(reg.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    container.listeners.controllerchange();
    container.listeners.controllerchange();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('offers a worker that finishes installing later, but not the first install of a page without a worker', async () => {
    const reg = fakeRegistration();
    const container = fakeContainer({ registration: reg });
    await watchServiceWorkerUpdates({ container, win: window, doc: document, reload: vi.fn() });
    const worker = fakeWorker();
    reg.installing = worker;
    reg.listeners.updatefound();
    worker.state = 'installed';
    worker.listeners.statechange();
    worker.listeners.statechange();
    expect(toasts).toHaveLength(1);

    resetServiceWorkerWatcher();
    toasts.length = 0;
    const first = fakeRegistration();
    first.waiting = fakeWorker();
    const fresh = fakeContainer({ controller: null, registration: first });
    const reload = vi.fn();
    await watchServiceWorkerUpdates({ container: fresh, win: window, doc: document, reload });
    fresh.listeners.controllerchange();
    expect(toasts).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it('offers a worker that was already installing when the watcher attached', async () => {
    const reg = fakeRegistration();
    const worker = fakeWorker();
    reg.installing = worker;
    await watchServiceWorkerUpdates({ container: fakeContainer({ registration: reg }), win: window, doc: document, reload: vi.fn() });
    expect(toasts).toHaveLength(0);
    worker.state = 'installed';
    worker.listeners.statechange();
    expect(toasts.map((t) => t.message)).toEqual([UPDATE_TEXT]);
    toasts[0].action.onClick();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  describe('a waiting worker of the release the page already runs', () => {
    let entry;
    beforeEach(() => {
      entry = document.createElement('script');
      entry.type = 'module';
      entry.setAttribute('src', '/assets/index-A.js');
      document.head.appendChild(entry);
    });
    afterEach(() => entry.remove());

    const releaseWorker = (files) => {
      const sw = loadWorker({ source: stamped(files), fetchImpl: vi.fn(), caches: fakeCaches(vi.fn()) });
      const worker = fakeWorker();
      worker.state = 'installed';
      worker.postMessage = vi.fn((data, ports) => sw.listeners.message({ data, ports, origin: '', waitUntil: () => {} }));
      return worker;
    };
    const settle = () => new Promise((resolve) => { setTimeout(resolve, 50); });

    it('is not offered when it precaches the entry script of this page', async () => {
      const RealChannel = globalThis.MessageChannel;
      globalThis.MessageChannel = class {
        constructor() {
          this.port1 = { onmessage: null, close: vi.fn() };
          this.port2 = { postMessage: (data) => this.port1.onmessage?.({ data }) };
        }
      };
      vi.useFakeTimers();
      try {
        const reg = fakeRegistration();
        reg.waiting = releaseWorker(['/assets/index-A.js', '/assets/index-A.css']);
        await watchServiceWorkerUpdates({ container: fakeContainer({ registration: reg }), win: window, doc: document, reload: vi.fn() });
        expect(reg.waiting.postMessage).toHaveBeenCalledWith({ type: 'HAS_FILE', url: '/assets/index-A.js' }, [expect.anything()]);
        await vi.advanceTimersByTimeAsync(WORKER_ANSWER_TIMEOUT_MS * 2);
        expect(toasts).toHaveLength(0);
        expect(reg.waiting.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      } finally {
        vi.useRealTimers();
        globalThis.MessageChannel = RealChannel;
      }
    });

    it('a worker of another release is offered', async () => {
      const reg = fakeRegistration();
      const container = fakeContainer({ registration: reg });
      await watchServiceWorkerUpdates({ container, win: window, doc: document, reload: vi.fn() });
      const worker = releaseWorker(['/assets/index-B.js']);
      worker.state = 'installing';
      reg.installing = worker;
      reg.listeners.updatefound();
      worker.state = 'installed';
      worker.listeners.statechange();
      await vi.waitFor(() => expect(toasts.map((t) => t.message)).toEqual([UPDATE_TEXT]));
      await settle();
      expect(toasts).toHaveLength(1);
    });

    it('an older worker that does not answer is offered after the timeout', async () => {
      vi.useFakeTimers();
      try {
        const reg = fakeRegistration();
        reg.waiting = fakeWorker();
        await watchServiceWorkerUpdates({ container: fakeContainer({ registration: reg }), win: window, doc: document, reload: vi.fn() });
        expect(reg.waiting.postMessage).toHaveBeenCalledWith({ type: 'HAS_FILE', url: '/assets/index-A.js' }, [expect.anything()]);
        await vi.advanceTimersByTimeAsync(WORKER_ANSWER_TIMEOUT_MS - 1);
        expect(toasts).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(toasts.map((t) => [t.message, t.action?.label])).toEqual([[UPDATE_TEXT, 'Neu laden']]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('checks for an update when the app returns to the foreground, at most hourly', async () => {
    const reg = fakeRegistration();
    let clock = 0;
    const doc = { visibilityState: 'visible', listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } };
    await watchServiceWorkerUpdates({ container: fakeContainer({ registration: reg }), win: window, doc, reload: vi.fn(), now: () => clock });
    clock = UPDATE_CHECK_INTERVAL_MS - 1;
    doc.listeners.visibilitychange();
    expect(reg.update).not.toHaveBeenCalled();
    clock = UPDATE_CHECK_INTERVAL_MS + 5;
    doc.listeners.visibilitychange();
    doc.listeners.visibilitychange();
    expect(reg.update).toHaveBeenCalledTimes(1);
    doc.visibilityState = 'hidden';
    clock *= 3;
    doc.listeners.visibilitychange();
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it('a stale chunk preload error reloads the page instead of throwing', async () => {
    const win = { listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } };
    const reload = vi.fn();
    sessionStorage.clear();
    await watchServiceWorkerUpdates({ container: fakeContainer({ registration: fakeRegistration() }), win, doc: document, reload });
    const event = { preventDefault: vi.fn() };
    win.listeners['vite:preloadError'](event);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('install guidance', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

  it('recognises iOS Safari, not Chrome on iOS or desktop Safari', () => {
    expect(isIosSafari({ userAgent: IPHONE })).toBe(true);
    expect(isIosSafari({ userAgent: IPHONE.replace('Version/17.5', 'CriOS/126.0') })).toBe(false);
    expect(isIosSafari({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.5 Safari/605.1.15', maxTouchPoints: 0 })).toBe(false);
    expect(isIosSafari({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.5 Safari/605.1.15', maxTouchPoints: 5 })).toBe(true);
  });

  it('shows the home-screen hint once in iOS Safari, never in the installed app', () => {
    const toasts = [];
    const off = subscribe((e) => { if (e.type === 'show') toasts.push(e.toast.message); });
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const win = (standalone) => ({ navigator: { userAgent: IPHONE, standalone }, matchMedia: () => ({ matches: false }) });
    expect(maybeShowIosInstallHint({ win: win(true), storage })).toBe(false);
    expect(maybeShowIosInstallHint({ win: win(false), storage })).toBe(true);
    expect(maybeShowIosInstallHint({ win: win(false), storage })).toBe(false);
    off();
    expect(toasts).toEqual([IOS_HINT_TEXT]);
    expect(store.has(IOS_HINT_KEY)).toBe(true);
  });

  it('asks for HTTPS on a plain-HTTP LAN address only', () => {
    expect(needsHttps({ isSecureContext: false, location: { hostname: '192.168.1.20' } })).toBe(true);
    expect(needsHttps({ isSecureContext: false, location: { hostname: 'localhost' } })).toBe(false);
    expect(needsHttps({ isSecureContext: true, location: { hostname: 'shelf.example' } })).toBe(false);
  });
});

describe('manifest', () => {
  it('has an id, separate maskable icons, a scan shortcut and a share target', () => {
    expect(manifest.id).toBe('/');
    expect(manifest.icons.every((i) => i.purpose !== 'any maskable')).toBe(true);
    const maskable = manifest.icons.find((i) => i.purpose === 'maskable');
    expect(fs.existsSync(path.resolve(import.meta.dirname, '../../public', maskable.src.slice(1)))).toBe(true);
    expect(manifest.shortcuts.map((s) => s.url)).toEqual(expect.arrayContaining(['/?view=stats', '/?view=shopping&scan=1']));
    expect(manifest.share_target).toEqual({ action: '/', method: 'GET', params: { text: 'share_text', url: 'share_url' } });
  });
});

describe('haptics', () => {
  beforeEach(() => resetHaptics());

  it('vibrates with the named pattern where the browser can', () => {
    const vibrate = vi.fn(() => true);
    expect(haptic('success', { nav: { vibrate } })).toBe(true);
    expect(haptic('error', { nav: { vibrate } })).toBe(true);
    expect(haptic('unknown', { nav: { vibrate } })).toBe(true);
    expect(vibrate.mock.calls).toEqual([[HAPTIC_PATTERNS.success], [HAPTIC_PATTERNS.error], [HAPTIC_PATTERNS.tap]]);
  });

  it('on iOS (no vibrate) a scan success plays a click only when asked to; errors never throw', () => {
    const started = [];
    class FakeAudio {
      constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.resume = vi.fn(); }
      createOscillator() { return { frequency: {}, connect: () => {}, start: (t) => started.push(t), stop: () => {} }; }
      createGain() { return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} }; }
    }
    expect(haptic('success', { nav: {}, AudioContextImpl: FakeAudio })).toBe(false);
    expect(haptic('success', { sound: true, nav: {}, AudioContextImpl: FakeAudio })).toBe(true);
    expect(started).toEqual([0]);
    expect(haptic('success', { sound: true, nav: {}, AudioContextImpl: undefined })).toBe(false);
    expect(haptic('tap', { nav: { vibrate: () => { throw new Error('blocked'); } } })).toBe(false);
  });
});

describe('usePullToRefresh and useForegroundRefresh', () => {
  const touch = (win, type, y) => win.dispatchEvent(Object.assign(new Event(type), { touches: y === undefined ? [] : [{ clientY: y }] }));
  const standaloneWin = () => {
    const win = new EventTarget();
    win.scrollY = 0;
    win.matchMedia = () => ({ matches: true });
    win.navigator = {};
    return win;
  };

  it('refreshes after a 70 px pull from the top, only in the installed app', async () => {
    const win = standaloneWin();
    const onRefresh = vi.fn(async () => {});
    const { result } = renderHook(() => usePullToRefresh(onRefresh, { win }));
    act(() => { touch(win, 'touchstart', 100); touch(win, 'touchmove', 150); });
    expect(result.current.pullDistance).toBe(50);
    await act(async () => { touch(win, 'touchend'); });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(result.current.pullDistance).toBe(0);

    act(() => { touch(win, 'touchstart', 100); touch(win, 'touchmove', 190); });
    await act(async () => { touch(win, 'touchend'); });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    win.scrollY = 300;
    act(() => { touch(win, 'touchstart', 100); touch(win, 'touchmove', 300); });
    await act(async () => { touch(win, 'touchend'); });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    const tab = standaloneWin();
    tab.matchMedia = () => ({ matches: false });
    const inTab = vi.fn();
    renderHook(() => usePullToRefresh(inTab, { win: tab }));
    act(() => { touch(tab, 'touchstart', 0); touch(tab, 'touchmove', 200); touch(tab, 'touchend'); });
    expect(inTab).not.toHaveBeenCalled();
  });

  it('calls back after the page was hidden for at least a minute', () => {
    let clock = 0;
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const onForeground = vi.fn();
    renderHook(() => useForegroundRefresh(onForeground, { doc, now: () => clock }));
    const set = (state) => { doc.visibilityState = state; doc.dispatchEvent(new Event('visibilitychange')); };
    set('hidden'); clock += 59 * 1000; set('visible');
    expect(onForeground).not.toHaveBeenCalled();
    set('hidden'); clock += FOREGROUND_REFRESH_MS; set('visible');
    expect(onForeground).toHaveBeenCalledTimes(1);
  });
});

describe('DashboardFooter', () => {
  const base = { isOfflineMode: false, networkOffline: false, refreshingCopy: false, refreshError: null, handleRefreshOfflineCopy: vi.fn() };

  it('shows the size of the offline copy next to its age', async () => {
    vi.stubGlobal('navigator', { ...navigator, storage: { estimate: vi.fn(async () => ({ usage: 41.4 * 1024 * 1024, quota: 1e9 })) } });
    render(<DashboardFooter {...base} user={{ id: 1, role: 'editor' }} offlineCopyAt={Date.now() - 3 * 60 * 1000} />);
    expect(await screen.findByText('Offline-Kopie: vor 3 Min., 41 MB – aktualisieren')).toBeTruthy();
    expect(formatStorageUsage(0)).toBe('');
    expect(formatStorageUsage(200 * 1024)).toBe('< 1 MB');
  });

  it('gives an admin on plain HTTP a link to the HTTPS guide; other users get the short note', () => {
    vi.stubGlobal('isSecureContext', false);
    const { rerender } = render(<DashboardFooter {...base} user={{ id: 1, role: 'admin' }} offlineCopyAt={null} />);
    const link = screen.getByRole('link', { name: /brauchen HTTPS/ });
    expect(link.getAttribute('href')).toBe(HTTPS_GUIDE_URL);
    rerender(<DashboardFooter {...base} user={{ id: 2, role: 'editor' }} offlineCopyAt={null} />);
    expect(screen.queryByRole('link', { name: /brauchen HTTPS/ })).toBeNull();
    expect(screen.getByText('Offline-Start und App-Installation nur über HTTPS')).toBeTruthy();
  });
});
