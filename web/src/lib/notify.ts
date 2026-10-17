// Desktop notifications through the Notification API. Background push while the
// tab is closed needs a service worker and a push endpoint on the bouncer, which
// do not exist yet.

export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined'
}

/** Asks for permission. Call from a click handler; browsers refuse otherwise. */
export async function requestNotifyPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  return (await Notification.requestPermission()) === 'granted'
}

/** True when the user is not looking at the page. */
export function pageUnfocused(): boolean {
  if (typeof document === 'undefined') return false
  return document.hidden || !document.hasFocus()
}

export function showNotification(title: string, body: string, onClick: () => void): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return
  try {
    const n = new Notification(title, { body, tag: title })
    n.onclick = () => {
      window.focus()
      onClick()
      n.close()
    }
  } catch {
    // some mobile browsers only allow notifications from a service worker
  }
}
