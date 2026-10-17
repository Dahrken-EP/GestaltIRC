import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeNet } from '../p2p/fakepc'
import { VoiceSlot } from './active'
import { VoiceCall, type CallView } from './call'
import type { Meter } from './meter'
import type { RoomMixer } from './mixer'
import { VoiceRoom, type RoomView } from './room'

const CHANNEL = '#lounge'

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

/** Records what the room asks of a mixer. */
function fakeMixer() {
  const calls: string[] = []
  const outbound = new FakeStream()
  const mixer = {
    outbound,
    setMic: (s: unknown) => calls.push(`mic:${s ? 'on' : 'off'}`),
    setPeer: (id: string, s: unknown) => calls.push(`peer:${id}:${s ? 'on' : 'off'}`),
    addGuest: (id: string) => (calls.push(`addGuest:${id}`), new FakeStream()),
    setGuestSource: (id: string, s: unknown) => calls.push(`guest:${id}:${s ? 'on' : 'off'}`),
    removeGuest: (id: string) => calls.push(`removeGuest:${id}`),
    close: () => calls.push('close'),
  }
  return { mixer: mixer as unknown as RoomMixer, calls, outbound }
}

interface Person {
  room: VoiceRoom
  view: RoomView
  presence: Array<{ target: string; value: string }>
}

