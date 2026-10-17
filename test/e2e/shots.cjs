// Takes screenshots of the client in its main states, for looking at. Run with SHOTS=1 test/e2e/run.sh
// and OUT_DIR set to keep them. This checks nothing.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

const OUT = process.env.OUT_DIR || '.'
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080'
const SITE = process.env.SITE_URL || 'http://127.0.0.1:18081'
const PASSWORD = process.env.TEST_PASSWORD || 'a-long-password-1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function login(page, user) {
  await page.waitForSelector('form.card')
  await page.fill('input[autocomplete=username]', user)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  // On a phone the network list is behind a button, so only wait for it to exist.
  await page.waitForSelector('.status.connected', { state: 'attached' })
}
const open = (page, name) => page.click(`button.name:has-text("${name}")`)
async function send(page, text) {
  await page.fill('#msg-input', text)
  await page.press('#msg-input', 'Enter')
}
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot ' + name)
}

;(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [...(process.env.CI || process.env.NO_SANDBOX ? ['--no-sandbox'] : []), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
  const ctx = (w = 1280, h = 800) => browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })

  const m = await (await ctx()).newPage()
  await m.goto(BASE + '/')
  await m.waitForSelector('form.card')
  await shot(m, '01-login')
  await login(m, 'matt')
  await open(m, '#chat')
  await m.waitForSelector('.line:has-text("hello matt")')
  await send(m, 'Morning all. Has anyone seen the release notes?')
  // The scripted network answers a "!msg" line by having alice say the rest. The "!msg" line is the test's
  // own command, so it is deleted again, which leaves a conversation that reads naturally.
  await send(m, '!msg The notes are here: ' + SITE + '/page.html')
  await m.waitForSelector('.card:has-text("An interesting article")', { timeout: 10000 })
  const command = m.locator('.line.self:has-text("!msg The notes")').last()
  await command.hover()
  await command.getByRole('button', { name: 'Delete message' }).click()
  await m.waitForSelector('.line.self:has-text("!msg The notes")', { state: 'detached' })
  await send(m, 'Thanks, reading them now')
  await sleep(800)
  await shot(m, '02-channel-light')

  // Dark theme and the settings dialog.
  await m.click('button[aria-label="Settings"]')
  await m.selectOption('select >> nth=0', 'dark')
  await sleep(300)
  await m.getByRole('button', { name: 'Use the example' }).click()
  await m.getByRole('button', { name: 'Review…' }).click()
  await m.waitForSelector('[aria-label="Allow this plugin"]')
  await shot(m, '03-settings-plugin-review-dark')
  await m.getByRole('button', { name: 'Install' }).click()
  await m.locator('[data-plugin=greeter] [data-testid=plugin-status]').filter({ hasText: 'running' }).waitFor()
  await shot(m, '04-settings-plugin-installed-dark')
  await m.keyboard.press('Escape')
  await send(m, '/greet everyone')
  await sleep(600)
  await shot(m, '05-channel-dark')

  // The quick switcher and the network editor.
  await m.keyboard.press('Control+k')
  await m.waitForSelector('[role=dialog][aria-label^="Go to"]')
  await m.keyboard.type('bu')
  await sleep(300)
  await shot(m, '12-quick-switcher')
  await m.keyboard.press('Escape')
  await m.click('button[aria-label="Settings"]')
  const panel = m.getByTestId('networks-panel')
  await panel.getByRole('button', { name: 'Add a network…' }).click()
  await panel.getByLabel('Name', { exact: true }).fill('libera')
  await panel.getByLabel('Server', { exact: true }).fill('irc.libera.chat')
  await panel.getByLabel('Channels to join').fill('#gestalt')
  await panel.scrollIntoViewIfNeeded()
  await sleep(300)
  await shot(m, '13-network-editor')
  await m.keyboard.press('Escape')

  // A direct chat with a file.
  const j = await (await ctx()).newPage()
  await j.goto(BASE + '/')
  await login(j, 'jane')
  await open(m, 'Status')
  await send(m, '/direct jane')
  await open(j, 'matt')
  await j.waitForSelector('.panel .status[data-state=incoming]')
  await shot(j, '06-direct-request-callee')
  await j.getByRole('button', { name: 'Accept' }).click()
  await m.waitForSelector('.panel .status[data-state=connected]', { timeout: 20000 })
  await send(m, 'Sending you the draft now')
  await send(j, 'Thanks, go ahead')
  await m.getByTestId('file-input').setInputFiles({ name: 'release-notes-draft.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2_400_000, 7) })
  await j.waitForSelector('.transfers li[data-state=offered]')
  await j.locator('.transfers li').getByRole('button', { name: 'Accept' }).click()
  await j.waitForSelector('.transfers li[data-state=done]', { timeout: 30000 })
  await m.getByRole('button', { name: 'Safety codes' }).click().catch(() => {})
  await m.getByText('What is this?').click().catch(() => {})
  await sleep(500)
  await shot(m, '07-direct-chat-transfer')
  await shot(j, '08-direct-chat-callee-done')
  await m.getByRole('button', { name: 'Hang up' }).click()

  // A voice room of three.
  const k = await (await ctx()).newPage()
  await k.goto(BASE + '/')
  await login(k, 'kim')
  for (const p of [m, j, k]) await open(p, '#chat')
  await sleep(500)
  for (const p of [m, j, k]) {
    await p.getByRole('button', { name: /Join voice/ }).click()
    await sleep(900)
  }
  for (const p of [m, j, k]) {
    await p.waitForFunction(() => document.querySelectorAll('[data-testid=voice-person][data-state=connected]').length === 2, null, { timeout: 25000 })
  }
  await m.locator('[data-testid=voice-person].speaking').first().waitFor({ timeout: 15000 }).catch(() => {})
  await shot(m, '09-voice-room')

  // A phone.
  const ph = await (await ctx(390, 844)).newPage()
  await ph.goto(BASE + '/')
  await login(ph, 'matt')
  await sleep(500)
  await shot(ph, '10-phone-list')
  await ph.click('button[aria-label="Show channels"]').catch(() => {})
  await sleep(300)
  await shot(ph, '11-phone-channels')

  await browser.close()
})().catch((e) => {
  console.log('SCRIPT ERROR:', e.stack || e.message)
  process.exit(1)
})
