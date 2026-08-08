/* 词间妙记 · Service Worker（离线缓存） */
const CACHE = "wbm-cache-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/words.js",
  "./js/book-notes.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 只处理本站 GET 请求；跨域（如 Supabase、CDN）不拦截
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // 页面导航：网络优先（保证更新能及时生效），离线时回退缓存
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }
  // 静态资源：先用缓存，同时后台拉取更新（stale-while-revalidate）
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