/** A host with a mixer, other people in the channel, and a guest who rings the host as a call. */
function setup(opts: { max?: number; withMixer?: boolean } = {}) {
  const net = new FakeNet()
  const people = new Map<string, Person>()
  const inChannel = new Set<string>()
  const m = fakeMixer()
  const guestSignals: Array<{ sid: string; payload: Record<string, unknown> }> = []
  let guestView!: CallView
  const hostId = 'matt'

  for (const nick of ['matt', 'alice']) {
    const p: Person = { room: undefined as unknown as VoiceRoom, view: undefined as unknown as RoomView, presence: [] }
    p.room = new VoiceRoom({
      channel: CHANNEL,
      ownNick: () => nick,
      max: opts.max,
      slot: new VoiceSlot(),
      mixer: nick === hostId && opts.withMixer !== false ? () => m.mixer : undefined,
      sendPresence: (target, value) => {
        p.presence.push({ target, value })
        const to = target === CHANNEL ? [...inChannel].filter((n) => n !== nick) : [target]
        for (const n of to) setTimeout(() => people.get(n)?.room.handlePresence(nick, value), 1)
      },
      sendSignal: (peer, sid, payload) => {
        if (peer === 'g-Sam') setTimeout(() => guest.handleSignal(sid, payload as never), 1)
        else setTimeout(() => people.get(peer)?.room.handleSignal(nick, sid, payload as never), 1)
      },
      iceServers: async () => [],
      getMedia: async () => new FakeStream() as unknown as MediaStream,
      onChange: (v) => (p.view = v),
      createConnection: net.create,
      createMeter: (): Meter => ({ level: () => 0, close() {} }),
      tickMs: 20,
    })
    people.set(nick, p)
    inChannel.add(nick)
  }
  const host = people.get(hostId)!.room
  const guest = new VoiceCall({
    sendSignal: (sid, payload) => {
      guestSignals.push({ sid, payload: payload as Record<string, unknown> })
      setTimeout(() => host.handleGuestSignal('g-Sam', sid, payload as never), 1)
    },
    iceServers: async () => [],
    getMedia: async () => new FakeStream() as unknown as MediaStream,
    onChange: (v) => (guestView = v),
    wins: () => true,
    createConnection: net.create,
    createMeter: (): Meter => ({ level: () => 0, close() {} }),
    slot: new VoiceSlot(),
  })
  return { people, host, guest, m, net, guestSignals, guestView: () => guestView, alice: people.get('alice')! }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const settle = (ms = 400) => vi.advanceTimersByTimeAsync(ms)

async function bothInRoom(s: ReturnType<typeof setup>) {
  void s.host.join()
  await settle()
  void s.people.get('alice')!.room.join()
  await settle(600)
}

describe('a voice room with a guest', () => {
  it('takes a guest only when it is active, has a microphone and a mixer', async () => {
    const s = setup()
    expect(s.host.guestJoined('g-Sam', 'Sam')).toBe(false) // not in the room yet
    void s.host.join({ listenOnly: true })
    await settle()
    expect(s.host.guestJoined('g-Sam', 'Sam')).toBe(false) // cannot be heard, so cannot relay anyone
    s.host.leave()
    const none = setup({ withMixer: false })
    void none.host.join()
    await settle()
    expect(none.host.guestJoined('g-Sam', 'Sam')).toBe(false)
  })

  it('connects the guest, lists them for the host and for everyone else, and mixes them in', async () => {
    const s = setup()
    await bothInRoom(s)
    expect(s.host.guestJoined('g-Sam', 'Sam')).toBe(true)
    void s.guest.invite()
    await settle(600)

    expect(s.guestView().state).toBe('connected')
    const mine = s.people.get('matt')!.view.participants.find((p) => p.guest)!
    expect(mine).toMatchObject({ nick: 'g-Sam', label: 'Sam', guest: true, via: '', state: 'connected' })
    expect(mine.code).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){4}$/)
    expect(s.m.calls).toContain('addGuest:g-sam')
    expect(s.m.calls.some((c) => c.startsWith('guest:g-sam:on'))).toBe(true)
    expect(s.m.calls).toContain('mic:on')

    // Alice, who has no connection to Sam, still sees them, as brought by matt.
    const theirs = s.alice.view.participants.find((p) => p.guest)!
    expect(theirs).toMatchObject({ label: 'Sam', guest: true, via: 'matt', state: 'connected', stream: null })
    expect(s.people.get('matt')!.presence.some((p) => p.target === CHANNEL && p.value === 'guests:Sam')).toBe(true)
  })

  it('sends what it says to the mix from then on, for people it already had a connection with', async () => {
    const s = setup()
    await bothInRoom(s)
    s.host.guestJoined('g-Sam', 'Sam')
    // The microphone, once, and the mix for the connection to alice: nobody is sent a second microphone.
    expect(s.m.calls.filter((c) => c === 'mic:on').length).toBe(1)
    expect(s.m.calls).toContain('peer:alice:on')
  })

  it('tells someone who joins later who the guests are', async () => {
    const s = setup()
    void s.host.join()
    await settle()
    s.host.guestJoined('g-Sam', 'Sam')
    void s.people.get('alice')!.room.join()
    await settle(600)
    expect(s.people.get('matt')!.presence.some((p) => p.target === 'alice' && p.value === 'guests:Sam')).toBe(true)
    expect(s.alice.view.participants.some((p) => p.guest && p.label === 'Sam')).toBe(true)
  })

  it('forgets a guest who leaves, and says so', async () => {
    const s = setup()
    await bothInRoom(s)
    s.host.guestJoined('g-Sam', 'Sam')
    void s.guest.invite()
    await settle(600)
    s.host.guestLeft('g-Sam')
    await settle()
    expect(s.people.get('matt')!.view.participants.some((p) => p.guest)).toBe(false)
    expect(s.alice.view.participants.some((p) => p.guest)).toBe(false)
    expect(s.m.calls).toContain('removeGuest:g-sam')
    expect(s.people.get('matt')!.presence.at(-1)).toEqual({ target: CHANNEL, value: 'guests:' })
  })

  it('ends a guest who says goodbye, and ignores a goodbye for another attempt', async () => {
    const s = setup()
    await bothInRoom(s)
    s.host.guestJoined('g-Sam', 'Sam')
    void s.guest.invite()
    await settle(600)
    expect(s.host.handleGuestSignal('g-Sam', 'someotherid', { k: 'voice', t: 'bye' })).toBe(true)
    expect(s.host.guestNames).toEqual(['Sam'])
    s.guest.hangUp()
    await settle()
    expect(s.host.guestNames).toEqual([])
  })

  it('does not take signals from someone who is not a guest of the room', async () => {
    const s = setup()
    await bothInRoom(s)
    expect(s.host.handleGuestSignal('g-Nobody', 'abcdef123456', { k: 'voice', t: 'offer', sdp: 'x' })).toBe(false)
  })

  it('stops listing guests when their host leaves the room', async () => {
    const s = setup()
    await bothInRoom(s)
    s.host.guestJoined('g-Sam', 'Sam')
    await settle()
    expect(s.alice.view.participants.some((p) => p.guest)).toBe(true)
    s.host.leave()
    await settle()
    expect(s.alice.view.participants.some((p) => p.guest)).toBe(false)
    expect(s.m.calls).toContain('close')
  })

  it('counts guests against the size of the room', async () => {
    const s = setup({ max: 3 })
    await bothInRoom(s)
    expect(s.host.guestJoined('g-Sam', 'Sam')).toBe(true)
    expect(s.host.guestJoined('g-Pat', 'Pat')).toBe(false)
  })

  it('marks a guest who never connects as failed instead of waiting for ever', async () => {
    const s = setup()
    await bothInRoom(s)
    s.host.guestJoined('g-Sam', 'Sam')
    await settle(35_000)
    expect(s.people.get('matt')!.view.participants.find((p) => p.guest)!.state).toBe('failed')
  })
})
