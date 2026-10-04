// __APP_VERSION__, __BUILD_ID__ and the list of build files are stamped in at build time (vite.config.js), so every build
// starts a fresh app cache holding all of its chunks; a waiting worker never writes into the cache open tabs still use.
// Covers live in their own cache because their file names never change content: they stay across releases (the offline
// copy would otherwise have to download them all again).
const BUILD_ID = '__BUILD_ID__';
// unstamped (tests): the version alone
const CACHE_NAME = BUILD_ID && !BUILD_ID.startsWith('__') ? `mangashelf-app-__APP_VERSION__-${BUILD_ID}` : 'mangashelf-app-__APP_VERSION__';
// Same name as UPLOADS_CACHE in src/appShell.js (cleared on logout). v2 dropped v1 entries that held index.html.
const UPLOADS_CACHE = 'mangashelf-uploads-v2';
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png'
];
const BUILD_FILES = [/*__PRECACHE__*/];
const NAVIGATION_TIMEOUT_MS = 3000;

/** Build files (/assets/<name>-<hash>.js|css|woff2) referenced in an HTML, JS or CSS text. */
function assetRefs(text) {
  const refs = new Set();
  for (const match of String(text).matchAll(/\/?assets\/[\w.-]+\.(?:js|css|woff2?)/g)) {
    refs.add(match[0].startsWith('/') ? match[0] : `/${match[0]}`);
  }
  return [...refs];
}

// A build stamps every chunk into BUILD_FILES and the whole release is cached atomically. Without the list (dev, tests)
// the entry files of the shell are required and the chunks they name are added best effort.
async function precache() {
  const cache = await caches.open(CACHE_NAME);
  if (BUILD_FILES.length) {
    await cache.addAll([...STATIC_ASSETS, ...BUILD_FILES]);
    return;
  }
  await cache.addAll(STATIC_ASSETS);
  const shell = await cache.match('/');
  const entry = assetRefs(shell ? await shell.text() : '');
  await cache.addAll(entry);
  const nested = new Set();
  for (const url of entry) {
    const res = await cache.match(url);
    if (res) assetRefs(await res.text()).forEach((ref) => nested.add(ref));
  }
  entry.forEach((url) => nested.delete(url));
  await Promise.allSettled([...nested].map((url) => cache.add(url)));
}

// No skipWaiting here: open tabs keep the release (and the cache) they were loaded with until the user accepts the
// update, which posts SKIP_WAITING.
self.addEventListener('install', (event) => {
  event.waitUntil(precache().catch((err) => {
    console.warn('[SW] Precache failed, keeping the previous version:', err);
    throw err;
  }));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const hasShell = Boolean(await (await caches.open(CACHE_NAME)).match('/'));
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key !== CACHE_NAME && key !== UPLOADS_CACHE)
      .filter((key) => hasShell || !key.startsWith('mangashelf-app-'))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

const contentType = (response) => response.headers.get('content-type') || '';
const isOwnOk = (response) => Boolean(response) && response.ok && response.type === 'basic';
const isHtml = (response) => contentType(response).includes('text/html');

// A page of a newer release (deployed, but its worker not installed yet) names chunks no cache holds; storing it would
// turn the next offline start into a blank page. The server sends the same shell for every route, so it is kept under
// '/' only (no browsing history or shared text as cache keys). caches.match also finds a waiting worker's precache.
async function storeNavigation(cache, response) {
  for (const ref of assetRefs(await response.clone().text())) {
    if (!(await caches.match(ref))) return;
  }
  await cache.put('/', response);
}

async function navigationResponse(event) {
  const { request } = event;
  const cache = await caches.open(CACHE_NAME);
  const cached = async () => (await cache.match('/')) || caches.match('/');
  const network = fetch(request).then((response) => {
    if (isOwnOk(response) && isHtml(response)) {
      event.waitUntil(storeNavigation(cache, response.clone()).catch(() => {}));
    }
    return response;
  });
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, NAVIGATION_TIMEOUT_MS, null); });
  try {
    const response = await Promise.race([network, timeout]);
    if (response && response.status < 500) return response;
    const fallback = await cached();
    if (fallback) {
      event.waitUntil(network.catch(() => {}));
      return fallback;
    }
    return response || await network;
  } catch (_) {
    return (await cached()) || Response.error();
  } finally {
    clearTimeout(timer);
  }
}

// Build files carry a content hash in their name: a cached copy is always the right one, also from another release's
// cache (a waiting update has precached all chunks of the page the network already serves).
async function cacheFirst(event) {
  const cachedResponse = await caches.match(event.request);
  if (cachedResponse) return cachedResponse;
  const response = await fetch(event.request);
  if (isOwnOk(response) && !isHtml(response)) {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone())).catch(() => {}));
  }
  return response;
}

// HTML is never stored here, so an SPA fallback page can never end up cached under a script or image URL.
async function networkFirst(event) {
  try {
    const response = await fetch(event.request);
    if (isOwnOk(response) && !isHtml(response)) {
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone())).catch(() => {}));
    }
    return response;
  } catch (_) {
    return (await (await caches.open(CACHE_NAME)).match(event.request)) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API or Auth requests (always network)
  if (url.pathname.startsWith('/api/')) return;

  // Cover uploads: cache first. File names are unique and the content never changes, so a cached image is
  // served as is - no re-download in the background (that used to cost tens of MB per sync on large collections).
  // Only real images are stored: a 404 page or a proxy's HTML must never be served for an image later.
  if (url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      caches.open(UPLOADS_CACHE).then(async (cache) => {
        const cachedResponse = await cache.match(request);
        if (cachedResponse) return cachedResponse;
        const networkResponse = await fetch(request);
        if (isOwnOk(networkResponse) && contentType(networkResponse).startsWith('image/')) {
          event.waitUntil(cache.put(request, networkResponse.clone()).catch(() => {}));
        }
        return networkResponse;
      })
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(event));
    return;
  }
  event.respondWith(url.pathname.startsWith('/assets/') ? cacheFirst(event) : networkFirst(event));
});
