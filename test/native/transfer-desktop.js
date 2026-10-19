;(function () {
  // Runs inside the desktop app's window (GESTALT_EVAL_JS). Signs in as matt, asks jane for a direct chat, sends her
  // a file, accepts the file she sends back, and leaves what it saw in window.__probe. __MB__ is filled in by run.sh.
  const MB = __MB__
  const P = (window.__probe = { step: 'start', ok: true, done: false })
  setInterval(() => { const t = document.querySelector('.panel'); P.panel = t ? t.innerText.replace(/\s+/g, ' ').slice(0, 500) : null; P.lis = [...document.querySelectorAll('.transfers li')].map((l) => l.getAttribute('data-state') + ':' + l.innerText.replace(/\s+/g, ' ').slice(0, 60)) }, 1500)
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
  const typeLine = (text) => {
    const el = document.querySelector('#msg-input')
    el.focus()
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
  }
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
      P.step = 'connected'
      const status = await until(() => [...document.querySelectorAll('button.name')].find((b) => b.textContent.includes('Status')), 10000, 'the Status buffer')
      status.click()
      await sleep(300)
      typeLine('/direct jane')
      await until(() => document.querySelector('.panel .status[data-state=connected]'), 90000, 'the direct chat to connect')
      P.step = 'direct chat connected'

      // Send: the same bytes as transfer.cjs expects.
      const n = MB * 1024 * 1024 + 17
      const bytes = new Uint8Array(n)
      for (let i = 0; i < n; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff
      const input = document.querySelector('[data-testid=file-input]')
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'from-desktop.bin'))
      input.files = dt.files
      const t0 = performance.now()
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await until(() => document.querySelector('.transfers li[data-state=done]'), 900000, 'the file to be sent')
      P.sendSeconds = (performance.now() - t0) / 1000
      P.step = 'sent'

      // Receive what jane sends back.
      const offer = await until(() => document.querySelector('.transfers li[data-state=offered]'), 180000, 'the file from jane to be offered')
      const t1 = performance.now()
      ;[...offer.querySelectorAll('button')].find((b) => /accept/i.test(b.textContent)).click()
      await until(() => document.querySelectorAll('.transfers li[data-state=done]').length >= 2, 900000, 'the file from jane to arrive')
      P.recvSeconds = (performance.now() - t1) / 1000
      P.step = 'received'
      P.mb = n / 1048576
      P.done = true
    } catch (e) {
      P.error = String(e)
      P.ok = false
      P.done = true
    }
  })()
})()
