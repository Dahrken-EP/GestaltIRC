const test = require('node:test')
const assert = require('node:assert/strict')
const { launcherHref, isLauncher, navigationAllowed, certificateDecision } = require('../electron/policy.js')

const launcher = launcherHref('/opt/Gestalt/resources/app/ui/index.html')
const server = 'https://irc.example.org'

test('the launcher may be shown, with a query or fragment', () => {
  assert.ok(navigationAllowed(launcher, launcher, null))
  assert.ok(navigationAllowed(launcher + '?x=1#y', launcher, null))
})

test('no other file is the launcher', () => {
  for (const href of ['file:///etc/passwd', 'file:///tmp/evil.html', 'file:///opt/Gestalt/resources/app/ui/other.html', 'file:///opt/Gestalt/resources/app/ui/index.html/../../../x.html']) {
    assert.equal(isLauncher(href, launcher), false, href)
    assert.equal(navigationAllowed(href, launcher, server), false, href)
  }
})

test('the chosen server is allowed, anything else is not', () => {
  assert.ok(navigationAllowed('https://irc.example.org/', launcher, server))
  assert.ok(navigationAllowed('https://irc.example.org/guest/abc?x=1', launcher, server))
  assert.equal(navigationAllowed('https://evil.example/', launcher, server), false)
  assert.equal(navigationAllowed('http://irc.example.org/', launcher, server), false, 'another scheme is another origin')
  assert.equal(navigationAllowed('https://irc.example.org:8443/', launcher, server), false, 'another port is another origin')
  assert.equal(navigationAllowed('https://irc.example.org.evil.example/', launcher, server), false)
})

test('with no server chosen only the launcher is allowed', () => {
  assert.equal(navigationAllowed('https://irc.example.org/', launcher, null), false)
})

test('data, javascript, blob and about addresses are not navigations the window may make', () => {
  for (const href of ['data:text/html,hi', 'javascript:alert(1)', 'blob:https://irc.example.org/abc', 'about:blank', 'not a url', '']) {
    assert.equal(navigationAllowed(href, launcher, server), false, href)
  }
})

test('certificates: only the chosen server, only the same certificate', () => {
  const trusted = { [server]: 'AA:BB' }
  assert.equal(certificateDecision(trusted, server, server, 'AA:BB'), 'trusted')
  assert.equal(certificateDecision(trusted, server, server, 'CC:DD'), 'changed')
  assert.equal(certificateDecision({}, server, server, 'AA:BB'), 'ask')
  assert.equal(certificateDecision(undefined, server, server, 'AA:BB'), 'ask')
  assert.equal(certificateDecision(trusted, 'https://other.example', server, 'AA:BB'), 'refuse')
  assert.equal(certificateDecision(trusted, server, null, 'AA:BB'), 'refuse')
})
