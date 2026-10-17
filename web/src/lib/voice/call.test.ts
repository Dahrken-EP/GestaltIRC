import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeNet } from '../p2p/fakepc'
import { VoiceSlot } from './active'
import { VoiceCall, type CallView } from './call'

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

interface Side {
  call: VoiceCall
  view: CallView
  mic: FakeStream
  mics: number
  sent: Array<Record<string, unknown>>
  history: CallView[]
  level: { value: number }
}

function pair(opts: { micFails?: boolean; micFailsB?: boolean; slotA?: VoiceSlot; slotB?: VoiceSlot } = {}) {
  const net = new FakeNet()
  const make = (name: string, other: () => Side, wins: boolean, slot?: VoiceSlot): Side => {
    const side: Side = { call: undefined as unknown as VoiceCall, view: undefined as unknown as CallView, mic: new FakeStream(), mics: 0, sent: [], history: [], level: { value: 0 } }
    side.call = new VoiceCall({
      wins: () => wins,
      slot: slot ?? new VoiceSlot(),
      sendSignal: (sid, payload) => {
        side.sent.push(payload as Record<string, unknown>)
        setTimeout(() => other().call.handleSignal(sid, payload as never), 1)
      },
      iceServers: async () => [],
      getMedia: async () => {
        side.mics++
        if (opts.micFails || (opts.micFailsB && name === 'alice')) throw new Error('denied')
        return side.mic as unknown as MediaStream
      },
      onChange: (v) => {
        side.view = v
        side.history.push(v)
      },
      createConnection: net.create,
      createMeter: () => ({ level: () => side.level.value, close() {} }),
      ringMs: 5000,
      tickMs: 20,
    })
    return side
  }
  const a: Side = make('bob', () => b, true, opts.slotA)
  const b: Side = make('alice', () => a, false, opts.slotB)
  return { a, b, net }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const settle = (ms = 300) => vi.advanceTimersByTimeAsync(ms)

async function connect(p: ReturnType<typeof pair>) {
  void p.a.call.invite()
  await settle()
  expect(p.b.view.state).toBe('incoming')
  void p.b.call.accept()
  await settle(500)
}

describe('VoiceCall', () => {
  it('rings, connects on accept, and shows the same safety code on both ends', async () => {
    const p = pair()
    await connect(p)
    expect(p.a.view.state).toBe('connected')
    expect(p.b.view.state).toBe('connected')
    expect(p.a.view.code).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){4}$/)
    expect(p.a.view.code).toBe(p.b.view.code)
    expect(p.a.view.remote).not.toBeNull()
    expect(p.b.view.remote).not.toBeNull()
  })

  it('asks for no microphone and makes no connection until the callee accepts', async () => {
    const p = pair()
    void p.a.call.invite()
    await settle()
    expect(p.b.view.state).toBe('incoming')
    expect(p.b.mics).toBe(0)
    expect(p.net.configs.length).toBe(1)
    void p.b.call.accept()
    await settle(500)
    expect(p.b.mics).toBe(1)
    expect(p.net.configs.length).toBe(2)
  })

  it('tells the caller about a decline', async () => {
    const p = pair()
    void p.a.call.invite()
    await settle()
    p.b.call.decline()
    await settle()
    expect(p.a.view).toMatchObject({ state: 'ended', reason: 'They declined.' })
    expect(p.b.view.state).toBe('idle')
    expect(p.b.mics).toBe(0)
    expect(p.a.mic.tracks[0]!.stopped).toBe(true)
  })

  it('stops ringing when nobody answers, on both ends', async () => {
    const p = pair()
    void p.a.call.invite()
    await settle()
    await settle(5100)
    expect(p.a.view).toMatchObject({ state: 'ended', reason: 'No answer.' })
    expect(p.b.view.state).toBe('ended')
    expect(p.a.mic.tracks[0]!.stopped).toBe(true)
  })

  it('ends for both when either hangs up, and lets go of the microphone', async () => {
    const p = pair()
    await connect(p)
    p.b.call.hangUp()
    await settle()
    expect(p.b.view.state).toBe('ended')
    expect(p.a.view).toMatchObject({ state: 'ended', reason: 'They ended the call.' })
    expect(p.a.mic.tracks[0]!.stopped).toBe(true)
    expect(p.b.mic.tracks[0]!.stopped).toBe(true)
  })

  it('reports a refused microphone and tells the other side nothing', async () => {
    const p = pair({ micFails: true })
    await p.a.call.invite()
    expect(p.a.view.state).toBe('ended')
    expect(p.a.view.reason).toContain('denied')
    await settle()
    expect(p.b.view).toBeUndefined()
    expect(p.a.sent).toEqual([])
  })

  it('mutes without renegotiating and sets volume within range', async () => {
    const p = pair()
    await connect(p)
    const n = p.a.sent.length
    p.a.call.setMuted(true)
    expect(p.a.mic.tracks[0]!.enabled).toBe(false)
    p.a.call.setMuted(false)
    expect(p.a.mic.tracks[0]!.enabled).toBe(true)
    p.a.call.setVolume(7)
    expect(p.a.view.volume).toBe(1)
    p.a.call.setVolume(-1)
    expect(p.a.view.volume).toBe(0)
    expect(p.a.sent.length).toBe(n)
  })

  it('shows who is speaking', async () => {
    const p = pair()
    await connect(p)
    p.a.level.value = 0.5
    await settle(100)
    expect(p.a.view.speaking).toBe(true)
    expect(p.a.view.remoteSpeaking).toBe(true) // the fake meter reads the same level for both streams
    p.a.level.value = 0
    await settle(1000)
    expect(p.a.view.speaking).toBe(false)
  })

  it('does not ring the user when already in another voice chat', async () => {
    const slot = new VoiceSlot()
    slot.claim({})
    const p = pair({ slotB: slot })
    void p.a.call.invite()
    await settle()
    expect(p.b.view).toBeUndefined()
    expect(p.a.view).toMatchObject({ state: 'ended', reason: 'They declined.' })
  })

  it('will not place a call while in another voice chat', async () => {
    const slot = new VoiceSlot()
    slot.claim({})
    const p = pair({ slotA: slot })
    await p.a.call.invite()
    expect(p.a.view.state).toBe('ended')
    expect(p.a.view.reason).toContain('already in a voice chat')
    expect(p.a.mics).toBe(0)
  })

  it('settles two people calling each other at once', async () => {
    const p = pair()
    void p.a.call.invite()
    void p.b.call.invite()
    await settle(300)
    expect([p.a.view.state, p.b.view.state].sort()).toEqual(['calling', 'incoming'])
    const callee = p.a.view.state === 'incoming' ? p.a : p.b
    void callee.call.accept()
    await settle(600)
    expect(p.a.view.state).toBe('connected')
    expect(p.b.view.state).toBe('connected')
  })

  it('can call again after it ended, and a late close does not end the new call', async () => {
    const p = pair()
    await connect(p)
    p.a.call.hangUp()
    await settle(10)
    void p.a.call.invite()
    await settle(300)
    void p.b.call.accept()
    await settle(800)
    expect(p.a.view.state).toBe('connected')
    expect(p.b.view.state).toBe('connected')
  })

  it('tells the other side and lets go of everything when the window is closed mid-call', async () => {
    const p = pair()
    await connect(p)
    p.b.call.dispose()
    await settle()
    expect(p.a.view).toMatchObject({ state: 'ended', reason: 'They ended the call.' })
    expect(p.b.mic.tracks[0]!.stopped).toBe(true)
  })

  it('does not come alive when the window is closed while the microphone prompt is open', async () => {
    let grant!: (s: MediaStream) => void
    const mic = new FakeStream()
    const sent: unknown[] = []
    const changes: string[] = []
    const call = new VoiceCall({
      wins: () => true, slot: new VoiceSlot(), sendSignal: (_s, payload) => void sent.push(payload),
      iceServers: async () => [], getMedia: () => new Promise<MediaStream>((r) => (grant = r)),
      onChange: (v) => void changes.push(v.state), createMeter: () => ({ level: () => 0, close() {} }),
    })
    void call.invite()
    call.dispose()
    const before = changes.length
    sent.length = 0
    grant(mic as unknown as MediaStream)
    await settle()
    expect(mic.tracks[0]!.stopped).toBe(true)
    expect(sent).toEqual([])
    expect(changes.length).toBe(before)
    expect(call.state).toBe('idle')
  })

  it('records one ending, with the real reason, when the other side hangs up', async () => {
    const p = pair()
    await connect(p)
    p.b.call.hangUp()
    await settle()
    // Closing the connection reports back; that must not add a second, wrong ending.
    expect(p.a.history.filter((v) => v.state === 'ended').map((v) => v.reason)).toEqual(['They ended the call.'])
    expect(p.b.history.filter((v) => v.state === 'ended').map((v) => v.reason)).toEqual(['You ended the call.'])
  })

  it('tells the caller when the callee cannot take the call', async () => {
    const p = pair({ micFailsB: true })
    void p.a.call.invite()
    await settle()
    void p.b.call.accept()
    await settle()
    expect(p.b.view.state).toBe('ended')
    expect(p.a.view).toMatchObject({ state: 'ended', reason: 'They declined.' })
  })

  it('ignores a room\'s messages and junk', async () => {
    const p = pair()
    p.a.call.handleSignal('abcdef12', { k: 'voice', t: 'offer', room: '#chat', sdp: 'v=0' })
    p.a.call.handleSignal('abcdef12', { k: 'voice', t: 'offer' })
    p.a.call.handleSignal('!!', { k: 'voice', t: 'offer', sdp: 'v=0' })
    p.a.call.handleSignal('abcdef12', { k: 'voice', t: 'bye' })
    p.a.call.handleSignal('abcdef12', { k: 'voice', t: 'answer', sdp: 'v=0' })
    expect(p.a.view).toBeUndefined()
  })
})
