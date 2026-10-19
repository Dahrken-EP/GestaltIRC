// A voice room in the desktop app takes guests: people who joined by a link, and talk to the room only through the
// host. Their audio is mixed in Rust (mix_pass in media.rs), so the page's part is to give each guest a native
// connection, in order, marked as a guest's.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { VoiceSlot } from '../voice/active'
import { VoiceRoom, type RoomView } from '../voice/room'
import type { Bridge } from './bridge'
import { NativePC } from './pc'
import { nativeVoice, type NativeVoice } from './voice'

interface Received {
  cmd: string
  args: Record<string, unknown>
}

class FakeRust implements Bridge {
  seen: Received[] = []
  invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    this.seen.push({ cmd, args })
    if (cmd === 'mic_start') return Promise.resolve({ ok: true, error: '' } as unknown as T)
    if (cmd === 'pc_local') return Promise.resolve('v=0\r\na=fingerprint:sha-256 ' + Array(32).fill('AA').join(':') + '\r\n' as unknown as T)
    return Promise.resolve(undefined as unknown as T)
  }
  async listen(): Promise<() => void> {
    return () => undefined
  }
}

function card(rust: FakeRust): NativeVoice {
  // The window is borrowed for a moment (not vi.unstubAllGlobals, which would also take the MediaStream stub away).
  const g = globalThis as { window?: unknown }
  const before = g.window
  g.window = { __TAURI__: { invoke: rust.invoke.bind(rust), event: { listen: async () => () => undefined } } }
  const nv = nativeVoice()
  if (before === undefined) delete g.window
  else g.window = before
  if (!nv) throw new Error('no card')
  return nv
}

// This test runs in Node, which has no MediaStream; the page makes an empty one as the marker of native audio.
beforeAll(() => {
  vi.stubGlobal('MediaStream', class {})
})

const later = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function host(rust: FakeRust, max?: number) {
  const signals: Array<{ peer: string; payload: Record<string, unknown> }> = []
  const natives: NativePC[] = []
  let view: RoomView | undefined
  const room = new VoiceRoom({
    channel: '#lounge',
    ownNick: () => 'matt',
    max,
    slot: new VoiceSlot(),
    sendPresence: () => {},
    sendSignal: (peer, _sid, payload) => signals.push({ peer, payload: payload as Record<string, unknown> }),
    iceServers: async () => [],
    getMedia: async () => {
      throw new Error('the page must not ask for a microphone in the desktop app')
    },
    onChange: (v) => (view = v),
    createConnection: (config) => {
      const pc = new NativePC(rust, config)
      natives.push(pc)
      return pc as unknown as RTCPeerConnection
    },
    nativeVoice: card(rust),
    tickMs: 20,
  })
  return { room, signals, natives, view: () => view! }
}

describe('guests in a voice room in the desktop app', () => {
  it('are taken, answered through a native connection of their own, and marked as a guest', async () => {
    const rust = new FakeRust()
    const h = host(rust)
    await h.room.join()
    expect(h.room.guestJoined('g-kim', 'Kim')).toBe(true)
    expect(h.view().participants.filter((p) => p.guest).map((p) => p.nick)).toEqual(['g-kim'])

    h.room.handleGuestSignal('g-kim', 'sid-1', { t: 'offer', sdp: 'v=0\r\n' } as never)
    await later()

    const cmds = rust.seen.filter((s) => !s.cmd.startsWith('mic_')).map((s) => s.cmd)
    // The connection exists, is marked as the guest's, then takes the audio and the offer, then answers.
    expect(cmds.slice(0, 5)).toEqual(['pc_create', 'pc_uplink', 'pc_track', 'pc_remote', 'pc_local'])
    expect(rust.seen.find((s) => s.cmd === 'pc_uplink')!.args).toMatchObject({ tag: 'guest:g-kim' })
    expect(h.signals.some((s) => s.peer === 'g-kim' && s.payload.t === 'answer')).toBe(true)
  })

  it('are refused when the room is full, like any other', async () => {
    const h = host(new FakeRust(), 2) // the host and one more
    await h.room.join()
    expect(h.room.guestJoined('g-a', 'A')).toBe(true)
    expect(h.room.guestJoined('g-b', 'B')).toBe(false)
  })

  it('are closed on the Rust side when they leave', async () => {
    const rust = new FakeRust()
    const h = host(rust)
    await h.room.join()
    h.room.guestJoined('g-kim', 'Kim')
    h.room.handleGuestSignal('g-kim', 'sid-1', { t: 'offer', sdp: 'v=0\r\n' } as never)
    await later()
    h.room.guestLeft('g-kim')
    await later()
    expect(rust.seen.some((s) => s.cmd === 'pc_close')).toBe(true)
    expect(h.view().participants.filter((p) => p.guest)).toHaveLength(0)
  })
})
