import { describe, expect, it } from 'vitest'
import { player } from './player.svelte'

describe('player', () => {
  it('plays one video at a time, and stops', () => {
    player.stop()
    expect(player.is('a')).toBe(false)
    player.play({ href: 'a', kind: 'youtube', id: 'x', title: 'A' })
    player.play({ href: 'b', kind: 'streamable', id: 'y', title: 'B' })
    expect(player.is('a')).toBe(false)
    expect(player.is('b')).toBe(true)
    player.stop()
    expect(player.current).toBeNull()
  })
})
