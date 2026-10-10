// public/sw.js run against fake globals: precache per release, runtime caching and cleanup of old caches.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { UPLOADS_CACHE } from '../appShell';

const swSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/sw.js'), 'utf8');
const ORIGIN = 'https://shelf.test';
const abs = (req) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;

function response(body, { status = 200, type = 'text/html', basic = true } = {}) {
  const res = new Response(body, { status, headers: { 'Content-Type': type } });
  if (basic) Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

class FakeCache {
  constructor() { this.entries = new Map(); }
  async match(req) { return this.entries.get(abs(req))?.clone(); }
  async put(req, res) { this.entries.set(abs(req), res); }
  async add(req) {
    const res = await this.fetch(abs(req));
    if (!res.ok) throw new TypeError(`add failed: ${abs(req)}`);
    await this.put(req, res);
  }
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
      if (!store.has(name)) { const c = new FakeCache(); c.fetch = fetchImpl; store.set(name, c); }
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

/** Runs public/sw.js against fake globals; returns its event handlers and helpers to dispatch them. */
function loadWorker({ version, fetchImpl, caches, catalogs = null }) {
  const listeners = {};
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
    location: { origin: ORIGIN }
  };
  let source = swSource.replaceAll('__APP_VERSION__', version);
  if (catalogs) source = source.replace('/*__CATALOGS__*/', Object.entries(catalogs).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', '));
  new Function('self', 'caches', 'fetch', 'Response', 'URL', 'console', source)(self, caches, fetchImpl, Response, URL, { warn: () => {} });

  const lifecycle = async (type) => {
    let pending;
    listeners[type]({ waitUntil: (p) => { pending = p; } });
    return pending;
  };
  const request = async (url, { mode = 'no-cors', method = 'GET' } = {}) => {
    let responded;
    const extra = [];
    listeners.fetch({ request: { url: abs(url), mode, method }, respondWith: (p) => { responded = p; }, waitUntil: (p) => extra.push(p) });
    if (!responded) return undefined;
    const res = await responded;
    await Promise.all(extra);
    return res;
  };
  const message = async (data, origin = '') => {
    let pending;
    listeners.message({ data, origin, waitUntil: (p) => { pending = p; } });
    return pending;
  };
  return { install: () => lifecycle('install'), activate: () => lifecycle('activate'), request, message, self };
}

const indexHtml = (hash) => `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-${hash}.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-${hash}.css"></head><body><div id="root"></div></body></html>`;

/** A server for one release: '/', the static files, the entry JS (which names its lazy chunks) and CSS. */
function server(hash, { missing = [] } = {}) {
  const files = {
    '/': [indexHtml(hash), 'text/html'],
    '/manifest.json': ['{}', 'application/json'],
    '/favicon.svg': ['<svg/>', 'image/svg+xml'],
    '/icon-192.png': ['png', 'image/png'],
    '/icon-512.png': ['png', 'image/png'],
    [`/assets/index-${hash}.js`]: [`const d=["assets/Dashboard-${hash}.js","assets/Login-${hash}.js"];`, 'text/javascript'],
    [`/assets/index-${hash}.css`]: [`@font-face{src:url(/assets/font-${hash}.woff2)}`, 'text/css'],
    [`/assets/Dashboard-${hash}.js`]: ['export default 1', 'text/javascript'],
    [`/assets/Login-${hash}.js`]: ['export default 2', 'text/javascript'],
    [`/assets/font-${hash}.woff2`]: ['woff', 'font/woff2'],
    '/uploads/cover-1.jpg': ['jpg', 'image/jpeg']
  };
  return vi.fn(async (req) => {
    const pathname = new URL(abs(req)).pathname;
    if (missing.includes(pathname) || !files[pathname]) return response('Nicht gefunden', { status: 404, type: 'text/plain' });
    const [body, type] = files[pathname];
    return response(body, { type });
  });
}

