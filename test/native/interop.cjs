// Chromium (as "jane") in a voice room with the desktop app (as "matt", driven by the app's own debug-build
// driver). Checks what only a real second implementation can: that the native WebRTC stack and a browser's
// connect, hear each other, and stay connected through mute and a leave and rejoin. Run by run.sh.
const browserKind = require('./browser.cjs')

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18280'
const PASSWORD = process.env.TEST_PASSWORD || 'a-long-password-1'
let failures = 0
const ok = (cond, msg) => {
  if (!cond) failures++
  console.log((cond ? 'ok  : ' : 'FAIL: ') + msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const browser = await browserKind.launch()
  const context = await browser.newContext()
  await context.addInitScript(browserKind.record)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(BASE + '/')
  await page.waitForSelector('form.card')
  await page.fill('input[autocomplete=username]', 'jane')
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForSelector('.status.connected')
  await page.click('button.name:has-text("#chat")')
  await page.getByRole('button', { name: /Join voice/ }).click()
  await page.getByRole('button', { name: 'Leave voice' }).waitFor()
  console.log('jane is in the room; waiting for the desktop app')

  // What jane sees of matt, five times a second, for as long as the desktop's driver runs through its lifecycle (join,
  // mute, leave, join again). Whether matt is being heard is read from the sound that arrived (the connection's
  // statistics), not from the page's speaking light, which needs an audio output to run and so says nothing in a
  // browser on a machine with no sound card.
  const timeline = []
  const started = Date.now()
  let last = ''
  let prevEnergy = 0
  const recent = [] // [time, energy gained] over the last second
  const budget = Number(process.env.WATCH_MS || 70000)
  while (Date.now() - started < budget) {
    let st = await page.evaluate(() => {
      const li = [...document.querySelectorAll('[data-testid=voice-person]')].find((l) => l.textContent.includes('matt'))
      return li ? li.getAttribute('data-state') : 'absent'
    })
    const now = Date.now()
    const { energy } = await browserKind.heard(page)
    // A connection that came or went changes the total in a way that is not sound.
    recent.push([now, Math.max(0, energy - prevEnergy)])
    prevEnergy = energy
    while (recent.length && now - recent[0][0] > 1000) recent.shift()
    const gained = recent.reduce((n, [, e]) => n + e, 0)
    if (st === 'connected' && gained > 0.005) st += '+speaking'
    if (st !== last) {
      timeline.push({ t: Date.now() - started, st })
      last = st
    }
    // Done once the whole lifecycle has been seen.
    if (seenAll(timeline)) break
    await sleep(200)
  }
  console.log('what jane saw of matt: ' + timeline.map((e) => `${(e.t / 1000).toFixed(1)}s ${e.st}`).join(' | '))

  const connectedAt = timeline.findIndex((e) => e.st.startsWith('connected'))
  ok(connectedAt >= 0, 'the desktop app and a browser connect to each other for voice')

  const spoke = timeline.findIndex((e) => e.st === 'connected+speaking')
  ok(spoke >= 0, "the browser hears the desktop app: its speaking indicator lights from the native side's audio")

  const audio = await page.evaluate(() => {
    const a = document.querySelector('audio[data-testid=voice-audio]')
    return a && a.srcObject ? a.srcObject.getAudioTracks().map((t) => t.readyState) : null
  })
  // The element exists only while connected; it may already be gone if the lifecycle moved on.
  if (audio) ok(audio.includes('live'), 'the received audio track is live')

  const m = muteWindow(timeline)
  ok(m.found, `muting: the desktop goes quiet for the browser (${m.found ? m.seconds.toFixed(1) + ' s' : 'never'}) and stays connected the whole time`)

  const left = spoke < 0 ? -1 : timeline.findIndex((e, i) => i > spoke && e.st === 'absent')
  ok(left >= 0, 'leaving: the desktop disappears from the browser\'s room')

  const rejoined = timeline.findIndex((e, i) => left >= 0 && i > left && e.st === 'connected+speaking')
  ok(rejoined >= 0, 'joining again: the desktop connects and is heard again')

  ok(!timeline.some((e) => e.st.startsWith('failed')), 'no connection failed at any point')
  ok(errors.length === 0, 'no page errors in the browser' + (errors.length ? ': ' + errors.join('; ') : ''))
  await browser.close()
  process.exit(failures ? 1 : 0)
})().catch((e) => {
  console.log('FAIL: ' + e.message)
  process.exit(1)
})

/** All of: connected and heard, a quiet stretch, gone, back and heard. */
function seenAll(tl) {
  const first = tl.findIndex((e) => e.st === 'connected+speaking')
  if (first < 0) return false
  const gone = tl.findIndex((e, i) => i > first && e.st === 'absent')
  if (gone < 0) return false
  return tl.some((e, i) => i > gone && e.st === 'connected+speaking')
}

/**
 * A stretch of at least four seconds, between first being heard and leaving, in which the desktop was
 * connected and never speaking, with no other state in it: what muting looks like from here.
 */
function muteWindow(tl) {
  const first = tl.findIndex((e) => e.st === 'connected+speaking')
  if (first < 0) return { found: false }
  for (let i = first + 1; i < tl.length; i++) {
    if (tl[i].st !== 'connected') continue
    // The next change ends this stretch.
    const end = i + 1 < tl.length ? tl[i + 1] : null
    if (!end) continue
    const seconds = (end.t - tl[i].t) / 1000
    // Muting ends with the desktop leaving. Ending any other way (connecting, failed) is a drop, not a mute.
    if (seconds >= 4 && end.st === 'absent') return { found: true, seconds }
  }
  return { found: false }
}
