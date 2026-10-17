// Service worker for background notifications. It only handles push and the
// click on a notification; it does not cache anything.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Gestalt'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      renotify: true,
      data: { network: data.network || '', buffer: data.buffer || '' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { network, buffer } = event.notification.data || {}
  const target = new URL('/', self.location.origin)
  if (network) target.searchParams.set('network', network)
  if (buffer) target.searchParams.set('buffer', buffer)

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) {
        // An open tab switches buffer itself, without reloading.
        open.postMessage({ type: 'open-buffer', network, buffer })
        return open.focus()
      }
      return self.clients.openWindow(target.href)
    }),
  )
})
