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
function loadWorker({ version, fetchImpl, caches }) {
  const listeners = {};
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
    location: { origin: ORIGIN }
  };
  const source = swSource.replaceAll('__APP_VERSION__', version);
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
  return { install: () => lifecycle('install'), activate: () => lifecycle('activate'), request, self };
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
    expect([...app.entries.keys()].sort()).toEqual([abs('/assets/x.js'), abs('/manga/5')]);
  });

  it('leaves API calls and non-GET requests to the network', async () => {
    const sw = loadWorker({ version: '3', fetchImpl: vi.fn(), caches: fakeCaches(vi.fn()) });
    expect(await sw.request('/api/auth/me')).toBeUndefined();
    expect(await sw.request('/uploads/a.jpg', { method: 'POST' })).toBeUndefined();
  });
});
