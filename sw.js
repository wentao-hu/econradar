'use strict';

/* 最小 Service Worker：满足 Chrome 安装为应用的条件，并提供离线兜底。
   在线时始终网络优先，部署更新能立即生效；断网时回退到上次缓存。 */

const CACHE = 'econradar-pwa-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 数据快照用网络优先；查询参数只用于绕过 CDN，缓存键去掉参数避免碎片化
  if (url.pathname.endsWith('/data/latest.json')) {
    const cacheKey = new Request(`${url.origin}${url.pathname}`);
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            caches.open(CACHE).then((cache) => cache.put(cacheKey, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match(cacheKey))
    );
    return;
  }

  // 静态资源：网络优先，缓存兜底
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          caches.open(CACHE).then((cache) => cache.put(req, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
