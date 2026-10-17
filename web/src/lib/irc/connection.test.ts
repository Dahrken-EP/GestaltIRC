import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Connection, encodeSaslPlain, type Batch, type SocketLike, type Status } from './connection'
import type { Message } from './message'

class FakeSocket implements SocketLike {
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.closed = true
  }
  recv(line: string) {
    this.onmessage?.({ data: line })
  }
  drop() {
    this.onclose?.({ code: 1006, reason: '' })
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  const messages: Message[] = []
  const batches: Batch[] = []
  const statuses: [Status, string | undefined][] = []
  const conn = new Connection({
    url: 'ws://x/ws',
    login: 'matt/libera',
    password: 'pw',
    nick: 'matt',
    onMessage: (m) => messages.push(m),
    onBatch: (b) => batches.push(b),
    onStatus: (s, d) => statuses.push([s, d]),
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
  })
  return { conn, sockets, messages, batches, statuses }
}

/** Runs the full handshake against a fake bouncer. */
function handshake(s: FakeSocket) {
  s.onopen!()
  s.recv(':b CAP * LS :message-tags server-time batch echo-message sasl=PLAIN chathistory message-ids')
  s.recv(':b CAP * ACK :message-tags server-time batch echo-message chathistory message-ids sasl')
  s.recv('AUTHENTICATE +')
  s.recv(':b 903 * :SASL authentication successful')
  s.recv(':b 001 matt :Welcome')
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Connection', () => {
  it('negotiates caps, logs in with SASL PLAIN, then registers', () => {
    const { conn, sockets, statuses } = setup()
    conn.connect()
    const s = sockets[0]!
    handshake(s)

    expect(s.sent[0]).toBe('CAP LS 302')
    expect(s.sent).toContain('NICK matt')
    expect(s.sent).toContain('CAP REQ :message-tags server-time batch echo-message chathistory message-ids sasl')
    expect(s.sent).toContain('AUTHENTICATE PLAIN')
    expect(s.sent).toContain('AUTHENTICATE ' + btoa('\0matt/libera\0pw'))
    expect(s.sent).toContain('CAP END')
    expect(statuses.map((x) => x[0])).toEqual(['connecting', 'connected'])
  })

  it('does not request caps the bouncer does not offer', () => {
    const { conn, sockets } = setup()
    conn.connect()
    const s = sockets[0]!
    s.onopen!()
    s.recv(':b CAP * LS :sasl=PLAIN message-tags')
    expect(s.sent).toContain('CAP REQ :message-tags sasl')
  })

  it('reads a multi-line CAP LS before requesting', () => {
    const { conn, sockets } = setup()
    conn.connect()
    const s = sockets[0]!
    s.onopen!()
    s.recv(':b CAP * LS * :batch')
    expect(s.sent.some((l) => l.startsWith('CAP REQ'))).toBe(false)
    s.recv(':b CAP * LS :sasl=PLAIN')
    expect(s.sent).toContain('CAP REQ :batch sasl')
  })

  it('fails without retrying when the login is rejected', () => {
    const { conn, sockets, statuses } = setup()
    conn.connect()
    const s = sockets[0]!
    s.onopen!()
    s.recv(':b CAP * LS :sasl=PLAIN')
    s.recv(':b CAP * ACK :sasl')
    s.recv('AUTHENTICATE +')
    s.recv(':b 904 * :bad user, password, or network')
    expect(statuses.at(-1)).toEqual(['failed', 'bad user, password, or network'])
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
  })

  it('answers PING and passes other messages up', () => {
    const { conn, sockets, messages } = setup()
    conn.connect()
    const s = sockets[0]!
    handshake(s)
    s.recv('PING :abc')
    s.recv(':n!u@h PRIVMSG #c :hi')
    expect(s.sent).toContain('PONG :abc')
    expect(messages.map((m) => m.command)).toEqual(['001', 'PRIVMSG'])
  })

  it('collects batch lines and delivers them when the batch closes', () => {
    const { conn, sockets, messages, batches } = setup()
    conn.connect()
    const s = sockets[0]!
    handshake(s)
    s.recv(':b BATCH +b1 chathistory #c')
    s.recv('@batch=b1;time=2026-01-01T00:00:00.000Z :a!u@h PRIVMSG #c :one')
    s.recv('@batch=b1 :a!u@h PRIVMSG #c :two')
    s.recv(':a!u@h PRIVMSG #c :live')
    expect(batches).toHaveLength(0)
    s.recv(':b BATCH -b1')
    expect(batches).toHaveLength(1)
    expect(batches[0]!.type).toBe('chathistory')
    expect(batches[0]!.params).toEqual(['#c'])
    expect(batches[0]!.messages.map((m) => m.params[1])).toEqual(['one', 'two'])
    expect(messages.filter((m) => m.command === 'PRIVMSG').map((m) => m.params[1])).toEqual(['live'])
  })

  it('reconnects with backoff after the socket drops', () => {
    const { conn, sockets, statuses } = setup()
    conn.connect()
    handshake(sockets[0]!)
    sockets[0]!.drop()
    expect(statuses.at(-1)![0]).toBe('disconnected')
    vi.advanceTimersByTime(999)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(2)
    expect(sockets).toHaveLength(2)
    sockets[1]!.drop()
    vi.advanceTimersByTime(1999)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(2)
    expect(sockets).toHaveLength(3)
  })

  it('does not reconnect after close()', () => {
    const { conn, sockets } = setup()
    conn.connect()
    handshake(sockets[0]!)
    conn.close()
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.closed).toBe(true)
  })

  it('drops a connection that goes silent', () => {
    const { conn, sockets, statuses } = setup()
    conn.connect()
    handshake(sockets[0]!)
    vi.advanceTimersByTime(45_000 * 3)
    expect(statuses.some((x) => x[1] === 'connection timed out')).toBe(true)
    vi.advanceTimersByTime(40_000)
    expect(sockets.length).toBeGreaterThan(1)
  })
})

