const CACHE = 'tiktok-reply-pwa-v1';
const ASSETS = ['index.html', 'pwa.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable.png'];
const assetUrl = path => new URL(path, self.registration.scope).href;
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    await cache.addAll(ASSETS.map(assetUrl));
    await self.skipWaiting();
  }));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('tiktok-reply-pwa-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!url.href.startsWith(self.registration.scope)) return;
  const root = new URL(self.registration.scope);
  const isHome = event.request.mode === 'navigate' && (url.pathname === root.pathname || url.pathname === new URL('index.html', root).pathname);
  const key = isHome ? assetUrl('index.html') : url.origin + url.pathname;
  if (!isHome && !ASSETS.map(assetUrl).includes(key)) return;
  // Static shell only: never cache sign-in pages, APIs or third-party requests.
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(key)) || fetch(event.request)));
});
