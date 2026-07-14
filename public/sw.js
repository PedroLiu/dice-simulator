// Service Worker：cache-first + runtime cache。
// 用 self.registration.scope 作为根，自动适配 dev（'/'）和 GitHub Pages（'/<repo>/'）。
// 首次访问会把打开过的所有 same-origin GET 请求写入缓存，之后离线可用。

const CACHE_NAME = 'dice-simulator-v2';
const scope = new URL(self.registration.scope);

// 预缓存最基础的入口，其它资源（骰子贴图、音效、hash 化的 JS/CSS/图片等）在首次 fetch 时按需缓存。
const CORE_ASSETS = [
  scope.pathname,
  scope.pathname + 'manifest.webmanifest',
  scope.pathname + 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // 只处理同源请求；跨域字体(Google Fonts)交给浏览器自己处理，避免 opaque 响应污染缓存。
  const url = new URL(req.url);
  if (url.origin !== scope.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        // 只缓存成功的响应，避免把 404/500 也缓存下来。
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => undefined);
        }
        return response;
      }).catch(() => cached);
    })
  );
});
