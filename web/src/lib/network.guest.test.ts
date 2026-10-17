import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRoster } from './guest/protocol'
import { GuestSession } from './guest/session.svelte'
import { parse } from './irc/message'
import { NetworkState, type NetworkHooks } from './network.svelte'
import { FakeNet } from './p2p/fakepc'
import { settings } from './settings.svelte'
import { VoiceSlot } from './voice/active'
import type { RoomMixer } from './voice/mixer'

class Mem {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
  removeItem(k: string) { this.data.delete(k) }
}

/** The bouncer's part, reduced to what the two ends can see of it. */
class Bouncer {
  host!: NetworkState
  guest: FakeGuestSocket | null = null
  fromHost(line: string) {
    const m = parse(line)
    if (m?.command === 'TAGMSG' && this.guest && m.params[0]?.toLowerCase() === this.guest.nick.toLowerCase()) {
      for (const [key, value] of Object.entries(m.tags)) this.guest.say({ t: 'tag', key, value })
    }
  }
}

let bouncer: Bouncer
let fake: FakeNet

class FakeGuestSocket {
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  nick = 'g-Sam'
  constructor(public url: string) {
    bouncer.guest = this
    queueMicrotask(() => this.onopen?.())
  }
  say(f: unknown) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(f) }), 1)
  }
  send(d: string) {
    const f = JSON.parse(d)
    if (f.t === 'hello') {
      this.nick = 'g-' + f.name
      this.say({ t: 'welcome', nick: this.nick, name: f.name, kind: 'direct', target: 'matt', host: 'matt', network: 'libera', resume: 'resume1', ice: [] })
      setTimeout(() => bouncer.host.handleMessage(parse(`@+gestalt/guest=join.inv123.${f.name} :${this.nick}!guest@guest.invalid TAGMSG matt`)!), 2)
    } else if (f.t === 'tag') {
      setTimeout(() => bouncer.host.handleMessage(parse(`@${f.key}=${f.value} :${this.nick}!guest@guest.invalid TAGMSG matt`)!), 1)
    } else if (f.t === 'bye') {
      setTimeout(() => bouncer.host.handleMessage(parse(`@+gestalt/guest=leave.inv123 :${this.nick}!guest@guest.invalid TAGMSG matt`)!), 1)
    }
  }
  close() {}
}

