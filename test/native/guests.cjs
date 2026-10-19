// The desktop app (as "matt", driven by guests-desktop.js) hosts a voice room with a person in it (Chromium, "jane")
// and a guest who came by a link (Chromium, "Sam"). The guest has one connection, to the app, and everything the
// guest hears of jane and everything jane hears of the guest is mixed by the app. Measured with the browsers' own
// statistics: how much sound arrived, in the stretch where everyone talks and in the stretch where the host is muted
// (when nothing is left to hear but what the app passes on).
const browserKind = require('./browser.cjs')

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18280'
const PASSWORD = process.env.TEST_PASSWORD || 'a-long-password-1'
const GUEST_PATH = process.env.GUEST_PATH
let failures = 0
const ok = (cond, msg) => {
  if (!cond) failures++
  console.log((cond ? 'ok  : ' : 'FAIL: ') + msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  if (!GUEST_PATH) throw new Error('GUEST_PATH is not set: run.sh makes the link')
  const browser = await browserKind.launch()
  const errors = []
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } })
    await ctx.addInitScript(browserKind.record)
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    return page
  }

  const jane = await open()
  await jane.goto(BASE + '/')
  await jane.waitForSelector('form.card')
  await jane.fill('input[autocomplete=username]', 'jane')
  await jane.fill('input[type=password]', PASSWORD)
  await jane.click('button[type=submit]')
  await jane.waitForSelector('.status.connected')
  await jane.click('button.name:has-text("#chat")')
  await jane.getByRole('button', { name: /Join voice/ }).click()
  await jane.getByRole('button', { name: 'Leave voice' }).waitFor()
  await jane.waitForSelector('[data-testid=voice-person][data-state=connected]:has-text("matt")', { timeout: 120000 })
  ok(true, 'the desktop app and a browser are in one voice room')

  const guest = await open()
  await guest.goto(BASE + GUEST_PATH)
  await guest.getByLabel('Your name').fill('Sam')
  await guest.getByRole('button', { name: 'Connect' }).click()
  await guest.waitForSelector('[data-testid=guest-room-state][data-state=connected]', { timeout: 60000 }).catch(async (e) => {
    console.log('the guest page when it gave up: ' + (await guest.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400))
    console.log("the browser in the room saw: " + (await jane.evaluate(() => document.querySelector('section.voice')?.innerText ?? '')).replace(/\s+/g, ' ').slice(0, 300))
    throw e
  })
  ok(true, 'a guest joins the desktop app\'s room by a link, and is connected')
  await jane.waitForSelector('[data-testid=voice-person]:has-text("Sam")', { timeout: 20000 })
  ok(true, 'the browser in the room sees the guest listed')

  // Sound received, sampled twice a second for 16 seconds from the moment the guest was connected. The app mutes its
  // microphone about 7 seconds in, for 8 seconds.
  const samples = []
  const t0 = Date.now()
  while (Date.now() - t0 < 16500) {
    samples.push({ t: (Date.now() - t0) / 1000, guest: await browserKind.heard(guest), jane: await browserKind.heard(jane) })
    await sleep(500)
  }
  const between = (who, from, to) => {
    const a = samples.find((s) => s.t >= from)
    const b = [...samples].reverse().find((s) => s.t <= to)
    return { energy: b[who].energy - a[who].energy, packets: b[who].packets - a[who].packets }
  }
  // Everyone talking, and the host muted. (Margins on either side of the mute, which is only roughly timed.)
  const talking = { guest: between('guest', 1, 5.5), jane: between('jane', 1, 5.5) }
  const muted = { guest: between('guest', 9.5, 14), jane: between('jane', 9.5, 14) }
  const f = (x) => `${x.packets} packets, energy ${x.energy.toFixed(3)}`
  console.log(`everyone talking:  guest heard ${f(talking.guest)}; jane heard ${f(talking.jane)}`)
  console.log(`the host muted:    guest heard ${f(muted.guest)}; jane heard ${f(muted.jane)}`)

  // Decoded silence reads exactly 0; the browsers' test tones read from 0.04 (Firefox, muted stretch) to over 1 (Chromium), so
  // anything clearly above zero is sound that really arrived.
  const SOUND = 0.01
  ok(talking.guest.packets > 100 && talking.guest.energy > SOUND, 'the guest hears the room')
  ok(talking.jane.packets > 100 && talking.jane.energy > SOUND, 'the browser in the room hears the host')
  ok(muted.guest.packets > 100 && muted.guest.energy > SOUND, "with the host muted, the guest still hears the person in the room: the app passes it on")
  ok(muted.jane.packets > 100 && muted.jane.energy > SOUND, 'with the host muted, the person in the room still hears the guest: the app passes it on')

  ok(errors.length === 0, 'no page errors in the browsers' + (errors.length ? ': ' + errors.join('; ') : ''))
  await browser.close()
  process.exit(failures ? 1 : 0)
})().catch((e) => {
  console.log('FAIL: ' + e.message)
  process.exit(1)
})
