// Takes the screenshots in the README, from the browser tests' scripted network. Run it with
//   SHOTS=1 OUT_DIR=/some/folder test/e2e/run.sh
// This checks nothing. The scripted network is named Libera.Chat so the pictures show a name people know, the
// pictures served in place of photographs are in samples/, and requests for imgur, giphy and YouTube are answered
// from the page, so the result does not depend on the network the script runs on.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const fs = require('node:fs')
const path = require('node:path')

const OUT = process.env.OUT_DIR || '.'
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080'
const SITE = process.env.SITE_URL || 'http://127.0.0.1:18081'
const PASSWORD = process.env.TEST_PASSWORD || 'a-long-password-1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sample = (name) => fs.readFileSync(path.join(__dirname, 'samples', name))

async function login(page, user) {
  await page.waitForSelector('form.card')
  await page.fill('input[autocomplete=username]', user)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForSelector('.status.connected', { state: 'attached' })
}
const open = (page, name) => page.click(`button.name:has-text("${name}")`)
async function send(page, text) {
  await page.fill('#msg-input', text)
  await page.press('#msg-input', 'Enter')
}
/** Somebody else says something. The scripted network does the talking; the instruction itself is not echoed. */
async function says(page, who, text) {
  await send(page, `!as ${who} ${text}`)
  await sleep(450)
}
const shot = async (target, name, opts = {}) => {
  await target.screenshot({ path: `${OUT}/${name}.png`, ...opts })
  console.log('shot ' + name)
}

