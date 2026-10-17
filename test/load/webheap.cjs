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
    for (let step = 0; step < 60; step++) {
      const more = page.getByRole('button', { name: 'Load older messages' })
      if ((await more.count()) === 0) break
      await more.click()
      await sleep(250)
    }
    await page.getByText('Start of history').waitFor({ timeout: 5000 }).catch(() => {})
    // Scrolling to the very top shows the oldest message.
    await page.evaluate(() => {
      const el = document.querySelector('[role=log], .scroller, .virtual') || document.querySelector('.messages *')
      void el
      for (const e of document.querySelectorAll('*')) if (e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== 'visible') e.scrollTop = 0
    })
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
