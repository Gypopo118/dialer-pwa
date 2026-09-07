// Простой app-shell кэш. При доработке под нативную сборку через Capacitor
// этот service worker обычно не используется внутри WebView (нативный
// контейнер грузит файлы локально), но остаётся нужен, если приложение
// также публикуется как обычный PWA/TWA.

const CACHE_NAME = 'dialer-shell-v2';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/base.css',
  './css/home.css',
  './css/sheets.css',
  './js/main.js',
  './js/store.js',
  './js/mock-data.js',
  './js/recents-model.js',
  './js/adapters/contacts-adapter.js',
  './js/adapters/call-log-adapter.js',
  './js/adapters/telephony-adapter.js',
  './js/adapters/native-bridge.js',
  './js/screens/home-screen.js',
  './js/screens/contact-history-screen.js',
  './js/screens/call-screen.js',
  './js/components/context-menu.js',
  './js/utils/format.js',
  './js/utils/icons.js',
  './js/utils/back-stack.js',
  './js/utils/list-scroll-gesture.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32x32.png',
  './icons/favicon-16x16.png',
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
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
