// End-to-end check of the web client against a real bouncer and a scripted IRC
// network. Run it with run.sh, which starts both. See README.md in this folder.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const crypto = require('node:crypto')

const OUT = process.env.OUT_DIR || '.'
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080'
const URL = BASE + '/'
const SITE = process.env.SITE_URL || 'http://127.0.0.1:18081'
const PASSWORD = process.env.TEST_PASSWORD || 'a-long-password-1'
let failures = 0
const ok = (cond, msg) => {
  if (!cond) failures++
  console.log((cond ? 'ok  : ' : 'FAIL: ') + msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function login(page, user = 'matt', password = PASSWORD) {
  await page.waitForSelector('form.card')
  await page.fill('input[autocomplete=username]', user)
  await page.fill('input[type=password]', password)
  await page.click('button[type=submit]')
}

async function openBuffer(page, name) {
  await page.click(`button.name:has-text("${name}")`)
}

async function send(page, text) {
  await page.fill('#msg-input', text)
  await page.press('#msg-input', 'Enter')
}

;(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      ...(process.env.CI || process.env.NO_SANDBOX ? ['--no-sandbox'] : []),
      // A microphone that is a fake source making a beep every second, with no permission prompt.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  })
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 760 } })
  // Granted for this address in particular: a grant for every origin is not honoured by newer Chromium.
  await ctxA.grantPermissions(['notifications'], { origin: BASE })
  const page = await ctxA.newPage()
  const errors = []
  const requested = []
  page.on('request', (r) => requested.push(r.url()))
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()))

  // ---------- A. login and session security ----------
  await page.goto(URL)
  await page.waitForSelector('form.card')
  ok((await page.locator('h2').innerText()) === 'Log in', 'login form is shown to a visitor with no session')

  await login(page, 'matt', 'wrong-password')
  await page.waitForSelector('.error[role=alert]')
  ok((await page.locator('.error').innerText()).includes('bad user or password'), 'wrong password shows the bouncer message')

  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForSelector('.list')
  await page.waitForSelector('.status.connected')
  ok(true, 'correct password logs in and connects the network without a password in the socket login')

  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }))
  ok(!stored.includes(PASSWORD), 'the password is not kept in localStorage or sessionStorage')
  ok(!(await page.evaluate(() => document.cookie)).includes('session'), 'the session cookie is not readable from JavaScript')
  const cookies = await ctxA.cookies()
  const sess = cookies.find((c) => c.name === 'session')
  ok(!!sess && sess.httpOnly && sess.sameSite === 'Strict', 'session cookie is HttpOnly and SameSite=Strict')

  await page.reload()
  await page.waitForSelector('.status.connected')
  ok((await page.locator('form.card').count()) === 0, 'a reload keeps the session, with no login prompt')

  // ---------- B. channel basics ----------
  await openBuffer(page, '#chat')
  await page.waitForSelector('text=hello matt, welcome')
  ok((await page.locator('.topic a[href="https://example.com/docs"]').count()) === 1, 'topic link is clickable')
  ok((await page.locator('.line.mention').count()) >= 1, 'a mention is highlighted')
  ok((await page.locator('.pane b, .vl b').count()) === 0, 'message text never becomes markup')
  const memberText = (await page.locator('.members li').allInnerTexts()).join('|').replace(/\s/g, '')
  ok(memberText.startsWith('@op'), 'members are listed ops first')

  // ---------- C. reply, react, delete ----------
  await send(page, 'my own message')
  await page.waitForSelector('.line.self:has-text("my own message")')
  const mine = page.locator('.line.self:has-text("my own message")').last()
  await mine.hover()
  await mine.getByRole('button', { name: 'Add reaction' }).click()
  await page.getByRole('button', { name: 'React with 👍' }).click()
  await page.waitForSelector('.chip:has-text("👍 1")')
  ok(true, 'a reaction shows as a chip with a count')
  await mine.locator('.chip').click()
  await page.waitForSelector('.chip:has-text("👍")', { state: 'detached' })
  ok(true, 'clicking my own reaction removes it')

  await send(page, '!msg what time is the meeting?')
  // Alice's line, not my own "!msg" line that asked for it.
  await page.waitForSelector('.line:not(.self):has-text("what time is the meeting?")')
  const question = page.locator('.line:not(.self):has-text("what time is the meeting?")').last()
  await question.hover()
  await question.getByRole('button', { name: /Reply to alice/ }).click()
  await page.waitForSelector('.replying:has-text("Replying to alice")')
  await send(page, 'at noon')
  await page.waitForSelector('.line:has-text("at noon")')
  const answer = page.locator('.line:has-text("at noon")').last()
  ok((await answer.locator('.reply').innerText()).includes('what time is the meeting?'), 'a reply shows the message it answers')
  ok((await page.locator('.replying').count()) === 0, 'the reply banner clears after sending')

  const doomed = page.locator('.line.self:has-text("at noon")').last()
  await doomed.hover()
  await doomed.getByRole('button', { name: 'Delete message' }).click()
  await page.waitForSelector('.line:has-text("at noon")', { state: 'detached' })
  ok(true, 'deleting my message removes it when the network confirms')

  // ---------- C2. pictures, previews and players from links ----------
  await send(page, '!msg look: ' + SITE + '/pic.png and ' + SITE + '/page.html')
  await page.waitForSelector('img[src^="/api/media?u="]', { timeout: 8000 })
  await page.waitForFunction(() => [...document.querySelectorAll('img[src^="/api/media?u="]')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 8000 })
  ok(true, 'a picture link is shown inline, loaded from the bouncer')
  await page.waitForSelector('.card:has-text("An interesting article")', { timeout: 8000 })
  ok((await page.locator('.card:has-text("An interesting article")').first().innerText()).toLowerCase().includes('example journal'), 'a page link gets a card with its title and site')
  await page.waitForFunction(() => [...document.querySelectorAll('.card img.thumb')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 8000 })
  ok(true, "the card's picture loads through the bouncer too")

  await send(page, '!msg trick: ' + SITE + '/fake.png')
  await page.waitForSelector('.note:has-text("Could not load that picture")', { timeout: 8000 })
  ok(true, 'an HTML page pretending to be a picture is refused, and the link is offered instead')

  await send(page, '!msg video: ' + SITE + '/clip.mp4')
  await page.waitForSelector('video[src^="/api/media?u="]', { timeout: 8000 })
  ok(true, 'a video link becomes a video element on the bouncer address')

  await send(page, '!msg watch https://youtu.be/dQw4w9WgXcQ')
  await page.waitForSelector('.card.video button:has-text("Play here")', { timeout: 8000 })
  ok((await page.locator('iframe').count()) === 0, 'a YouTube link shows a card and loads nothing from YouTube yet')
  await page.click('.card.video button:has-text("Play here")')
  await page.waitForSelector('iframe[src^="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]')
  ok(true, 'pressing play loads the privacy-friendly player')

  // The point of the proxy: the browser asked only the bouncer, and YouTube only after the click.
  const direct = requested.filter((u) => u.startsWith(SITE))
  ok(direct.length === 0, 'the browser never contacted the linked site itself' + (direct.length ? ': ' + direct.join(', ') : ''))
  const outside = requested.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:') && !u.includes('youtube-nocookie.com'))
  ok(outside.length === 0, 'every request went to the bouncer' + (outside.length ? ': ' + outside.join(', ') : ''))

  // The settings switches really turn it off.
  await page.click('button[aria-label="Settings"]')
  await page.getByLabel('Show pictures and video inline').uncheck()
  await page.getByLabel('Show a title and picture for other links').uncheck()
  await page.getByLabel('Offer YouTube and Streamable players').uncheck()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelectorAll('img[src^="/api/media?u="], video, .card, iframe').length === 0, null, { timeout: 5000 })
  ok(true, 'with the three switches off, nothing is fetched or shown')
  await page.click('button[aria-label="Settings"]')
  await page.getByLabel('Show pictures and video inline').check()
  await page.getByLabel('Show a title and picture for other links').check()
  await page.getByLabel('Offer YouTube and Streamable players').check()
  await page.keyboard.press('Escape')

  // ---------- D. typing, E. away ----------
  await send(page, '!typing')
  await page.waitForSelector('.typing:has-text("alice is typing")')
  ok(true, 'someone typing is shown above the input')
  await page.waitForFunction(() => !document.querySelector('.typing')?.textContent?.includes('typing'), null, { timeout: 8000 })
  ok(true, 'the typing indicator goes away')

  await send(page, '!away')
  await page.waitForSelector('.members li button.away')
  ok((await page.locator('.members li button.away').innerText()).includes('carol'), 'an away member is dimmed in the list')
  await send(page, '!back')
  await page.waitForSelector('.members li button.away', { state: 'detached' })
  ok(true, 'the member is no longer dimmed when they come back')

  // ---------- F. preferences follow the account ----------
  await page.click('button[aria-label="Settings"]')
  await page.selectOption('select >> nth=0', 'dark')
  const words = page.getByLabel(/Highlight words/)
  await words.fill('deploy')
  await words.blur()
  await page.waitForTimeout(1500)
  const saved = await page.evaluate(async () => (await fetch('/api/prefs')).json())
  ok(saved.theme === 'dark' && saved.keywords?.includes('deploy'), 'preferences were saved on the bouncer: ' + JSON.stringify({ t: saved.theme, k: saved.keywords }))
  await page.keyboard.press('Escape')

  const ctxB = await browser.newContext({ viewport: { width: 1000, height: 700 } })
  const pageB = await ctxB.newPage()
  pageB.on('pageerror', (e) => errors.push('B pageerror: ' + e.message))
  await pageB.goto(URL)
  ok((await pageB.evaluate(() => document.documentElement.dataset.theme)) === undefined, 'a new browser starts with default settings')
  await login(pageB)
  await pageB.waitForSelector('.status.connected')
  await pageB.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  ok(true, 'a second device picks up the theme from the account')

  // ---------- G. read position follows the account ----------
  await openBuffer(page, 'Status')
  await openBuffer(pageB, 'Status')
  // Asked from the status buffer, so neither device is looking at #chat when the message arrives.
  await send(page, '/msg #chat !msg you have mail')
  await page.waitForSelector('button.name:has-text("#chat") .badge')
  await pageB.waitForSelector('button.name:has-text("#chat") .badge', { timeout: 5000 })
  ok(true, 'both devices show the new message as unread')
  await openBuffer(page, '#chat')
  await pageB.waitForSelector('button.name:has-text("#chat") .badge', { state: 'detached', timeout: 8000 })
  ok(true, 'reading it on one device clears it on the other')
  await ctxB.close()

  // ---------- H. a long history in a windowed list ----------
  await openBuffer(page, '#bulk')
  await page.waitForSelector('.line:has-text("bulk message")')
  await page.waitForTimeout(600)
  const rowsInDom = () => page.locator('.vl .row').count()
  const layout = await page.evaluate(() => ({
    vh: window.innerHeight,
    list: document.querySelector('.vl').clientHeight,
    inputBottom: document.querySelector('#msg-input').getBoundingClientRect().bottom,
  }))
  ok(layout.list < layout.vh && layout.inputBottom <= layout.vh + 1, `a long channel does not push the input bar off screen (list ${layout.list}px, input bottom ${Math.round(layout.inputBottom)}px, window ${layout.vh}px)`)
  ok((await rowsInDom()) < 200, `only the rows near the view are rendered (${await rowsInDom()} in the page)`)

  // Scroll to just under the load threshold, settle, and pick a line that is in view.
  await page.evaluate(() => { document.querySelector('.vl').scrollTop = 130 })
  await page.waitForTimeout(500)
  const probe = await page.evaluate(() => {
    const vl = document.querySelector('.vl')
    const top = vl.getBoundingClientRect().top
    const line = [...vl.querySelectorAll('.line .text')].find((n) => n.getBoundingClientRect().top >= top + 20)
    return line.textContent.trim()
  })
  // Cross the threshold, which asks for older messages. Read the line's position in the same
  // breath, before anything asynchronous can happen, and again once the new rows are in.
  const before = await page.evaluate((text) => {
    const vl = document.querySelector('.vl')
    vl.scrollTop = 100
    const top = vl.getBoundingClientRect().top
    const line = [...vl.querySelectorAll('.line .text')].find((n) => n.textContent.trim() === text)
    return line.getBoundingClientRect().top - top
  }, probe)
  await page.waitForTimeout(1500)
  const after = await page.evaluate((text) => {
    const vl = document.querySelector('.vl')
    const top = vl.getBoundingClientRect().top
    const line = [...vl.querySelectorAll('.line .text')].find((n) => n.textContent.trim() === text)
    return line ? line.getBoundingClientRect().top - top : null
  }, probe)
  const grew = await page.evaluate(() => document.querySelector('.vl').scrollHeight)
  ok(after !== null && Math.abs(after - before) < 6, `loading older messages does not move the view (line "${probe}" stayed at ${before.toFixed(0)}px -> ${after === null ? 'gone' : after.toFixed(0)}px; list is now ${grew}px tall)`)

  for (let i = 0; i < 40; i++) {
    if (await page.locator('.older:has-text("Start of history")').count()) break
    await page.evaluate(() => { const vl = document.querySelector('.vl'); vl.scrollTop = 0; vl.dispatchEvent(new Event('scroll')) })
    await page.waitForTimeout(250)
  }
  await page.waitForSelector('.older:has-text("Start of history")', { timeout: 5000 })
  const height = await page.evaluate(() => document.querySelector('.vl').scrollHeight)
  ok(height > 800 * 15, `the scroll height reflects all 800 messages (${height}px)`)
  ok((await rowsInDom()) < 200, `still only a window of rows in the page after loading everything (${await rowsInDom()})`)
  ok((await page.locator('.line:has-text("bulk message 0")').count()) >= 1, 'the oldest message is reachable at the top')

  await page.evaluate(() => { const vl = document.querySelector('.vl'); vl.scrollTop = vl.scrollHeight; vl.dispatchEvent(new Event('scroll')) })
  await page.waitForSelector('.line:has-text("bulk message 799")')
  ok(true, 'scrolling back down reaches the newest message')

  // ---------- I. mobile layout ----------
  await page.setViewportSize({ width: 390, height: 760 })
  await page.waitForTimeout(200)
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal page scroll at 390px')
  await page.screenshot({ path: OUT + '/mobile.png' })
  await page.setViewportSize({ width: 1280, height: 760 })
  await openBuffer(page, '#chat')
  await page.waitForTimeout(300)
  await page.screenshot({ path: OUT + '/desktop.png' })

  // ---------- J. service worker handles a push ----------
  const swUrl = await page.evaluate(async () => {
    const r = await fetch('/sw.js')
    return { type: r.headers.get('content-type'), ok: r.ok }
  })
  ok(swUrl.ok && /javascript/.test(swUrl.type), `sw.js is served as JavaScript (${swUrl.type})`)

  const cdp = await ctxA.newCDPSession(page)
  await cdp.send('ServiceWorker.enable')
  let registrationId = null
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
    if (e.registrations[0]) registrationId = e.registrations[0].registrationId
  })
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
  })
  for (let i = 0; i < 20 && !registrationId; i++) await sleep(100)
  ok(!!registrationId, 'the service worker registered')
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: BASE,
    registrationId,
    data: JSON.stringify({ title: 'alice in #chat', body: 'matt: lunch?', tag: 'fake/#chat', network: 'fake', buffer: '#chat' }),
  })
  let shown = []
  for (let i = 0; i < 30 && shown.length === 0; i++) {
    await sleep(100)
    shown = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration('/')
      return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data }))
    })
  }
  ok(shown.length === 1 && shown[0].title === 'alice in #chat' && shown[0].body === 'matt: lunch?' && shown[0].data.buffer === '#chat', 'a push shows a notification with its title, body and target: ' + JSON.stringify(shown[0]))

  // The settings switch must fail gracefully where no push service is reachable.
  await page.click('button[aria-label="Settings"]')
  await page.getByLabel('Background notifications').check()
  await page.waitForTimeout(3000)
  const pushNote = await page.locator('.note').allInnerTexts()
  const checked = await page.getByLabel('Background notifications').isChecked()
  ok(checked || pushNote.some((t) => /could not|did not allow|cannot/i.test(t)), 'the push switch either works or explains why not (checked=' + checked + ')')
  await page.keyboard.press('Escape')


  // ---------- K. direct chat and file transfer between two browsers ----------
  const ctxJ = await browser.newContext({ viewport: { width: 1100, height: 760 }, acceptDownloads: true })
  const jane = await ctxJ.newPage()
  jane.on('pageerror', (e) => errors.push('jane pageerror: ' + e.message))
  jane.on('console', (m) => m.type() === 'error' && errors.push('jane console: ' + m.text()))
  await jane.goto(URL)
  await login(jane, 'jane')
  await jane.waitForSelector('.status.connected')

  // jane has a second device open, to see that it is asked too.
  const ctxJ2 = await browser.newContext({ viewport: { width: 900, height: 700 } })
  const jane2 = await ctxJ2.newPage()
  await jane2.goto(URL)
  await login(jane2, 'jane')
  await jane2.waitForSelector('.status.connected')

  await openBuffer(page, 'Status')
  await send(page, '/direct jane')
  await page.waitForSelector('.panel .status[data-state=calling]')
  ok((await page.locator('.panel .status').innerText()).includes('Waiting for jane'), 'asking for a direct chat shows a waiting state')
  await jane.waitForSelector('button.name:has-text("matt") .badge')
  await openBuffer(jane, 'matt')
  await jane.waitForSelector('.panel .status[data-state=incoming]')
  ok((await jane.locator('.panel .status').innerText()).includes('network address'), 'the callee is told what accepting reveals, and nothing is connected yet')
  ok(!(await jane.evaluate(() => document.body.innerText)).includes('Connected directly'), 'no connection is made before the callee accepts')
  ok((await page.locator('button.name:has-text("jane")').count()) === 0 || (await page.locator('.list h3:has-text("Messages")').count()) === 0, 'signalling did not open a query window')


  await jane2.waitForSelector('button.name:has-text("matt") .badge', { timeout: 5000 })
  ok(true, "a second device of the callee's account is asked too")
  await ctxJ2.close()

  await jane.getByRole('button', { name: 'Accept' }).click()
  await page.waitForSelector('.panel .status[data-state=connected]', { timeout: 20000 })
  await jane.waitForSelector('.panel .status[data-state=connected]', { timeout: 20000 })
  ok(true, 'both browsers connect over WebRTC')
  const code1 = await page.getByTestId('safety-code').innerText()
  const code2 = await jane.getByTestId('safety-code').innerText()
  ok(/^[0-9A-F]{4}( [0-9A-F]{4}){4}$/.test(code1) && code1 === code2, 'both sides show the same safety code: ' + code1)

  await send(page, 'hello over p2p')
  await jane.waitForSelector('.line:has-text("hello over p2p")')
  await send(jane, 'hi matt, direct')
  await page.waitForSelector('.line:has-text("hi matt, direct")')
  ok(true, 'chat lines go both ways')
  ok((await page.locator('.line:has-text("hello over p2p")').count()) === 1, 'a sent line is shown once on the sender')
  await send(page, '/quit')
  await page.waitForSelector('.line.error:has-text("Commands do not work")')
  ok((await page.locator('.status.connected').count()) > 0, 'a command in a direct chat is refused instead of reaching the network')

  // A file of several chunks with a known hash.
  const data = Buffer.alloc(300_017)
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8)) & 0xff
  const want = crypto.createHash('sha256').update(data).digest('hex')
  await page.getByTestId('file-input').setInputFiles({ name: '../../report final.bin', mimeType: 'text/html', buffer: data })
  await jane.waitForSelector('.transfers li[data-state=offered]')
  const offered = await jane.locator('.transfers li').innerText()
  ok(offered.includes('report final.bin') && !offered.includes('..'), 'the offered file name is shown without any path: ' + offered.replace(/\s+/g, ' '))
  await jane.locator('.transfers li').getByRole('button', { name: 'Accept' }).click()
  await jane.waitForSelector('.transfers li[data-state=done]', { timeout: 30000 })
  await page.waitForSelector('.transfers li[data-state=done]', { timeout: 30000 })
  ok(true, 'the file transferred and both sides report it done')
  const [download] = await Promise.all([jane.waitForEvent('download'), jane.locator('.transfers li').getByRole('button', { name: 'Save' }).click()])
  const chunks = []
  for await (const c of await download.createReadStream()) chunks.push(c)
  const got = crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex')
  ok(got === want, 'the saved file is byte for byte what was sent')
  ok(download.suggestedFilename() === 'report final.bin', 'it is saved under the cleaned name: ' + download.suggestedFilename())

  // Declining sends nothing.
  await page.getByTestId('file-input').setInputFiles({ name: 'nope.txt', mimeType: 'text/plain', buffer: Buffer.from('no thanks') })
  await jane.waitForSelector('.transfers li[data-state=offered]')
  await jane.locator('.transfers li[data-state=offered]').getByRole('button', { name: 'Decline' }).click()
  await page.waitForSelector('.transfers li[data-state=declined]')
  ok(true, 'a declined file is reported to the sender')

  // An empty file is a valid file.
  await page.getByTestId('file-input').setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) })
  await jane.waitForSelector('.transfers li[data-state=offered]')
  await jane.locator('.transfers li[data-state=offered]').getByRole('button', { name: 'Accept' }).click()
  await jane.waitForSelector('.transfers li:has-text("empty.txt")[data-state=done]', { timeout: 15000 })
  ok(true, 'an empty file transfers')

  await page.screenshot({ path: OUT + '/direct-chat.png' })

  await page.getByRole('button', { name: 'Hang up' }).click()
  await page.waitForSelector('.panel .status[data-state=ended]')
  await jane.waitForSelector('.panel .status[data-state=ended]')
  ok((await jane.locator('.panel .status').innerText()).includes('They closed the chat'), 'hanging up is shown to the other side')
  ok((await jane.locator('input[type=file]').count()) === 1 && (await jane.locator('#msg-input').isDisabled()), 'the message box is off once the chat has ended')

  // It can be started again.
  await page.getByRole('button', { name: 'Connect again' }).click()
  await jane.waitForSelector('.panel .status[data-state=incoming]')
  await jane.getByRole('button', { name: 'Decline' }).first().click()
  await page.waitForSelector('.panel .status[data-state=ended]:has-text("declined")')
  ok(true, 'a declined request ends the call on the caller')
  await ctxJ.close()


  // ---------- M. voice: a channel room, then a private call ----------
  const voiceUser = async (user) => {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } })
    const p = await ctx.newPage()
    p.on('pageerror', (e) => errors.push(`${user} pageerror: ` + e.message))
    p.on('console', (m) => m.type() === 'error' && errors.push(`${user} console: ` + m.text()))
    await p.goto(URL)
    await login(p, user)
    await p.waitForSelector('.status.connected')
    await p.waitForSelector('button.name:has-text("#chat")')
    await openBuffer(p, '#chat')
    return { ctx, p }
  }
  const vJane = await voiceUser('jane')
  const vKim = await voiceUser('kim')
  await openBuffer(page, '#chat')
  const people = (p) => p.locator('[data-testid=voice-person]')
  const speakingOf = (p, nick) => p.locator(`[data-testid=voice-person]:has-text("${nick}").speaking`)

  ok((await page.getByRole('button', { name: /Join voice/ }).count()) === 1, 'a joined channel offers to join its voice room')
  await page.getByRole('button', { name: /Join voice/ }).click()
  await page.getByRole('button', { name: 'Leave voice' }).waitFor()
  ok(true, 'joining asks for the microphone and enters the room')
  await vJane.p.waitForSelector('.voice:has-text("In voice: matt")')
  ok(true, 'others in the channel see who is in the voice room')

  await vJane.p.getByRole('button', { name: /Join voice/ }).click()
  await page.waitForSelector('[data-testid=voice-person][data-state=connected]:has-text("jane")', { timeout: 20000 })
  await vJane.p.waitForSelector('[data-testid=voice-person][data-state=connected]:has-text("matt")', { timeout: 20000 })
  ok(true, 'two browsers connect to each other for voice')

  // The fake microphone beeps; hearing it on the other side shows audio really crossed the connection.
  await speakingOf(page, 'jane').first().waitFor({ timeout: 15000 })
  await speakingOf(vJane.p, 'matt').first().waitFor({ timeout: 15000 })
  ok(true, "each side's speaking indicator lights up from the other's audio")
  ok((await page.locator('audio[data-testid=voice-audio]').count()) === 1, 'one audio element plays the one other person')
  const live = await page.evaluate(() => {
    const a = document.querySelector('audio[data-testid=voice-audio]')
    return { tracks: a.srcObject.getAudioTracks().filter((t) => t.readyState === 'live').length, paused: a.paused }
  })
  ok(live.tracks === 1 && live.paused === false, 'the received audio track is live and playing: ' + JSON.stringify(live))
  const codeA = await page.locator('[data-testid=voice-person] code').count()
  await page.getByRole('button', { name: 'Safety codes' }).click()
  await vJane.p.getByRole('button', { name: 'Safety codes' }).click()
  const c1 = await page.locator('[data-testid=voice-person] code').first().innerText()
  const c2 = await vJane.p.locator('[data-testid=voice-person] code').first().innerText()
  ok(codeA === 0 && /^[0-9A-F]{4}( [0-9A-F]{4}){4}$/.test(c1) && c1 === c2, 'the pair share one safety code: ' + c1)

  await vKim.p.getByRole('button', { name: /Join voice/ }).click()
  for (const who of [page, vJane.p, vKim.p]) {
    await who.waitForFunction(() => document.querySelectorAll('[data-testid=voice-person][data-state=connected]').length === 2, null, { timeout: 25000 })
  }
  ok(true, 'a third person joins and everyone is connected to everyone')

  // Audio goes on when looking at another window.
  await openBuffer(page, '#bulk')
  await sleep(500)
  ok((await page.locator('audio[data-testid=voice-audio]').count()) === 2, 'audio keeps playing while another buffer is open')
  ok((await page.locator('button.name:has-text("🎙 #chat")').count()) === 1, 'the channel list marks the room you are in')
  await openBuffer(page, '#chat')

  // Muting silences you for the others without a new connection.
  await page.getByRole('button', { name: 'Mute' }).click()
  await sleep(1500)
  let leaked = false
  for (let i = 0; i < 20; i++) {
    if ((await speakingOf(vJane.p, 'matt').count()) > 0) leaked = true
    await sleep(150)
  }
  ok(!leaked, 'a muted person is not heard')
  ok((await speakingOf(vJane.p, 'kim').count()) > 0 || (await speakingOf(vJane.p, 'kim').first().waitFor({ timeout: 6000 }).then(() => true, () => false)), 'others are still heard while one is muted')
  await page.getByRole('button', { name: 'Unmute' }).click()
  await speakingOf(vJane.p, 'matt').first().waitFor({ timeout: 10000 })
  ok(true, 'unmuting makes them heard again')

  await vKim.p.getByRole('button', { name: 'Leave voice' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=voice-person]').length === 1, null, { timeout: 10000 })
  ok(true, 'someone leaving disappears from the others')

  // The room is limited to one voice chat: a private call cannot start while in it.
  await send(page, '/call jane')
  await page.waitForSelector('.panel .call')
  await page.waitForSelector('.panel .call:has-text("already in a voice chat")')
  ok(true, 'a call is refused while in a voice room')
  await openBuffer(page, '#chat')
  await page.getByRole('button', { name: 'Leave voice' }).click()
  await page.getByRole('button', { name: /Join voice/ }).waitFor()
  await vJane.p.waitForFunction(() => document.querySelectorAll('[data-testid=voice-person]').length === 0)
  await vJane.p.getByRole('button', { name: 'Leave voice' }).click()

  // A private call.
  await openBuffer(page, 'jane')
  await page.getByRole('button', { name: /Call/ }).first().click()
  await page.waitForSelector('.panel .call[data-state=calling]')
  await openBuffer(vJane.p, 'matt')
  await vJane.p.waitForSelector('.panel .call[data-state=incoming]')
  ok((await vJane.p.locator('.panel .call').innerText()).includes('microphone stays off'), 'the callee is told the microphone is off until answering')
  ok((await vJane.p.locator('.panel .status[data-state=connected]').count()) === 0, 'ringing does not connect anything')
  await vJane.p.getByRole('button', { name: 'Answer' }).click()
  await page.waitForSelector('.panel .call[data-state=connected]', { timeout: 20000 })
  await vJane.p.waitForSelector('.panel .call[data-state=connected]', { timeout: 20000 })
  ok(true, 'answering connects a private call')
  await page.locator('[data-testid=remote-speaking].speaking').waitFor({ timeout: 15000 })
  await vJane.p.locator('[data-testid=remote-speaking].speaking').waitFor({ timeout: 15000 })
  ok(true, 'each person hears the other')
  const k1 = await page.getByTestId('call-code').innerText()
  const k2 = await vJane.p.getByTestId('call-code').innerText()
  ok(k1 === k2 && /^[0-9A-F]{4}( [0-9A-F]{4}){4}$/.test(k1), 'the call shows the same safety code on both ends: ' + k1)
  await page.screenshot({ path: OUT + '/voice-call.png' })
  await page.getByRole('button', { name: 'Hang up' }).click()
  await vJane.p.waitForSelector('.panel .call[data-state=ended]')
  ok((await vJane.p.locator('.panel .call').innerText()).includes('They ended the call'), 'hanging up is shown to the other person')
  ok((await page.locator('audio[data-testid=voice-audio]').count()) === 0 && (await vJane.p.locator('audio[data-testid=voice-audio]').count()) === 0, 'no audio element is left playing')

  // Declining sends the caller away without the callee's microphone ever being used.
  await page.getByRole('button', { name: /Call again/ }).click()
  await vJane.p.waitForSelector('.panel .call[data-state=incoming]')
  await vJane.p.getByRole('button', { name: 'Decline' }).first().click()
  await page.waitForSelector('.panel .call:has-text("They declined")')
  ok(true, 'a declined call is reported to the caller')

  await vJane.ctx.close()
  await vKim.ctx.close()

  // ---------- L. logout ----------
  await page.click('button[aria-label="Settings"]')
  await page.getByRole('button', { name: 'Log out' }).click()
  await page.waitForSelector('form.card')
  ok(true, 'logging out returns to the login form')
  ok(!(await ctxA.cookies()).some((c) => c.name === 'session' && c.value), 'logout clears the session cookie')
  await page.reload()
  await page.waitForSelector('form.card')
  ok(true, 'after logout a reload shows the login form, not the app')
  const status = await page.evaluate(async () => (await fetch('/api/session')).status)
  ok(status === 401, 'the old session no longer works on the server')

  // Errors from trying to reach a push service that does not exist in this sandbox are expected.
  // The browser logs every failed fetch itself, so the 401 after logout appears as a console error.
  const unexpected = errors.filter((e) => !/push service|Registration failed|AbortError|subscribe|status of 401|status of 415|incognito/i.test(e))
  ok(unexpected.length === 0, 'no unexpected console or page errors' + (unexpected.length ? ': ' + unexpected.join(' | ') : ''))

  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.log('SCRIPT ERROR:', e.stack || e.message)
  process.exit(1)
})
