// Service Worker — COLFRAME Horas Extra
const CACHE = 'colframe-v4';
const STATIC = [
  './', './index.html', './app.html', './admin.html',
  './css/styles.css',
  './js/config.js', './js/api.js', './js/geo.js', './js/app.js', './js/admin.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // API calls (Apps Script) siempre van a la red
  if (e.request.url.includes('script.google.com')) return;
  // Fonts siempre van a la red con fallback al cache
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
