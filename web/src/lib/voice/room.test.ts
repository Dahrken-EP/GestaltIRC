import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeNet } from '../p2p/fakepc'
import { VoiceSlot } from './active'
import type { Meter } from './meter'
import { VoiceRoom, type RoomView } from './room'

const CHANNEL = '#lounge'

interface Member {
  nick: string
  room: VoiceRoom
  view: RoomView
  mic: FakeStream
  level: { value: number }
  presence: Array<{ target: string; value: string }>
  signals: Array<{ peer: string; payload: Record<string, unknown> }>
}

class FakeTrack {
  enabled = true
  stopped = false
  kind = 'audio'
  stop() {
    this.stopped = true
  }
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

/** A channel and a wire between people. Messages arrive a moment after they are sent. */
function lounge(nicks: string[], opts: { max?: number; micFails?: boolean; slot?: VoiceSlot; own?: boolean } = {}) {
  const net = new FakeNet()
  const members = new Map<string, Member>()
  const rooms = new Set<string>() // everyone in the channel
  for (const nick of nicks) {
    const m: Member = {
      nick, view: undefined as unknown as RoomView, mic: new FakeStream(), level: { value: 0 }, presence: [], signals: [],
      room: undefined as unknown as VoiceRoom,
    }
    m.room = new VoiceRoom({
      channel: CHANNEL,
      ownNick: () => nick,
      max: opts.max,
      // Each person is a different browser, so each has a slot of their own.
      slot: opts.slot ?? new VoiceSlot(),
      sendPresence: (target, value) => {
        m.presence.push({ target, value })
        const to = target === CHANNEL ? [...rooms].filter((n) => n !== nick) : [target]
        for (const n of to) setTimeout(() => members.get(n)?.room.handlePresence(nick, value), 1)
      },
      sendSignal: (peer, sid, payload) => {
        m.signals.push({ peer, payload: payload as Record<string, unknown> })
        setTimeout(() => members.get(peer)?.room.handleSignal(nick, sid, payload as never), 1)
      },
      iceServers: async () => [],
      getMedia: async () => {
        if (opts.micFails) throw new Error('permission denied')
        return m.mic as unknown as MediaStream
      },
      onChange: (v) => (m.view = v),
      createConnection: net.create,
      createMeter: (): Meter => ({ level: () => m.level.value, close() {} }),
      tickMs: 20,
    })
    members.set(nick, m)
    rooms.add(nick)
  }
  return { members, net, get: (n: string) => members.get(n)! }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
})
const settle = (ms = 300) => vi.advanceTimersByTimeAsync(ms)

async function joinAll(l: ReturnType<typeof lounge>, nicks: string[]) {
  for (const n of nicks) {
    void l.get(n).room.join()
    await settle()
  }
  await settle(500)
}

