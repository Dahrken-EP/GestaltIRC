import { beforeEach, describe, expect, it } from 'vitest'
import { EMOJI, GROUPS, loadRecent, rememberEmoji, searchEmoji } from './emoji'

class Mem {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
}

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new Mem()
})

describe('emoji data', () => {
  it('has a good number in each group, all with a name', () => {
    expect(GROUPS.length).toBe(8)
    expect(EMOJI.length).toBeGreaterThan(300)
    for (const g of GROUPS) expect(EMOJI.filter((e) => e.group === g).length).toBeGreaterThan(20)
    expect(EMOJI.every((e) => e.char && e.name)).toBe(true)
  })
  it('has no emoji twice', () => {
    const seen = new Set<string>()
    for (const e of EMOJI) {
      expect(seen.has(e.char), `${e.char} ${e.name} appears twice`).toBe(false)
      seen.add(e.char)
    }
  })
})

describe('searchEmoji', () => {
  it('finds by name, by a word, and by part of a word', () => {
    expect(searchEmoji('pizza')[0]!.char).toBe('🍕')
    expect(searchEmoji('lol').map((e) => e.char)).toContain('😂')
    expect(searchEmoji('rock').map((e) => e.char)).toEqual(expect.arrayContaining(['🤟', '🎸']))
    expect(searchEmoji('thumb')[0]!.char).toBe('👍')
  })
  it('needs every word, and ranks an exact name first', () => {
    expect(searchEmoji('red heart')[0]!.char).toBe('❤️')
    expect(searchEmoji('pizza banana')).toEqual([])
    expect(searchEmoji('fire')[0]!.char).toBe('🔥')
  })
  it('ignores case and spaces, and finds nothing for nothing', () => {
    expect(searchEmoji('  PIZZA ')[0]!.char).toBe('🍕')
    expect(searchEmoji('')).toEqual([])
    expect(searchEmoji('xyzzy')).toEqual([])
  })
  it('is limited', () => {
    expect(searchEmoji('face', 5).length).toBe(5)
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
