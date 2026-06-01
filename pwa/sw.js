const VERSION = '0.9.17.0';
const CACHE = `reddivault-${VERSION}`;

const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/styles.css',
  '/js/app.js',
  '/js/state.js',
  '/js/util.js',
  '/js/core.js',
  '/js/enrich.js',
  '/js/cloud.js',
  '/js/feed.js',
  '/js/bookmarklet.js',
  '/js/dataio.js',
  '/js/search.js',
  '/js/items.js',
  '/js/render.js',
  '/js/render/shell.js',
  '/js/render/home.js',
  '/js/render/browse.js',
  '/js/render/card.js',
  '/js/render/preview.js',
  '/js/render/trash.js',
  '/js/render/lists.js',
  '/js/render/settings.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dexie/3.2.4/dexie.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => {
      // Tell all open clients to reload so they get the new version
      return self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SW_UPDATED', version: VERSION }));
      });
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // External API calls — pass through, no caching
  if (url.includes('supabase.co') || url.includes('reddit.com')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Only cache GET requests — skip POST/PATCH/DELETE entirely
  if (e.request.method !== 'GET') return;

  // Main app HTML — network first, cache fallback
  if (url.endsWith('/') || url.includes('index.html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const toCache = res.clone(); // clone BEFORE returning original
            caches.open(CACHE).then(c => c.put(e.request, toCache));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // CDN assets — cache first, network fallback
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const toCache = res.clone(); // clone BEFORE returning original
          caches.open(CACHE).then(c => c.put(e.request, toCache));
        }
        return res;
      });
    })
  );
});
