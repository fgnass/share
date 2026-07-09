// Minimal offline cache. We precache the shell and then cache every same-origin
// GET as it's fetched (the hashed JS/CSS/font assets), so after the first load a
// reload works offline — pairing itself is peer-to-peer and needs no server.
const CACHE = "share-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-512.png", "./icon-192.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for the app shell, network-first-ish fallback for everything else.
self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  e.respondWith(
    caches.match(request).then((hit) =>
      hit || fetch(request).then((res) => {
        // Cache same-origin GETs so a reload works offline.
        if (res.ok && new URL(request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match("./index.html"))
    )
  );
});
