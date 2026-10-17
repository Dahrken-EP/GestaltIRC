import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from './irc/message'
import { NetworkState, type NetworkHooks } from './network.svelte'
import { VoiceSlot } from './voice/active'
import { FakeNet } from './p2p/fakepc'
import { VOICE_TAG } from './voice/presence'
import { settings } from './settings.svelte'

class FakeTrack {
  enabled = true
  kind = 'audio'
  stop() {}
}
class FakeStream {
  tracks = [new FakeTrack()]
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks
  }
}

interface Node {
  net: NetworkState
  sent: string[]
  mentioned: string[]
}

/**
 * Networks joined by a wire. A TAGMSG to a channel goes to every other member; one to a nick goes
 * to that nick. Everyone is in #lounge.
 */
function lounge(nicks: string[]) {
  const fake = new FakeNet()
  const nodes: Record<string, Node> = {}
  for (const me of nicks) {
    const sent: string[] = []
    const mentioned: string[] = []
    const hooks: NetworkHooks = {
      onMention: (_n, _b, m) => void mentioned.push(m.text),
      iceServers: async () => [],
      createConnection: fake.create,
      getMedia: async () => new FakeStream() as unknown as MediaStream,
      // Each person is a separate browser.
      voiceSlot: new VoiceSlot(),
    }
    const net = new NetworkState(me, `${me}/net`, me, (line) => {
      sent.push(line)
      const m = parse(line)
      if (m?.command !== 'TAGMSG') return
      const tags = Object.entries(m.tags).map(([k, v]) => `${k}=${v}`).join(';')
      const target = m.params[0]!
      const to = target.startsWith('#') ? nicks.filter((n) => n !== me) : [target]
      for (const n of to) setTimeout(() => nodes[n]?.net.handleMessage(parse(`@${tags} :${me}!u@h TAGMSG ${target}`)!), 1)
    }, hooks)
    net.nick = me
    net.viewing = true
    net.setCaps(new Set(['message-tags', 'server-time']))
    net.handleMessage(parse(`:${me}!u@h JOIN #lounge`)!)
    net.handleMessage(parse(`:s 353 ${me} = #lounge :${nicks.join(' ')}`)!)
    net.handleMessage(parse(`:s 366 ${me} #lounge :End`)!)
    nodes[me] = { net, sent, mentioned }
  }
  return nodes
}

beforeEach(() => {
  vi.useFakeTimers()
  settings.keywords = []
})
afterEach(() => vi.useRealTimers())
const settle = (ms = 500) => vi.advanceTimersByTimeAsync(ms)

