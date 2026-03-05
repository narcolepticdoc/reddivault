const VERSION = '0.7.20';
const CACHE = `reddivault-${VERSION}`;

const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
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
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // External API calls — pass through by responding with a direct network fetch
  if (url.includes('supabase.co') || url.includes('reddit.com')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Main app HTML — network first, cache fallback
  if (url.endsWith('/') || url.includes('index.html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
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
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      });
    })
  );
});
