/* Offline support: app shell is cached, weather is network-first, map tiles are cached as you view them. */
const VERSION = 'hs-v2';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/astro.js', 'js/movement.js',
  'vendor/suncalc.js', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const TILE_CACHE = 'hs-tiles';
const MAX_TILES = 1500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isTile(url) {
  return /arcgisonline\.com|tile\.openstreetmap\.org|tile\.opentopomap\.org/.test(url.hostname);
}

async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (isTile(url)) {
    // Cache-first so stands still show on satellite when there's no signal.
    e.respondWith(caches.open(TILE_CACHE).then(async (cache) => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === 'opaque') { cache.put(e.request, res.clone()); trimTiles(); }
      return res;
    }));
    return;
  }

  if (url.origin === self.location.origin) {
    // Stale-while-revalidate for the app shell.
    e.respondWith(caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
  // Everything else (weather API) goes straight to the network; the app keeps its own copy.
});
