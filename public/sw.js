// Service Worker：
// - HTML / 未 hash 化的入口：network-first，保证代码永远最新（避免 iOS 上缓存到坏版本永远无法自愈）
// - 带 hash 的静态资源（assets/*、textures/*、sounds/*）：cache-first，充分利用离线缓存
// 用 self.registration.scope 自适配子路径（dev '/'；GitHub Pages '/<repo>/'）

const CACHE_NAME = 'dice-simulator-v4';
const scope = new URL(self.registration.scope);

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

// 判断是否是"不会变的带 hash 资源"。Vite 打包出的文件名带 hash（如 index-BLhow48L.js），
// 以及 dice-box 官方静态资源，都可以放心走 cache-first。
function isImmutable(url) {
  const p = url.pathname;
  return (
    /\/assets\/.+-[A-Za-z0-9_-]{6,}\.(?:js|css|png|jpg|jpeg|webp|mp3|svg)$/.test(p) ||
    p.includes('/assets/textures/') ||
    p.includes('/assets/sounds/')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== scope.origin) return; // 跨域交给浏览器

  if (isImmutable(url)) {
    // 静态资源：cache-first。命中直接返回，否则去网络拿再缓存。
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => undefined);
        }
        return response;
      }))
    );
    return;
  }

  // 其它（HTML / manifest / sw.js 自身）：network-first，网络失败才回落到缓存。
  // 这样任何"坏版本"最多只影响一次访问；下一次刷新自愈。
  event.respondWith(
    fetch(req).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => undefined);
      }
      return response;
    }).catch(() => caches.match(req))
  );
});
