const CACHE_NAME = 'flyingmom-cache-v2';

// Core App Shell assets for offline reliability and fast installation
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/map.js',
  './js/theme.js',
  './js/manager.js',
  './js/calendar.js',
  './js/airports.js',
  './js/home-manager.js',
  './js/location-engine.js',
  './js/pwa.js',
  './assets/icons/favicon-16.png',
  './assets/icons/favicon-32.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png'
];

// Install: precache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Non-critical precache error:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up outdated caches & claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Robust routing to prevent ERR_FAILED
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') {
    return;
  }

  const url = new URL(req.url);

  // Skip browser extensions or non-http(s)
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // 1. Navigation requests (PWA startup, index.html navigation)
  // Network first; on failure, fallback immediately to cached index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkResponse;
        })
        .catch(async () => {
          return (await caches.match(req)) ||
                 (await caches.match('./index.html')) ||
                 (await caches.match('./')) ||
                 (await caches.match('/'));
        })
    );
    return;
  }

  // 2. Live dynamic external APIs (Open-Meteo, Daum Postcode): Network first
  if (url.hostname.includes('open-meteo.com') || url.hostname.includes('daumcdn.net')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // 3. Static assets: Stale-While-Revalidate with guaranteed response
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && (networkResponse.type === 'basic' || networkResponse.type === 'cors')) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkResponse;
        });

      if (cachedResponse) {
        // Return cached version immediately; refresh cache in background
        fetchPromise.catch(() => {});
        return cachedResponse;
      }

      // If not in cache, wait for network fetch
      return fetchPromise;
    })
  );
});
