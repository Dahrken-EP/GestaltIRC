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

  it('links an address typed without http, when it ends in a known domain', () => {
    expect(tokenize('see example.com and www.site.org/page?x=1, or sub.domain.co.uk.')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'example.com', href: 'https://example.com/' },
      { type: 'text', text: ' and ' },
      { type: 'link', text: 'www.site.org/page?x=1', href: 'https://www.site.org/page?x=1' },
      { type: 'text', text: ', or ' },
      { type: 'link', text: 'sub.domain.co.uk', href: 'https://sub.domain.co.uk/' },
      { type: 'text', text: '.' },
    ])
    expect(tokenize('imgur.com/MOWg5fE')[0]).toMatchObject({ type: 'link', href: 'https://imgur.com/MOWg5fE' })
    expect(tokenize('irc.example.net:6697')[0]).toMatchObject({ type: 'link', href: 'https://irc.example.net:6697/' })
  })

  it('leaves email addresses, file names and words alone', () => {
    for (const t of ['mail me at bob@example.com', 'open index.php or readme.md', 'e.g. this', 'wait.what', 'the.community', 'v1.2.3', 'node.js', 'bob.net@host', 'hello.Com1']) {
      expect(tokenize(t).every((x) => x.type === 'text'), t).toBe(true)
    }
  })

  it('does not link the same address twice when it has http', () => {
    const toks = tokenize('https://example.com/a and http://www.x.org')
    expect(toks.filter((t) => t.type === 'link').map((t) => (t as { text: string }).text)).toEqual(['https://example.com/a', 'http://www.x.org'])
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
