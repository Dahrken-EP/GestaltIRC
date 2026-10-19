const { _electron } = require('playwright-core')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
;(async () => {
  // The app keeps its settings and the local bouncer's data under the user's home; the test uses a home of its own.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gestalt-smoke-'))
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data') }
  const app = await _electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox'], cwd: process.cwd(), env })
  const page = await app.firstWindow()
  await page.waitForLoadState()
  await page.waitForSelector('#local:not(.hidden)')
  await page.fill('#user', 'me')
  await page.fill('#pass', 'a-long-password')
  await page.click('#local-go')
  await page.waitForURL(/127\.0\.0\.1/, { timeout: 30000 })
  await page.waitForSelector('form.card', { timeout: 15000 })
  console.log('local mode shows the login page at', page.url())
  // the bouncer's page is given no way to talk to the app
  console.log('invoke exposed to the bouncer page:', await page.evaluate(() => typeof window.__TAURI__))
  // log in through the real client
  await page.getByLabel(/user/i).first().fill('me')
  await page.locator('input[type=password]').fill('a-long-password')
  await page.getByRole('button', { name: /log in|sign in/i }).click()
  await page.waitForSelector('text=Add your first server', { timeout: 15000 })
  console.log('logged in: the client shows "Add your first server"')

  // A page the bouncer serves cannot take the window anywhere else, nor to another local file (which would be
  // given the launcher's commands).
  const here = page.url()
  for (const target of ['file:///etc/hostname', 'https://example.org/']) {
    await page.evaluate((t) => { location.href = t }, target).catch(() => {})
    await new Promise((r) => setTimeout(r, 500))
    if (page.url() !== here) throw new Error(`the bouncer's page moved the window to ${page.url()}`)
  }
  console.log('the window stays on the bouncer: refused file:// and another site')

  // The bouncer that comes with the app is watched: killed from outside, it is started again, and the page can reach it.
  const userData = await app.evaluate(({ app }) => app.getPath('userData'))
  const pidFile = path.join(userData, 'bouncer', 'bouncer.pid')
  const before = Number(fs.readFileSync(pidFile, 'utf8'))
  process.kill(before, 'SIGKILL')
  let after = 0
  for (let i = 0; i < 40 && !(after && after !== before); i++) {
    await new Promise((r) => setTimeout(r, 250))
    try { after = Number(fs.readFileSync(pidFile, 'utf8')) } catch { after = 0 }
  }
  if (!after || after === before) throw new Error('the bouncer was not started again after it was killed')
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    up = await fetch(here).then((r) => r.ok, () => false)
    if (!up) await new Promise((r) => setTimeout(r, 250))
  }
  if (!up) throw new Error('the restarted bouncer does not answer')
  console.log(`the bouncer was killed (pid ${before}) and is running again (pid ${after})`)
  // The desktop app can notify without asking, and starts with mentions notifying.
  const notif = await page.evaluate(() => ({ bridge: window.gestaltDesktop?.desktop, permission: Notification.permission, notify: JSON.parse(localStorage.getItem('irc:settings') || '{}').notify ?? 'unset' }))
  console.log('notifications:', JSON.stringify(notif))
  if (notif.bridge !== true || notif.permission !== 'granted') throw new Error('the desktop app cannot show notifications')
  // The tray holds the menu, so the window has no menu bar across its top.
  const bar = await app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null)
  console.log('window has no menu bar:', bar)
  if (!bar) throw new Error('the window still has a menu bar although the tray has the menu')

  // Closing the window keeps the app in the tray; the tray brings it back; quitting really quits.
  const closed = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.close()
    return [w.isVisible(), w.isDestroyed()]
  })
  console.log('after closing the window: visible, destroyed =', closed.join(', '))
  if (closed[0] !== false || closed[1] !== false) throw new Error('closing the window did not hide it to the tray')
  // A notification's click brings a hidden window forward, through the bridge the page is given.
  await page.evaluate(() => window.gestaltDesktop.show())
  const shown = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
  if (!shown) throw new Error('the bridge did not bring the window forward')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  const back = await app.evaluate(({ app, BrowserWindow }) => {
    app.tray.emit('click')
    return BrowserWindow.getAllWindows()[0].isVisible()
  })
  console.log('after clicking the tray icon: visible =', back)
  if (!back) throw new Error('the tray icon did not bring the window back')
  await app.close()
  // Quitting stops the bouncer and removes its pid file.
  if (fs.existsSync(path.join(userData, 'bouncer', 'bouncer.pid'))) throw new Error('the pid file is still there after quitting')
  console.log('quit: the bouncer is stopped')
  fs.rmSync(home, { recursive: true, force: true })
})().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
