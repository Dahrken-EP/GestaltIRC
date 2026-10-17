import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectChat, type ChatLine, type ChatView } from './chat'
import { FakeNet, type FakePC } from './fakepc'
import { newSessionId } from './signal'

interface Side {
  chat: DirectChat
  view: ChatView
  lines: ChatLine[]
  history: ChatView[]
  sent: Array<{ sid: string; payload: { k: string; t: string; sdp?: string } }>
}

function pair(net = new FakeNet(), opts: { aWins?: boolean; ice?: () => Promise<RTCIceServer[]> } = {}) {
  const make = (name: string, wins: boolean): Side => {
    const side: Side = { view: undefined as unknown as ChatView, lines: [], history: [], sent: [], chat: undefined as unknown as DirectChat }
    side.chat = new DirectChat({
      peer: name,
      iceServers: opts.ice ?? (async () => [{ urls: 'stun:stun.example.org' }]),
      createConnection: net.create,
      newSid: newSessionId,
      wins: () => wins,
      signal: (sid, payload) => {
        side.sent.push({ sid, payload })
        // Delivered a moment later, as IRC would.
        setTimeout(() => (side === a ? b : a).chat.handleSignal(sid, payload), 1)
      },
      onChange: (v) => {
        side.view = v
        side.history.push(v)
      },
      onMessage: (l) => side.lines.push(l),
      inviteTimeoutMs: 5000,
    })
    return side
  }
  const a: Side = make('bob', opts.aWins ?? true)
  const b: Side = make('alice', !(opts.aWins ?? true))
  return { a, b, net }
}

const settle = (ms = 30) => vi.advanceTimersByTimeAsync(ms)

