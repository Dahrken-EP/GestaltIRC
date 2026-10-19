// The browser the scripts drive: Chromium by default, or BROWSER=firefox (Playwright's build of Firefox). Both get a fake
// microphone and no permission prompt, and may use loopback addresses for the connection.
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

const name = process.env.BROWSER || 'chromium'

async function launch() {
  if (name === 'firefox') {
    return pw.firefox.launch({
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        'media.peerconnection.ice.loopback': true,
      },
    })
  }
  return pw.chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [...(process.env.CI || process.env.NO_SANDBOX ? ['--no-sandbox'] : []), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
}

// Keeps every connection a page makes, so its statistics can be read. Add it to a context before the page loads.
const record = () => {
  const Orig = window.RTCPeerConnection
  window.__pcs = []
  const Wrapped = function (...args) {
    const pc = new Orig(...args)
    window.__pcs.push(pc)
    return pc
  }
  Wrapped.prototype = Orig.prototype
  Object.assign(Wrapped, Orig)
  window.RTCPeerConnection = Wrapped
}

/**
 * Sound a page has received over all its connections so far: packets, and the energy of what arrived. This is what the
 * connection delivered, whatever the page then does with it. (The page's own "speaking" light needs an audio output
 * to run its meter, which a browser on a machine with no sound card, like a CI runner, does not have.)
 */
const heard = (page) =>
  page.evaluate(async () => {
    let packets = 0
    let energy = 0
    for (const pc of window.__pcs || []) {
      if (pc.connectionState === 'closed') continue
      const stats = await pc.getStats()
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          packets += r.packetsReceived || 0
          energy += r.totalAudioEnergy || 0
        }
      })
    }
    return { packets, energy }
  })

module.exports = { launch, name, record, heard }