;(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [...(process.env.CI || process.env.NO_SANDBOX ? ['--no-sandbox'] : []), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
  const ctx = (w = 1280, h = 800) => browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })

  const m = await (await ctx(1100, 1500)).newPage()
  // What imgur, giphy and YouTube would have sent.
  await m.route(/\/api\/media\?u=https%3A%2F%2Fmedia\.giphy\.com/, (r) => r.fulfill({ contentType: 'image/gif', body: sample('loop.gif') }))
  await m.route(/\/api\/media\?u=https%3A%2F%2Fi\.imgur\.com/, (r) => r.fulfill({ contentType: 'image/png', body: sample('dashboard.png') }))
  await m.route(/\/api\/media\?u=https%3A%2F%2Fi\.ytimg\.com/, (r) => r.fulfill({ contentType: 'image/png', body: sample('thumb.png') }))
  await m.route(/\/api\/preview\?u=.*youtu/, (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        url: 'https://youtu.be/dQw4w9WgXcQ',
        kind: 'youtube',
        id: 'dQw4w9WgXcQ',
        title: 'Gestalt walkthrough: direct chat, voice and plugins',
        site: 'YouTube',
        image: '/api/media?u=https%3A%2F%2Fi.ytimg.com%2Fvi%2FdQw4w9WgXcQ%2Fhq.jpg',
      }),
    }),
  )
  await m.goto(BASE + '/')
  await login(m, 'matt')
  // Dark theme for every picture.
  await m.click('button[aria-label="Settings"]')
  await m.getByRole('tab', { name: 'Appearance' }).click()
  await m.selectOption('select >> nth=0', 'dark')
  await m.keyboard.press('Escape')

  // ---- media in a conversation, one thing per line
  await open(m, '#chat')
  await m.waitForSelector('.line:has-text("hello matt")')
  await send(m, '/clear')
  await sleep(300)
  await says(m, 'bob', `Mockup for the release dashboard: ${SITE}/dashboard.png`)
  await says(m, 'alice', 'The deploy this morning https://giphy.com/gifs/deploy-friday-xT9IgzoKnwFNmISR8I')
  await says(m, 'carol', `And as a plain gif link: ${SITE}/loop.gif`)
  await says(m, 'dave', 'From the archive https://imgur.com/AbCd123')
  await m.waitForFunction(() => [...document.querySelectorAll('.messages img')].filter((i) => i.src.includes('/api/media')).every((i) => i.complete && i.naturalWidth > 0) && document.querySelectorAll('.messages img').length >= 4, null, { timeout: 20000 })
  await sleep(600)
  await shot(m.locator('.messages'), 'media-images')

  await send(m, '/clear')
  await sleep(300)
  await says(m, 'bob', `Listen to the demo: ${SITE}/tune.mp3`)
  await says(m, 'alice', 'The talk from last week https://youtu.be/dQw4w9WgXcQ')
  await says(m, 'carol', `Notes on the proxy: ${SITE}/page.html`)
  await m.waitForSelector('.card:has-text("An interesting article")', { timeout: 15000 })
  await m.waitForSelector('.card.video:has-text("Gestalt walkthrough")', { timeout: 15000 })
  await m.waitForFunction(() => [...document.querySelectorAll('.card img.thumb')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 })
  await sleep(600)
  await shot(m.locator('.messages'), 'media-embeds')

  // ---- direct chat, with a file
  await m.setViewportSize({ width: 1280, height: 800 })
  const j = await (await ctx()).newPage()
  await j.goto(BASE + '/')
  await login(j, 'jane')
  await open(m, 'Status')
  await send(m, '/direct jane')
  await open(j, 'matt')
  await j.waitForSelector('.panel .status[data-state=incoming]')
  await j.getByRole('button', { name: 'Accept' }).click()
  await m.waitForSelector('.panel .status[data-state=connected]', { timeout: 20000 })
  await send(m, 'Sending you the draft now')
  await send(j, 'Thanks, go ahead')
  await m.getByTestId('file-input').setInputFiles({ name: 'release-notes-draft.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2_400_000, 7) })
  await j.waitForSelector('.transfers li[data-state=offered]')
  await j.locator('.transfers li').getByRole('button', { name: 'Accept' }).click()
  await j.waitForSelector('.transfers li[data-state=done]', { timeout: 30000 })
  await sleep(500)
  await shot(m, 'direct-chat')
  await m.getByRole('button', { name: 'Verify…' }).click()
  await sleep(300)
  await shot(m, 'direct-chat-verify')
  await m.getByRole('button', { name: 'Hang up' }).click()

  await open(m, '#chat')

  // ---- managing servers
  await m.setViewportSize({ width: 1280, height: 800 })
  await send(m, '/clear')
  await says(m, 'alice', 'Anyone around for the release call?')
  await says(m, 'bob', 'Yes, joining in five')
  for (const [name, password, off] of [['rizon', 'Rizon', false], ['snoonet', 'Snoonet', true]]) {
    await m.getByRole('button', { name: 'Add a server' }).click()
    const d = m.getByTestId('server-dialog')
    await d.getByLabel('Name', { exact: true }).fill(name)
    await d.getByLabel('Address').fill('127.0.0.1')
    await d.getByLabel('Port').fill('16667')
    await d.getByLabel('Use TLS (encrypted)').uncheck()
    await d.getByLabel(/^Server password/).fill(password) // the scripted network takes this as the name it calls itself
    await d.getByLabel(/^Channels to join/).fill('#chat')
    if (name === 'rizon') await d.getByLabel(/^Highlight words/).fill('release gestalt')
    await d.getByRole('button', { name: 'Add server' }).click()
    await d.waitFor({ state: 'detached' })
    await m.waitForFunction((n) => document.querySelector(`button.net[data-server=${n}][aria-label*=", connected"]`), name, { timeout: 20000 })
    if (off) {
      await m.locator(`button.net[data-server=${name}]`).click()
      await m.getByRole('menuitem', { name: 'Switch off' }).click()
      await m.locator(`button.net.off[data-server=${name}]`).waitFor()
    }
  }
  await m.locator('button.net[data-server=libera]').click() // already the one on screen, so this opens its menu
  await m.getByRole('menu').waitFor()
  await sleep(300)
  await shot(m, 'servers-menu')
  await m.keyboard.press('Escape')

  // The dialog, filled in as for a real network.
  await m.setViewportSize({ width: 1280, height: 1100 })
  await m.getByRole('button', { name: 'Add a server' }).click()
  const dlg = m.getByTestId('server-dialog')
  await dlg.getByLabel('Name', { exact: true }).fill('oftc')
  await dlg.getByLabel('Address').fill('irc.oftc.net')
  await dlg.getByLabel(/^Server password/).fill('not-needed-here')
  await dlg.getByLabel('Nick', { exact: true }).fill('matt')
  await dlg.getByLabel(/^Alternative nicks/).fill('matt_ matt__')
  await dlg.getByLabel(/^SASL/).selectOption('PLAIN')
  await dlg.getByLabel('Account', { exact: true }).fill('matt')
  await dlg.getByLabel(/^Channels to join/).fill('#gestalt #help')
  await dlg.getByLabel(/^Commands to run/).fill('MODE matt +i')
  await dlg.getByLabel(/^Highlight words/).fill('gestalt release')
  await dlg.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded()
  await sleep(300)
  await shot(dlg, 'servers-dialog')
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await m.setViewportSize({ width: 1280, height: 800 })

  // ---- settings, every tab
  await m.click('button[aria-label="Settings"]')
  await m.getByRole('tab', { name: 'Plugins' }).click()
  await m.getByRole('button', { name: 'Use the example' }).click()
  await m.getByRole('button', { name: 'Review…' }).click()
  await m.getByRole('button', { name: 'Install' }).click()
  await m.locator('[data-plugin=greeter] [data-testid=plugin-status]').filter({ hasText: 'running' }).waitFor()
  await m.getByRole('tab', { name: 'Highlights' }).click()
  await m.getByLabel(/On every server/).fill('deploy\nrelease')
  await m.getByLabel(/On every server/).blur()
  await m.getByRole('tab', { name: 'Appearance' }).click()
  await m.locator('input[aria-label=Nick]').fill('bob')
  await m.locator('input[type=color]').fill('#e8a33d')
  await m.getByRole('button', { name: 'Set', exact: true }).click()
  const settings = m.getByTestId('settings')
  for (const [tab, file] of [['General', 'settings-general'], ['Appearance', 'settings-appearance'], ['Notifications', 'settings-notifications'], ['Highlights', 'settings-highlights'], ['Media', 'settings-media'], ['Plugins', 'settings-plugins']]) {
    await m.getByRole('tab', { name: tab }).click()
    await sleep(250)
    await shot(settings, file)
  }
  await m.keyboard.press('Escape')

  await browser.close()
})().catch((e) => {
  console.log('SCRIPT ERROR:', e.stack || e.message)
  process.exit(1)
})
