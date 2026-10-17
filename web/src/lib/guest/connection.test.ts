import { describe, expect, it, vi } from 'vitest'
import { GuestConnection, guestSocketUrl, guestTokenFrom, type GuestEvents, type Welcome } from './connection'

class FakeSocket {
  static last: FakeSocket
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeSocket.last = this
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.closed = true
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  say(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) })
  }
}

function setup() {
  const events = {
    onWelcome: vi.fn<(w: Welcome) => void>(),
    onTag: vi.fn(),
    onEnd: vi.fn(),
    onRefused: vi.fn(),
    onClosed: vi.fn(),
  } satisfies GuestEvents
  const conn = new GuestConnection('tok12345', events, FakeSocket as never, 'ws://x/api/guest/ws?token=tok12345')
  return { conn, events }
}

const welcome = { t: 'welcome', nick: 'g-Sam', name: 'Sam', kind: 'direct', target: 'alice', host: 'matt', network: 'libera', resume: 'r', ice: [{ urls: ['stun:x'] }] }

describe('guestTokenFrom', () => {
  it('finds the token in a guest page address only', () => {
    expect(guestTokenFrom('/guest/abcdefgh12345678')).toBe('abcdefgh12345678')
    expect(guestTokenFrom('/guest/abcdefgh12345678/')).toBe('abcdefgh12345678')
    for (const p of ['/', '/guest/', '/guest/short', '/guest/a/b', '/other/abcdefgh12345678', '/guest/abc def ghi'])
      expect(guestTokenFrom(p), p).toBeNull()
  })
  it('builds the socket address', () => {
    expect(guestSocketUrl('a b', { protocol: 'https:', host: 'h.example' })).toBe('wss://h.example/api/guest/ws?token=a%20b')
    expect(guestSocketUrl('t', { protocol: 'http:', host: 'localhost:8080' })).toBe('ws://localhost:8080/api/guest/ws?token=t')
  })
})

describe('GuestConnection', () => {
  it('says hello with the name once open, and reports the welcome', () => {
    const { conn, events } = setup()
    conn.join('Sam', 'key')
    FakeSocket.last.open()
    expect(JSON.parse(FakeSocket.last.sent[0]!)).toEqual({ t: 'hello', name: 'Sam', resume: 'key' })
    FakeSocket.last.say(welcome)
    expect(events.onWelcome).toHaveBeenCalledWith({ nick: 'g-Sam', name: 'Sam', kind: 'direct', target: 'alice', host: 'matt', network: 'libera', resume: 'r', ice: [{ urls: ['stun:x'] }] })
  })

  it('passes tags both ways and says goodbye', () => {
    const { conn, events } = setup()
    conn.join('Sam')
    FakeSocket.last.open()
    conn.sendTag('+gestalt/p2p', 'abc')
    expect(JSON.parse(FakeSocket.last.sent[1]!)).toEqual({ t: 'tag', key: '+gestalt/p2p', value: 'abc' })
    FakeSocket.last.say({ t: 'tag', key: '+gestalt/p2p', value: 'xyz' })
    expect(events.onTag).toHaveBeenCalledWith('+gestalt/p2p', 'xyz')
    const ws = FakeSocket.last
    conn.leave()
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ t: 'bye' })
    expect(ws.closed).toBe(true)
  })

  it('reports an end, a refusal and a lost connection, each once', () => {
    let s = setup()
    s.conn.join('Sam')
    FakeSocket.last.open()
    FakeSocket.last.say({ t: 'end', reason: 'The host left.' })
    expect(s.events.onEnd).toHaveBeenCalledWith('The host left.')
    FakeSocket.last.onclose?.()
    expect(s.events.onClosed).not.toHaveBeenCalled()

    s = setup()
    s.conn.join('Sam')
    FakeSocket.last.say({ t: 'error', reason: 'This link has already been used.' })
    expect(s.events.onRefused).toHaveBeenCalledWith('This link has already been used.')

    s = setup()
    s.conn.join('Sam')
    FakeSocket.last.onclose?.()
    expect(s.events.onClosed).toHaveBeenCalledOnce()
  })

  it('ignores frames that are not what it expects', () => {
    const { conn, events } = setup()
    conn.join('Sam')
    const ws = FakeSocket.last
    ws.onmessage?.({ data: 'not json' })
    ws.onmessage?.({ data: new ArrayBuffer(2) })
    ws.say({ t: 'welcome', nick: 5 })
    ws.say({ t: 'welcome', nick: 'g-x', host: 'h', kind: 'weird' })
    ws.say({ t: 'tag', key: 1, value: 2 })
    ws.say({ t: 'surprise' })
    expect(events.onWelcome).not.toHaveBeenCalled()
    expect(events.onTag).not.toHaveBeenCalled()
  })

  it('does not send before it is open', () => {
    const { conn } = setup()
    conn.join('Sam')
    conn.sendTag('+gestalt/p2p', 'early')
    expect(FakeSocket.last.sent).toEqual([])
  })
})
