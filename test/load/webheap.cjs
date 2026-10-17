// Opens ten channels, loads each one's whole history, and reports the page's JavaScript heap after a
// garbage collection at each step. Run by web.sh.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18095'
const PASSWORD = process.env.TEST_PASSWORD || 'a-long-password-1'
const MSGS = Number(process.env.MSGS || 2000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    // Exact heap numbers and a way to collect garbage first, so the figures are of what is held, not of what is waiting to be freed.
    args: [...(process.env.CI || process.env.NO_SANDBOX ? ['--no-sandbox'] : []), '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const heapMB = async () => {
    await page.evaluate(() => window.gc && window.gc())
    await sleep(300)
    await page.evaluate(() => window.gc && window.gc())
    return (await page.evaluate(() => performance.memory.usedJSHeapSize)) / 1048576
  }

  await page.goto(BASE + '/')
  await page.waitForSelector('form.card')
  await page.fill('input[autocomplete=username]', 'matt')
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForSelector('.status.connected')
  await page.waitForSelector('button.name:has-text("#load10")')
  const start = await heapMB()
  console.log(`logged in, ten channels joined, nothing opened: ${start.toFixed(1)} MB`)

  // Each channel is opened, which shows its newest messages (the bouncer replays up to its replay limit).
  for (let i = 1; i <= 10; i++) {
    await page.click(`button.name:has-text("#load${i}")`)
    await page.waitForSelector('.line')
    await sleep(300)
  }
  const replayed = await heapMB()
  console.log(`ten channels opened, with the replay each got: ${replayed.toFixed(1)} MB`)

  // Then each one is scrolled to the start of its history, which loads the rest. The start is checked
  // for: the oldest message must be reachable, or the figure below would be of less than it claims.
  let complete = 0
  for (let i = 1; i <= 10; i++) {
    await page.click(`button.name:has-text("#load${i}")`)
    // The list draws only the rows near the view, so the button for older messages exists only while
    // the view is at the top. Scrolling there asks for the next page; keep going until the start.
    for (let step = 0; step < 120; step++) {
      if ((await page.locator('.older:has-text("Start of history")').count()) > 0) break
      await page.evaluate(() => {
        const vl = document.querySelector('.vl')
        vl.scrollTop = 0
        vl.dispatchEvent(new Event('scroll'))
      })
      await sleep(200)
    }
    await sleep(300)
    if ((await page.locator(`.line:has-text("message 0 in #load${i}:")`).count()) > 0) complete++
  }
  console.log(`channels whose oldest message was reached: ${complete} of 10`)
  await sleep(1000)
  const full = await heapMB()
  console.log(`all ten with their full history (${MSGS} messages each, ${10 * MSGS} in all): ${full.toFixed(1)} MB   (budget 60 MB)`)

  // And the list stays small however much is loaded: only the rows near the view are in the page.
  const rows = await page.locator('.line').count()
  const nodes = await page.evaluate(() => document.getElementsByTagName('*').length)
  console.log(`rows in the page: ${rows}, elements in the page: ${nodes}`)
  if (errors.length) console.log('page errors: ' + errors.join(' | '))
  await browser.close()
})().catch((e) => {
  console.error('SCRIPT ERROR:', e.stack || e.message)
  process.exit(1)
})
