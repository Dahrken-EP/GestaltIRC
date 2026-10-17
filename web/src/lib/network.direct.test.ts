import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from './irc/message'
import { NetworkState, type NetworkHooks } from './network.svelte'
import { FakeNet } from './p2p/fakepc'
import { SIGNAL_TAG } from './p2p/signal'
import { settings } from './settings.svelte'

interface Node {
  net: NetworkState
  sent: string[]
  mentioned: string[]
}

/** Two networks joined by a wire that delivers each TAGMSG to the other with the sender's nick. */
function pair() {
  const fake = new FakeNet()
  const nodes: Record<string, Node> = {}
  for (const [me, other] of [
    ['alice', 'bob'],
    ['bob', 'alice'],
  ] as const) {
    const sent: string[] = []
    const mentioned: string[] = []
    const hooks: NetworkHooks = {
      onMention: (_n, _b, m) => void mentioned.push(m.text),
      iceServers: async () => [],
      createConnection: fake.create,
    }
    const net = new NetworkState(me, `${me}/net`, me, (line) => {
      sent.push(line)
      const parsed = parse(line)
      if (parsed?.command === 'TAGMSG' && parsed.params[0]?.toLowerCase() === other) {
        const tags = Object.entries(parsed.tags).map(([k, v]) => `${k}=${v}`).join(';')
        setTimeout(() => nodes[other]!.net.handleMessage(parse(`@${tags} :${me}!u@h TAGMSG ${other}`)!), 1)
      }
    }, hooks)
    net.nick = me
    net.viewing = true
    net.setCaps(new Set(['message-tags', 'server-time', 'draft/read-marker']))
    nodes[me] = { net, sent, mentioned }
  }
  return { alice: nodes.alice!, bob: nodes.bob!, fake }
}

beforeEach(() => {
  vi.useFakeTimers()
  settings.keywords = []
  settings.sendTyping = true
})
afterEach(() => vi.useRealTimers())
const settle = (ms = 400) => vi.advanceTimersByTimeAsync(ms)

describe('direct chats in a network', () => {
  it('opens a direct buffer apart from a query with the same name', () => {
    const { alice } = pair()
    alice.net.openQuery('bob')
    alice.net.openDirect('bob')
    expect(alice.net.buffers.map((b) => [b.kind, b.key])).toEqual([
      ['status', ''],
      ['query', 'bob'],
      ['p2p', 'p2p:bob'],
    ])
    expect(alice.net.activeKey).toBe('p2p:bob')
  })

  it('connects, asks the other user first, and carries lines both ways', async () => {
    const { alice, bob } = pair()
    alice.net.openDirect('bob')
    await settle()
    const b = bob.net.find('p2p:alice')!
    expect(b.p2p!.state).toBe('incoming')
    expect(bob.mentioned).toEqual(['wants to start a direct chat'])
    expect(b.unread).toBe(1)

    void bob.net.directChat(b).acceptIncoming()
    await settle()
    const a = alice.net.find('p2p:bob')!
    expect(a.p2p!.state).toBe('connected')
    expect(b.p2p!.state).toBe('connected')

    alice.net.submit('hello there')
    await settle(50)
    const text = (buf: typeof a) => buf.messages.filter((m) => m.kind === 'msg').map((m) => [m.nick, m.text, m.self])
    expect(text(a)).toEqual([['alice', 'hello there', true]])
    expect(text(b)).toEqual([['alice', 'hello there', false]])
    // None of it went to the IRC network as a message.
    expect(alice.sent.some((l) => l.includes('PRIVMSG'))).toBe(false)
  })

  it('does not treat signalling as a message, a query or a typing notice', async () => {
    const { alice, bob } = pair()
    alice.net.openDirect('bob')
    await settle()
    expect(bob.net.find('alice')).toBeUndefined()
    expect(bob.net.buffers.map((b) => b.kind).sort()).toEqual(['p2p', 'status'])
  })

  it('ignores signalling sent to a channel, or from ourselves', () => {
    const { bob } = pair()
    const v = 'abcdef12.0.1.' + btoa(JSON.stringify({ k: 'chat', t: 'offer', sdp: 'v=0' })).replace(/=+$/, '')
    bob.net.handleMessage(parse(`@${SIGNAL_TAG}=${v} :alice!u@h TAGMSG #chan`)!)
    bob.net.handleMessage(parse(`@${SIGNAL_TAG}=${v} :bob!u@h TAGMSG alice`)!)
    expect(bob.net.buffers.length).toBe(1)
  })

  it('sends no read markers, typing notices or history requests for a direct chat', async () => {
    const { alice } = pair()
    alice.net.openDirect('bob')
    const buf = alice.net.find('p2p:bob')!
    alice.sent.length = 0
    alice.net.markActiveRead()
    alice.net.sendTyping(buf, 'active')
    alice.net.loadOlder(buf)
    await settle(2000)
    expect(alice.sent.filter((l) => /MARKREAD|CHATHISTORY|typing/.test(l))).toEqual([])
  })

  it('does not accept commands in a direct chat', async () => {
    const { alice } = pair()
    alice.net.openDirect('bob')
    alice.sent.length = 0
    alice.net.submit('/quit')
    expect(alice.sent).toEqual([])
    expect(alice.net.active.messages.at(-1)).toMatchObject({ kind: 'error' })
  })

  it('removes the buffer and ends the chat when it is closed', async () => {
    const { alice, bob } = pair()
    alice.net.openDirect('bob')
    await settle()
    void bob.net.directChat(bob.net.find('p2p:alice')!).acceptIncoming()
    await settle()
    alice.net.closeBuffer(alice.net.find('p2p:bob')!)
    await settle()
    expect(alice.net.find('p2p:bob')).toBeUndefined()
    expect(bob.net.find('p2p:alice')!.p2p!.state).toBe('ended')
  })

  it.each(['#chan', 'two words', 'a:b', '', 'x'.repeat(100)])('refuses to send an offer to %j, which is not a nick', async (target) => {
    const { alice } = pair()
    alice.sent.length = 0
    alice.net.openDirect(target)
    await settle()
    expect(alice.sent).toEqual([])
    expect(alice.net.buffers.some((b) => b.kind === 'p2p')).toBe(false)
    expect(alice.net.active.messages.at(-1)).toMatchObject({ kind: 'error' })
  })

  it('refuses a direct chat with yourself, or on a network without message tags', async () => {
    const { alice } = pair()
    alice.net.openDirect('alice')
    expect(alice.net.active.messages.at(-1)!.text).toContain('yourself')
    alice.net.setCaps(new Set(['server-time']))
    alice.net.openDirect('bob')
    expect(alice.net.active.messages.at(-1)!.text).toContain('message tags')
    expect(alice.net.buffers.some((b) => b.kind === 'p2p')).toBe(false)
    await settle()
    expect(alice.sent).toEqual([])
  })

  it('opens from the /direct command', () => {
    const { alice } = pair()
    alice.net.submit('/direct bob')
    expect(alice.net.find('p2p:bob')).toBeDefined()
    alice.net.submit('/direct')
    expect(alice.net.active.messages.at(-1)).toMatchObject({ kind: 'error' })
  })
})
