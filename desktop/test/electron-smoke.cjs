const { _electron } = require('playwright-core')
;(async () => {
  const app = await _electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env } })
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
  // The desktop app can notify without asking, and starts with mentions notifying.
  const notif = await page.evaluate(() => ({ bridge: window.gestaltDesktop?.desktop, permission: Notification.permission, notify: JSON.parse(localStorage.getItem('irc:settings') || '{}').notify ?? 'unset' }))
  console.log('notifications:', JSON.stringify(notif))
  if (notif.bridge !== true || notif.permission !== 'granted') throw new Error('the desktop app cannot show notifications')
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
})().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
