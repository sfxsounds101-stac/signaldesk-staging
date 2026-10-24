// SignalDesk ISP — service worker
// Only caches the static "app shell" (this page + icons) so the app opens
// instantly and shows a friendly offline message if there's no connection.
// It deliberately does NOT cache Supabase data, the /api/send-receipt
// endpoint, or CDN scripts — those always go straight to the network so
// you're never looking at stale subscriber/payment data.

const CACHE_NAME = 'signaldesk-shell-v1';
const SHELL_FILES = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests for shell files.
  // Everything else (Supabase, /api/*, CDN scripts) passes through untouched.
  const isShellFile = url.origin === self.location.origin &&
    SHELL_FILES.some((f) => url.pathname.endsWith(f.replace('./', '')));

  if (event.request.method === 'GET' && isShellFile) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request)
          .then((res) => {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
