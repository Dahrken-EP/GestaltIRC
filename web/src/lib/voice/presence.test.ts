import { describe, expect, it } from 'vitest'
import { formatPresence, isRoomName, parsePresence, type Presence } from './presence'
import { Speaking } from './meter'

describe('presence', () => {
  it('round-trips', () => {
    for (const p of [{ t: 'join' }, { t: 'leave' }, { t: 'hello' }, { t: 'here', room: '#chat' }, { t: 'guests', names: [] }, { t: 'guests', names: ['Sam', 'Pat Lee'] }] as Presence[]) {
      expect(parsePresence(formatPresence(p))).toEqual(p)
    }
  })
  it.each(['', 'JOIN', 'join ', 'here', 'here:', 'here:chat', 'here:#a b', 'here:#a,b', `here:#${'x'.repeat(100)}`, 'leave:#x', '\x00'])('rejects %j', (v) => {
    expect(parsePresence(v)).toBeNull()
  })
  it.each(['guests:a b ', 'guests: x', 'guests:<b>', 'guests:a,b,c,d,e,f,g,h,i', `guests:${'x'.repeat(30)}`, 'guests:a\x00'])('rejects the guest list %j', (v) => {
    expect(parsePresence(v)).toBeNull()
  })
  it('accepts the usual channel prefixes only', () => {
    expect(isRoomName('#a')).toBe(true)
    expect(isRoomName('&local')).toBe(true)
    expect(isRoomName('nick')).toBe(false)
    expect(isRoomName(5)).toBe(false)
  })
})

describe('Speaking', () => {
  it('holds speaking briefly after the sound stops', () => {
    const s = new Speaking(0.1, 500)
    expect(s.update(0, 0)).toBe(false)
    expect(s.update(0.5, 1000)).toBe(true)
    expect(s.update(0, 1300)).toBe(true)
    expect(s.update(0, 1600)).toBe(false)
  })
  it('ignores noise below the threshold', () => {
    const s = new Speaking(0.1, 500)
    expect(s.update(0.05, 0)).toBe(false)
  })
})
