// Lets the app open instantly, work as an installed app, and show notifications.
// Bump VERSION whenever you change app files so phones pick up the update.
const VERSION = "sd-v16";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  // Only handle this app's own files. Scores, sign-in and the database always go to the network.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Network first (so updates show up right away), falling back to the saved copy when offline.
  // "no-cache" = always check GitHub for a newer copy (skips the browser's 10-minute cache).
  event.respondWith(
    fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match("index.html")))
  );
});

// ---- Notifications from the game watcher
self.addEventListener("push", event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(d.title || "Sports Digest", {
    body: d.body || "",
    tag: d.tag || undefined,          // a newer score update replaces the older one
    renotify: !!d.tag,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { url: d.url || "./#games" },
  }));
});

// Tapping a notification opens the app (or brings it forward) on the Games tab.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./#games", self.location.href).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        try { await w.navigate(url); } catch (e) { /* some browsers don't allow navigate; focusing is enough */ }
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
