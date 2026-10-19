// The service worker (public/sw.js) run against a stand-in for its global scope.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown) => void

function loadWorker() {
  const handlers = new Map<string, Handler>()
  const stored: string[] = []
  const origin = 'https://irc.example.org'
  const self = {
    location: { origin },
    addEventListener: (kind: string, fn: Handler) => handlers.set(kind, fn),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]), openWindow: () => Promise.resolve() },
    registration: { showNotification: () => Promise.resolve() },
  }
  const cache = { put: (req: { url: string }) => (stored.push(new URL(req.url).pathname), Promise.resolve()), addAll: () => Promise.resolve() }
  const caches = {
    open: () => Promise.resolve(cache),
    match: () => Promise.resolve(undefined),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  }
  const fetchFn = vi.fn((req: { url: string }) =>
    Promise.resolve({ ok: true, status: req.url.includes('/partial') ? 206 : 200, clone() { return this } }),
  )
  const code = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')
  new Function('self', 'caches', 'fetch', 'URL', code)(self, caches, fetchFn, URL)

  /** Sends a request through the worker; says whether it answered it, and waits for it to finish. */
  async function request(path: string, method = 'GET'): Promise<{ handled: boolean }> {
    let answer: Promise<unknown> | undefined
    handlers.get('fetch')!({
      request: { url: origin + path, method },
      respondWith: (p: Promise<unknown>) => (answer = p),
    })
    if (answer) await answer
    await new Promise((r) => setTimeout(r, 0))
    return { handled: answer !== undefined }
  }
  return { request, stored, fetchFn }
}

describe('what the service worker keeps', () => {
  it('keeps the app and its build files', async () => {
    const w = loadWorker()
    expect((await w.request('/')).handled).toBe(true)
    expect((await w.request('/assets/index-abc123.js')).handled).toBe(true)
    expect((await w.request('/manifest.webmanifest')).handled).toBe(true)
    expect(w.stored).toEqual(expect.arrayContaining(['/', '/assets/index-abc123.js', '/manifest.webmanifest']))
  })

  it('does not touch uploads, guest links, the API, the media proxy or the socket', async () => {
    const w = loadWorker()
    for (const path of ['/uploads/0123456789abcdef0123456789abcdef/photo.png', '/guest/some-token', '/api/media?u=x', '/api/session', '/ws']) {
      expect((await w.request(path)).handled, path).toBe(false)
    }
    expect(w.stored).toEqual([])
    expect(w.fetchFn).not.toHaveBeenCalled()
  })

  it('does not answer requests other than GET', async () => {
    const w = loadWorker()
    expect((await w.request('/', 'POST')).handled).toBe(false)
  })

  it('stores only whole answers', async () => {
    const w = loadWorker()
    await w.request('/assets/partial.js')
    expect(w.stored).toEqual([])
  })
})
