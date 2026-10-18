// Service worker for Gestalt: push notifications and offline caching.
//
// The app shell (HTML, CSS, JS) is cached on install so the PWA can launch
// offline. API responses and media are not cached: they need the bouncer.

const APP_SHELL = [
  "/",
  "/index.html",
  "/src/main.ts",
  "/app.css",
  "/favicon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
];

const CACHE_NAME = "gestalt-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

// Serve the app shell from cache, falling back to the network.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests.
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // API and WebSocket requests are never cached.
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Cache GET responses for the app shell so they survive a reload offline.
        if (response.ok && url.pathname !== "/ws") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});

// --- push notifications ---

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" }
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Gestalt"
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      renotify: true,
      data: { network: data.network || "", buffer: data.buffer || "" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const { network, buffer } = event.notification.data || {}
  const target = new URL("/", self.location.origin)
  if (network) target.searchParams.set("network", network)
  if (buffer) target.searchParams.set("buffer", buffer)

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) {
        open.postMessage({ type: "open-buffer", network, buffer })
        return open.focus()
      }
      return self.clients.openWindow(target.href)
    }),
  );
});
