// Minimal service worker: caches the app shell so YardDex opens fast. Data always comes from Firebase.
const CACHE = "yarddex-v5";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./firebase-config.js", "./icon-192.png", "./icon-512.png", "./icon-180.png", "./manifest.webmanifest"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/__/")) return;
  // network first, fall back to cache (so updates show up right away)
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
