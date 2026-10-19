// The native connection against a scripted stand-in for the Rust bridge. The
// script follows what media.rs does: pc_local answers with one ready-made
// description, state and channel events arrive on the one `media` channel, a
// locally opened channel also gets its own dc-open back, and a send comes back
// as a message on the same channel.

import { describe, expect, it, vi } from 'vitest'
import { tauriBridge } from './bridge'
import { BridgeChannel, nativeConnection, NativePC, probeMedia } from './pc'
import { fingerprintOf, PeerSession, safetyCode } from '../p2p/peer'
import type { Bridge } from './bridge'

interface Received {
  cmd: string
  args: Record<string, unknown>
}

interface EventSpec {
  k: string
  id?: number
  state?: string
  label?: string
  text?: string
  b64?: string
}

/** Answers commands the way media.rs does and records what the page asked. */
class FakeRust implements Bridge {
  seen: Received[] = []
  private listeners: Array<(payload: unknown) => void> = []
  /** What pc_local returns for each kind. */
  sdp = new Map<string, string>()
  /** The name of the command that should fail, if any. */
  failCmd: string | null = null

  emit(e: EventSpec): void {
    for (const fn of [...this.listeners]) fn(e)
  }

  invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    if ('id' in args) expect(args.id).toBeTypeOf('number')
    this.seen.push({ cmd, args })
    if (this.failCmd === cmd) return Promise.reject(new Error(`no ${cmd}`))
    switch (cmd) {
      case 'native_media':
        return Promise.resolve({ available: true, mic: true, output: true, error: '' } as T)
      case 'pc_local':
        return Promise.resolve((this.sdp.get(args.kind as string) ?? '') as T)
      case 'pc_send': {
        const text = (args.text as string | undefined) ?? ''
        const b64 = (args.b64 as string | undefined) ?? ''
        // Nothing answers a send here; the message simply arrives (loopback).
        setTimeout(() => {
          this.emit(
            b64
              ? { k: 'dc-msg', id: args.id as number, label: args.label as string, b64 }
              : { k: 'dc-msg', id: args.id as number, label: args.label as string, text },
          )
        }, 0)
        return Promise.resolve((b64?.length ?? text.length) as T)
      }
      default:
        return Promise.resolve(undefined as T)
    }
  }

  async listen(_event: string, onEvent: (payload: unknown) => void): Promise<() => void> {
    this.listeners.push(onEvent)
    return () => {
      this.listeners = this.listeners.filter((f) => f !== onEvent)
    }
  }
}