describe('Connection with the full bouncer', () => {
  it('requests the capabilities the client can use, and only those offered', () => {
    const { conn, sockets } = setup()
    conn.connect()
    const s = sockets[0]!
    s.onopen!()
    s.recv(
      ':b CAP * LS :message-tags sasl=PLAIN draft/read-marker draft/message-redaction away-notify multi-prefix standard-replies cap-notify extended-join sts=port=443',
    )
    const req = s.sent.find((l) => l.startsWith('CAP REQ'))!
    const asked = req.replace('CAP REQ :', '').split(' ')
    expect(asked).toEqual(
      expect.arrayContaining(['message-tags', 'sasl', 'draft/read-marker', 'draft/message-redaction', 'away-notify', 'multi-prefix', 'standard-replies', 'cap-notify']),
    )
    // Offered but not wanted, and the sts policy is never a capability to request.
    expect(asked).not.toContain('extended-join')
    expect(asked.some((c) => c.startsWith('sts'))).toBe(false)
  })

  it('logs in with an empty password when a session cookie stands in for it', () => {
    const sockets: FakeSocket[] = []
    const conn = new Connection({
      url: 'ws://x/ws',
      login: 'matt/libera',
      password: '',
      nick: 'matt',
      onMessage: () => {},
      onBatch: () => {},
      onStatus: () => {},
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    })
    conn.connect()
    const s = sockets[0]!
    s.onopen!()
    s.recv(':b CAP * LS :sasl=PLAIN')
    s.recv(':b CAP * ACK :sasl')
    s.recv('AUTHENTICATE +')
    expect(s.sent).toContain('AUTHENTICATE ' + btoa('\0matt/libera\0'))
  })

  it('reports the capabilities the bouncer acknowledged', () => {
    const { conn, sockets } = setup()
    conn.connect()
    handshake(sockets[0]!)
    expect(conn.capabilities.has('sasl')).toBe(true)
    expect(conn.capabilities.has('message-tags')).toBe(true)
  })
})

describe('encodeSaslPlain', () => {
  it('encodes UTF-8 credentials', () => {
    expect(atob(encodeSaslPlain('u', 'pä')[0]!).length).toBeGreaterThan(0)
    expect(encodeSaslPlain('u', 'p')).toEqual([btoa('\0u\0p')])
  })

  it('chunks long payloads and terminates exact multiples with +', () => {
    const long = encodeSaslPlain('u', 'x'.repeat(600))
    expect(long.length).toBeGreaterThan(1)
    expect(long.slice(0, -1).every((c) => c.length === 400)).toBe(true)
    // 3 + 1 ("\0u\0") bytes of overhead; pick a password length that makes the base64 exactly 400 chars.
    const exact = encodeSaslPlain('u', 'x'.repeat(297))
    expect(exact).toHaveLength(2)
    expect(exact[1]).toBe('+')
  })
})
