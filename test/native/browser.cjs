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

module.exports = { launch, name }
