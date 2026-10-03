// __APP_VERSION__ is replaced with the app version at build time (vite.config.js), so every release starts a fresh app
// cache and the old one is deleted. Covers live in their own cache because their file names never change content:
// they stay across releases (the offline copy would otherwise have to download them all again).
const CACHE_NAME = 'mangashelf-app-__APP_VERSION__';
const UPLOADS_CACHE = 'mangashelf-uploads-v1';
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME && key !== UPLOADS_CACHE).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API or Auth requests (always network)
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Cover uploads: cache first. File names are unique and the content never changes, so a cached image is
  // served as is - no re-download in the background (that used to cost tens of MB per sync on large collections)
  if (url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      caches.open(UPLOADS_CACHE).then(async (cache) => {
        const cachedResponse = await cache.match(event.request);
        if (cachedResponse) return cachedResponse;
        const networkResponse = await fetch(event.request);
        if (networkResponse.status === 200) {
          cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      })
    );
    return;
  }

  // Static assets & navigation: Network first with cache fallback
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 200 && event.request.method === 'GET') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(async () => {
        const cachedResponse = await caches.match(event.request);
        if (cachedResponse) return cachedResponse;
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      })
  );
});
