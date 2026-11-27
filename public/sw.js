// Service Worker for LiLa PWA
const CACHE_NAME = 'lila-pwa-v29';
const OFFLINE_URL = '/offline.html';
// Lean customer shell assets; admin assets are lazy-loaded and cached on demand.
const SHELL_ASSETS = ["/","/styles.css?v=2.9.7","/selectPopup.css?v=3","/app.js?v=2.9.10","/selectPopup.js?v=3"];
const LAZY_ADMIN_PATHS = ['/adminMobile.css', '/csvImport.js', '/tiktokReply.js', '/adminMobile.js'];

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(
        [OFFLINE_URL, '/offline.js', '/icon.svg', ...SHELL_ASSETS].map(
          (url) => new Request(url, { cache: 'reload' })
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name.startsWith('lila-pwa-') && name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
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
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
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
    const html = cached
      ? await cached.text()
      : '<h1>Không thể mở LiLa</h1><p>Kiểm tra Wi-Fi hoặc 4G/5G rồi mở lại ứng dụng.</p>';
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

  // API, authentication and affiliate redirect routes always stay live (never cached).
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/go/')) return;

  const shellKey =
    url.pathname === '/' || url.pathname === '/index.html' ? '/' : url.pathname + url.search;

  // Stale-While-Revalidate for core shell & lazy-loaded admin assets
  if (SHELL_ASSETS.includes(shellKey) || LAZY_ADMIN_PATHS.includes(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(shellKey);
        const networkUpdate = fetch(event.request)
          .then((res) => {
            if (res && res.status === 200) {
              cache.put(shellKey, res.clone());
            }
            return res;
          })
          .catch(() => null);

        if (cached) {
          event.waitUntil(networkUpdate);
          return cached;
        }
        const fresh = await networkUpdate;
        if (fresh) return fresh;
        if (event.request.mode === 'navigate') return navigationResponse(event.request);
        return Response.error();
      })
    );
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(navigationResponse(event.request));
  } else if (['/offline.js', '/icon.svg'].includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