describe('service worker', () => {
  it('uses the same uploads cache name as the logout cleanup', () => {
    expect(swSource).toContain(`const UPLOADS_CACHE = '${UPLOADS_CACHE}'`);
  });

  it('an update precaches the new entry JS/CSS, lazy chunks and fonts, so an offline cold start still works', async () => {
    let net = server('OLD');
    const caches = fakeCaches((r) => net(r));
    const v1 = loadWorker({ version: '1.0.0', fetchImpl: (r) => net(r), caches });
    await v1.install();
    await v1.activate();
    (await caches.open('mangashelf-uploads-v1')).entries.set(abs('/uploads/old.jpg'), response('<html>', { type: 'text/html' }));

    net = server('NEW');
    const v2 = loadWorker({ version: '1.1.0', fetchImpl: (r) => net(r), caches });
    await v2.install();
    await v2.activate();

    expect(await caches.keys()).toEqual(['mangashelf-app-1.1.0']);
    net = vi.fn(async () => { throw new TypeError('offline'); });
    for (const url of ['/assets/index-NEW.js', '/assets/index-NEW.css', '/assets/Dashboard-NEW.js', '/assets/Login-NEW.js', '/assets/font-NEW.woff2']) {
      const res = await v2.request(url);
      expect(res.ok, url).toBe(true);
    }
    const page = await v2.request('/manga/5', { mode: 'navigate' });
    expect(await page.text()).toContain('index-NEW.js');
  });

  it('a failed precache rejects the install and keeps the previous cache', async () => {
    let net = server('OLD');
    const caches = fakeCaches((r) => net(r));
    const v1 = loadWorker({ version: '1.0.0', fetchImpl: (r) => net(r), caches });
    await v1.install();
    await v1.activate();

    net = server('NEW', { missing: ['/assets/index-NEW.css'] });
    const v2 = loadWorker({ version: '1.1.0', fetchImpl: (r) => net(r), caches });
    await expect(v2.install()).rejects.toThrow();
    expect(await (await caches.open('mangashelf-app-1.0.0')).match('/')).toBeTruthy();
  });

  it('activate keeps the previous app cache when the new one has no app shell', async () => {
    const caches = fakeCaches(server('X'));
    (await caches.open('mangashelf-app-1.0.0')).entries.set(abs('/'), response('old'));
    const sw = loadWorker({ version: '1.1.0', fetchImpl: server('X'), caches });
    await sw.activate();
    expect(await caches.keys()).toContain('mangashelf-app-1.0.0');
  });

  it('/uploads: caches real images only, never an HTML or error page', async () => {
    const caches = fakeCaches(vi.fn());
    const answers = {
      '/uploads/cover-1.jpg': () => response('jpg', { type: 'image/jpeg' }),
      '/uploads/missing.jpg': () => response('<!doctype html>', { type: 'text/html' }),
      '/uploads/gone.jpg': () => response('Nicht gefunden', { status: 404, type: 'text/plain' }),
      '/uploads/foreign.jpg': () => response('jpg', { type: 'image/jpeg', basic: false })
    };
    const sw = loadWorker({ version: '1', fetchImpl: async (r) => answers[new URL(abs(r)).pathname](), caches });
    for (const url of Object.keys(answers)) await sw.request(url);
    const uploads = await caches.open(UPLOADS_CACHE);
    expect([...uploads.entries.keys()]).toEqual([abs('/uploads/cover-1.jpg')]);
  });

  it('network first: stores no HTML under a script URL, but stores navigations', async () => {
    const caches = fakeCaches(vi.fn());
    const answers = {
      '/assets/MangaDetail-OLD.js': () => response('<!doctype html>', { type: 'text/html' }),
      '/assets/x.js': () => response('export {}', { type: 'text/javascript' }),
      '/manga/5': () => response('<!doctype html>', { type: 'text/html' }),
      '/assets/y.js': () => response('nope', { status: 500, type: 'text/plain' })
    };
    const sw = loadWorker({ version: '2', fetchImpl: async (r) => answers[new URL(abs(r)).pathname](), caches });
    await sw.request('/assets/MangaDetail-OLD.js');
    await sw.request('/assets/x.js');
    await sw.request('/manga/5', { mode: 'navigate' });
    await sw.request('/assets/y.js');
    const app = await caches.open('mangashelf-app-2');
    expect([...app.entries.keys()].sort()).toEqual([abs('/'), abs('/assets/x.js')]);
  });

  it('navigations are stored under / only: no series ids or shared text as cache keys', async () => {
    const net = server('A');
    const caches = fakeCaches(net);
    const sw = loadWorker({ version: '1', fetchImpl: net, caches });
    await sw.install();
    await sw.request('/manga/5', { mode: 'navigate' });
    await sw.request('/?share_text=geheim', { mode: 'navigate' });
    const keys = [...(await caches.open('mangashelf-app-1')).entries.keys()];
    expect(keys.filter((k) => !k.includes('/assets/'))).toEqual(
      // the manifest is no longer precached: WARM_LANGUAGE caches the active language's one
      ['/', '/favicon.svg', '/icon-192.png', '/icon-512.png'].map(abs)
    );

    net.mockImplementation(async () => { throw new TypeError('offline'); });
    expect(await (await sw.request('/manga/77', { mode: 'navigate' })).text()).toContain('index-A.js');
  });

  it('while an update waits, the active worker serves the new release from the waiting precache', async () => {
    const netA = server('A');
    const netB = server('B');
    let net = netA;
    const caches = fakeCaches((r) => net(r));
    const v1 = loadWorker({ version: '1.0.0', fetchImpl: (r) => net(r), caches });
    await v1.install();
    await v1.activate();
    net = netB;
    const v2 = loadWorker({ version: '1.1.0', fetchImpl: (r) => net(r), caches });
    await v2.install();

    netB.mockClear();
    expect(await (await v1.request('/assets/Dashboard-B.js')).text()).toBe('export default 1');
    expect(netB).not.toHaveBeenCalled();

    await v1.request('/', { mode: 'navigate' });
    expect(await (await (await caches.open('mangashelf-app-1.0.0')).match('/')).text()).toContain('index-B.js');
    net = vi.fn(async () => { throw new TypeError('offline'); });
    const page = await v1.request('/manga/5', { mode: 'navigate' });
    expect(await page.text()).toContain('index-B.js');
    expect(await (await v1.request('/assets/Login-B.js')).text()).toBe('export default 2');
  });

  it('WARM_LANGUAGE caches the catalog and manifest of that language only; German needs only /manifest.json', async () => {
    const files = {
      '/manifest.json': ['{}', 'application/json'],
      '/manifest.en.json': ['{}', 'application/json'],
      '/assets/en-H1.js': ['export default {}', 'text/javascript'],
      '/assets/fr-H2.js': ['export default {}', 'text/javascript']
    };
    const net = vi.fn(async (req) => {
      const hit = files[new URL(abs(req)).pathname];
      return hit ? response(hit[0], { type: hit[1] }) : response('Nicht gefunden', { status: 404, type: 'text/plain' });
    });
    const caches = fakeCaches(net);
    const sw = loadWorker({ version: '4', fetchImpl: net, caches, catalogs: { en: '/assets/en-H1.js', fr: '/assets/fr-H2.js' } });
    await sw.message({ type: 'WARM_LANGUAGE', language: 'en' });
    const keys = () => (caches.store.get('mangashelf-app-4') ? [...caches.store.get('mangashelf-app-4').entries.keys()].sort() : []);
    expect(keys()).toEqual(['/assets/en-H1.js', '/manifest.en.json'].map(abs));
    await sw.message({ type: 'WARM_LANGUAGE', language: 'de' });
    expect(keys()).toEqual(['/assets/en-H1.js', '/manifest.en.json', '/manifest.json'].map(abs));
    // already cached files are not fetched again; junk is ignored
    net.mockClear();
    await sw.message({ type: 'WARM_LANGUAGE', language: 'en' });
    await sw.message({ type: 'WARM_LANGUAGE', language: '../x' });
    expect(net).not.toHaveBeenCalled();
  });

  it('a catalog loaded at runtime is cached on first use (cache first, like every hashed chunk)', async () => {
    const net = vi.fn(async () => response('export default {}', { type: 'text/javascript' }));
    const caches = fakeCaches(net);
    const sw = loadWorker({ version: '5', fetchImpl: net, caches });
    await sw.request('/assets/ja-H3.js');
    net.mockImplementation(async () => { throw new TypeError('offline'); });
    expect((await sw.request('/assets/ja-H3.js')).ok).toBe(true);
  });

  it('leaves API calls and non-GET requests to the network', async () => {
    const sw = loadWorker({ version: '3', fetchImpl: vi.fn(), caches: fakeCaches(vi.fn()) });
    expect(await sw.request('/api/auth/me')).toBeUndefined();
    expect(await sw.request('/uploads/a.jpg', { method: 'POST' })).toBeUndefined();
  });

  it('ignores messages from a foreign origin', async () => {
    const net = vi.fn(async () => response('{}', { type: 'application/json' }));
    const caches = fakeCaches(net);
    const sw = loadWorker({ version: '6', fetchImpl: net, caches });
    expect(await sw.message({ type: 'WARM_LANGUAGE', language: 'en' }, 'https://evil.test')).toBeUndefined();
    await sw.message({ type: 'SKIP_WAITING' }, 'https://evil.test');
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    expect(net).not.toHaveBeenCalled();
    await sw.message({ type: 'SKIP_WAITING' }, ORIGIN);
    expect(sw.self.skipWaiting).toHaveBeenCalledTimes(1);
    await sw.message({ type: 'SKIP_WAITING' });
    expect(sw.self.skipWaiting).toHaveBeenCalledTimes(2);
  });
});
