// Chromium (as "jane") and the desktop app (as "matt", driven by transfer-desktop.js) in a direct chat, sending each
// other a file of MB megabytes. Checks that both arrive whole (the protocol's own SHA-256 check) and that the
// browser's saved copy of the desktop's file is byte for byte what was sent, and reports how long each took.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18280'
const PASSWORD = process.env.TEST_PASSWORD || 'a-long-password-1'
const MB = Number(process.env.MB || 20)
let failures = 0
const ok = (cond, msg) => {
  if (!cond) failures++
  console.log((cond ? 'ok  : ' : 'FAIL: ') + msg)
}

;(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [...(process.env.CI || process.env.NO_SANDBOX ? ['--no-sandbox'] : [])],
  })
  const ctx = await browser.newContext({ acceptDownloads: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(BASE + '/')
  await page.waitForSelector('form.card')
  await page.fill('input[autocomplete=username]', 'jane')
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForSelector('.status.connected')
  console.log('jane is signed in; waiting for the desktop app to ask for a direct chat')

  await page.waitForSelector('button.name:has-text("matt") .badge', { timeout: 120000 })
  await page.click('button.name:has-text("matt")')
  await page.waitForSelector('.panel .status[data-state=incoming]')
  await page.getByRole('button', { name: 'Accept' }).click()
  await page.waitForSelector('.panel .status[data-state=connected]', { timeout: 60000 })
  ok(true, 'the desktop app and a browser connect for a direct chat')

  // The desktop's file.
  const n = MB * 1024 * 1024 + 17
  const want = Buffer.alloc(n)
  for (let i = 0; i < n; i++) want[i] = (i * 31 + (i >> 8)) & 0xff
  const wantHash = crypto.createHash('sha256').update(want).digest('hex')
  const t0 = Date.now()
  await page.waitForSelector('.transfers li[data-state=offered]', { timeout: 180000 })
  await page.locator('.transfers li[data-state=offered]').getByRole('button', { name: 'Accept' }).click()
  await page.waitForSelector('.transfers li[data-state=done]', { timeout: 900000 })
  const down = (Date.now() - t0) / 1000
  ok(true, `a ${MB} MB file from the desktop app arrived whole and verified (${down.toFixed(1)} s, ${(MB / down).toFixed(1)} MB/s)`)
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.transfers li').getByRole('button', { name: 'Save' }).click()])
  const chunks = []
  for await (const c of await download.createReadStream()) chunks.push(c)
  const gotHash = crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex')
  ok(gotHash === wantHash, "the browser's saved copy is byte for byte what the desktop app sent")

  // The browser's file, back to the desktop.
  const back = Buffer.alloc(n)
  for (let i = 0; i < n; i++) back[i] = (i * 7 + (i >> 10)) & 0xff
  const t1 = Date.now()
  // By path: Playwright refuses a buffer over 50 MB.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gestalt-transfer-'))
  const file = path.join(dir, 'from-browser.bin')
  fs.writeFileSync(file, back)
  await page.getByTestId('file-input').setInputFiles(file)
  await page.waitForFunction(() => document.querySelectorAll('.transfers li[data-state=done]').length >= 2, null, { timeout: Number(process.env.TRANSFER_TIMEOUT_MS || 900000) }).catch(async (e) => {
    // Say what the browser's side looked like, which the desktop's own findings can be read beside.
    const lis = await page.evaluate(() => [...document.querySelectorAll('.transfers li')].map((l) => l.getAttribute('data-state') + ': ' + l.innerText.replace(/\s+/g, ' ').slice(0, 80)))
    console.log("the browser's transfers when it gave up: " + JSON.stringify(lis))
    throw e
  })
  const up = (Date.now() - t1) / 1000
  ok(true, `a ${MB} MB file from the browser arrived at the desktop app (${up.toFixed(1)} s, ${(MB / up).toFixed(1)} MB/s, includes the desktop accepting it)`)

  fs.rmSync(dir, { recursive: true, force: true })
  ok(errors.length === 0, 'no page errors in the browser' + (errors.length ? ': ' + errors.join('; ') : ''))
  await browser.close()
  process.exit(failures ? 1 : 0)
})().catch((e) => {
  console.log('FAIL: ' + e.message)
  process.exit(1)
})
