// Service worker for Gestalt: push notifications and offline caching.
//
// The app shell (HTML, CSS, JS) is cached on install so the PWA can launch
// offline. API responses and media are not cached: they need the bouncer.

const APP_SHELL = [
  "/",
  "/index.html",
  "/favicon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
];

// Bumped when what may be cached changes: the old cache is deleted on activation. (v2 kept anything the site
// answered, including uploaded files and guest-link pages; v3 keeps only the app itself.)
const CACHE_NAME = "gestalt-shell-v3";

// What the worker may keep: the app shell, the manifest, and the hashed build files. Everything else (hosted
// uploads, a guest link's page, the media proxy, the API) is left to the network, so that a file that has
// expired on the bouncer does not live on in this browser, and a link that was revoked is not shown from here.
const CACHEABLE = new Set([...APP_SHELL, "/manifest.webmanifest"]);
const isCacheable = (url) => CACHEABLE.has(url.pathname) || url.pathname.startsWith("/assets/");

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

// Documents (the HTML shell, icons, the manifest) come from the network when
// possible, so an updated bouncer's client reaches the page after one reload;
// the cache only answers when the device is offline. Files under /assets/ have
// hashed names that change with every build, so a cached copy is always valid.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests.
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Only the app itself is the worker's business.
  if (!isCacheable(url)) return;

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Keep the fresh copy so a later reload works offline. (Only a whole answer: a partial one cannot be stored.)
        if (response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request)),
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
