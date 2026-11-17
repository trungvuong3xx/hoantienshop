// Service Worker for LiLa PWA
const CACHE_NAME = 'lila-pwa-v7';
const OFFLINE_URL = '/offline.html';
// Bump CACHE_NAME whenever shell assets change; installation is all-or-nothing.
const SHELL_ASSETS = ["/","/styles.css?v=2.3.2","/selectPopup.css?v=1","/adminMobile.css?v=1","/csvImport.js?v=2.3.2","/app.js?v=2.3.5","/tiktokReply.js?v=1","/selectPopup.js?v=1","/adminMobile.js?v=2"];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([OFFLINE_URL, '/offline.js', '/icon.svg', ...SHELL_ASSETS].map(url => new Request(url, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('lila-pwa-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

async function navigationResponse(request) {
  const controller = new AbortController();
  let timer;
  let reason = 'connection';
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(request, { signal: controller.signal });
        if (response.status >= 500) {
          reason = 'server';
          throw new Error('Server unavailable');
        }
        // Include body download in the deadline, not just response headers.
        const body = await response.arrayBuffer();
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      })(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reason = 'timeout';
          controller.abort();
          reject(new Error('Navigation timeout'));
        }, 10000);
      })
    ]);
  } catch {
    const cached = await caches.match(OFFLINE_URL);
    const html = cached ? await cached.text() : '<h1>Không thể mở LiLa</h1><p>Kiểm tra Wi-Fi hoặc 4G/5G rồi mở lại ứng dụng.</p>';
    const headers = new Headers(cached ? cached.headers : undefined);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    return new Response(html.replace('data-reason="connection"', `data-reason="${reason}"`), {
      status: 503,
      headers
    });
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  // Only public shell files are cached. API, authentication and redirect data stay live.
  const shellKey = url.pathname === '/' || url.pathname === '/index.html'
    ? '/' : url.pathname + url.search;
  if (SHELL_ASSETS.includes(shellKey)) {
    event.respondWith(caches.open(CACHE_NAME).then(async cache =>
      (await cache.match(shellKey)) || fetch(event.request)));
    return;
  }
  if (event.request.mode === 'navigate' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/go/')) {
    event.respondWith(navigationResponse(event.request));
  } else if (['/offline.js', '/icon.svg'].includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
