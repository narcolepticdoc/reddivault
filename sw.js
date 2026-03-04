// ─── VERSION ──────────────────────────────────────────────────────────────────
// INCREMENT THIS every time you deploy a new version of the app.
// Changing this string is what tells browsers to throw away the old cache
// and fetch everything fresh. Matches APP_VERSION in index.html.
const VERSION = '3.6';
const CACHE = `reddivault-${VERSION}`;

const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/dexie/3.2.4/dexie.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js',
];

// Install: cache core assets, activate immediately
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .catch(() => {}) // don't block install if a CDN asset fails
  );
  // Take over immediately without waiting for old tabs to close
  self.skipWaiting();
});

// Activate: delete all old caches that don't match current VERSION
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => {
        console.log('[SW] Deleting old cache:', k);
        return caches.delete(k);
      }))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for index.html (always get latest app),
// cache-first for everything else (CDN libraries, fonts)
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never cache Supabase API calls
  if (url.includes('supabase.co')) return;

  // For the main app HTML — always try network first so updates are instant
  // Fall back to cache only if offline
  if (url.endsWith('/') || url.includes('index.html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // For everything else — cache first, fall back to network
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
