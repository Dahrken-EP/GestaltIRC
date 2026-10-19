import { describe, expect, it, vi } from 'vitest'
import { compareVersions, reloadIfStale, shouldReload } from './staleness'

describe('comparing versions', () => {
  it('orders x.y.z versions by number, not by text', () => {
    expect(compareVersions('0.2.14', '0.2.15')).toBe(-1)
    expect(compareVersions('0.2.15', '0.2.14')).toBe(1)
    expect(compareVersions('0.2.15', '0.2.15')).toBe(0)
    expect(compareVersions('0.2.9', '0.2.10')).toBe(-1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
  })

  it('has no opinion on anything else', () => {
    expect(compareVersions('dev', '0.2.15')).toBeNull()
    expect(compareVersions('0.2.15', '')).toBeNull()
    expect(compareVersions('0.2.15-rc1', '0.2.15')).toBeNull()
  })
})

describe('a page older than its server', () => {
  it('is reloaded, once for each server version', () => {
    expect(shouldReload('0.2.14', '0.2.15', null)).toBe(true)
    expect(shouldReload('0.2.14', '0.2.15', '0.2.15')).toBe(false)
    expect(shouldReload('0.2.14', '0.2.16', '0.2.15')).toBe(true)
  })

  it('is left alone when it is the same or newer, or when the versions cannot be told', () => {
    expect(shouldReload('0.2.15', '0.2.15', null)).toBe(false)
    expect(shouldReload('0.2.16', '0.2.15', null)).toBe(false)
    expect(shouldReload('dev', '0.2.15', null)).toBe(false)
    expect(shouldReload('0.2.14', '', null)).toBe(false)
  })

  it('reloads one time and then, having come back as old, does not go round again', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
    try {
      const reload = vi.fn()
      expect(reloadIfStale('0.2.14', '0.2.15', reload)).toBe(true)
      expect(reloadIfStale('0.2.14', '0.2.15', reload)).toBe(false) // the page that came back
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('is not reloaded where it cannot be remembered that it was (no loop is better than a stale page)', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => { throw new Error('denied') } })
    try {
      const reload = vi.fn()
      expect(reloadIfStale('0.2.14', '0.2.15', reload)).toBe(false)
      expect(reload).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
