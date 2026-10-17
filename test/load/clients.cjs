// Attaches many clients to a running bouncer, as a web client would, and reports how long it took and how
// much came back. Used by run.sh, which measures the bouncer's memory around it.
//
//   node clients.cjs USERS NETWORKS_PER_USER   (user names u01.., networks n1..)
const WebSocket = globalThis.WebSocket
const BASE = process.env.BASE_URL || 'ws://127.0.0.1:18090/ws'
const PASSWORD = process.env.TEST_PASSWORD || 'a-long-password-1'
const USERS = Number(process.argv[2] || 50)
const NETS = Number(process.argv[3] || 2)
const HOLD_MS = Number(process.env.HOLD_MS || 0)
const API = BASE.replace(/^ws/, 'http').replace(/\/ws$/, '')
// "cookie" is how the web client attaches: one password check at login, then the session cookie. "password" is
// how an ordinary IRC client does, with a password check on every connection.
const AUTH = process.env.AUTH || 'cookie'
const EXPECT = Number(process.env.CHANNELS || 0)
const cookies = new Map()

async function sessionCookie(user) {
  if (cookies.has(user)) return cookies.get(user)
  const res = await fetch(API + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`${user}: login failed (${res.status})`)
  const c = res.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ')
  cookies.set(user, c)
  return c
}

async function attach(user, net, tries = 0) {
  try {
    return await attachOnce(user, net)
  } catch (e) {
    if (!e.retry || tries >= 20) throw e
    e.ws?.close()
    await new Promise((r) => setTimeout(r, 3000))
    return attach(user, net, tries + 1)
  }
}

async function attachOnce(user, net) {
  const cookie = AUTH === 'cookie' ? await sessionCookie(user) : ''
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const ws = new WebSocket(BASE, { protocols: ['text.ircv3.net'], headers: cookie ? { Cookie: cookie } : {} })
    let lines = 0
    let bytes = 0
    let channels = 0
    const send = (l) => ws.send(l)
    const timer = setTimeout(() => reject(new Error(`${user}/${net}: timed out after ${lines} lines`)), 60000)
    ws.onclose = () => {}
    ws.onopen = () => send('CAP LS 302')
    ws.onerror = (e) => reject(new Error(`${user}/${net}: socket error`))
    ws.onmessage = (ev) => {
      const line = String(ev.data)
      lines++
      bytes += line.length
      if (/ CAP \S+ LS /.test(line)) {
        send('CAP REQ :sasl message-tags server-time batch echo-message chathistory message-ids draft/read-marker')
      } else if (/ CAP \S+ ACK /.test(line)) {
        send('AUTHENTICATE PLAIN')
      } else if (line.startsWith('AUTHENTICATE +')) {
        send('AUTHENTICATE ' + Buffer.from(`\0${user}/${net}\0${AUTH === 'cookie' ? '' : PASSWORD}`).toString('base64'))
      } else if (/ 903 /.test(line)) {
        send('CAP END')
        send('NICK x')
        send('USER x 0 * :x')
      } else if (/ 904 /.test(line)) {
        reject(new Error(`${user}/${net}: login refused: ${line}`))
      } else if (/ 366 /.test(line)) {
        // The channel snapshot is over for one channel; the attach is over when the replay has gone quiet.
        channels++
      }
      clearTimeout(quiet)
      quiet = setTimeout(done, 700)
    }
    let quiet = setTimeout(() => {}, 0)
    function done() {
      clearTimeout(timer)
      // A network whose upstream connection is not up yet has no channels to show. A real client would be
      // shown an empty window and reconnect; this one is told to try again.
      if (channels === 0 || channels < EXPECT) return reject(Object.assign(new Error('not ready'), { retry: true, ws }))
      resolve({ ms: Date.now() - started, lines, bytes, channels, ws })
    }
  })
}

;(async () => {
  const jobs = []
  for (let u = 1; u <= USERS; u++) for (let n = 1; n <= NETS; n++) jobs.push([`u${String(u).padStart(2, '0')}`, `n${n}`])
  const t0 = Date.now()
  const results = []
  // Attached in waves, as people arrive, not all in one instant.
  for (let i = 0; i < jobs.length; i += 20) {
    results.push(...(await Promise.all(jobs.slice(i, i + 20).map(([u, n]) => attach(u, n)))))
  }
  const ms = results.map((r) => r.ms).sort((a, b) => a - b)
  const total = results.reduce((a, r) => a + r.lines, 0)
  console.log(JSON.stringify({
    clients: results.length,
    totalSeconds: (Date.now() - t0) / 1000,
    attachMsMedian: ms[Math.floor(ms.length / 2)],
    attachMsWorst: ms[ms.length - 1],
    linesPerClient: Math.round(total / results.length),
    bytesPerClient: Math.round(results.reduce((a, r) => a + r.bytes, 0) / results.length),
    channelsPerClient: Math.round(results.reduce((a, r) => a + r.channels, 0) / results.length),
  }))
  if (HOLD_MS) await new Promise((r) => setTimeout(r, HOLD_MS))
  for (const r of results) r.ws.close()
  process.exit(0)
})().catch((e) => {
  console.error('LOAD ERROR:', e.message)
  process.exit(1)
})
