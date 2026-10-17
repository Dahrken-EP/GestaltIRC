import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Settings reads localStorage when the module loads, so each test imports a fresh copy.
async function fresh(stored?: Record<string, unknown>) {
  const store = new Map<string, string>()
  if (stored) store.set('irc:settings', JSON.stringify(stored))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.resetModules()
  const { settings } = await import('./settings.svelte')
  return { settings, store }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('settings', () => {
  it('loads saved values and falls back to defaults', async () => {
    const { settings } = await fresh({ theme: 'dark', keywords: ['deploy'] })
    expect(settings.theme).toBe('dark')
    expect(settings.keywords).toEqual(['deploy'])
    expect(settings.density).toBe('compact')
    expect(settings.sendTyping).toBe(false) // privacy-affecting options start off
  })

  it('survives corrupt storage', async () => {
    const store = new Map([['irc:settings', '{not json']])
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: () => {} })
    vi.resetModules()
    const { settings } = await import('./settings.svelte')
    expect(settings.theme).toBe('system')
  })

  it('ignores values of the wrong type instead of breaking the page', async () => {
    const { settings } = await fresh({ theme: 'neon', density: 7, keywords: 'x', nickColors: [1], showMembers: 'yes' })
    expect(settings.theme).toBe('system')
    expect(settings.density).toBe('compact')
    expect(settings.keywords).toEqual([])
    expect(settings.nickColors).toEqual({})
    expect(settings.showMembers).toBe(true)
  })

  it('adopts the bouncer preferences when it has some', async () => {
    const { settings, store } = await fresh({ theme: 'light' })
    const push = vi.fn()
    settings.connectRemote({ theme: 'dark', keywords: ['a'] }, push)
    expect(settings.theme).toBe('dark')
    expect(JSON.parse(store.get('irc:settings')!).theme).toBe('dark') // cached for the next visit
    vi.advanceTimersByTime(5000)
    expect(push).not.toHaveBeenCalled() // nothing to upload when the server already has them
  })

  it('uploads local preferences when the bouncer has none', async () => {
    const { settings } = await fresh({ theme: 'light', keywords: ['mine'] })
    const push = vi.fn()
    settings.connectRemote(null, push)
    vi.advanceTimersByTime(1000)
    expect(push).toHaveBeenCalledOnce()
    expect(push.mock.calls[0]![0]).toMatchObject({ theme: 'light', keywords: ['mine'] })
  })

  it('treats empty bouncer preferences as none', async () => {
    const { settings } = await fresh({ theme: 'light' })
    const push = vi.fn()
    settings.connectRemote({}, push)
    vi.advanceTimersByTime(1000)
    expect(settings.theme).toBe('light')
    expect(push).toHaveBeenCalledOnce()
  })

  it('combines quick changes into one upload', async () => {
    const { settings } = await fresh()
    const push = vi.fn()
    settings.connectRemote({ theme: 'system' }, push)
    for (const t of ['light', 'dark', 'light'] as const) {
      settings.theme = t
      settings.save()
    }
    vi.advanceTimersByTime(1000)
    expect(push).toHaveBeenCalledOnce()
    expect(push.mock.calls[0]![0]).toMatchObject({ theme: 'light' })
  })

  it('never uploads the browser-only notification setting', async () => {
    const { settings } = await fresh()
    const push = vi.fn()
    settings.connectRemote({ theme: 'system' }, push)
    settings.notify = true
    settings.save()
    vi.advanceTimersByTime(1000)
    expect(Object.keys(push.mock.calls[0]![0])).not.toContain('notify')
  })

  it('keeps the notification setting when the bouncer preferences are adopted', async () => {
    const { settings } = await fresh({ notify: true })
    settings.connectRemote({ theme: 'dark', notify: false }, vi.fn())
    // The server's copy never had a say in this browser's permission, so a stray key does nothing.
    expect(settings.theme).toBe('dark')
    expect(settings.notify).toBe(true)
  })

  it('stops uploading after disconnectRemote but still saves locally', async () => {
    const { settings, store } = await fresh()
    const push = vi.fn()
    settings.connectRemote({ theme: 'system' }, push)
    settings.disconnectRemote()
    settings.theme = 'dark'
    settings.save()
    vi.advanceTimersByTime(5000)
    expect(push).not.toHaveBeenCalled()
    expect(JSON.parse(store.get('irc:settings')!).theme).toBe('dark')
  })

  it('does not upload a pending change after logout', async () => {
    const { settings } = await fresh()
    const push = vi.fn()
    settings.connectRemote({ theme: 'system' }, push)
    settings.theme = 'dark'
    settings.save()
    settings.disconnectRemote() // logout before the delay ends
    vi.advanceTimersByTime(5000)
    expect(push).not.toHaveBeenCalled()
  })

  it('nick colour overrides are saved and removed case-insensitively', async () => {
    const { settings } = await fresh()
    settings.setNickColor('Alice', '#ff0000')
    expect(settings.nickColors).toEqual({ alice: '#ff0000' })
    settings.setNickColor('ALICE', null)
    expect(settings.nickColors).toEqual({})
  })
})
