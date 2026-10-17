import { describe, expect, it } from 'vitest'
import type { NetworkDetail } from './api'
import { blankForm, checkForm, formFromNetwork, parseChannels, toRequest } from './networkform'

const saved: NetworkDetail = {
  name: 'libera', host: 'irc.libera.chat', port: 6697, tls: true, nick: 'matt', ident: 'matt', realname: 'matt',
  sasl_mech: 'PLAIN', sasl_user: 'matt', has_server_password: false, has_sasl_password: true, has_certificate: false,
  has_nickserv_password: false, tls_insecure: false, tls_fingerprint: '', alt_nicks: ['matt_'], perform: ['MODE matt +i'],
  join: ['#a', '#b'], enabled: true, connected: true,
}

describe('parseChannels', () => {
  it('splits on spaces, commas and lines, and drops repeats', () => {
    expect(parseChannels('#a, #b\n#c  #A')).toEqual(['#a', '#b', '#c'])
    expect(parseChannels('')).toEqual([])
  })
})

describe('checkForm', () => {
  const ok = () => ({ ...blankForm('matt'), name: 'libera', host: 'irc.libera.chat' })

  it('accepts a minimal form', () => {
    expect(checkForm(ok())).toBe('')
  })

  it('says what is missing or wrong', () => {
    expect(checkForm({ ...ok(), name: '' })).toMatch(/name/)
    expect(checkForm({ ...ok(), name: 'a b' })).toMatch(/name/)
    expect(checkForm({ ...ok(), host: '' })).toMatch(/address/)
    expect(checkForm({ ...ok(), host: 'a b' })).toMatch(/spaces/)
    expect(checkForm({ ...ok(), port: 'abc' })).toMatch(/port/)
    expect(checkForm({ ...ok(), port: '70000' })).toMatch(/port/)
    expect(checkForm({ ...ok(), nick: '' })).toMatch(/nick/)
    expect(checkForm({ ...ok(), nick: 'a b' })).toMatch(/nick/)
    expect(checkForm({ ...ok(), sasl: 'PLAIN' })).toMatch(/account/)
    expect(checkForm({ ...ok(), sasl: 'PLAIN', saslUser: 'u' })).toMatch(/password/)
  })

  it('does not ask for the name of a network that is being edited', () => {
    expect(checkForm({ ...ok(), editing: 'libera', name: '' })).toBe('')
  })

  it('does not ask again for a saved SASL password', () => {
    const f = { ...formFromNetwork(saved) }
    expect(checkForm(f)).toBe('')
    expect(checkForm({ ...f, clearSaslPassword: true })).toMatch(/password/)
  })
})

describe('toRequest', () => {
  it('sends a new network with its name and no secrets that were not typed', () => {
    const r = toRequest({ ...blankForm('matt'), name: 'libera', host: ' irc.libera.chat ', channels: '#a #b' })
    expect(r).toMatchObject({ name: 'libera', host: 'irc.libera.chat', port: 6697, tls: true, nick: 'matt', join: ['#a', '#b'], enabled: true })
    expect('server_password' in r).toBe(false)
    expect('sasl_password' in r).toBe(false)
  })

  it('keeps saved secrets by leaving them out, and sends a changed one', () => {
    const f = formFromNetwork(saved)
    const r = toRequest(f)
    expect('name' in r).toBe(false)
    expect('sasl_password' in r).toBe(false)
    expect(toRequest({ ...f, saslPassword: 'new' }).sasl_password).toBe('new')
  })

  it('clears a secret only when asked', () => {
    const f = { ...formFromNetwork({ ...saved, has_server_password: true }), clearServerPassword: true }
    expect(toRequest(f).server_password).toBe('')
  })

  it('drops the SASL password when SASL is switched off', () => {
    const r = toRequest({ ...formFromNetwork(saved), sasl: '' })
    expect(r).toMatchObject({ sasl_mech: '', sasl_user: '', sasl_password: '' })
  })

  it('shows a nick that equals the username as blank, and does not send it back as a change', () => {
    const f = formFromNetwork(saved)
    expect(f.ident).toBe('')
    expect(toRequest(f).ident).toBe('')
  })

  it('does not touch the login of a network that uses a certificate', () => {
    const f = formFromNetwork({ ...saved, sasl_mech: 'EXTERNAL', has_certificate: true, has_sasl_password: false })
    expect(f.certificate).toBe(true)
    expect(toRequest(f).sasl_mech).toBe('')
  })
})