async function connect(p: ReturnType<typeof pair>) {
  void p.a.chat.invite()
  await settle()
  expect(p.b.view.state).toBe('incoming')
  void p.b.chat.acceptIncoming()
  await settle(100)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DirectChat connection', () => {
  it('connects after the other side accepts, and both see the same safety code', async () => {
    const p = pair()
    await connect(p)
    expect(p.a.view.state).toBe('connected')
    expect(p.b.view.state).toBe('connected')
    expect(p.a.view.code).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){4}$/)
    expect(p.a.view.code).toBe(p.b.view.code)
    expect(p.a.view.fingerprints.local).toBe(p.b.view.fingerprints.remote)
    expect(p.a.view.fingerprints.remote).toBe(p.b.view.fingerprints.local)
  })

  it('tells the caller as soon as the request arrives, before anyone has decided', async () => {
    const net = new FakeNet()
    const p = pair(net)
    void p.a.chat.invite()
    await settle()
    expect(p.b.sent.map((x) => x.payload.t)).toEqual(['ack'])
    expect(p.a.view.state).toBe('calling')
    expect(p.a.view.acked).toBe(true)
    // It is only a receipt: nothing is connected, and no description was made.
    expect(net.created.length).toBe(1)
    // A new request starts without it.
    p.a.chat.hangUp()
    void p.a.chat.invite()
    expect(p.a.view.acked).toBe(false)
  })

  it('ignores a receipt for something else', async () => {
    const p = pair()
    void p.a.chat.invite()
    await settle(0)
    p.a.chat.handleSignal('otherid1234', { t: 'ack' })
    expect(p.a.view.acked).toBe(false)
  })

  it('makes no connection until the user accepts', async () => {
    const net = new FakeNet()
    const p = pair(net)
    void p.a.chat.invite()
    await settle()
    expect(p.b.view.state).toBe('incoming')
    // Only the caller has made a peer connection. The receiver has revealed nothing.
    expect(net.configs.length).toBe(1)
    void p.b.chat.acceptIncoming()
    await settle(100)
    expect(net.configs.length).toBe(2)
  })

  it('passes the ICE servers to the connection', async () => {
    const p = pair()
    await connect(p)
    expect(p.net.configs[0]).toEqual({ iceServers: [{ urls: 'stun:stun.example.org' }] })
  })

  it('still connects when the ICE server request fails', async () => {
    const p = pair(new FakeNet(), { ice: () => Promise.reject(new Error('no')) })
    await connect(p)
    expect(p.a.view.state).toBe('connected')
    expect(p.net.configs[0]).toEqual({ iceServers: [] })
  })

  it('reports a decline to the caller', async () => {
    const p = pair()
    void p.a.chat.invite()
    await settle()
    p.b.chat.declineIncoming()
    await settle()
    expect(p.a.view.state).toBe('ended')
    expect(p.a.view.reason).toBe('They declined.')
    expect(p.b.view.state).toBe('idle')
  })

  it('gives up on a call nobody answers, and tells the other side', async () => {
    const p = pair()
    void p.a.chat.invite()
    await settle()
    await vi.advanceTimersByTimeAsync(5100)
    expect(p.a.view.state).toBe('ended')
    expect(p.a.view.reason).toBe('No answer.')
    // The callee's pending request is dropped, too.
    expect(p.b.view.state).toBe('ended')
  })

  it('lets either side hang up', async () => {
    const p = pair()
    await connect(p)
    p.b.chat.hangUp()
    await settle()
    expect(p.b.view.state).toBe('ended')
    expect(p.a.view.state).toBe('ended')
    expect(p.a.view.reason).toBe('They closed the chat.')
  })

  it('records one ending, with the real reason, when the other side hangs up', async () => {
    const p = pair()
    await connect(p)
    p.b.chat.hangUp()
    await settle()
    // Closing the connection reports back; that must not add a second, wrong ending.
    const endings = p.a.history.filter((v) => v.state === 'ended').map((v) => v.reason)
    expect(endings).toEqual(['They closed the chat.'])
  })

  it('closes a chat whose certificate cannot be read, instead of calling it verified', async () => {
    const p = pair()
    p.net.hideFingerprintNext = true // the caller's own descriptions carry no fingerprint
    void p.a.chat.invite()
    await settle()
    void p.b.chat.acceptIncoming()
    await settle(300)
    expect(p.a.view.state).toBe('ended')
    expect(p.a.view.reason).toContain('certificate')
    expect(p.a.view.code).toBe('')
    expect(p.b.view.state).toBe('ended')
  })

  it('turns away offers beyond a dozen a minute, and takes them again later', async () => {
    const p = pair()
    await connect(p)
    const tiny = (n: string) => new File([new Uint8Array(10)], n)
    for (let i = 0; i < 20; i++) {
      const id = p.a.chat.offerFile(tiny('f' + i))!
      await settle(5)
      p.b.chat.declineFile(id) // keep the pending count low, so only the rate matters
    }
    await settle(50)
    expect(p.b.view.transfers.length).toBe(12)
    expect(p.a.view.transfers.filter((t) => t.state === 'declined').length).toBe(20)
    await settle(61_000)
    p.a.chat.offerFile(tiny('later'))
    await settle(50)
    expect(p.b.view.transfers.some((t) => t.name === 'later')).toBe(true)
  })

  it('keeps a file offer waiting when too many transfers are running', async () => {
    const p = pair()
    await connect(p)
    const big = (n: string) => new File([new Uint8Array(3_000_000)], n)
    const ids = [1, 2, 3, 4, 5].map((i) => p.a.chat.offerFile(big('f' + i))!)
    await settle()
    for (const id of ids.slice(0, 4)) p.b.chat.acceptFile(id)
    p.b.chat.acceptFile(ids[4]!)
    const fifth = p.b.view.transfers.find((t) => t.id === ids[4])!
    expect(fifth.state).toBe('offered')
    expect(fifth.error).toContain('wait')
    expect(p.a.view.transfers.find((t) => t.id === ids[4])!.state).toBe('waiting')
  })

  it('tells the caller when accepting fails, instead of leaving them to time out', async () => {
    const p = pair()
    void p.a.chat.invite()
    await settle()
    p.net.failNext = true
    void p.b.chat.acceptIncoming()
    await settle(100)
    expect(p.b.view.state).toBe('ended')
    expect(p.b.sent.at(-1)).toMatchObject({ payload: { t: 'reject' } })
    expect(p.a.view.reason).toBe('They declined.')
  })

  it('ends when the network connection fails', async () => {
    const p = pair()
    await connect(p)
    const pcs = [...p.net.byFingerprint.values()] as FakePC[]
    pcs[0]!.fail()
    await settle()
    expect(p.a.view.state).toBe('ended')
  })

  it('ends a bad answer', async () => {
    const p = pair()
    void p.a.chat.invite()
    await settle()
    // The answer's description cannot be applied.
    for (const pc of p.net.byFingerprint.values()) pc.rejectRemote = true
    void p.b.chat.acceptIncoming()
    await settle(100)
    expect(p.a.view.state).toBe('ended')
  })

  it('can be started again after it ended', async () => {
    const p = pair()
    await connect(p)
    p.a.chat.hangUp()
    await settle()
    await connect(p)
    expect(p.a.view.state).toBe('connected')
    expect(p.b.view.state).toBe('connected')
  })

  it('is not ended by the late close of a connection that was already hung up', async () => {
    const p = pair()
    await connect(p)
    p.a.chat.hangUp()
    // Straight away asks again, before the old connection has finished closing.
    void p.a.chat.invite()
    await settle(500)
    expect(p.b.view.state).toBe('incoming')
    expect(p.a.view.state).toBe('calling')
    void p.b.chat.acceptIncoming()
    await settle(500)
    expect(p.a.view.state).toBe('connected')
    expect(p.b.view.state).toBe('connected')
  })

  it('resolves two people calling each other at once in favour of exactly one', async () => {
    const p = pair()
    void p.a.chat.invite()
    void p.b.chat.invite()
    await settle(200)
    // One of them is now asked to accept; the other is calling.
    const states = [p.a.view.state, p.b.view.state].sort()
    expect(states).toEqual(['calling', 'incoming'])
    const callee = p.a.view.state === 'incoming' ? p.a : p.b
    void callee.chat.acceptIncoming()
    await settle(200)
    expect(p.a.view.state).toBe('connected')
    expect(p.b.view.state).toBe('connected')
  })

  it('refuses an offer while a chat is live, without disturbing it', async () => {
    const p = pair()
    await connect(p)
    p.a.chat.handleSignal('zzzzzz1', { t: 'offer', sdp: 'v=0' })
    await settle()
    expect(p.a.view.state).toBe('connected')
    expect(p.a.sent.at(-1)).toMatchObject({ sid: 'zzzzzz1', payload: { t: 'reject' } })
  })

  it('ignores malformed and stray signals', async () => {
    const p = pair()
    p.a.chat.handleSignal('abcdef', { t: 'answer', sdp: 'v=0' }) // nothing was offered
    p.a.chat.handleSignal('abcdef', { t: 'bye' })
    p.a.chat.handleSignal('abcdef', { t: 'reject' })
    p.a.chat.handleSignal('abcdef', { t: 'offer' }) // no sdp
    p.a.chat.handleSignal('!!', { t: 'offer', sdp: 'v=0' }) // bad id
    p.a.chat.handleSignal('abcdef', { t: 'weird' })
    expect(p.a.view).toBeUndefined()
  })

  it('does not let a stale answer or bye from another attempt affect a call', async () => {
    const p = pair()
    void p.a.chat.invite()
    await settle(0)
    p.a.chat.handleSignal('other123', { t: 'bye' })
    p.a.chat.handleSignal('other123', { t: 'reject' })
    p.a.chat.handleSignal('other123', { t: 'answer', sdp: 'v=0' })
    expect(p.a.view.state).toBe('calling')
  })
})

