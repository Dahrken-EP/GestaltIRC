import { describe, expect, it } from 'vitest'
import { guestLabel, isGuestPrefix, parseGuestEvent } from './protocol'

describe('isGuestPrefix', () => {
  it('knows the prefix the bouncer makes, and nothing else', () => {
    expect(isGuestPrefix('g-Sam!guest@guest.invalid')).toBe(true)
    expect(isGuestPrefix('g-Sam!guest@example.com')).toBe(false)
    expect(isGuestPrefix('guest.invalid')).toBe(false)
    expect(isGuestPrefix('bob!u@evil.guest.invalid.example')).toBe(false)
  })
})

describe('parseGuestEvent', () => {
  it('reads a join and a leave', () => {
    expect(parseGuestEvent('join.abc123.Sam Smith')).toEqual({ t: 'join', inviteId: 'abc123', name: 'Sam Smith' })
    expect(parseGuestEvent('leave.abc123')).toEqual({ t: 'leave', inviteId: 'abc123' })
  })
  it('decodes the escapes in a name, and keeps only plain text', () => {
    expect(parseGuestEvent('join.abc123.a%2Eb%25c')).toEqual({ t: 'join', inviteId: 'abc123', name: 'a.bc' })
    expect(parseGuestEvent('join.abc123.<b>x</b>%0A')).toEqual({ t: 'join', inviteId: 'abc123', name: 'bxb' })
    expect(parseGuestEvent('join.abc123.' + 'x'.repeat(60))).toMatchObject({ name: 'x'.repeat(24) })
  })
  it('refuses anything else', () => {
    for (const v of ['', 'join', 'join.abc123', 'join.abc123.', 'join.ab.Sam', 'join.abc123.a.b', 'leave.abc123.x', 'kick.abc123', 'join.abc123.%ZZ', 'join.abc123.<>'])
      expect(parseGuestEvent(v), v).toBeNull()
  })
})

describe('guestLabel', () => {
  it('says it is a guest', () => expect(guestLabel('Sam')).toBe('Sam (guest)'))
})
