// Ten real browsers in one voice room, and an eleventh turned away. Run it with
// VOICE_LOAD=1 test/e2e/run.sh, which adds the users u01 to u11 and starts this instead of
// the normal checks. It reports memory and processor use as information, not as a pass mark.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const fs = require('node:fs')

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080'
const PASSWORD = process.env.TEST_PASSWORD || 'a-long-password-1'
const N = 10
let failures = 0
const ok = (cond, msg) => {
  if (!cond) failures++
  console.log((cond ? 'ok  : ' : 'FAIL: ') + msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** CPU seconds used so far by every browser process on this machine, from /proc. Nothing else of that kind should be running. */
function browserCpuSeconds() {
  let total = 0
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      if (!/chrom|headless_shell/.test(fs.readlinkSync(`/proc/${d}/exe`))) continue
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8')
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      total += (Number(f[11]) + Number(f[12])) / 100
    } catch {
      // the process ended, or is not ours to read
    }
  }
  return total
}

;(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      ...(process.env.CI || process.env.NO_SANDBOX ? ['--no-sandbox'] : []),
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  })
  const pages = []
  const errors = []
  for (let i = 1; i <= N + 1; i++) {
    const user = 'u' + String(i).padStart(2, '0')
    const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(`${user}: ${e.message}`))
    await page.goto(BASE + '/')
    await page.waitForSelector('form.card')
    await page.fill('input[autocomplete=username]', user)
    await page.fill('input[type=password]', PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForSelector('.status.connected')
    await page.click('button.name:has-text("#chat")')
    pages.push({ user, page })
  }
  ok(true, `${N + 1} browsers are logged in`)

  const t0 = Date.now()
  for (const { page } of pages.slice(0, N)) {
    await page.getByRole('button', { name: /Join voice/ }).click()
    await sleep(700)
  }
  for (const { user, page } of pages.slice(0, N)) {
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid=voice-person][data-state=connected]').length === n, N - 1, { timeout: 60000 })
    void user
  }
  ok(true, `all ${N} are connected to the other ${N - 1} (${Math.round((Date.now() - t0) / 1000)} s from the first join)`)

  const counts = await Promise.all(pages.slice(0, N).map(({ page }) => page.locator('audio[data-testid=voice-audio]').count()))
  ok(counts.every((c) => c === N - 1), `each one plays ${N - 1} audio streams`)

  // Someone is heard by everyone else.
  let heard = 0
  for (let i = 0; i < 20 && heard < N; i++) {
    heard = 0
    for (const { page } of pages.slice(0, N)) if ((await page.locator('[data-testid=voice-person].speaking').count()) > 0) heard++
    if (heard < N) await sleep(300)
  }
  ok(heard === N, `every one of the ${N} hears somebody speak (${heard})`)

  const cpu0 = browserCpuSeconds()
  await sleep(10000)
  const cpu1 = browserCpuSeconds()
  console.log(`info: all ${N + 1} browsers together used ${(cpu1 - cpu0).toFixed(1)} CPU seconds in 10 s, about ${((cpu1 - cpu0) / 10 / N).toFixed(2)} of a core per voice participant`)
  const heap = await Promise.all(pages.slice(0, N).map(({ page }) => page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0))))
  console.log(`info: JavaScript heap per participant: ${Math.round(Math.max(...heap) / 1048576)} MB at most, ${Math.round(heap.reduce((a, b) => a + b, 0) / N / 1048576)} MB on average`)

  // The eleventh is refused.
  const late = pages[N].page
  await late.getByRole('button', { name: /Join voice/ }).click()
  await late.waitForSelector('.voice .error:has-text("full")', { timeout: 20000 })
  ok(true, 'an eleventh person is told the room is full')
  const still = await Promise.all(pages.slice(0, N).map(({ page }) => page.locator('[data-testid=voice-person][data-state=connected]').count()))
  ok(still.every((c) => c === N - 1), 'the ten are undisturbed by the eleventh')

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.log('SCRIPT ERROR:', e.stack || e.message)
  process.exit(1)
})
