import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, websocketUrl } from './api'

function reply(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body })
}

afterEach(() => vi.unstubAllGlobals())

describe('api', () => {
  it('session returns null for 401 and the session otherwise', async () => {
    vi.stubGlobal('fetch', reply(401, { error: 'not logged in' }))
    expect(await api.session()).toBeNull()

    const session = { user: 'matt', networks: [], prefs: null }
    vi.stubGlobal('fetch', reply(200, session))
    expect(await api.session()).toEqual(session)
  })

  it('session rethrows anything other than 401', async () => {
    vi.stubGlobal('fetch', reply(500, { error: 'boom' }))
    await expect(api.session()).rejects.toMatchObject({ status: 500, message: 'boom' })
  })

  it('login sends JSON with the same-origin credentials and reports the server error', async () => {
    const f = reply(401, { error: 'bad user or password' })
    vi.stubGlobal('fetch', f)
    await expect(api.login('matt', 'wrong')).rejects.toBeInstanceOf(ApiError)
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('/api/login')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ user: 'matt', password: 'wrong' })
  })

  it('reports a rate limit with its message', async () => {
    vi.stubGlobal('fetch', reply(429, { error: 'too many failed logins; try again later' }))
    await expect(api.login('matt', 'x')).rejects.toMatchObject({ status: 429, message: expect.stringContaining('too many') })
  })

  it('falls back to the status when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => Promise.reject(new Error('html')) }))
    await expect(api.logout()).rejects.toMatchObject({ status: 502, message: 'request failed (502)' })
  })

  it('does not put a body on GET requests', async () => {
    const f = reply(200, { key: 'K' })
    vi.stubGlobal('fetch', f)
    await api.pushKey()
    expect(f.mock.calls[0]![1].body).toBeUndefined()
    expect(f.mock.calls[0]![1].headers).toBeUndefined()
  })

  it('sends preferences as the JSON body', async () => {
    const f = reply(200, { ok: true })
    vi.stubGlobal('fetch', f)
    await api.putPrefs({ theme: 'dark' })
    expect(f.mock.calls[0]![0]).toBe('/api/prefs')
    expect(f.mock.calls[0]![1].method).toBe('PUT')
    expect(JSON.parse(f.mock.calls[0]![1].body)).toEqual({ theme: 'dark' })
  })

  // A refreshed page never logs in again, so the session answer is where the CSRF
  // token comes from. Without it, adding a network is refused there ("missing
  // CSRF token").
  it('keeps the CSRF token from the session answer for later state-changing calls', async () => {
    vi.stubGlobal('fetch', reply(200, { user: 'matt', networks: [], prefs: null, csrf_token: 'T-T' }))
    await api.session()

    const f = reply(200, { ok: true })
    vi.stubGlobal('fetch', f)
    await api.putPrefs({ theme: 'dark' })
    expect(f.mock.calls[0]![1].headers['X-CSRF-Token']).toBe('T-T')
  })

  // A page can outlive the bouncer's last restart: the token it carried in from
  // the session as it was then may be stale or empty now, and the bouncer answers
  // "missing CSRF token" before doing anything. The call re-reads the session and
  // tries once more, so a long-lived tab heals instead of staying broken.
  it('re-arms the CSRF token from the session when a state-changing call is refused', async () => {
    const calls: { url: string; token: string }[] = []
    let answered = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        if (url === '/api/session') {
          // The first read is the token the tab carried in from before the
          // bouncer's restart (stale); the re-read hands out the fresh one.
          const token = answered ? 'fresh' : 'stale'
          answered = true
          return { ok: true, status: 200, json: async () => ({ user: 'matt', networks: [], prefs: null, csrf_token: token }) }
        }
        calls.push({ url, token: headers['X-CSRF-Token'] ?? '' })
        if (calls.length === 1) return { ok: false, status: 403, json: async () => ({ error: 'bad CSRF token' }) }
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }) as unknown as typeof fetch,
    )
    await api.session()
    expect(await api.putPrefs({ theme: 'dark' })).toEqual({ ok: true })
    expect(calls).toEqual([
      { url: '/api/prefs', token: 'stale' },
      { url: '/api/prefs', token: 'fresh' },
    ])
  })

  it('does not re-read the session for refusals that are not about the CSRF token', async () => {
    const f = reply(403, { error: 'cross-origin request refused' })
    vi.stubGlobal('fetch', f)
    await expect(api.putPrefs({})).rejects.toMatchObject({ message: 'cross-origin request refused' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('uploads heal a stale token the same way', async () => {
    const calls: string[] = []
    let answered = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        if (url === '/api/session') {
          const token = answered ? 'fresh' : 'stale'
          answered = true
          return { ok: true, status: 200, json: async () => ({ user: 'matt', networks: [], prefs: null, csrf_token: token }) }
        }
        calls.push(headers['X-CSRF-Token'] ?? '')
        if (calls.length === 1) return { ok: false, status: 403, json: async () => ({ error: 'missing CSRF token' }) }
        return { ok: true, status: 200, json: async () => ({ id: '1', name: 'f.txt', url: '/uploads/1/f.txt', size: 1, mime: 'text/plain', expires_at: 1 }) }
      }) as unknown as typeof fetch,
    )
    await api.session()
    const file = new File(['x'], 'f.txt')
    expect(await api.uploadFile(file)).toMatchObject({ url: '/uploads/1/f.txt' })
    expect(calls).toEqual(['stale', 'fresh'])
  })
})

describe('websocketUrl', () => {
  it('follows the page scheme and host', () => {
    expect(websocketUrl({ protocol: 'https:', host: 'irc.example.org' })).toBe('wss://irc.example.org/ws')
    expect(websocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws')
  })
})