describe('VoiceRoom', () => {
  it('connects two people, sends audio each way, and shows each other', async () => {
    const l = lounge(['alice', 'bob'])
    await joinAll(l, ['alice', 'bob'])
    const a = l.get('alice').view
    const b = l.get('bob').view
    expect(a.state).toBe('active')
    expect(a.participants.map((p) => [p.nick, p.state])).toEqual([['bob', 'connected']])
    expect(b.participants.map((p) => [p.nick, p.state])).toEqual([['alice', 'connected']])
    expect(a.participants[0]!.stream).not.toBeNull()
    expect(a.participants[0]!.code).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){4}$/)
    expect(a.participants[0]!.code).toBe(b.participants[0]!.code)
  })

  it('announces itself on the channel, and each member answers the newcomer alone', async () => {
    const l = lounge(['alice', 'bob'])
    await joinAll(l, ['alice', 'bob'])
    expect(l.get('bob').presence[0]).toEqual({ target: CHANNEL, value: 'join' })
    expect(l.get('alice').presence).toContainEqual({ target: 'bob', value: `here:${CHANNEL}` })
  })

  it('lets the first nick make the offer, so nobody offers twice', async () => {
    const l = lounge(['alice', 'bob'])
    await joinAll(l, ['alice', 'bob'])
    const kinds = (m: Member) => m.signals.map((s) => s.payload.t)
    expect(kinds(l.get('alice'))).toEqual(['offer'])
    expect(kinds(l.get('bob'))).toEqual(['answer'])
  })

  it('builds a full mesh of three', async () => {
    const l = lounge(['alice', 'bob', 'carol'])
    await joinAll(l, ['alice', 'bob', 'carol'])
    for (const n of ['alice', 'bob', 'carol']) {
      const v = l.get(n).view
      expect(v.participants.length).toBe(2)
      expect(v.participants.every((p) => p.state === 'connected')).toBe(true)
    }
  })

  it('shows who is speaking, and stops after a pause', async () => {
    const l = lounge(['alice', 'bob'])
    await joinAll(l, ['alice', 'bob'])
    // The meter reads the stream bob receives; here every meter of a member reads its own level.
    l.get('alice').level.value = 0.5
    await settle(100)
    expect(l.get('alice').view.speaking).toBe(true)
    l.get('alice').level.value = 0
    await settle(1000)
    expect(l.get('alice').view.speaking).toBe(false)
  })

  it('mutes by switching the microphone off, without renegotiating', async () => {
    const l = lounge(['alice', 'bob'])
    await joinAll(l, ['alice', 'bob'])
    const before = l.get('alice').signals.length
    l.get('alice').room.setMuted(true)
    expect(l.get('alice').mic.tracks[0]!.enabled).toBe(false)
    expect(l.get('alice').view.muted).toBe(true)
    l.get('alice').room.setMuted(false)
    expect(l.get('alice').mic.tracks[0]!.enabled).toBe(true)
    expect(l.get('alice').signals.length).toBe(before)
  })

  it('sets one person\'s volume within 0 to 1', async () => {
    const l = lounge(['alice', 'bob'])
    await joinAll(l, ['alice', 'bob'])
    l.get('alice').room.setVolume('bob', 0.3)
    expect(l.get('alice').view.participants[0]!.volume).toBe(0.3)
    l.get('alice').room.setVolume('bob', 5)
    expect(l.get('alice').view.participants[0]!.volume).toBe(1)
    l.get('alice').room.setVolume('nobody', 0.1)
  })

  it('removes someone who leaves, and releases the microphone when we leave', async () => {
    const l = lounge(['alice', 'bob', 'carol'])
    await joinAll(l, ['alice', 'bob', 'carol'])
    l.get('carol').room.leave()
    await settle()
    expect(l.get('alice').view.participants.map((p) => p.nick)).toEqual(['bob'])
    expect(l.get('bob').view.participants.map((p) => p.nick)).toEqual(['alice'])
    expect(l.get('carol').view.state).toBe('idle')
    expect(l.get('carol').mic.tracks[0]!.stopped).toBe(true)
    expect(l.get('carol').view.participants).toEqual([])
  })

  it('drops someone who quit the network', async () => {
    const l = lounge(['alice', 'bob'])
    await joinAll(l, ['alice', 'bob'])
    l.get('alice').room.memberGone('Bob')
    expect(l.get('alice').view.participants).toEqual([])
  })

  it('can be rejoined after leaving', async () => {
    const l = lounge(['alice', 'bob'])
    await joinAll(l, ['alice', 'bob'])
    l.get('bob').room.leave()
    await settle()
    await joinAll(l, ['bob'])
    expect(l.get('alice').view.participants.map((p) => [p.nick, p.state])).toEqual([['bob', 'connected']])
    expect(l.get('bob').view.participants.map((p) => [p.nick, p.state])).toEqual([['alice', 'connected']])
  })

  it('starts over when someone joins again without having been seen to leave', async () => {
    const l = lounge(['alice', 'bob'])
    await joinAll(l, ['alice', 'bob'])
    // bob's page was reloaded and he is back, but alice never heard "leave".
    l.get('alice').room.handlePresence('bob', 'join')
    await settle(500)
    expect(l.get('alice').signals.filter((s) => s.payload.t === 'offer').length).toBe(2)
    expect(l.get('alice').view.participants.map((p) => [p.nick, p.state])).toEqual([['bob', 'connected']])
    expect(l.get('bob').view.participants.map((p) => [p.nick, p.state])).toEqual([['alice', 'connected']])
  })

  it('reports a refused microphone and does not join', async () => {
    const l = lounge(['alice'], { micFails: true })
    await l.get('alice').room.join()
    expect(l.get('alice').view.state).toBe('idle')
    expect(l.get('alice').view.error).toContain('microphone')
    expect(l.get('alice').presence).toEqual([])
  })

  it('does not join twice', async () => {
    const l = lounge(['alice'])
    void l.get('alice').room.join()
    void l.get('alice').room.join()
    await settle()
    expect(l.get('alice').presence.length).toBe(1)
  })

  it('stays out of the way until joined', async () => {
    const l = lounge(['alice', 'bob'])
    l.get('alice').room.handlePresence('bob', 'join')
    l.get('alice').room.handleSignal('bob', 'abcdef12', { k: 'voice', t: 'offer', room: CHANNEL, sdp: 'v=0' })
    await settle()
    expect(l.get('alice').presence).toEqual([])
    expect(l.get('alice').signals).toEqual([])
  })

  it('ignores junk presence and signals for another room', async () => {
    const l = lounge(['alice', 'bob'])
    await joinAll(l, ['alice'])
    const a = l.get('alice').room
    a.handlePresence('bob', 'garbage')
    a.handlePresence('bob', 'here:no spaces allowed')
    a.handlePresence('bob', 'here:#other')
    a.handleSignal('bob', 'abcdef12', { k: 'voice', t: 'offer', room: '#other', sdp: 'v=0' })
    a.handleSignal('bob', 'abcdef12', { k: 'voice', t: 'offer', sdp: 'v=0' })
    a.handleSignal('bob', 'abcdef12', { k: 'voice', t: 'offer', room: CHANNEL })
    await settle()
    expect(l.get('alice').view.participants).toEqual([])
  })

  it('ignores its own presence', async () => {
    const l = lounge(['alice'])
    await joinAll(l, ['alice'])
    l.get('alice').room.handlePresence('Alice', 'join')
    expect(l.get('alice').presence.length).toBe(1)
  })

  it('turns away an eleventh person, and the eleventh sees the room is full', async () => {
    const nicks = Array.from({ length: 11 }, (_, i) => `u${String(i).padStart(2, '0')}`)
    const l = lounge(nicks, { max: 10 })
    await joinAll(l, nicks.slice(0, 10))
    for (const n of nicks.slice(0, 10)) expect(l.get(n).view.participants.length).toBe(9)
    void l.get('u10').room.join()
    await settle(1000)
    const late = l.get('u10').view
    expect(late.state).toBe('idle')
    expect(late.error).toContain('full')
    // The ten are still connected to each other and nobody gained an eleventh.
    for (const n of nicks.slice(0, 10)) {
      const v = l.get(n).view
      expect(v.participants.length).toBe(9)
      expect(v.participants.every((p) => p.state === 'connected')).toBe(true)
    }
  })

  it('refuses an offer from a stranger when full, whatever the presence said', async () => {
    const l = lounge(['alice', 'bob', 'carol'], { max: 2 })
    await joinAll(l, ['alice', 'bob'])
    l.get('alice').room.handleSignal('carol', 'zzzzzz99', { k: 'voice', t: 'offer', room: CHANNEL, sdp: 'v=0' })
    await settle()
    expect(l.get('alice').view.participants.map((p) => p.nick)).toEqual(['bob'])
    expect(l.get('alice').signals.at(-1)).toMatchObject({ peer: 'carol', payload: { t: 'bye' } })
  })

  it('gives up on someone whose offer never comes', async () => {
    const l = lounge(['alice', 'bob'])
    await joinAll(l, ['bob'])
    // alice is the first nick, so she should offer; she never does.
    l.get('bob').room.handlePresence('alice', `here:${CHANNEL}`)
    await settle(31_000)
    expect(l.get('bob').view.participants.map((p) => [p.nick, p.state])).toEqual([['alice', 'failed']])
  })

  it('marks a connection that fails, and replaces it when they come back', async () => {
    const l = lounge(['alice', 'bob'])
    await joinAll(l, ['alice', 'bob'])
    const pcs = [...l.net.byFingerprint.values()]
    pcs[0]!.fail()
    await settle()
    expect(l.get('alice').view.participants[0]!.state).toBe('failed')
    l.get('alice').room.handlePresence('bob', `here:${CHANNEL}`)
    await settle(500)
    expect(l.get('alice').view.participants[0]!.state).toBe('connected')
  })

  it('only lets one voice chat at a time', async () => {
    const slot = new VoiceSlot()
    const l = lounge(['alice'], { slot })
    await joinAll(l, ['alice'])
    const l2 = lounge(['zed'], { slot })
    await l2.get('zed').room.join()
    expect(l2.get('zed').view.error).toContain('already in a voice chat')
    expect(l2.get('zed').view.state).toBe('idle')
    l.get('alice').room.leave()
    await l2.get('zed').room.join()
    expect(l2.get('zed').view.state).toBe('active')
  })

  it('drops a microphone prompt that finished after leaving', async () => {
    const l = lounge(['alice'])
    let resolve!: (s: MediaStream) => void
    const slow = new VoiceRoom({
      channel: CHANNEL, ownNick: () => 'alice', sendPresence: vi.fn(), sendSignal: vi.fn(), iceServers: async () => [],
      getMedia: () => new Promise<MediaStream>((r) => (resolve = r)), onChange: vi.fn(), slot: new VoiceSlot(), createMeter: () => ({ level: () => 0, close() {} }),
    })
    void l
    void slow.join()
    slow.leave()
    const mic = new FakeStream()
    resolve(mic as unknown as MediaStream)
    await settle()
    expect(slow.state).toBe('idle')
    expect(mic.tracks[0]!.stopped).toBe(true)
  })
})
