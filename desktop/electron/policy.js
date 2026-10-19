// The rules that decide what the window may show and whom it may trust. They are plain functions so a test can
// run them without Electron.
const { pathToFileURL } = require('node:url')

/** The address of the launcher page, which is part of the app. */
const launcherHref = (launcherPath) => pathToFileURL(launcherPath).href

/** The address without its query and fragment, which a page may change without going anywhere else. */
const bare = (href) => {
  try {
    const u = new URL(href)
    u.search = ''
    u.hash = ''
    return u.href
  } catch {
    return ''
  }
}

/** Whether `href` is the launcher itself. Any other file:// address is not: it would be given the app's commands. */
const isLauncher = (href, launcher) => bare(href) === bare(launcher)

/**
 * Whether the window may go to `href`: the launcher, or the one server the user chose. This is asked for every
 * navigation, including the redirects a server answers with.
 */
function navigationAllowed(href, launcher, allowedOrigin) {
  if (isLauncher(href, launcher)) return true
  try {
    const u = new URL(href)
    return (u.protocol === 'http:' || u.protocol === 'https:') && allowedOrigin !== null && u.origin === allowedOrigin
  } catch {
    return false
  }
}

/**
 * What to do about a server certificate the system does not trust. Only the server the user chose is ever
 * asked about, and a certificate that was accepted once is accepted again only while it is the same one.
 *   'trusted'  the user accepted exactly this certificate before
 *   'ask'      nothing is remembered for this server: ask
 *   'changed'  something else was accepted before: ask, and say it changed
 *   'refuse'   not the server the user chose
 */
function certificateDecision(trusted, origin, allowedOrigin, fingerprint) {
  if (allowedOrigin === null || origin !== allowedOrigin) return 'refuse'
  const known = trusted?.[origin]
  if (!known) return 'ask'
  return known === fingerprint ? 'trusted' : 'changed'
}

module.exports = { launcherHref, isLauncher, navigationAllowed, certificateDecision }
