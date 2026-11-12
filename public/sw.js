// Service Worker for HoanTienShop PWA
const CACHE_NAME = 'hts-pwa-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Let the browser fetch network resources directly
  // This minimal fetch handler satisfies browser PWA install criteria
});