describe('DirectChat chat', () => {
  it('delivers lines both ways', async () => {
    const p = pair()
    await connect(p)
    expect(p.a.chat.sendChat('hello bob')).toBe(true)
    expect(p.b.chat.sendChat('hi alice')).toBe(true)
    await settle()
    expect(p.a.lines.map((l) => [l.text, l.self])).toEqual([
      ['hello bob', true],
      ['hi alice', false],
    ])
    expect(p.b.lines.map((l) => [l.text, l.self])).toEqual([
      ['hi alice', true],
      ['hello bob', false],
    ])
  })

  it('does not send when not connected, or when empty', async () => {
    const p = pair()
    expect(p.a.chat.sendChat('x')).toBe(false)
    await connect(p)
    expect(p.a.chat.sendChat('   ')).toBe(false)
  })
})

describe('DirectChat files', () => {
  const file = (n: number, name = 'a.bin', type = 'application/x-thing') => {
    const data = new Uint8Array(n)
    for (let i = 0; i < n; i++) data[i] = (i * 7) & 0xff
    return new File([data], name, { type })
  }

  it('sends a file once the other side accepts it, and both end up done', async () => {
    const p = pair()
    await connect(p)
    const f = file(200_000, 'notes.txt', 'text/plain')
    const id = p.a.chat.offerFile(f)!
    await settle()
    expect(p.b.view.transfers).toMatchObject([{ id, dir: 'in', name: 'notes.txt', size: 200_000, state: 'offered' }])
    expect(p.a.view.transfers[0]).toMatchObject({ state: 'waiting' })
    p.b.chat.acceptFile(id)
    await settle(500)
    expect(p.b.view.transfers[0]).toMatchObject({ state: 'done', done: 200_000 })
    expect(p.a.view.transfers[0]).toMatchObject({ state: 'done', done: 200_000 })
    const got = p.b.view.transfers[0]!.blob!
    expect(got.size).toBe(200_000)
    expect(p.b.view.transfers[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('sends nothing when the file is declined', async () => {
    const p = pair()
    await connect(p)
    const id = p.a.chat.offerFile(file(1000))!
    await settle()
    p.b.chat.declineFile(id)
    await settle()
    expect(p.a.view.transfers[0]!.state).toBe('declined')
    expect(p.b.view.transfers[0]!.state).toBe('declined')
    expect(p.b.view.transfers[0]!.blob).toBeUndefined()
  })

  it('lets the receiver cancel part-way', async () => {
    const p = pair()
    await connect(p)
    const id = p.a.chat.offerFile(file(3_000_000))!
    await settle()
    p.b.chat.acceptFile(id)
    await settle(15)
    p.b.chat.cancelTransfer(id)
    await settle(500)
    expect(p.b.view.transfers[0]!.state).toBe('cancelled')
    expect(['cancelled', 'failed']).toContain(p.a.view.transfers[0]!.state)
    expect(p.b.view.transfers[0]!.blob).toBeUndefined()
  })

  it('lets the sender cancel part-way', async () => {
    const p = pair()
    await connect(p)
    const id = p.a.chat.offerFile(file(3_000_000))!
    await settle()
    p.b.chat.acceptFile(id)
    await settle(15)
    p.a.chat.cancelTransfer(id)
    await settle(500)
    expect(p.a.view.transfers[0]!.state).toBe('cancelled')
    expect(p.b.view.transfers[0]!.state).toBe('cancelled')
  })

  it('refuses a file channel for a file nobody accepted', async () => {
    const p = pair()
    await connect(p)
    const id = p.a.chat.offerFile(file(1000))!
    await settle()
    // The sender opens a channel without waiting for acceptance.
    const pcs = [...p.net.byFingerprint.values()] as FakePC[]
    const ch = pcs[0]!.createDataChannel(`file:${id}`) as { readyState: string }
    await settle()
    expect(ch.readyState).toBe('closed')
    expect(p.b.view.transfers[0]!.state).toBe('offered')
  })

  it('refuses channels with unknown labels', async () => {
    const p = pair()
    await connect(p)
    const pcs = [...p.net.byFingerprint.values()] as FakePC[]
    const ch = pcs[0]!.createDataChannel('whatever') as { readyState: string }
    const ch2 = pcs[0]!.createDataChannel('file:nosuchfile') as { readyState: string }
    await settle()
    expect(ch.readyState).toBe('closed')
    expect(ch2.readyState).toBe('closed')
  })

  it('limits how many offers can wait for an answer', async () => {
    const p = pair()
    await connect(p)
    for (let i = 0; i < 12; i++) p.a.chat.offerFile(file(10, `f${i}`))
    await settle()
    expect(p.b.view.transfers.length).toBe(8)
    // The rest were turned down, which the sender sees.
    expect(p.a.view.transfers.filter((t) => t.state === 'declined').length).toBe(4)
  })

  it('fails running transfers when the chat ends', async () => {
    const p = pair()
    await connect(p)
    const id = p.a.chat.offerFile(file(3_000_000))!
    await settle()
    p.b.chat.acceptFile(id)
    await settle(10)
    p.b.chat.hangUp()
    await settle(100)
    expect(p.a.view.transfers[0]!.state).toBe('failed')
    // Closing it ourselves cancels it; the other side's transfer failed.
    expect(p.b.view.transfers[0]!.state).toBe('cancelled')
  })

  it('does not offer files while not connected', () => {
    const p = pair()
    expect(p.a.chat.offerFile(file(10))).toBeNull()
  })

  it('cleans file names from the other side', async () => {
    const p = pair()
    await connect(p)
    p.a.chat.offerFile(file(10, '../../evil.html'))
    await settle()
    // The sender's own list shows what they chose; the receiver's is sanitised.
    expect(p.b.view.transfers[0]!.name).toBe('evil.html')
  })

  it('clears finished transfers but keeps running ones', async () => {
    const p = pair()
    await connect(p)
    const id = p.a.chat.offerFile(file(100))!
    p.a.chat.offerFile(file(100))
    await settle()
    p.b.chat.declineFile(id)
    await settle()
    p.b.chat.clearFinished()
    expect(p.b.view.transfers.length).toBe(1)
    expect(p.b.view.transfers[0]!.state).toBe('offered')
  })
})