describe('voice in a network', () => {
  it('joins a channel room, and others see who is in it', async () => {
    const n = lounge(['alice', 'bob'])
    const a = n.alice!.net.find('#lounge')!
    const b = n.bob!.net.find('#lounge')!
    n.alice!.net.joinVoice(a)
    await settle()
    expect(b.voiceMembers).toEqual(['alice'])
    n.bob!.net.joinVoice(b)
    await settle(1500)
    expect(a.voice!.participants.map((p) => [p.nick, p.state])).toEqual([['bob', 'connected']])
    expect(b.voice!.participants.map((p) => [p.nick, p.state])).toEqual([['alice', 'connected']])
    expect(a.voiceMembers).toEqual(['bob'])
  })

  it('does not show voice signalling as a message or open a window', async () => {
    const n = lounge(['alice', 'bob'])
    n.alice!.net.joinVoice(n.alice!.net.find('#lounge')!)
    await settle()
    expect(n.bob!.net.buffers.map((b) => b.key)).toEqual(['', '#lounge'])
    expect(n.bob!.net.find('#lounge')!.messages.filter((m) => m.kind === 'msg')).toEqual([])
  })

  it('forgets a member who leaves, quits, or is kicked', async () => {
    const n = lounge(['alice', 'bob', 'carol'])
    const b = n.bob!.net.find('#lounge')!
    for (const who of ['alice', 'carol']) n[who]!.net.joinVoice(n[who]!.net.find('#lounge')!)
    await settle(1500)
    expect(b.voiceMembers.sort()).toEqual(['alice', 'carol'])
    n.alice!.net.leaveVoice(n.alice!.net.find('#lounge')!)
    await settle()
    expect(b.voiceMembers).toEqual(['carol'])
    n.bob!.net.handleMessage(parse(':carol!u@h QUIT :bye')!)
    expect(b.voiceMembers).toEqual([])
  })

  it('leaves the room when the channel is left', async () => {
    const n = lounge(['alice', 'bob'])
    const a = n.alice!.net.find('#lounge')!
    n.alice!.net.joinVoice(a)
    await settle()
    n.alice!.net.handleMessage(parse(':alice!u@h PART #lounge')!)
    await settle()
    expect(n.bob!.net.find('#lounge')!.voiceMembers).toEqual([])
  })

  it('needs message tags and a joined channel', async () => {
    const n = lounge(['alice'])
    const a = n.alice!.net.find('#lounge')!
    n.alice!.net.setCaps(new Set())
    n.alice!.net.joinVoice(a)
    await settle()
    expect(a.voice).toBeNull()
    n.alice!.net.submit('/voice')
    expect(n.alice!.net.active.messages.at(-1)).toBeDefined()
  })

  it('runs /voice and /voice leave from the channel window', async () => {
    const n = lounge(['alice', 'bob'])
    const a = n.alice!.net.find('#lounge')!
    n.alice!.net.select('#lounge')
    n.alice!.net.submit('/voice')
    await settle()
    expect(a.voice!.state).toBe('active')
    n.alice!.net.submit('/voice leave')
    await settle()
    expect(a.voice!.state).toBe('idle')
  })

  it('rings a person from a call command, and they answer in the direct window', async () => {
    const n = lounge(['alice', 'bob'])
    n.alice!.net.callNick('bob')
    await settle()
    const b = n.bob!.net.find('p2p:alice')!
    expect(b.call!.state).toBe('incoming')
    expect(n.bob!.mentioned).toContain('is calling you')
    void n.bob!.net.callFor('alice').accept()
    await settle(1500)
    expect(n.alice!.net.find('p2p:bob')!.call!.state).toBe('connected')
    expect(b.call!.state).toBe('connected')
  })

  it('ignores voice tags from ourselves and malformed ones', () => {
    const n = lounge(['alice', 'bob'])
    const a = n.alice!.net.find('#lounge')!
    n.alice!.net.handleMessage(parse(`@${VOICE_TAG}=join :alice!u@h TAGMSG #lounge`)!)
    n.alice!.net.handleMessage(parse(`@${VOICE_TAG}=nonsense :bob!u@h TAGMSG #lounge`)!)
    n.alice!.net.handleMessage(parse(`@${VOICE_TAG}=join :bob!u@h TAGMSG #unknown`)!)
    expect(a.voiceMembers).toEqual([])
  })

  it('does not answer an offer from someone who is not in the channel', async () => {
    const n = lounge(['alice', 'bob'])
    const a = n.alice!.net.find('#lounge')!
    n.alice!.net.joinVoice(a)
    await settle()
    const sentBefore = n.alice!.sent.length
    // mallory is not in #lounge, and sends an offer for its room and a private "here".
    const offer = btoa(JSON.stringify({ k: 'voice', t: 'offer', room: '#lounge', sdp: 'v=0' })).replace(/=+$/, '')
    n.alice!.net.handleMessage(parse(`@+gestalt/p2p=abcdef12.0.1.${offer} :mallory!u@h TAGMSG alice`)!)
    n.alice!.net.handleMessage(parse(`@${VOICE_TAG}=here:#lounge :mallory!u@h TAGMSG alice`)!)
    await settle()
    expect(a.voice!.participants).toEqual([])
    expect(n.alice!.sent.length).toBe(sentBefore)
  })

  it('limits how many strangers can be ringing at once', async () => {
    const n = lounge(['alice'])
    const offer = btoa(JSON.stringify({ k: 'voice', t: 'offer', sdp: 'v=0' })).replace(/=+$/, '')
    for (let i = 0; i < 12; i++) {
      n.alice!.net.handleMessage(parse(`@+gestalt/p2p=zz${String(i).padStart(2, '0')}abcd.0.1.${offer} :stranger${i}!u@h TAGMSG alice`)!)
    }
    await settle(2000)
    expect(n.alice!.net.buffers.filter((b) => b.kind === 'p2p').length).toBe(8)
  })

  it('keeps a participant who changes nick, and shows the new name', async () => {
    const n = lounge(['alice', 'bob'])
    for (const w of ['alice', 'bob']) n[w]!.net.joinVoice(n[w]!.net.find('#lounge')!)
    await settle(1500)
    const a = n.alice!.net.find('#lounge')!
    n.alice!.net.handleMessage(parse(':bob!u@h NICK bobby')!)
    expect(a.voice!.participants.map((p) => p.nick)).toEqual(['bobby'])
    expect(a.voiceMembers).toEqual(['bobby'])
  })

  it('announces itself again when the connection to the bouncer comes back', async () => {
    const n = lounge(['alice', 'bob'])
    n.alice!.net.joinVoice(n.alice!.net.find('#lounge')!)
    await settle()
    n.alice!.sent.length = 0
    n.alice!.net.connectionLost()
    n.alice!.net.setCaps(new Set(['message-tags']))
    expect(n.alice!.sent.some((l) => l.includes(`${VOICE_TAG}=hello`))).toBe(true)
  })

  it('says why a call or direct chat cannot start', () => {
    const n = lounge(['alice'])
    n.alice!.net.callNick('#lounge')
    expect(n.alice!.net.active.messages.at(-1)!.text).toContain('not a nick')
    n.alice!.net.setCaps(new Set())
    n.alice!.net.callNick('bob')
    expect(n.alice!.net.active.messages.at(-1)!.text).toContain('call needs')
  })
})
