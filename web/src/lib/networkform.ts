// The network editor's form: turning a network into fields, the fields into a request, and
// checking them before anything is sent. The bouncer checks everything again; this is for
// telling the person what is wrong without a round trip.

import type { NetworkDetail, NetworkRequest } from './api'

export interface NetworkForm {
  /** The name of the network being edited, or '' for a new one. */
  editing: string
  name: string
  host: string
  port: string
  tls: boolean
  nick: string
  ident: string
  realname: string
  serverPassword: string
  clearServerPassword: boolean
  sasl: '' | 'PLAIN' | 'SCRAM-SHA-256'
  saslUser: string
  saslPassword: string
  clearSaslPassword: boolean
  channels: string
  enabled: boolean
  /** What is saved already, so the form can say "unchanged". */
  hasServerPassword: boolean
  hasSaslPassword: boolean
  /** A network that logs in with a certificate: its login is managed on the command line. */
  certificate: boolean
}

export function blankForm(nick = ''): NetworkForm {
  return {
    editing: '', name: '', host: '', port: '6697', tls: true, nick, ident: '', realname: '',
    serverPassword: '', clearServerPassword: false, sasl: '', saslUser: '', saslPassword: '', clearSaslPassword: false,
    channels: '', enabled: true, hasServerPassword: false, hasSaslPassword: false, certificate: false,
  }
}

export function formFromNetwork(n: NetworkDetail): NetworkForm {
  return {
    editing: n.name, name: n.name, host: n.host, port: String(n.port), tls: n.tls, nick: n.nick,
    ident: n.ident === n.nick ? '' : n.ident, realname: n.realname === n.nick ? '' : n.realname,
    serverPassword: '', clearServerPassword: false,
    sasl: n.sasl_mech === 'PLAIN' || n.sasl_mech === 'SCRAM-SHA-256' ? n.sasl_mech : '',
    saslUser: n.sasl_user, saslPassword: '', clearSaslPassword: false,
    channels: n.join.join(' '), enabled: n.enabled,
    hasServerPassword: n.has_server_password, hasSaslPassword: n.has_sasl_password,
    certificate: n.has_certificate || n.sasl_mech === 'EXTERNAL',
  }
}

/** Channel names separated by spaces, commas or lines. */
export function parseChannels(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(/[\s,]+/)) {
    if (!part || seen.has(part.toLowerCase())) continue
    seen.add(part.toLowerCase())
    out.push(part)
  }
  return out
}

/** What is wrong with the form, or '' when it can be sent. */
export function checkForm(f: NetworkForm): string {
  if (!f.editing && !/^[A-Za-z0-9_-]{1,32}$/.test(f.name)) return 'Give the network a short name: letters, digits, "-" or "_".'
  if (!f.host.trim()) return 'Enter the server address.'
  if (/\s/.test(f.host.trim())) return 'The server address cannot contain spaces.'
  const port = Number(f.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'The port must be a number from 1 to 65535.'
  if (!f.nick.trim()) return 'Enter the nick to use.'
  if (/\s/.test(f.nick.trim())) return 'A nick cannot contain spaces.'
  if (/\s/.test(f.ident.trim())) return 'The username cannot contain spaces.'
  if (f.sasl && !f.saslUser.trim()) return 'Enter the account name for SASL.'
  if (f.sasl && !f.saslPassword && !(f.hasSaslPassword && !f.clearSaslPassword)) return 'Enter the SASL password.'
  return ''
}

export function toRequest(f: NetworkForm): NetworkRequest {
  const req: NetworkRequest = {
    host: f.host.trim(),
    port: Number(f.port),
    tls: f.tls,
    nick: f.nick.trim(),
    ident: f.ident.trim(),
    realname: f.realname.trim(),
    sasl_mech: f.certificate ? '' : f.sasl,
    sasl_user: f.sasl ? f.saslUser.trim() : '',
    join: parseChannels(f.channels),
    enabled: f.enabled,
  }
  if (!f.editing) req.name = f.name.trim()
  if (f.serverPassword) req.server_password = f.serverPassword
  else if (f.clearServerPassword) req.server_password = ''
  if (f.sasl) {
    if (f.saslPassword) req.sasl_password = f.saslPassword
  } else if (f.hasSaslPassword) {
    // Switching SASL off drops its password too, rather than keeping it unused.
    req.sasl_password = ''
  }
  if (f.sasl && f.clearSaslPassword && !f.saslPassword) req.sasl_password = ''
  return req
}
