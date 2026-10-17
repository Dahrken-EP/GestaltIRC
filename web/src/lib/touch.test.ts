import { afterEach, describe, expect, it, vi } from 'vitest'
import { cannotHover, isInteractive } from './touch.svelte'

afterEach(() => vi.unstubAllGlobals())

describe('cannotHover', () => {
  it('follows the media query', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(hover: none)' }))
    expect(cannotHover()).toBe(true)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    expect(cannotHover()).toBe(false)
  })

  it('is false where there is no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(cannotHover()).toBe(false)
  })
})

describe('isInteractive', () => {
  // closest() answers for the selector the way the browser would: here, "inside a link or button".
  const inside = (interactive: boolean) => ({ closest: (sel: string) => (interactive && sel.includes('button') ? {} : null) })

  it('is true for what is inside a link or button, false for plain text and for nothing', () => {
    expect(isInteractive(inside(true) as unknown as EventTarget)).toBe(true)
    expect(isInteractive(inside(false) as unknown as EventTarget)).toBe(false)
    expect(isInteractive(null)).toBe(false)
    expect(isInteractive({} as unknown as EventTarget)).toBe(false)
  })
})
