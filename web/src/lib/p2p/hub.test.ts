import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatLine, ChatView } from './chat'
import { FakeNet } from './fakepc'
import { P2pHub } from './hub'
import { SIGNAL_TAG } from './signal'

interface Node {
  hub: P2pHub
  nick: string
  views: Map<string, ChatView>
  lines: Array<[string, ChatLine]>
  wire: Array<{ to: string; value: string }>
}

function network(nicks: string[], opts: { maxIncoming?: number; maxChats?: number } = {}) {
  const net = new FakeNet()
  const nodes = new Map<string, Node>()
  for (const nick of nicks) {
    const node: Node = { nick, views: new Map(), lines: [], wire: [], hub: undefined as unknown as P2pHub }
    node.hub = new P2pHub({
      ownNick: () => node.nick,
      iceServers: async () => [],
      createConnection: net.create,
      pace: 10,
      maxIncoming: opts.maxIncoming,
      maxChats: opts.maxChats,
      sendSignalLine: (peer, value) => {
        node.wire.push({ to: peer, value })
        // The network delivers it with the sender's nick.
        setTimeout(() => nodes.get(peer)?.hub.receive(node.nick, value), 1)
      },
      onView: (peer, v) => node.views.set(peer, v),
      onLine: (peer, l) => node.lines.push([peer, l]),
    })
    nodes.set(nick, node)
  }
  return { nodes, net }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const settle = (ms = 100) => vi.advanceTimersByTimeAsync(ms)

describe('P2pHub', () => {
  it('connects two people through signalling lines and carries chat', async () => {
    const { nodes } = network(['alice', 'bob'])
    const a = nodes.get('alice')!
    const b = nodes.get('bob')!
    void a.hub.chat('bob').invite()
    await settle()
    expect(b.views.get('alice')!.state).toBe('incoming')
    void b.hub.chat('alice').acceptIncoming()
    await settle(300)
    expect(a.views.get('bob')!.state).toBe('connected')
    expect(b.views.get('alice')!.state).toBe('connected')
    a.hub.chat('bob').sendChat('hi')
    await settle()
    expect(b.lines).toEqual([['alice', expect.objectContaining({ text: 'hi', self: false })]])
  })

  it('sends signalling to the right person, in small pieces, spaced out', async () => {
    const { nodes } = network(['alice', 'bob'])
    const a = nodes.get('alice')!
    void a.hub.chat('bob').invite()
    await settle(500)
    expect(a.wire.length).toBeGreaterThan(0)
    for (const w of a.wire) {
      expect(w.to).toBe('bob')
      expect(w.value.length).toBeLessThan(1900)
    }
  })

  it('ignores its own signalling echoed back, and malformed values', async () => {
    const { nodes } = network(['alice', 'bob'])
    const a = nodes.get('alice')!
    a.hub.receive('alice', 'abcdef.0.1.e30')
    a.hub.receive('bob', 'garbage')
    a.hub.receive('bob', '')
    expect(a.views.size).toBe(0)
    expect(a.hub.has('bob')).toBe(false)
  })

  it('does not start a chat from a reply, only from an offer', async () => {
    const { nodes } = network(['alice', 'bob'])
    const a = nodes.get('alice')!
    const payload = btoa(JSON.stringify({ k: 'chat', t: 'bye' })).replace(/=+$/, '')
    a.hub.receive('bob', `abcdef12.0.1.${payload}`)
    expect(a.hub.has('bob')).toBe(false)
  })

  it('ignores signalling meant for something else (another kind)', async () => {
    const { nodes } = network(['alice', 'bob'])
    const a = nodes.get('alice')!
    const payload = btoa(JSON.stringify({ k: 'voice', t: 'offer', sdp: 'x' })).replace(/=+$/, '')
    a.hub.receive('bob', `abcdef12.0.1.${payload}`)
    expect(a.hub.has('bob')).toBe(false)
  })

  it('limits how many strangers can have an unanswered request', async () => {
    const names = ['target', 's1', 's2', 's3', 's4']
    const { nodes } = network(names, { maxIncoming: 2 })
    for (const n of names.slice(1)) {
      // Each stranger sends to the target only.
      void nodes.get(n)!.hub.chat('target').invite()
    }
    await settle(500)
    const t = nodes.get('target')!
    expect([...t.views.values()].filter((v) => v.state === 'incoming').length).toBe(2)
  })

  it('closing a chat tells the other side and forgets it', async () => {
    const { nodes } = network(['alice', 'bob'])
    const a = nodes.get('alice')!
    const b = nodes.get('bob')!
    void a.hub.chat('bob').invite()
    await settle()
    void b.hub.chat('alice').acceptIncoming()
    await settle(300)
    a.hub.close('bob')
    await settle(300)
    expect(a.hub.has('bob')).toBe(false)
    expect(b.views.get('alice')!.state).toBe('ended')
  })

  it('forgets finished chats with nothing in them when there are too many', () => {
    const { nodes } = network(['a', 'b'], { maxChats: 1 })
    const a = nodes.get('a')!
    void a.hub.chat('x').invite()
    a.hub.chat('x').hangUp()
    a.hub.chat('y')
    expect(a.hub.has('x')).toBe(false)
    expect(a.hub.has('y')).toBe(true)
  })

  it('uses the tag name other clients can recognise', () => {
    expect(SIGNAL_TAG).toBe('+irc-webclient/p2p')
  })
})
