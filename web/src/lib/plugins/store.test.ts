import { beforeEach, describe, expect, it } from 'vitest'
import { deleteData, loadData, loadPlugins, savePlugins, saveData } from './store'
import type { InstalledPlugin } from './types'

class Mem {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
  removeItem(k: string) { this.data.delete(k) }
}

const p = (name: string): InstalledPlugin => ({ manifest: { name, version: '1.0.0', description: '', permissions: ['send'] }, source: 'x', granted: ['send'], enabled: true })

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new Mem()
})

describe('plugin store', () => {
  it('keeps plugins per account', () => {
    savePlugins('matt', [p('aaa')])
    savePlugins('jane', [p('bbb')])
    expect(loadPlugins('matt').map((x) => x.manifest.name)).toEqual(['aaa'])
    expect(loadPlugins('jane').map((x) => x.manifest.name)).toEqual(['bbb'])
    expect(loadPlugins('nobody')).toEqual([])
  })
  it('ignores damaged entries and duplicates', () => {
    ;(localStorage as unknown as Mem).setItem('irc:plugins:matt', JSON.stringify([p('aaa'), { nonsense: 1 }, p('aaa'), null]))
    expect(loadPlugins('matt').length).toBe(1)
    ;(localStorage as unknown as Mem).setItem('irc:plugins:matt', 'not json')
    expect(loadPlugins('matt')).toEqual([])
  })
  it('keeps plugin data per plugin and per account', () => {
    saveData('matt', 'aaa', { k: '1' })
    saveData('matt', 'bbb', { k: '2' })
    expect(loadData('matt', 'aaa')).toEqual({ k: '1' })
    expect(loadData('jane', 'aaa')).toEqual({})
    deleteData('matt', 'aaa')
    expect(loadData('matt', 'aaa')).toEqual({})
    expect(loadData('matt', 'bbb')).toEqual({ k: '2' })
  })
  it('reads only strings, and no more than the allowance', () => {
    ;(localStorage as unknown as Mem).setItem('irc:plugin-data:matt:aaa', JSON.stringify({ a: '1', b: 2, c: 'x'.repeat(200_000) }))
    expect(loadData('matt', 'aaa')).toEqual({ a: '1' })
  })
  it('survives storage that is unavailable', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem() { throw new Error('no') }, setItem() { throw new Error('no') }, removeItem() { throw new Error('no') } }
    expect(loadPlugins('matt')).toEqual([])
    expect(savePlugins('matt', [p('aaa')])).toBe(false)
    expect(() => deleteData('matt', 'aaa')).not.toThrow()
  })
})
