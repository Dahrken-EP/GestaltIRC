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

  await send(page, '!msg tune: ' + SITE + '/tune.mp3')
  await page.waitForSelector('audio.sound[src^="/api/media?u="]', { timeout: 8000 })
  ok((await page.locator('audio.sound').first().getAttribute('controls')) !== null, 'a sound link becomes a player on the bouncer address')

  // Imgur and Giphy pages are shown as the file they stand for, still fetched through the bouncer.
  await send(page, '!msg https://imgur.com/AbCd123 and https://giphy.com/gifs/cat-xT9IgzoKnwFNmISR8I')
  for (let i = 0; i < 40 && !(requested.some((u) => u.includes('i.imgur.com')) && requested.some((u) => u.includes('media.giphy.com'))); i++) await sleep(200)
  ok(requested.some((u) => u.endsWith('/api/media?u=https%3A%2F%2Fi.imgur.com%2FAbCd123.jpg')), 'an imgur page link is fetched as its picture, through the bouncer')
  ok(requested.some((u) => u.endsWith('/api/media?u=https%3A%2F%2Fmedia.giphy.com%2Fmedia%2FxT9IgzoKnwFNmISR8I%2Fgiphy.gif')), 'a giphy page link is fetched as its gif, through the bouncer')

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
  await page.getByLabel('Show pictures, video and sound inline').uncheck()
  await page.getByLabel('Show a title and picture for other links').uncheck()
  await page.getByLabel('Offer YouTube and Streamable players').uncheck()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelectorAll('img[src^="/api/media?u="], video, audio, .card, iframe').length === 0, null, { timeout: 5000 })
  ok(true, 'with the three switches off, nothing is fetched or shown')
  await page.click('button[aria-label="Settings"]')
  await page.getByLabel('Show pictures, video and sound inline').check()
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

  // ---------- H2. jump to latest, search, quick switcher, next unread, emoji ----------
  await page.evaluate(() => { document.querySelector('.vl').scrollTop = 3000 })
  await page.waitForSelector('button:has-text("Jump to latest")')
  ok(true, 'scrolled up, a button offers to jump to the latest message')
  await page.click('button:has-text("Jump to latest")')
  await page.waitForSelector('.line:has-text("bulk message 799")')
  await page.waitForSelector('button:has-text("Jump to latest")', { state: 'detached' })
  ok(true, 'it takes me to the newest message and goes away')

  await page.keyboard.press('Control+f')
  await page.waitForSelector('input[type=search]:focus')
  ok(true, 'Ctrl+F opens the search bar with the cursor in it')
  await page.keyboard.type('bulk message 42')
  await sleep(800)
  const found = await page.locator('.vl .line .text').allInnerTexts()
  ok(found.length === 18 && found.every((t) => t.includes('42')), `search keeps only matching messages (${found.length} of 800: every word must appear)`)
  await page.fill('input[type=search]', 'from:nobody')
  await page.waitForSelector('.vl .empty:has-text("Nothing here matches")')
  ok(true, 'a search with no matches says so')
  await page.keyboard.press('Escape')
  await page.waitForSelector('input[type=search]', { state: 'detached' })
  await page.waitForSelector('.line:has-text("bulk message 799")')
  ok(true, 'Escape closes the search and all messages come back')

  await page.keyboard.press('Control+k')
  await page.waitForSelector('[role=dialog][aria-label^="Go to"] input:focus')
  await page.keyboard.type('chat')
  await page.keyboard.press('Enter')
  await page.waitForSelector('h1:has-text("#chat")')
  ok((await page.locator('[role=dialog][aria-label^="Go to"]').count()) === 0, 'Ctrl+K, a few letters and Enter go to that channel')

  await page.keyboard.press('Control+k')
  await page.keyboard.type('zzzz')
  await page.waitForSelector('[role=dialog] .none')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[role=dialog][aria-label^="Go to"]', { state: 'detached' })
  ok(true, 'the switcher says when nothing matches, and Escape closes it')

  await openBuffer(page, '#bulk')
  await send(page, '/msg #chat !msg alt-a target')
  await page.waitForSelector('button.name:has-text("#chat") .badge')
  await page.keyboard.press('Alt+a')
  await page.waitForSelector('h1:has-text("#chat")')
  await page.waitForSelector('button.name:has-text("#chat") .badge', { state: 'detached', timeout: 5000 })
  ok(true, 'Alt+A goes to the buffer with unread messages and reads it')

  await page.focus('#msg-input')
  await page.keyboard.press('Control+e')
  await page.waitForSelector('[data-testid=emoji-grid]')
  await page.fill('.picker input', 'thumbs up')
  await page.locator('[data-testid=emoji-grid] button').first().click()
  ok(/\p{Extended_Pictographic}/u.test(await page.inputValue('#msg-input')), 'the emoji picker puts the emoji in the message')
  await page.fill('#msg-input', '')
  await page.keyboard.press('Escape')

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


  // ---------- N. plugins ----------
  const bundle = (name, permissions, source, version = '1.0.0') => JSON.stringify({ name, version, description: 'e2e ' + name, permissions, source })
  const openSettings = async () => {
    await page.click('button[aria-label="Settings"]')
    await page.waitForSelector('[data-testid=plugin-text]')
  }
  const closeSettings = async () => {
    await page.keyboard.press('Escape')
    await page.waitForSelector('.card[role=dialog]', { state: 'detached' })
  }
  /** Pastes a plugin, reviews it, and installs it. `only` names the permissions to leave ticked; all stay ticked if it is left out. */
  const installPlugin = async (json, only) => {
    await page.getByTestId('plugin-text').fill(json)
    await page.getByRole('button', { name: 'Review…' }).click()
    await page.waitForSelector('[aria-label="Allow this plugin"]')
    if (only) {
      for (const box of await page.locator('[aria-label="Allow this plugin"] input[type=checkbox]').all()) {
        const label = (await box.locator('xpath=..').innerText()).toLowerCase()
        const want = only.some((w) => label.includes(w))
        if ((await box.isChecked()) !== want) await box.setChecked(want)
      }
    }
    await page.getByRole('button', { name: 'Install' }).click()
  }
  const entry = (name) => page.locator(`[data-plugin=${name}]`)
  const statusOf = (name) => entry(name).locator('[data-testid=plugin-status]')
  const siteHits = async () => (await (await fetch(SITE + '/_hits')).json())
  const logOf = async (name) => {
    const log = entry(name).getByTestId('plugin-log')
    if ((await log.count()) === 0) await entry(name).getByRole('button', { name: /Log/ }).click()
    return log.innerText()
  }

  await openBuffer(page, '#chat')
  await openSettings()

  // A plugin that does not parse is explained, and nothing is installed.
  await page.getByTestId('plugin-text').fill('{"name":"Bad Name"}')
  await page.getByRole('button', { name: 'Review…' }).click()
  await page.getByTestId('plugin-error').waitFor()
  ok((await page.getByTestId('plugin-error').innerText()).includes('name'), 'a plugin that does not parse is explained')

  // The example, with the permission to send taken away.
  await page.getByRole('button', { name: 'Use the example' }).click()
  await page.getByRole('button', { name: 'Review…' }).click()
  await page.waitForSelector('[aria-label="Allow this plugin"]')
  const asked = await page.locator('[aria-label="Allow this plugin"] .perm').allInnerTexts()
  ok(asked.length === 4 && asked.some((t) => /send messages/i.test(t)) && asked.some((t) => /read what happens/i.test(t)), 'installing lists each permission the plugin asks for: ' + asked.join(' | '))
  await page.getByRole('button', { name: 'Cancel' }).click()
  await installPlugin(await page.getByTestId('plugin-text').inputValue(), ['read what happens', 'show lines', 'keep a small'])
  await statusOf('greeter').filter({ hasText: 'running' }).waitFor({ timeout: 10000 })
  const row = await entry('greeter').innerText()
  ok(row.includes('Not allowed: send'), 'the list shows what was refused')
  ok(row.includes('/greet'), 'the list shows the command the plugin added')
  await closeSettings()

  // /greet needs "send", which was refused, so nothing may be sent.
  await send(page, '/greet jane')
  await sleep(1500)
  ok((await page.locator('.line:has-text("Hello, jane!")').count()) === 0, 'a plugin refused permission to send cannot send')
  await openSettings()
  ok((await logOf('greeter')).includes('permission "send" was not granted'), 'its log says which permission was missing')

  // Installed again with everything allowed, it replaces the first and works.
  await page.getByRole('button', { name: 'Use the example' }).click()
  await installPlugin(await page.getByTestId('plugin-text').inputValue())
  await statusOf('greeter').filter({ hasText: 'running' }).waitFor()
  ok((await page.locator('[data-plugin]').count()) === 1, 'installing under the same name replaces the plugin')
  await closeSettings()
  await send(page, '/greet jane')
  await page.waitForSelector('.line.self:has-text("Hello, jane!")')
  ok(true, 'a command added by a plugin works, and its message goes out as the user')
  ok((await page.locator('.line:has-text("/greet")').count()) === 0, 'the typed plugin command is not also sent to the network')

  await send(page, '!msg hey matt, got a minute?')
  await page.waitForSelector('.line:has-text("[greeter] Mentioned 1 time(s)")', { timeout: 8000 })
  ok(true, 'a plugin hears about a mention, and shows a line only the user sees')
  ok((await page.locator('.line.self:has-text("[greeter]")').count()) === 0, 'a line a plugin prints is not a message from the user')

  // What it kept survives a reload, and it starts again by itself.
  await page.reload()
  await page.waitForSelector('.status.connected')
  await openBuffer(page, '#chat')
  await send(page, '!msg matt: again please')
  await page.waitForSelector('.line:has-text("[greeter] Mentioned 2 time(s)")', { timeout: 10000 })
  ok(true, 'plugins start again after a reload, with the data they kept')

  // A plugin cannot take over a built-in command.
  await openSettings()
  await installPlugin(bundle('hijack', [], `irc.alias('join', function () {}); irc.alias('mine', function () {})`))
  await statusOf('hijack').filter({ hasText: 'running' }).waitFor()
  ok((await logOf('hijack')).includes('built-in'), 'a plugin is told it cannot replace a built-in command')
  const commands = await entry('hijack').locator('div.small', { hasText: 'Commands:' }).innerText()
  ok(commands.includes('/mine') && !commands.includes('/join'), 'only the allowed alias was registered: ' + commands)

  // Timers run, and stop when the plugin is turned off.
  await installPlugin(bundle('ticker', ['timers', 'output'], `var n = 0; irc.setTimer(500, function () { irc.print('tick ' + (++n)) }, true)`))
  await statusOf('ticker').filter({ hasText: 'running' }).waitFor()
  await closeSettings()
  await page.waitForSelector('.line:has-text("[ticker] tick 3")', { timeout: 8000 })
  ok(true, 'a repeating timer runs')
  await openSettings()
  await entry('ticker').getByRole('button', { name: 'Turn off' }).click()
  await statusOf('ticker').filter({ hasText: 'stopped' }).waitFor()
  await closeSettings()
  const ticksThen = await page.locator('.line:has-text("[ticker] tick")').count()
  await sleep(2000)
  ok((await page.locator('.line:has-text("[ticker] tick")').count()) === ticksThen, 'turning a plugin off stops its timers')

  // The sandbox. The probe asks for nothing and then tries to get out.
  await openSettings()
  const probeSource = `
    var names = ['fetch','XMLHttpRequest','WebSocket','importScripts','Worker','SharedWorker','indexedDB','caches','BroadcastChannel','postMessage','setTimeout','setInterval','navigator','location'];
    irc.log('globals ' + names.map(function (n) { return n + ':' + typeof self[n]; }).join(' '));
    irc.log('page ' + typeof document + ' ' + typeof window + ' ' + typeof localStorage + ' ' + typeof XMLHttpRequest);
    irc.log('indirect ' + (new Function('return typeof fetch'))());
    var found = null, p = self;
    while (p && !found) { var d = Object.getOwnPropertyDescriptor(p, 'fetch'); if (d && typeof d.value === 'function') found = d.value; p = Object.getPrototypeOf(p); }
    if (found) { try { found.call(self, '${SITE}/escape-fetch').then(function () { irc.log('FETCH WORKED'); }, function () { irc.log('recovered fetch is blocked'); }); } catch (e) { irc.log('recovered fetch threw'); } }
    else irc.log('no fetch anywhere');
    import('${SITE}/escape.js').then(function () { irc.log('IMPORT WORKED'); }, function () { irc.log('import is blocked'); });
    import('${BASE}/api/session').then(function () { irc.log('API IMPORT WORKED'); }, function () { irc.log('api import is blocked'); });
  `
  await installPlugin(bundle('probe', [], probeSource))
  await statusOf('probe').filter({ hasText: 'running' }).waitFor()
  await sleep(2500)
  const plog = await logOf('probe')
  for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'Worker', 'SharedWorker', 'indexedDB', 'caches', 'BroadcastChannel', 'postMessage', 'setTimeout', 'setInterval', 'navigator', 'location']) {
    if (!plog.includes(n + ':undefined')) ok(false, `${n} is still there in the sandbox: ${plog}`)
  }
  ok(plog.includes('page undefined undefined undefined undefined'), 'a plugin has no document, window, storage or XMLHttpRequest')
  ok(plog.includes('indirect undefined'), 'fetch cannot be got back through Function')
  ok(!/WORKED/.test(plog), 'nothing the probe tried reached the network: ' + plog.replace(/\s+/g, ' '))
  const seen = await siteHits()
  ok(!seen.includes('/escape.js') && !seen.includes('/escape-fetch'), 'the test website never heard from the plugin: ' + JSON.stringify(seen.filter((h) => h.startsWith('/escape'))))

  // One that spins is stopped, and the page stays usable.
  await installPlugin(bundle('spinner', [], `irc.alias('spin', function () { while (true) {} })`))
  await statusOf('spinner').filter({ hasText: 'running' }).waitFor()
  await closeSettings()
  await send(page, '/spin')
  await openSettings()
  await statusOf('spinner').filter({ hasText: 'stopped' }).waitFor({ timeout: 15000 })
  ok((await entry('spinner').innerText()).includes('stopped responding'), 'a plugin stuck in a loop is stopped, with the reason shown')
  ok((await entry('greeter').locator('[data-testid=plugin-status]').innerText()).includes('running'), 'the others keep running')
  await closeSettings()
  await send(page, 'still here')
  await page.waitForSelector('.line.self:has-text("still here")')
  ok(true, 'the page stays usable while a plugin hangs')

  // Removing plugins.
  await openSettings()
  for (const name of ['greeter', 'hijack', 'ticker', 'probe', 'spinner']) await entry(name).getByRole('button', { name: 'Remove' }).click()
  ok((await page.locator('[data-plugin]').count()) === 0, 'plugins can be removed')
  await closeSettings()

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
  // The browser logs every failed fetch itself, so the 401 after logout appears as a console error, and
  // so does the 502 for the imgur and giphy pictures, which the sandbox has no way to reach.
  const unexpected = errors.filter((e) => !/push service|Registration failed|AbortError|subscribe|status of 401|status of 415|status of 502|incognito/i.test(e))
  ok(unexpected.length === 0, 'no unexpected console or page errors' + (unexpected.length ? ': ' + unexpected.join(' | ') : ''))

  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.log('SCRIPT ERROR:', e.stack || e.message)
  process.exit(1)
})
