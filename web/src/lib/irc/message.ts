// IRC line parsing and formatting, including IRCv3 message tags.

export type Tags = Record<string, string>

export interface Message {
  tags: Tags
  prefix: string
  command: string
  params: string[]
}

const unescapes: Record<string, string> = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' }
const escapes: Record<string, string> = { ';': '\\:', ' ': '\\s', '\\': '\\\\', '\r': '\\r', '\n': '\\n' }

export function unescapeTag(v: string): string {
  let out = ''
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!
    if (c !== '\\') {
      out += c
      continue
    }
    i++
    if (i >= v.length) break // a trailing lone backslash is dropped
    const next = v[i]!
    out += unescapes[next] ?? next
  }
  return out
}

export function escapeTag(v: string): string {
  return v.replace(/[; \\\r\n]/g, (c) => escapes[c]!)
}

/** Parses one IRC line. Returns null for an empty or malformed line. */
export function parse(line: string): Message | null {
  let rest = line.replace(/[\r\n]+$/, '')
  const tags: Tags = {}
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ')
    if (sp < 0) return null
    for (const part of rest.slice(1, sp).split(';')) {
      if (!part) continue
      const eq = part.indexOf('=')
      if (eq < 0) tags[part] = ''
      else tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1))
    }
    rest = rest.slice(sp + 1).replace(/^ +/, '')
  }
  let prefix = ''
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ')
    if (sp < 0) return null
    prefix = rest.slice(1, sp)
    rest = rest.slice(sp + 1).replace(/^ +/, '')
  }
  if (!rest) return null
  const params: string[] = []
  let command = rest
  const sp = rest.indexOf(' ')
  if (sp >= 0) {
    command = rest.slice(0, sp)
    rest = rest.slice(sp + 1)
    while (rest) {
      if (rest.startsWith(':')) {
        params.push(rest.slice(1))
        break
      }
      const next = rest.indexOf(' ')
      if (next < 0) {
        params.push(rest)
        break
      }
      params.push(rest.slice(0, next))
      rest = rest.slice(next + 1).replace(/^ +/, '')
    }
  }
  return { tags, prefix, command: command.toUpperCase(), params }
}

export function format(m: Partial<Message> & { command: string }): string {
  let out = ''
  const tagKeys = Object.keys(m.tags ?? {})
  if (tagKeys.length) {
    out += '@' + tagKeys.map((k) => (m.tags![k] ? `${k}=${escapeTag(m.tags![k]!)}` : k)).join(';') + ' '
  }
  if (m.prefix) out += ':' + m.prefix + ' '
  out += m.command
  const params = m.params ?? []
  params.forEach((p, i) => {
    const last = i === params.length - 1
    out += last && (p === '' || p.includes(' ') || p.startsWith(':')) ? ' :' + p : ' ' + p
  })
  return out
}

// Multiline tag names from the IRCv3 draft/multiline specification.
export const MultilineConcat = '+draft/multiline-concat'
export const MultilineCont = '+draft/multiline-cont'
export const MultilineEnd = '+draft/multiline-end'

/** IsMultiline reports whether m carries any draft/multiline tag. */
export function isMultiline(m: Message): boolean {
  return (
    m.tags[MultilineConcat] !== undefined ||
    m.tags[MultilineCont] !== undefined ||
    m.tags[MultilineEnd] !== undefined
  )
}

/** MultilineStage reports which part of a multiline message m is, or ''. */
export function multilineStage(m: Message): 'concat' | 'cont' | 'end' | '' {
  if (m.tags[MultilineConcat] !== undefined) return 'concat'
  if (m.tags[MultilineCont] !== undefined) return 'cont'
  if (m.tags[MultilineEnd] !== undefined) return 'end'
  return ''
}

/** The nick part of a "nick!user@host" prefix, or the whole prefix if it has no "!". */
export function nickOf(prefix: string): string {
  const bang = prefix.indexOf('!')
  return bang < 0 ? prefix : prefix.slice(0, bang)
}

/** The time of a message in ms since the epoch, from its server-time tag or `fallback`. */
export function timeOf(m: Message, fallback = Date.now()): number {
  const t = m.tags.time
  if (t) {
    const ms = Date.parse(t)
    if (!Number.isNaN(ms)) return ms
  }
  return fallback
}

/** True when the prefix names a server rather than a user. */
export function isServerPrefix(prefix: string): boolean {
  return !prefix.includes('!')
}
