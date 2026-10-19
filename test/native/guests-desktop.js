;(function () {
  // Runs inside the desktop app's window (GESTALT_EVAL_JS). Signs in as matt, joins the voice room in #chat, waits for a
  // guest named Sam to be connected, then stays for a while, mutes for a stretch, unmutes, and leaves its findings in
  // window.__probe. __PASS__ is filled in by run.sh.
  const P = (window.__probe = { step: 'start', ok: true, done: false })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (f, ms, what) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const v = f()
      if (v) return v
      await sleep(100)
    }
    throw new Error('timed out waiting for ' + what + ' (after step ' + P.step + ')')
  }
  // What the window says in its lines, for whoever reads the findings.
  setInterval(() => { P.lines = [...document.querySelectorAll('.line.error, .line.info')].slice(-6).map((l) => l.innerText.replace(/\s+/g, ' ').slice(0, 140)) }, 2000)
  const voice = () => document.querySelector('section.voice')
  const button = (prefix) => [...(voice()?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim().startsWith(prefix))
  ;(async () => {
    try {
      const u = await until(() => document.querySelector('input[autocomplete="username"]'), 30000, 'the login form')
      const p = document.querySelector('input[type="password"]')
      u.value = 'matt'
      u.dispatchEvent(new Event('input', { bubbles: true }))
      p.value = '__PASS__'
      p.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(100)
      u.form.requestSubmit()
      await until(() => document.querySelector('.status.connected'), 30000, 'the IRC connection')
      const chat = await until(() => [...document.querySelectorAll('button.name')].find((b) => b.textContent.includes('#chat')), 20000, '#chat')
      chat.click()
      const join = await until(() => voice() && !voice().classList.contains('on') && voice().querySelectorAll('button')[0], 20000, 'the join button')
      join.click()
      await until(() => voice()?.classList.contains('on'), 30000, 'the voice room to be joined')
      P.step = 'in the room'
      const sam = () => [...document.querySelectorAll('[data-testid=voice-person]')].find((l) => l.textContent.includes('Sam') && l.getAttribute('data-state') === 'connected')
      await until(sam, 180000, 'the guest Sam to connect')
      P.step = 'guest connected'
      await sleep(7000)
      button('Mute').click()
      P.step = 'muted'
      await sleep(8000)
      button('Unmute').click()
      P.step = 'unmuted'
      await sleep(8000)
      P.guestStillConnected = !!sam()
      P.done = true
    } catch (e) {
      P.error = String(e)
      P.ok = false
      P.done = true
    }
  })()
})()
