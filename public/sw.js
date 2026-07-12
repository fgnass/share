// Offline cache. Hashed JS/CSS/font assets are immutable, so they're cache-first;
// the HTML document is network-first so a new deploy is picked up on the next
// visit instead of being shadowed forever by a stale cached index.html (which
// would keep pointing at the old hashed bundle). Pairing itself is peer-to-peer
// and needs no server, so an offline reload still works from the cached shell.
const CACHE = "share-v2";
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

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;

  // Document requests: network-first, so a fresh deploy loads immediately;
  // fall back to the cached shell when offline.
  const isNav = request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html");
  if (isNav) {
    e.respondWith(
      fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(request).then((h) => h || caches.match("./index.html")))
    );
    return;
  }

  // Everything else (hashed, immutable assets): cache-first, populate on miss.
  e.respondWith(
    caches.match(request).then((hit) =>
      hit || fetch(request).then((res) => {
        if (res.ok && new URL(request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => undefined)
    )
  );
});
