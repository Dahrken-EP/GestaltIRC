import { describe, expect, it } from 'vitest'
import { parseInput, splitText, type CommandContext } from './commands'

const chan: CommandContext = { target: '#c', inBuffer: true, chanTypes: '#&' }
const status: CommandContext = { target: '', inBuffer: false, chanTypes: '#&' }
const raws = (input: string, ctx = chan) =>
  parseInput(input, ctx).map((a) => (a.type === 'raw' ? a.line : a.type === 'error' ? 'ERR' : a.type))

describe('parseInput', () => {
  it('sends plain text to the current buffer', () => {
    expect(raws('hello there')).toEqual(['PRIVMSG #c :hello there'])
    expect(raws('hello', status)).toEqual(['ERR'])
  })

  it('opens a direct chat', () => {
    expect(parseInput('/direct bob', chan)).toEqual([{ type: 'direct', target: 'bob' }])
    expect(parseInput('/dm bob extra', status)).toEqual([{ type: 'direct', target: 'bob' }])
    expect(raws('/direct')).toEqual(['ERR'])
  })

  it('treats // as a literal slash', () => {
    expect(raws('//shrug')).toEqual(['PRIVMSG #c :/shrug'])
  })

  it('maps the standard commands', () => {
    expect(raws('/join #x key')).toEqual(['JOIN #x key'])
    expect(raws('/part')).toEqual(['PART #c'])
    expect(raws('/part bye now')).toEqual(['PART #c :bye now'])
    expect(raws('/part #x bye')).toEqual(['PART #x :bye'])
    expect(raws('/me waves')).toEqual(['PRIVMSG #c :\x01ACTION waves\x01'])
    expect(raws('/topic')).toEqual(['TOPIC #c'])
    expect(raws('/topic new topic')).toEqual(['TOPIC #c :new topic'])
    expect(raws('/kick bob spam')).toEqual(['KICK #c bob :spam'])
    expect(raws('/ban bob')).toEqual(['MODE #c +b bob!*@*'])
    expect(raws('/unban bob!*@*')).toEqual(['MODE #c -b bob!*@*'])
    expect(raws('/mode +m')).toEqual(['MODE #c +m'])
    expect(raws('/mode #x +i')).toEqual(['MODE #x +i'])
    expect(raws('/away')).toEqual(['AWAY :Away'])
    expect(raws('/back')).toEqual(['AWAY'])
    expect(raws('/invite bob')).toEqual(['INVITE bob #c'])
    expect(raws('/whois bob')).toEqual(['WHOIS bob'])
    expect(raws('/names')).toEqual(['NAMES #c'])
    expect(raws('/nick new extra')).toEqual(['NICK new'])
  })

  it('opens a query for /msg to a nick and /query', () => {
    expect(raws('/msg bob hi')).toEqual(['PRIVMSG bob :hi', 'open'])
    expect(raws('/msg #x hi')).toEqual(['PRIVMSG #x :hi'])
    expect(raws('/query bob')).toEqual(['open'])
    expect(raws('/query bob hey')).toEqual(['open', 'PRIVMSG bob :hey'])
  })

  it('sends unknown commands to the server', () => {
    expect(raws('/knock #x please')).toEqual(['KNOCK #x please'])
    expect(raws('/raw MODE #c +b')).toEqual(['MODE #c +b'])
  })

  it('reports usage errors', () => {
    expect(raws('/join')).toEqual(['ERR'])
    expect(raws('/me hi', status)).toEqual(['ERR'])
    expect(raws('/msg bob')).toEqual(['ERR'])
  })
})

describe('splitText', () => {
  it('leaves short text alone', () => {
    expect(splitText('hi')).toEqual(['hi'])
  })

  it('splits long text at spaces within the byte limit', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    const parts = splitText(text, 100)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => new TextEncoder().encode(p).length <= 100)).toBe(true)
    expect(parts.join(' ')).toBe(text)
  })

  it('never splits inside a multi-byte character', () => {
    const parts = splitText('é'.repeat(300), 100)
    expect(parts.join('')).toBe('é'.repeat(300))
    expect(parts.every((p) => new TextEncoder().encode(p).length <= 100)).toBe(true)
  })
})