const FP_A = Array.from({ length: 32 }, (_, i) => ((i * 3) % 16).toString(16).padStart(2, '0')).join(':').toUpperCase()
const FP_B = Array.from({ length: 32 }, (_, i) => ((i * 5 + 1) % 16).toString(16).padStart(2, '0')).join(':').toUpperCase()
const withFingerprint = (fp: string) =>
  `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${fp.toLowerCase()}\r\n`

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('probeMedia', () => {
  it('asks the bridge what the machine can do', async () => {
    const rust = new FakeRust()
    const probe = await probeMedia(rust)
    expect(rust.seen).toEqual([{ cmd: 'native_media', args: {} }])
    expect(probe.available).toBe(true)
    expect(probe.mic).toBe(true)
    expect(probe.output).toBe(true)
  })

  it('makes every session native where there is a bridge, and the browser without one', () => {
    vi.stubGlobal('window', { __TAURI__: { invoke: async () => undefined, event: { listen: async () => () => undefined } } })
    try {
      expect(tauriBridge()).not.toBeNull()
      const npc = nativeConnection({ iceServers: [] }) as unknown as NativePC
      expect(npc.id).toBeGreaterThan(0)
      // The same for an audio session: the connection finds out what it carries itself.
      expect(nativeConnection({ iceServers: [] }, { audio: true, receiveAudio: false }) as unknown as NativePC).toBeInstanceOf(NativePC)
      vi.stubGlobal('RTCPeerConnection', FakeBrowserPC)
      // With no bridge at all there is nothing native:
      vi.stubGlobal('window', {})
      expect(nativeConnection({ iceServers: [] })).toBeInstanceOf(FakeBrowserPC)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

class FakeBrowserPC {
  constructed = true
}

describe('NativePC over PeerSession', () => {
  it('offers and answers across two connections, with matching safety codes', async () => {
    const over = new FakeRust()
    const under = new FakeRust()
    over.sdp.set('offer', withFingerprint(FP_A))
    under.sdp.set('answer', withFingerprint(FP_B))

    const offerer = new PeerSession({
      iceServers: [],
      send: (d) => {
        expect(d).toEqual({ t: 'offer', sdp: over.sdp.get('offer') })
        void answerer.accept(d.sdp)
      },
      createConnection: (config) => new NativePC(over, config) as unknown as RTCPeerConnection,
    })
    const answerer = new PeerSession({
      iceServers: [],
      send: (d) => void offerer.applyAnswer(d.sdp),
      createConnection: (config) => new NativePC(under, config) as unknown as RTCPeerConnection,
    })
    await offerer.start('chat')
    await flush()

    expect(answerer.fingerprints.local).toBe(FP_B)
    expect(answerer.fingerprints.remote).toBe(FP_A)
    expect(offerer.fingerprints.local).toBe(FP_A)
    expect(offerer.fingerprints.remote).toBe(FP_B)
    expect(safetyCode(offerer.fingerprints.local, offerer.fingerprints.remote)).toEqual(
      safetyCode(answerer.fingerprints.local, answerer.fingerprints.remote),
    )
    expect(fingerprintOf(withFingerprint(FP_A))).toBe(FP_A)
  })

  it('brings local channels up and delivers messages both ways', async () => {
    const rust = new FakeRust()
    const incoming: unknown[] = []
    const natives: NativePC[] = []

    const session = new PeerSession({
      iceServers: [],
      send: () => {},
      createConnection: (config) => {
        const npc = new NativePC(rust, config)
        natives.push(npc)
        return npc as unknown as RTCPeerConnection
      },
    })
    const ch = session.openChannel('chat')
    ch.onmessage = (ev) => incoming.push(ev.data)
    expect(ch.readyState).toBe('connecting')
    expect(rust.seen.map((r) => r.cmd)).toContain('pc_channel')
    expect(rust.seen.find((r) => r.cmd === 'pc_channel')!.args).toMatchObject({ label: 'chat' })

    rust.emit({ k: 'dc-open', id: natives[0]!.id, label: 'chat' })
    await flush()
    expect(ch.readyState).toBe('open')

    ch.send('hello')
    await flush()
    expect(incoming).toEqual(['hello'])

    ch.send(new Uint8Array([1, 2, 3]))
    await flush()
    expect(new Uint8Array(incoming[1] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('hands over a channel the other side opened', async () => {
    const rust = new FakeRust()
    const npc = new NativePC(rust, { iceServers: [] })
    const inboxes: BridgeChannel[] = []
    npc.ondatachannel = (ev) => inboxes.push(ev.channel as unknown as BridgeChannel)

    rust.emit({ k: 'dc-open', id: npc.id, label: 'chat' })
    const got: unknown[] = []
    inboxes[0]!.onmessage = (ev) => got.push(ev.data)
    rust.emit({ k: 'dc-msg', id: npc.id, label: 'chat', text: 'hi' })
    rust.emit({ k: 'dc-msg', id: npc.id, label: 'chat', b64: b64Of([9, 9]) })
    rust.emit({ k: 'dc-close', id: npc.id, label: 'chat' })
    await flush()

    expect(inboxes).toHaveLength(1)
    expect(inboxes[0]!.label).toBe('chat')
    expect(inboxes[0]!.readyState).toBe('closed')
    const text = got[0] as string
    expect(text).toBe('hi')
    expect(new Uint8Array(got[1] as ArrayBuffer)).toEqual(new Uint8Array([9, 9]))
    expect(npc.connectionState).toBe('new')
  })

  it('reaches complete gathering without further waiting in the page', async () => {
    const rust = new FakeRust()
    rust.sdp.set('offer', withFingerprint(FP_A))
    const npc = new NativePC(rust, { iceServers: [] })
    expect(npc.iceGatheringState).toBe('new')
    const offer = await npc.createOffer()
    expect(offer.type).toBe('offer')
    await npc.setLocalDescription({ type: 'offer', sdp: offer.sdp! })
    expect(npc.iceGatheringState).toBe('complete')
    expect(npc.localDescription?.sdp).toContain(FP_A.toLowerCase())
    expect(npc.localDescription?.type).toBe('offer')
  })

  it('marks the connection failed when the Rust side refuses it', async () => {
    const rust = new FakeRust()
    rust.failCmd = 'pc_create'
    const npc = new NativePC(rust, { iceServers: [] })
    const seen: string[] = []
    npc.addEventListener('connectionstatechange', () => seen.push(npc.connectionState))
    await flush()
    expect(npc.connectionState).toBe('failed')
    expect(seen).toEqual(['failed'])
  })

  it('fires the onconnectionstatechange property PeerSession assigns', async () => {
    const rust = new FakeRust()
    const npc = new NativePC(rust, { iceServers: [] })
    const seen: string[] = []
    npc.onconnectionstatechange = () => seen.push(npc.connectionState)
    await flush()
    rust.emit({ k: 'state', id: npc.id, state: 'connecting' })
    rust.emit({ k: 'state', id: npc.id, state: 'connected' })
    rust.emit({ k: 'state', id: npc.id, state: 'connected' })
    await flush()
    expect(npc.connectionState).toBe('connected')
    expect(seen).toEqual(['connecting', 'connected'])
  })

  it('ends everything when close() is called, and ignores late events', async () => {
    const rust = new FakeRust()
    const npc = new NativePC(rust, { iceServers: [] })
    const ch = npc.createDataChannel('chat') as unknown as BridgeChannel
    const closes: Array<'channel'> = []
    ch.onclose = () => closes.push('channel')

    npc.close()
    expect(npc.connectionState).toBe('closed')
    expect(ch.readyState).toBe('closed')
    await flush()
    expect(closes).toEqual(['channel'])
    expect(rust.seen.some((r) => r.cmd === 'pc_close')).toBe(true)

    rust.emit({ k: 'dc-open', id: npc.id, label: 'chat' })
    rust.emit({ k: 'bye', id: npc.id })
    await flush()
    expect(ch.readyState).toBe('closed')
    expect(npc.connectionState).toBe('closed')
  })

  it('treats bye from the Rust side as the end', async () => {
    const rust = new FakeRust()
    const npc = new NativePC(rust, { iceServers: [] })
    rust.emit({ k: 'bye', id: npc.id })
    await flush()
    expect(npc.connectionState).toBe('failed')
  })
})

// --- helpers ---

function b64Of(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
}