describe('alternative nicks, commands on connect and the NickServ password', () => {
  it('reads them from a saved network and sends them back as lists', () => {
    const f = formFromNetwork({ ...saved, alt_nicks: ['matt_', 'matt__'], perform: ['MODE matt +i', 'msg ChanServ hi'] })
    expect(f.altNicks).toBe('matt_ matt__')
    expect(f.perform).toBe('MODE matt +i\nmsg ChanServ hi')
    const r = toRequest(f)
    expect(r.alt_nicks).toEqual(['matt_', 'matt__'])
    expect(r.perform).toEqual(['MODE matt +i', 'msg ChanServ hi'])
  })

  it('splits alternative nicks on spaces and commas, and drops blank command lines', () => {
    const f = { ...blankForm('matt'), name: 'x', host: 'h', altNicks: 'a, b  c,a', perform: '\n MODE matt +i \n\n' }
    expect(toRequest(f).alt_nicks).toEqual(['a', 'b', 'c'])
    expect(toRequest(f).perform).toEqual(['MODE matt +i'])
  })

  it('keeps a saved NickServ password unless a new one is typed or removal is asked for', () => {
    const f = formFromNetwork({ ...saved, has_nickserv_password: true })
    expect('nickserv_password' in toRequest(f)).toBe(false)
    expect(toRequest({ ...f, nickservPassword: 'new' }).nickserv_password).toBe('new')
    expect(toRequest({ ...f, clearNickservPassword: true }).nickserv_password).toBe('')
  })

  it('refuses what the bouncer would', () => {
    const ok = { ...blankForm('matt'), name: 'x', host: 'h' }
    expect(checkForm({ ...ok, altNicks: 'a b c d e f' })).toMatch(/five/)
    expect(checkForm({ ...ok, perform: Array(11).fill('MODE a').join('\n') })).toMatch(/ten/)
    expect(checkForm({ ...ok, perform: '/quit bye' })).toMatch(/cannot be used/)
    expect(checkForm({ ...ok, perform: 'MODE matt +i' })).toBe('')
  })
})

describe('accepting an untrusted certificate', () => {
  const ok = () => ({ ...blankForm('matt'), name: 'x', host: 'h' })

  it('is off by default and sent only with TLS', () => {
    expect(toRequest(ok()).tls_insecure).toBe(false)
    expect(toRequest({ ...ok(), tlsInsecure: true }).tls_insecure).toBe(true)
    expect(toRequest({ ...ok(), tls: false, tlsInsecure: true }).tls_insecure).toBe(false)
  })

  it('needs TLS', () => {
    expect(checkForm({ ...ok(), tls: false, tlsInsecure: true })).toMatch(/needs TLS/)
    expect(checkForm({ ...ok(), tlsInsecure: true })).toBe('')
  })

  it('shows what a saved network has, and asks to forget the remembered certificate only when told to', () => {
    const f = formFromNetwork({ ...saved, tls_insecure: true, tls_fingerprint: 'AA:BB' })
    expect(f.tlsInsecure).toBe(true)
    expect(f.tlsFingerprint).toBe('AA:BB')
    expect('forget_tls_pin' in toRequest(f)).toBe(false)
    expect(toRequest({ ...f, forgetTlsPin: true }).forget_tls_pin).toBe(true)
  })
})

