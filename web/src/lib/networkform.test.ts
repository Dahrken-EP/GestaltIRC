import { describe, expect, it } from 'vitest'
import type { NetworkDetail } from './api'
import { blankForm, checkForm, formFromNetwork, parseChannels, toRequest } from './networkform'

const saved: NetworkDetail = {
  name: 'libera', host: 'irc.libera.chat', port: 6697, tls: true, nick: 'matt', ident: 'matt', realname: 'matt',
  sasl_mech: 'PLAIN', sasl_user: 'matt', has_server_password: false, has_sasl_password: true, has_certificate: false,
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
