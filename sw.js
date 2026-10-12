// Service worker : rend l'app installable et lui permet de s'ouvrir sans réseau.
// Réseau d'abord (une mise en ligne est visible tout de suite), cache en secours.
// Les appels à Supabase ne passent jamais par le cache : les données restent toujours fraîches.
const CACHE = "sport-v1";
const COQUILLE = ["./", "index.html", "style.css", "config.js", "demo.js", "app.js", "manifest.json", "icons/icon-192.png"];
const HOTES_EN_CACHE = [self.location.host, "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(COQUILLE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || !HOTES_EN_CACHE.includes(new URL(req.url).host)) return;
  e.respondWith(
    fetch(req)
      .then((rep) => {
        if (rep.ok || rep.type === "opaque") {
          const copie = rep.clone();
          caches.open(CACHE).then((c) => c.put(req, copie));
        }
        return rep;
      })
      .catch(() => caches.match(req, { ignoreSearch: req.mode === "navigate" })),
  );
});
