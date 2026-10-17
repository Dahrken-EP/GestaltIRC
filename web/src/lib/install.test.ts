import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Install } from './install.svelte'

type Listener = (e: Event) => void

function browser(ua: string, standalone = false) {
  const listeners = new Map<string, Listener>()
  vi.stubGlobal('window', { addEventListener: (t: string, f: Listener) => listeners.set(t, f) })
  vi.stubGlobal('navigator', { userAgent: ua, standalone })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  return { fire: (t: string, e: Partial<Event> = {}) => listeners.get(t)!({ preventDefault() {}, ...e } as Event) }
}

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('Install', () => {
  it('offers nothing until the browser says the page can be installed', () => {
    const b = browser('Mozilla/5.0 Firefox')
    const i = new Install()
    expect(i.kind).toBe('none')
    const prompt = vi.fn().mockResolvedValue(undefined)
    b.fire('beforeinstallprompt', { prompt, userChoice: Promise.resolve({ outcome: 'accepted' }) } as never)
    expect(i.kind).toBe('prompt')
  })

  it('shows the browser prompt once, and says whether it was accepted', async () => {
    const b = browser('Mozilla/5.0 Chrome')
    const i = new Install()
    const prompt = vi.fn().mockResolvedValue(undefined)
    b.fire('beforeinstallprompt', { prompt, userChoice: Promise.resolve({ outcome: 'dismissed' }) } as never)
    expect(await i.install()).toBe(false)
    expect(prompt).toHaveBeenCalledOnce()
    expect(i.kind).toBe('none')
    expect(await i.install()).toBe(false)
  })

  it('knows when it is installed or already running as an app', () => {
    const b = browser('Mozilla/5.0 Chrome')
    const i = new Install()
    b.fire('appinstalled')
    expect(i.kind).toBe('installed')
    browser('Mozilla/5.0 Safari', true)
    expect(new Install().kind).toBe('installed')
  })

  it('tells Safari on an iPhone to use the share sheet, but not other iOS browsers', () => {
    browser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Safari')
    expect(new Install().kind).toBe('ios')
    browser('Mozilla/5.0 (iPhone) CriOS/120 Safari')
    expect(new Install().kind).toBe('none')
  })
})
