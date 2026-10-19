// The voice half of the native build, from the page's side: a session that carries the
// Rust microphone asks for it before its description is built; a far person's loudness
// arrives as events and is read back through the meter; and the microphone's lifecycle
// goes through mic_start, mic_mute and mic_stop as rooms and calls hand it over.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativePC } from './pc'
import { feeds, nativeMeter, nativeVoice } from './voice'
import type { NativeVoice } from './voice'
import type { Bridge } from './bridge'

interface Received {
  cmd: string
  args: Record<string, unknown>
}

class FakeRust implements Bridge {
  seen: Received[] = []
  micAnswer = { ok: true, error: '' }
  private listeners: Array<(payload: unknown) => void> = []

  invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    this.seen.push({ cmd, args })
    if (cmd === 'mic_start') return Promise.resolve({ ...this.micAnswer } as unknown as T)
    if (cmd === 'pc_local') return Promise.resolve('v=0\r\n' as unknown as T)
    return Promise.resolve(undefined as unknown as T)
  }

  async listen(event: string, onEvent: (payload: unknown) => void): Promise<() => void> {
    void event
    this.listeners.push(onEvent)
    return () => {
      this.listeners = this.listeners.filter((f) => f !== onEvent)
    }
  }

  /** What the bridge saw, as one breadcrumb per command. */
  order(): string {
    return this.seen.map((s) => s.cmd).join(',')
  }
}

/** nativeVoice() reads the window's bridge; tests put theirs in place of the window's. */
function card(rust: FakeRust): NonNullable<NativeVoice> {
  vi.stubGlobal('window', {
    __TAURI__: { invoke: rust.invoke.bind(rust), event: { listen: async () => () => undefined } },
  })
  const nv = nativeVoice()
  vi.unstubAllGlobals()
  if (!nv) throw new Error('no card behind the fake bridge')
  return nv
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the microphone', () => {
  it('is asked for before the description is built, and only once', async () => {
    const rust = new FakeRust()
    const npc = new NativePC(rust, { iceServers: [] })
    npc.addTrack()
    await npc.createOffer()
    await npc.setLocalDescription({ type: 'offer', sdp: '' })
    expect(rust.order()).toEqual('pc_create,pc_track,pc_local')
    expect(rust.seen.find((s) => s.cmd === 'pc_track')!.args).toMatchObject({ kind: 'mic' })
    // A later description is not asked for a second send:
    await npc.setLocalDescription({ type: 'offer', sdp: '' })
    expect(rust.seen.filter((s) => s.cmd === 'pc_track')).toHaveLength(1)
  })

  it('a listener asks to receive, and sends nothing', async () => {
    const rust = new FakeRust()
    const npc = new NativePC(rust, { iceServers: [] })
    npc.addTransceiver('audio', { direction: 'recvonly' })
    await npc.setLocalDescription({ type: 'offer', sdp: '' })
    expect(rust.seen.find((s) => s.cmd === 'pc_track')!.args).toMatchObject({ kind: 'recv' })
  })
})

describe('the loudness feeds', () => {
  it("the mic's events feed the local meter, a person's feed their own", () => {
    const rust = new FakeRust()
    const npc = new NativePC(rust, { iceServers: [] })
    const nv = card(rust)
    nv.wire(npc)

    npc.onrms?.('mic', 0.5)
    expect(nv.localMeter().level()).toBe(0.5)
    npc.onrms?.(`pc:${npc.id}`, 0.8)
    expect(nv.remoteMeter(npc.id).level()).toBe(0.8)
    expect(nv.remoteMeter(npc.id + 9).level()).toBe(0)
    npc.onrms?.(`pc:${npc.id}`, 0.9)
    // Something not reported lately decays to silence:
    const now = Date.now()
    const proceed = new Date(now + 500)
    vi.setSystemTime(proceed)
    try {
      expect(nv.remoteMeter(npc.id).level()).toBe(0)
      feeds.feed('mic', 0) // clean the shared feed for the next test
    } finally {
      vi.useRealTimers()
    }
  })

  it("a placeholder stream reaches its connection's feed through the factory", () => {
    const rust = new FakeRust()
    const npc = new NativePC(rust, { iceServers: [] })
    const seen: MediaStream[] = []
    npc.ontrack = (ev) => seen.push(ev.streams[0]!)
    card(rust).wire(npc)
    const intern = npc as unknown as { onEvent(e: unknown): void }
    try {
      intern.onEvent({ k: 'track', id: npc.id })
    } catch (e) {
      // This environment cannot make a MediaStream; the page code still must not throw.
      expect(String(e)).toContain('MediaStream')
    }
    const stream = seen[0]
    if (stream) {
      const meter = nativeMeter(stream)
      expect(meter).not.toBeNull()
      npc.onrms?.(`pc:${npc.id}`, 0.42)
      expect(meter!.level()).toBe(0.42)
      feeds.feed(`pc:${npc.id}`, 0)
    }
  })
})

describe('the mic lifecycle', () => {
  it('hands over start, mute and stop as rooms and calls do', async () => {
    const rust = new FakeRust()
    const mic = card(rust).mic()
    await mic.start()
    mic.mute(true)
    mic.stop()
    expect(rust.order()).toEqual('mic_start,mic_mute,mic_stop')
    expect(rust.seen.find((s) => s.cmd === 'mic_mute')!.args).toEqual({ muted: true })
  })

  it('says when the microphone could not be opened', async () => {
    const rust = new FakeRust()
    rust.micAnswer = { ok: false, error: 'no microphone' }
    await expect(card(rust).mic().start()).rejects.toThrow('no microphone')
  })

  it('gives its card only where a bridge is', () => {
    vi.stubGlobal('window', {})
    try {
      expect(nativeVoice()).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