function host(over: Partial<NetworkHooks> = {}) {
  const sent: string[] = []
  const signals: string[] = []
  const net = new NetworkState('matt', 'matt/libera', 'matt', (line) => {
    sent.push(line)
    const signal = parse(line)?.tags['+gestalt/p2p']
    if (signal) signals.push(signal)
    bouncer.fromHost(line)
  }, { onMention: () => {}, iceServers: async () => [], createConnection: fake.create, ...over })
  net.nick = 'matt'
  net.viewing = true
  net.setCaps(new Set(['message-tags']))
  bouncer.host = net
  return { net, sent, signals }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('location', { protocol: 'http:', host: 'bouncer.test', pathname: '/guest/tok123456', origin: 'http://bouncer.test' })
  ;(globalThis as { localStorage?: unknown }).localStorage = new Mem()
  settings.keywords = []
  bouncer = new Bouncer()
  fake = new FakeNet()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const settle = (ms = 500) => vi.advanceTimersByTimeAsync(ms)

describe('a guest and the host', () => {
  it('joins by a link and chats with the host, who did not have to accept', async () => {
    const { net } = host()
    const guest = new GuestSession('tok123456', { Socket: FakeGuestSocket as never, createConnection: fake.create, storage: new Mem() })
    expect(guest.phase).toBe('name')
    guest.join('Sam')
    expect(guest.phase).toBe('joining')
    await settle()
    expect(guest.phase).toBe('joined')

    // The host knows who this is, and calls them by name.
    expect(net.isGuest('g-Sam')).toBe(true)
    expect(net.displayName('g-Sam')).toBe('Sam (guest)')
    const hostBuf = net.find('p2p:g-sam')!
    expect(hostBuf.title).toBe('Sam (guest)')
    await settle(1500)
    expect(hostBuf.p2p!.state).toBe('connected')
    const guestBuf = guest.net!.find('p2p:matt')!
    expect(guestBuf.p2p!.state).toBe('connected')

    // Lines go both ways, under the guest's name.
    guest.net!.submit('hello from a browser')
    await settle()
    expect(hostBuf.messages.map((m) => `${m.nick}: ${m.text}`)).toContain('Sam (guest): hello from a browser')
    net.select(hostBuf.key)
    net.submit('hi Sam')
    await settle()
    expect(guestBuf.messages.map((m) => m.text)).toContain('hi Sam')

    // Leaving is noticed.
    guest.leave()
    await settle()
    expect(net.isGuest('g-Sam')).toBe(false)
    expect(guest.phase).toBe('ended')
  })

  it('keeps the key to come back to a link that works once', async () => {
    host()
    const storage = new Mem()
    const guest = new GuestSession('tok123456', { Socket: FakeGuestSocket as never, createConnection: fake.create, storage })
    guest.join('Sam')
    await settle()
    expect(storage.getItem('guest-resume:tok123456')).toBe('resume1')
  })

  it('shows why it could not join and lets the guest try again', async () => {
    host()
    class Refusing extends FakeGuestSocket {
      send() {
        this.say({ t: 'error', reason: 'This link has already been used.' })
      }
    }
    const guest = new GuestSession('tok123456', { Socket: Refusing as never, storage: new Mem() })
    guest.join('Sam')
    await settle()
    expect(guest.phase).toBe('name')
    expect(guest.message).toBe('This link has already been used.')
    guest.join('   ')
    expect(guest.message).toBe('Enter a name to join with.')
  })

  it('ends when the host or the bouncer ends the link', async () => {
    host()
    const guest = new GuestSession('tok123456', { Socket: FakeGuestSocket as never, createConnection: fake.create, storage: new Mem() })
    guest.join('Sam')
    await settle()
    bouncer.guest!.say({ t: 'end', reason: 'The host left.' })
    await settle()
    expect(guest.phase).toBe('ended')
    expect(guest.message).toBe('The host left.')
  })

  it('does not believe a guest announcement from anyone but the bouncer', () => {
    const { net } = host()
    net.handleMessage(parse('@+gestalt/guest=join.inv123.Eve :bob!u@example.com TAGMSG matt')!)
    net.handleMessage(parse('@+gestalt/guest=join.inv123.Eve :bob!u@guest.invalid.example.com TAGMSG matt')!)
    expect(net.guests.size).toBe(0)
    net.handleMessage(parse('@+gestalt/guest=join.inv123.Eve :g-Eve!guest@guest.invalid TAGMSG matt')!)
    expect(net.isGuest('g-eve')).toBe(true)
  })

  it('does not take a stranger for a guest and accept their chat for them', async () => {
    const { net } = host()
    // A person on the network, not a guest, asks for a direct chat: the user is still asked.
    const other = new NetworkState('bob', 'bob/libera', 'bob', (line) => {
      const m = parse(line)
      if (m?.command === 'TAGMSG' && m.params[0] === 'matt') {
        const tags = Object.entries(m.tags).map(([k, v]) => `${k}=${v}`).join(';')
        setTimeout(() => net.handleMessage(parse(`@${tags} :bob!u@example.com TAGMSG matt`)!), 1)
      }
    }, { onMention: () => {}, iceServers: async () => [], createConnection: fake.create })
    other.nick = 'bob'
    other.setCaps(new Set(['message-tags']))
    other.openDirect('matt')
    await settle()
    expect(net.find('p2p:bob')!.p2p!.state).toBe('incoming')
  })
})

describe('reaching someone who may not use Gestalt', () => {
  it('sends a link when their client does not confirm the request', async () => {
    const guestLink = vi.fn().mockResolvedValue({ url: 'https://irc.example/guest/abcdef123456', id: 'inv999' })
    const { net, sent } = host({ guestLink })
    net.openDirect('bob')
    await settle(7000)
    expect(guestLink).not.toHaveBeenCalled()
    await settle(2000)
    expect(guestLink).toHaveBeenCalledWith({ network: 'libera', kind: 'direct', target: 'bob' })
    const msg = sent.find((l) => l.startsWith('PRIVMSG bob :'))!
    expect(msg).toContain('https://irc.example/guest/abcdef123456')
    expect(msg).toContain('works once')
    expect(net.find('p2p:bob')!.messages.map((m) => m.text).join('\n')).toContain('sent a one-time link')
  })

  it('does not send one when their client confirmed, even if they have not answered', async () => {
    const guestLink = vi.fn().mockResolvedValue({ url: 'https://irc.example/guest/abcdef123456', id: 'inv999' })
    const { net, signals } = host({ guestLink })
    net.openDirect('bob')
    await settle(100)
    // Their client says it has the request.
    const sid = signals[0]!.split('.')[0]!
    net.handleMessage(parse(`@+gestalt/p2p=${ackValue(sid)} :bob!u@h TAGMSG matt`)!)
    await settle(10_000)
    expect(net.find('p2p:bob')!.p2p!.acked).toBe(true)
    expect(guestLink).not.toHaveBeenCalled()
  })

  it('sends a link at once on a network that cannot carry the request, and only once in a while', async () => {
    const guestLink = vi.fn().mockResolvedValue({ url: 'https://irc.example/guest/abcdef123456', id: 'inv999' })
    const { net, sent } = host({ guestLink })
    net.setCaps(new Set())
    net.openDirect('bob')
    await settle(10)
    net.openDirect('bob')
    await settle(10)
    expect(sent.filter((l) => l.startsWith('PRIVMSG bob :')).length).toBe(1)
  })

  it('says so when guests are not allowed, instead of sending anything', async () => {
    const guestLink = vi.fn().mockResolvedValue(null)
    const { net, sent } = host({ guestLink })
    net.openDirect('bob')
    await settle(9000)
    expect(sent.some((l) => l.startsWith('PRIVMSG'))).toBe(false)
  })

  it('does nothing without the hook (guests are off for this account)', async () => {
    const { net, sent } = host()
    net.openDirect('bob')
    await settle(9000)
    expect(sent.some((l) => l.startsWith('PRIVMSG'))).toBe(false)
  })
})

function ackValue(sid: string): string {
  const payload = btoa(JSON.stringify({ k: 'chat', t: 'ack' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${sid}.0.1.${payload}`
}

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

const mixerStub = () =>
  ({
    outbound: new FakeStream(),
    setMic() {},
    setPeer() {},
    addGuest: () => new FakeStream(),
    setGuestSource() {},
    removeGuest() {},
    close() {},
  }) as unknown as RoomMixer

/** A host in #lounge with the voice machinery, and a place to read what it sent. */
function voiceHost(over: Partial<NetworkHooks> = {}) {
  const sent: string[] = []
  const net = new NetworkState('matt', 'matt/libera', 'matt', (line) => sent.push(line), {
    onMention: () => {},
    iceServers: async () => [],
    createConnection: fake.create,
    getMedia: async () => new FakeStream() as unknown as MediaStream,
    voiceSlot: new VoiceSlot(),
    mixer: mixerStub,
    ...over,
  })
  net.nick = 'matt'
  net.viewing = true
  net.setCaps(new Set(['message-tags']))
  net.handleMessage(parse(':matt!u@h JOIN #lounge')!)
  net.handleMessage(parse(':s 353 matt = #lounge :matt alice')!)
  net.handleMessage(parse(':s 366 matt #lounge :End')!)
  return { net, sent, buf: net.find('#lounge')! }
}

describe('a voice room link', () => {
  const made = { url: 'https://irc.example/guest/roomtoken123456', id: 'room42' }

  it('is made when the user joins voice, announced in the channel, and ended when they leave', async () => {
    const guestLink = vi.fn().mockResolvedValue(made)
    const guestRevoke = vi.fn()
    const { net, sent, buf } = voiceHost({ guestLink, guestRevoke })
    settings.announceVoice = true
    net.joinVoice(buf)
    await settle()
    expect(guestLink).toHaveBeenCalledWith({ network: 'libera', kind: 'room', target: '#lounge' })
    expect(buf.guestLink).toBe(made.url)
    const line = sent.find((l) => l.startsWith('PRIVMSG #lounge :\x01ACTION'))!
    expect(line).toContain('has entered voice chat')
    expect(line).toContain(made.url)
    net.leaveVoice(buf)
    await settle()
    expect(guestRevoke).toHaveBeenCalledWith('room42')
    expect(buf.guestLink).toBe('')
  })

  it('is kept quiet when the user does not want it announced, and not made for a listener', async () => {
    const guestLink = vi.fn().mockResolvedValue(made)
    const { net, sent, buf } = voiceHost({ guestLink })
    settings.announceVoice = false
    net.joinVoice(buf)
    await settle()
    expect(buf.guestLink).toBe(made.url)
    expect(sent.some((l) => l.includes('ACTION'))).toBe(false)
    net.leaveVoice(buf)
    await settle()
    settings.announceVoice = true
    guestLink.mockClear()
    net.joinVoice(buf, true)
    await settle()
    expect(guestLink).not.toHaveBeenCalled()
  })

  it('is ended at once if the user left while it was being made', async () => {
    let finish!: (v: typeof made) => void
    const guestLink = vi.fn().mockReturnValue(new Promise((r) => (finish = r)))
    const guestRevoke = vi.fn()
    const { net, buf } = voiceHost({ guestLink, guestRevoke })
    net.joinVoice(buf)
    await settle()
    net.leaveVoice(buf)
    finish(made)
    await settle()
    expect(guestRevoke).toHaveBeenCalledWith('room42')
    expect(buf.guestLink).toBe('')
  })

  it('does nothing when guests are not allowed', async () => {
    const { net, sent, buf } = voiceHost()
    net.joinVoice(buf)
    await settle()
    expect(buf.guestLink).toBe('')
    expect(sent.some((l) => l.includes('ACTION'))).toBe(false)
  })

  it('puts a guest who comes by it in the room, and tells them who is there', async () => {
    const invites = new Map([['room42', { kind: 'room' as const, target: '#lounge' }]])
    const { net, sent, buf } = voiceHost({ guestLink: vi.fn().mockResolvedValue(made), guestInvite: (id) => invites.get(id) })
    net.joinVoice(buf)
    await settle()
    net.handleMessage(parse('@+gestalt/guest=join.room42.Sam :g-Sam!guest@guest.invalid TAGMSG matt')!)
    await settle()
    expect(buf.voice!.participants.find((p) => p.guest)).toMatchObject({ label: 'Sam', guest: true })

    const roster = sent.filter((l) => l.includes('TAGMSG g-Sam') && l.includes('+gestalt/roster=')).at(-1)!
    const value = /\+gestalt\/roster=(\S+) TAGMSG/.exec(roster)![1]!
    expect(parseRoster(value)).toEqual(expect.arrayContaining([
      { name: 'matt', guest: false, host: true, speaking: false },
      { name: 'Sam', guest: true, host: false, speaking: false },
    ]))

    net.handleMessage(parse('@+gestalt/guest=leave.room42 :g-Sam!guest@guest.invalid TAGMSG matt')!)
    await settle()
    expect(buf.voice!.participants.some((p) => p.guest)).toBe(false)
  })

  it('says so when a guest cannot be put in the room, because the user is not in it', async () => {
    const invites = new Map([['room42', { kind: 'room' as const, target: '#lounge' }]])
    const { net, buf } = voiceHost({ guestInvite: (id) => invites.get(id) })
    net.handleMessage(parse('@+gestalt/guest=join.room42.Sam :g-Sam!guest@guest.invalid TAGMSG matt')!)
    await settle()
    expect(net.active.messages.map((m) => m.text).join('\n')).toContain('could not be put in the voice room')
    expect(buf.voice?.participants.some((p) => p.guest) ?? false).toBe(false)
  })
})
