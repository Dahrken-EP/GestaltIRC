import { beforeEach, describe, expect, it } from 'vitest'
import { Layout, MEMBERS, NAV, parseLayout } from './layout.svelte'

class Mem {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
}

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new Mem()
})

describe('parseLayout', () => {
  it('keeps sensible values and clamps the rest', () => {
    expect(parseLayout({ nav: 300, members: 250, railHidden: true })).toEqual({ nav: 300, members: 250, railHidden: true })
    expect(parseLayout({ nav: 5000, members: -3 })).toEqual({ nav: NAV.max, members: MEMBERS.min, railHidden: false })
  })
  it('falls back to the defaults for anything else', () => {
    for (const bad of [null, 'x', [], { nav: 'wide', members: NaN, railHidden: 'yes' }])
      expect(parseLayout(bad)).toEqual({ nav: NAV.initial, members: MEMBERS.initial, railHidden: false })
  })
})

describe('Layout', () => {
  it('remembers widths and the hidden bar, within limits', () => {
    const a = new Layout()
    a.setNav(1000)
    a.setMembers(10)
    a.setRailHidden(true)
    expect([a.nav, a.members, a.railHidden]).toEqual([NAV.max, MEMBERS.min, true])
    const b = new Layout()
    expect([b.nav, b.members, b.railHidden]).toEqual([NAV.max, MEMBERS.min, true])
    b.reset()
    expect([b.nav, b.members, b.railHidden]).toEqual([NAV.initial, MEMBERS.initial, true])
  })
  it('works when storage is unusable', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => 'not json', setItem() { throw new Error('no') } }
    const l = new Layout()
    expect(l.nav).toBe(NAV.initial)
    expect(() => l.setNav(300)).not.toThrow()
    expect(l.nav).toBe(300)
  })
})
