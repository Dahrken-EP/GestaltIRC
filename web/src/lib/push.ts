// Background notifications through Web Push. A service worker receives the push
// while no tab is open and shows the notification. The bouncer sends a push only
// when no client is attached to the network, so an open tab is not told twice.

import { api } from './api'

export type PushResult = 'ok' | 'unsupported' | 'denied' | 'error'

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  )
}

/** Decodes the base64url VAPID key into the bytes the browser wants. */
export function keyToBytes(key: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (key.length % 4)) % 4)
  const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function b64url(buf: ArrayBuffer | null): string {
  if (!buf) return ''
  let s = ''
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' })
}

/** True when this browser already has a push subscription. */
export async function pushSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    return !!(await reg?.pushManager.getSubscription())
  } catch {
    return false
  }
}

/** Asks permission, subscribes this browser, and tells the bouncer. Call from a click. */
export async function enablePush(): Promise<PushResult> {
  if (!pushSupported()) return 'unsupported'
  try {
    if ((await Notification.requestPermission()) !== 'granted') return 'denied'
    const reg = await registration()
    await navigator.serviceWorker.ready
    const { key } = await api.pushKey()
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key) }))
    await api.pushSubscribe({
      endpoint: sub.endpoint,
      keys: { p256dh: b64url(sub.getKey('p256dh')), auth: b64url(sub.getKey('auth')) },
    })
    return 'ok'
  } catch {
    return 'error'
  }
}

/** Removes this browser's subscription, here and on the bouncer. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    const sub = await reg?.pushManager.getSubscription()
    if (!sub) return
    await api.pushUnsubscribe(sub.endpoint).catch(() => {})
    await sub.unsubscribe()
  } catch {
    // nothing more to clean up
  }
}
