/* 词间妙记 · Service Worker（离线缓存） */
const CACHE = "wbm-cache-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./css/style.css?v=3",
  "./js/words.js?v=3",
  "./js/book-notes.js?v=3",
  "./js/supabase-config.js?v=3",
  "./js/app.js?v=3",
  "./manifest.webmanifest?v=3",
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
  // 网络优先：保证每次都能拿到最新文件；离线时回退缓存
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((hit) => hit || (e.request.mode === "navigate" ? caches.match("./index.html") : undefined))
      )
  );
});
