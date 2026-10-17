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
})

describe('websocketUrl', () => {
  it('follows the page scheme and host', () => {
    expect(websocketUrl({ protocol: 'https:', host: 'irc.example.org' })).toBe('wss://irc.example.org/ws')
    expect(websocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws')
  })
})
