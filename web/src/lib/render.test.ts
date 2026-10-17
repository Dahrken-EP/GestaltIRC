import { describe, expect, it } from 'vitest'
import { mentions, splitFormatting, tokenize } from './render'

const types = (s: string, words: string[] = []) => tokenize(s, words).map((t) => [t.type, t.text])

describe('tokenize', () => {
  it('never produces anything but text for markup', () => {
    const toks = tokenize('<img src=x onerror=alert(1)>')
    expect(toks).toEqual([{ type: 'text', text: '<img src=x onerror=alert(1)>' }])
  })

  it('finds links and trims trailing punctuation', () => {
    expect(types('see https://example.com/a?b=1, ok')).toEqual([
      ['text', 'see '],
      ['link', 'https://example.com/a?b=1'],
      ['text', ', ok'],
    ])
  })

  it('keeps a closing bracket only when the link opened one', () => {
    expect(types('(https://example.com/x)')[1]).toEqual(['link', 'https://example.com/x'])
    expect(types('https://en.wikipedia.org/wiki/A_(b)')[0]).toEqual(['link', 'https://en.wikipedia.org/wiki/A_(b)'])
  })

  it('only links http and https', () => {
    expect(tokenize('javascript:alert(1) and data:text/html,x').every((t) => t.type === 'text')).toBe(true)
  })

  it('finds channels but not anchors inside words or links', () => {
    expect(types('join #irc now')).toEqual([
      ['text', 'join '],
      ['channel', '#irc'],
      ['text', ' now'],
    ])
    const t = tokenize('https://example.com/page#frag')
    expect(t).toHaveLength(1)
    expect(t[0]!.type).toBe('link')
  })

  it('marks mentions on word boundaries, ignoring case', () => {
    expect(types('Hey Matt, hi', ['matt'])).toEqual([
      ['text', 'Hey '],
      ['mention', 'Matt'],
      ['text', ', hi'],
    ])
    expect(tokenize('matthew and matt_2', ['matt']).some((t) => t.type === 'mention')).toBe(false)
  })

  it('handles nicks with regex characters', () => {
    expect(mentions('ping [bob]^ please', ['[bob]^'])).toBe(true)
    expect(mentions('ping x', ['('])).toBe(false)
  })
})

describe('formatting codes', () => {
  it('toggles styles and strips colours', () => {
    const parts = splitFormatting('a\x02b\x0304,05c\x0fd')
    expect(parts.map((p) => [p.text, !!p.style.bold])).toEqual([
      ['a', false],
      ['bc', true],
      ['d', false],
    ])
  })

  it('does not eat digits after a bare colour code', () => {
    expect(splitFormatting('\x03text')[0]!.text).toBe('text')
  })
})
