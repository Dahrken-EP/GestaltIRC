import { describe, expect, it } from 'vitest'
import {
  escapeTag,
  format,
  isMultiline,
  multilineStage,
  nickOf,
  parse,
  timeOf,
  unescapeTag,
} from './message'

describe('parse', () => {
  it('parses tags, prefix, command and a trailing param', () => {
    const m = parse('@time=2026-01-02T03:04:05.000Z;msgid=abc :nick!u@h PRIVMSG #chan :hello world')!
    expect(m.tags).toEqual({ time: '2026-01-02T03:04:05.000Z', msgid: 'abc' })
    expect(m.prefix).toBe('nick!u@h')
    expect(m.command).toBe('PRIVMSG')
    expect(m.params).toEqual(['#chan', 'hello world'])
  })

  it('uppercases the command and handles no params', () => {
    expect(parse('ping')).toMatchObject({ command: 'PING', params: [] })
  })

  it('keeps an empty trailing param', () => {
    expect(parse('TOPIC #c :')!.params).toEqual(['#c', ''])
  })

  it('treats a valueless tag as an empty string', () => {
    expect(parse('@draft/x;a=b PING')!.tags).toEqual({ 'draft/x': '', a: 'b' })
  })

  it('rejects empty and malformed lines', () => {
    expect(parse('')).toBeNull()
    expect(parse('@only=tags')).toBeNull()
    expect(parse(':prefixonly')).toBeNull()
  })

  it('strips the line ending', () => {
    expect(parse('PING :x\r\n')!.params).toEqual(['x'])
  })
})

describe('tag escaping', () => {
  it('round-trips special characters', () => {
    const v = 'a;b c\\d\r\ne'
    expect(unescapeTag(escapeTag(v))).toBe(v)
    expect(escapeTag('a b;c')).toBe('a\\sb\\:c')
  })

  it('drops a trailing backslash and keeps unknown escapes', () => {
    expect(unescapeTag('ab\\')).toBe('ab')
    expect(unescapeTag('\\q')).toBe('q')
  })
})

describe('format', () => {
  it('round-trips a parsed line', () => {
    const line = '@msgid=1 :n!u@h PRIVMSG #c :hi there'
    expect(format(parse(line)!)).toBe(line)
  })

  it('adds a colon only where needed', () => {
    expect(format({ command: 'JOIN', params: ['#a'] })).toBe('JOIN #a')
    expect(format({ command: 'PART', params: ['#a', ''] })).toBe('PART #a :')
    expect(format({ command: 'PRIVMSG', params: ['#a', ':)'] })).toBe('PRIVMSG #a ::)')
  })
})

describe('helpers', () => {
  it('nickOf', () => {
    expect(nickOf('nick!user@host')).toBe('nick')
    expect(nickOf('irc.server.net')).toBe('irc.server.net')
  })

  it('timeOf uses server-time, then the fallback', () => {
    expect(timeOf(parse('@time=2026-01-02T03:04:05.000Z PING')!, 5)).toBe(Date.parse('2026-01-02T03:04:05.000Z'))
    expect(timeOf(parse('PING')!, 5)).toBe(5)
    expect(timeOf(parse('@time=junk PING')!, 7)).toBe(7)
  })
})

describe('multiline helpers', () => {
  it('isMultiline detects concat/cont/end tags', () => {
    expect(isMultiline(parse('@+draft/multiline-concat PING')!)).toBe(true)
    expect(isMultiline(parse('@+draft/multiline-cont PING')!)).toBe(true)
    expect(isMultiline(parse('@+draft/multiline-end PING')!)).toBe(true)
    expect(isMultiline(parse('@msgid=abc PING')!)).toBe(false)
    expect(isMultiline(parse('PING')!)).toBe(false)
  })

  it('multilineStage reports the part', () => {
    expect(multilineStage(parse('@+draft/multiline-concat PING')!)).toBe('concat')
    expect(multilineStage(parse('@+draft/multiline-cont PING')!)).toBe('cont')
    expect(multilineStage(parse('@+draft/multiline-end PING')!)).toBe('end')
    expect(multilineStage(parse('PING')!)).toBe('')
  })
})
