import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyScore } from './fuzzy'

describe('fuzzyScore', () => {
  it('matches letters in order and rejects anything else', () => {
    expect(fuzzyScore('gnrl', '#general')).not.toBeNull()
    expect(fuzzyScore('lgn', '#general')).toBeNull()
    expect(fuzzyScore('z', '#general')).toBeNull()
  })

  it('treats an empty query as matching everything equally', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
    expect(fuzzyScore('   ', 'anything')).toBe(0)
  })

  it('ignores case', () => {
    expect(fuzzyScore('GEN', '#General')).not.toBeNull()
  })

  it('prefers a match at the start of the name, then one that runs together', () => {
    expect(fuzzyScore('gen', '#general')!).toBeGreaterThan(fuzzyScore('gen', '#engineering')!)
    expect(fuzzyScore('abc', 'abcdef')!).toBeGreaterThan(fuzzyScore('abc', 'axbxcx')!)
  })
})

describe('fuzzyFilter', () => {
  const names = ['#random', '#engineering', '#general', 'alice', 'libera']

  it('returns everything in the given order for an empty query', () => {
    expect(fuzzyFilter(names, '', (n) => [n])).toEqual(names)
  })

  it('drops what does not match and puts the best first', () => {
    expect(fuzzyFilter(names, 'gen', (n) => [n])).toEqual(['#general', '#engineering'])
  })

  it('looks in every field it is given', () => {
    const items = [{ n: '#a', net: 'libera' }, { n: '#b', net: 'oftc' }]
    expect(fuzzyFilter(items, 'oftc', (i) => [i.n, i.net])).toEqual([items[1]])
  })

  it('keeps the given order between equal scores', () => {
    const items = ['ab1', 'ab2', 'ab3']
    expect(fuzzyFilter(items, 'ab', (n) => [n])).toEqual(items)
  })
})
