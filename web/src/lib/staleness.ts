// A page that was loaded before the server was updated runs the old client until it is loaded again. A browser tab
// usually gets reloaded now and then; a desktop app left in the tray does not, and one that starts can be handed its
// old copy by its cache. The server reports its own version in the session answer, so the page can tell, and ask the
// browser for a fresh copy of itself, once.

const TRIED = 'gestalt:reloaded-for'

/** Compares "1.2.3" style versions. Returns null when either is not of that form (a development build, say). */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null)
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1
  return 0
}

/**
 * Whether this page is older than the server it talks to, and has not already been reloaded for that version. Only an
 * older client is reloaded: a newer one (the server is yet to be updated) has nothing to gain, and `tried` stops a
 * server whose files are stale as well from sending the page round in circles.
 */
export function shouldReload(client: string, server: string, tried: string | null): boolean {
  return compareVersions(client, server) === -1 && tried !== server
}

/** Reloads the page if it is out of date. Returns true when it did, so the caller can stop what it was starting. */
export function reloadIfStale(client: string, server: string, reload: () => void = () => location.reload()): boolean {
  let tried: string | null = null
  try {
    tried = sessionStorage.getItem(TRIED)
  } catch {
    // no storage: the check below still works once, and a reload that did not help is not repeated by the same page
  }
  if (!shouldReload(client, server, tried)) return false
  try {
    sessionStorage.setItem(TRIED, server)
  } catch {
    // Without storage a loop would be possible; do not reload at all.
    return false
  }
  reload()
  return true
}
