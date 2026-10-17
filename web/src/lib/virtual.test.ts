import { describe, expect, it } from 'vitest'
import { Layout } from './virtual'

const keys = (n: number, prefix = 'k') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

describe('Layout', () => {
  it('uses the estimate until a row is measured', () => {
    const l = new Layout(20)
    l.setKeys(keys(5))
    expect(l.total).toBe(100)
    expect(l.offsetOf(3)).toBe(60)
    expect(l.setHeight('k1', 50)).toBe(true)
    expect(l.total).toBe(130)
    expect(l.offsetOf(2)).toBe(70)
  })

  it('reports a change only when the height really changed', () => {
    const l = new Layout(20)
    l.setKeys(keys(2))
    expect(l.setHeight('k0', 30)).toBe(true)
    expect(l.setHeight('k0', 30)).toBe(false)
    expect(l.setHeight('k0', 30.2)).toBe(false) // sub-pixel noise
    expect(l.setHeight('k0', 31)).toBe(true)
  })

  it('ignores heights for rows that do not exist or are zero', () => {
    const l = new Layout(20)
    l.setKeys(keys(2))
    expect(l.setHeight('ghost', 40)).toBe(false)
    expect(l.setHeight('k0', 0)).toBe(false) // a row that is not laid out yet
    expect(l.setHeight('k0', NaN)).toBe(false)
    expect(l.total).toBe(40)
  })

  it('forgets heights of removed rows', () => {
    const l = new Layout(20)
    l.setKeys(keys(3))
    l.setHeight('k1', 100)
    l.setKeys(['k0', 'k2'])
    expect(l.total).toBe(40)
    l.setKeys(keys(3)) // k1 returns but is not remembered
    expect(l.heightOf('k1')).toBe(20)
  })

  it('finds the row at a position', () => {
    const l = new Layout(10)
    l.setKeys(keys(10))
    expect(l.indexAt(0)).toBe(0)
    expect(l.indexAt(9.9)).toBe(0)
    expect(l.indexAt(10)).toBe(1)
    expect(l.indexAt(55)).toBe(5)
    expect(l.indexAt(-50)).toBe(0)
    expect(l.indexAt(10_000)).toBe(9)
  })

  it('handles variable heights when finding a row', () => {
    const l = new Layout(10)
    l.setKeys(keys(4))
    l.setHeight('k0', 5)
    l.setHeight('k1', 100)
    l.setHeight('k2', 1)
    // rows start at 0, 5, 105, 106
    expect([l.indexAt(4), l.indexAt(5), l.indexAt(104), l.indexAt(105), l.indexAt(106)]).toEqual([0, 1, 1, 2, 3])
  })

  it('renders only what is near the viewport', () => {
    const l = new Layout(20)
    l.setKeys(keys(1000))
    const r = l.range(10_000, 600, 200) // viewport 10000..10600, plus 200 either side
    expect(r.start).toBe(Math.floor(9800 / 20))
    expect(r.end).toBe(Math.floor(10800 / 20) + 1)
    expect(r.end - r.start).toBeLessThan(60)
  })

  it('clamps the range at both ends', () => {
    const l = new Layout(20)
    l.setKeys(keys(10))
    expect(l.range(0, 100, 500)).toEqual({ start: 0, end: 10 })
    expect(l.range(10_000, 100, 50).end).toBe(10)
    expect(l.range(10_000, 100, 50).end - l.range(10_000, 100, 50).start).toBeGreaterThanOrEqual(1)
  })

  it('has an empty range with no rows', () => {
    const l = new Layout(20)
    expect(l.range(0, 500, 100)).toEqual({ start: 0, end: 0 })
    expect(l.total).toBe(0)
    expect(l.anchorAt(0)).toBeNull()
  })

  it('keeps the same rows in view when older rows are added above', () => {
    const l = new Layout(20)
    l.setKeys(['b', 'c', 'd'])
    const anchor = l.anchorAt(25)! // 5px into row c
    expect(anchor).toEqual({ key: 'c', delta: 5 })

    l.setKeys(['x', 'y', 'b', 'c', 'd'])
    l.setHeight('x', 30)
    l.setHeight('y', 10)
    // c used to start at 20; now it starts at 30+10+20 = 60
    expect(l.scrollTopFor(anchor)).toBe(65)
  })

  it('keeps the same rows in view when a row above is measured taller', () => {
    const l = new Layout(20)
    l.setKeys(keys(5))
    const anchor = l.anchorAt(65)! // 5px into k3
    l.setHeight('k0', 60) // 40px taller than estimated
    expect(l.scrollTopFor(anchor)).toBe(105)
  })

  it('cannot restore an anchor whose row was removed', () => {
    const l = new Layout(20)
    l.setKeys(keys(3))
    const anchor = l.anchorAt(25)!
    l.setKeys(['k0', 'k2'])
    expect(l.scrollTopFor(anchor)).toBeNull()
  })

  it('stays fast for the largest buffer', () => {
    const l = new Layout(22)
    const ks = keys(3000)
    l.setKeys(ks)
    const t = performance.now()
    for (let i = 0; i < 200; i++) {
      l.setHeight(ks[i]!, 20 + (i % 7))
      l.range(i * 40, 700, 600)
    }
    expect(performance.now() - t).toBeLessThan(1500)
  })
})
