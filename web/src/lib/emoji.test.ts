import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { expandShortcodes, loadEmoji, loadRecent, matchShortcodes, rememberEmoji, searchEmoji, shortcodeQueryAt } from './emoji'

class Mem {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
}

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new Mem()
})

let all: Awaited<ReturnType<typeof loadEmoji>>
beforeAll(async () => {
  all = await loadEmoji()
})

describe('emoji data', () => {
  it('is the full set, in groups, all with a name', () => {
    expect(all.groups.length).toBe(9)
    expect(all.list.length).toBeGreaterThan(1800)
    for (let g = 0; g < all.groups.length; g++) expect(all.list.filter((e) => e.group === all.groups[g]).length).toBeGreaterThan(20)
    expect(all.list.every((e) => e.char && e.name)).toBe(true)
  })
  it('has no emoji twice, and no shortcode for two emoji', () => {
    const seen = new Set<string>()
    for (const e of all.list) {
      expect(seen.has(e.char), `${e.char} ${e.name} appears twice`).toBe(false)
      seen.add(e.char)
    }
    expect(all.byCode.size).toBe(all.list.reduce((n, e) => n + e.codes.length, 0))
  })
  it('knows the usual shortcodes', () => {
    expect(all.byCode.get('smile')).toBe('😄')
    expect(all.byCode.get('tada')).toBe('🎉')
    expect(all.byCode.get('thumbsup')).toContain('👍')
    expect(all.byCode.get('+1')).toContain('👍')
  })
})

describe('searchEmoji', () => {
  it('finds by name, by a word, and by part of a word', () => {
    expect(searchEmoji(all.list, 'pizza')[0]!.char).toBe('🍕')
    expect(searchEmoji(all.list, 'lol').map((e) => e.char)).toContain('😂')
    expect(searchEmoji(all.list, 'rock').map((e) => e.char)).toContain('🪨')
    expect(searchEmoji(all.list, 'thumbs up')[0]!.char).toContain('👍')
  })
  it('needs every word, and ranks an exact name first', () => {
    expect(searchEmoji(all.list, 'red heart')[0]!.char).toBe('❤️')
    expect(searchEmoji(all.list, 'pizza banana')).toEqual([])
    expect(searchEmoji(all.list, 'fire')[0]!.char).toBe('🔥')
  })
  it('ignores case and spaces, and finds nothing for nothing', () => {
    expect(searchEmoji(all.list, '  PIZZA ')[0]!.char).toBe('🍕')
    expect(searchEmoji(all.list, '')).toEqual([])
    expect(searchEmoji(all.list, 'xyzzy')).toEqual([])
  })
  it('is limited', () => {
    expect(searchEmoji(all.list, 'face', 5).length).toBe(5)
  })
})

describe('shortcodeQueryAt', () => {
  it('finds the code being typed at the caret', () => {
    expect(shortcodeQueryAt(':smi', 4)).toEqual({ start: 0, query: 'smi' })
    expect(shortcodeQueryAt('hello :tad', 10)).toEqual({ start: 6, query: 'tad' })
    expect(shortcodeQueryAt('hello :tada: and', 10)).toEqual({ start: 6, query: 'tad' })
    expect(shortcodeQueryAt('(:+1', 4)).toEqual({ start: 1, query: '+1' })
  })
  it('wants two characters, and a colon that starts a word', () => {
    expect(shortcodeQueryAt(':s', 2)).toBeNull()
    expect(shortcodeQueryAt('at 10:30', 8)).toBeNull()
    expect(shortcodeQueryAt('https://example.com', 19)).toBeNull()
    expect(shortcodeQueryAt('no colon', 4)).toBeNull()
    expect(shortcodeQueryAt(':sm ile', 7)).toBeNull()
  })
})

describe('matchShortcodes', () => {
  it('puts names that start with it first, shortest first', () => {
    const m = matchShortcodes(all.byCode, 'smile').map((x) => x.code)
    expect(m[0]).toBe('smile')
    expect(m.length).toBeGreaterThan(1)
  })
  it('is limited and finds names that merely contain it', () => {
    expect(matchShortcodes(all.byCode, 'face', 3).length).toBe(3)
    expect(matchShortcodes(all.byCode, 'zzzzq')).toEqual([])
    expect(matchShortcodes(all.byCode, 'ulb').map((x) => x.code)).toContain('bulb')
  })
})

describe('expandShortcodes', () => {
  it('replaces known names between colons', () => {
    expect(expandShortcodes(all.byCode, 'nice :tada: work :+1:!')).toMatch(/^nice 🎉 work 👍.*!$/u)
    expect(expandShortcodes(all.byCode, ':SMILE:')).toBe('😄')
    expect(expandShortcodes(all.byCode, ':smile::tada:')).toBe('😄🎉')
  })
  it('leaves everything else alone', () => {
    for (const t of [':notanemoji:', 'at 10:30:15', 'a :smile : b', 'http://x:80/a:b:c', '::', ':a:', 'plain text'])
      expect(expandShortcodes(all.byCode, t)).toBe(t)
  })
})

describe('recent emoji', () => {
  it('remembers the latest first, without repeats, and caps the list', () => {
    rememberEmoji('😀')
    rememberEmoji('🍕')
    rememberEmoji('😀')
    expect(loadRecent()).toEqual(['😀', '🍕'])
    for (let i = 0; i < 40; i++) rememberEmoji(String.fromCodePoint(0x1f600 + i))
    expect(loadRecent().length).toBe(24)
  })
  it('survives unusable storage and bad contents', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => 'not json', setItem() { throw new Error('no') } }
    expect(loadRecent()).toEqual([])
    expect(() => rememberEmoji('😀')).not.toThrow()
    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => '{"a":1}' }
    expect(loadRecent()).toEqual([])
  })
})
