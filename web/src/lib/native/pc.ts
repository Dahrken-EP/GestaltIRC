// The Rust media stack, seen from the page: a stand-in for RTCPeerConnection whose
// actual connections live in the desktop app (see desktop/src-tauri/src/media.rs).
// The page's PeerSession drives it as if it were the browser's, so chat keeps its
// whole shape — offers, answers, channels, per-person fingerprint codes — and the
// bridge only moves descriptions and channel payloads. What the browser cannot do
// reliably (ICE against the OS mic and speakers) never happens in the page on this
// path: the Rust side hunts the sockets, decodes the voice, and plays it.
//
// Audio sessions (rooms and private calls) stay on the webview's own stack until
// the voice work lands; nativeConnection hands those back to the browser as before.
// So this native path currently serves the data channels: chat and file transfer.

import { tauriBridge, type Bridge } from './bridge'
import type { PeerConnectionContext } from '../p2p/peer'

/** What `native_media` reports about this machine's media stack. */
export interface MediaProbe {
  available: boolean
  mic: boolean
  output: boolean
  error: string
}

/** Asks the desktop app what it can do. In a plain browser this returns null. */
export async function probeMedia(br: Bridge = notNull(tauriBridge())): Promise<MediaProbe> {
  return (await br.invoke('native_media')) as MediaProbe
}

export interface ConnectionContext extends PeerConnectionContext {}

/**
 * The factory the app hands PeerSession through. Every session goes through the bridge
 * where there is one: the browser's own WebRTC on WebKitGTK is unreliable, and that was
 * the reason for the Rust stack. In a plain browser this falls straight back to the
 * browser's connection, exactly as before. `ctx` says what a session carries; on the
 * native path the connection itself finds out via addTrack/addTransceiver.
 */
export function nativeConnection(config: RTCConfiguration, _ctx?: ConnectionContext): RTCPeerConnection {
  const br = tauriBridge()
  return (br ? new NativePC(br, config) : new RTCPeerConnection(config)) as unknown as RTCPeerConnection
}

/**
 * One WebRTC connection living in Rust. The page only ever sees its descriptions,
 * its state, and its data channels; the events for all of them arrive on the one
 * `media` channel (each tagged with the connection's id), so this class subscribes
 * once for the whole page and hands each event to its connection.
 */
export class NativePC {
  readonly id: number
  ondatachannel: ((ev: { channel: RTCDataChannel }) => void) | null = null
  ontrack: ((ev: RTCTrackEvent) => void) | null = null
  /** Speaking loudness from the Rust mixing pass: the mic ('mic') or one far person ('pc:N'). */
  onrms: ((src: string, level: number) => void) | null = null
  /** Marks this as a connection the Rust side owns (see ../p2p/peer). */
  readonly nativeVoice = true
  private connState: RTCPeerConnectionState = 'new'
  private gatherState: RTCIceGatheringState = 'new'
  private local: { type: 'offer' | 'answer'; sdp: string } | null = null
  private closed = false
  private channels: Map<string, BridgeChannel> = new Map()
  private gatherListeners: Array<() => void> = []
  private changeListeners: Array<() => void> = []
  /** The DOM-style property PeerSession assigns; fired on every state change. */
  onconnectionstatechange: (() => void) | null = null

  constructor(private br: Bridge, config: RTCConfiguration) {
    this.id = nextId()
    events(br).on(this.id, (e) => this.onEvent(e))
    this.run('pc_create', { id: this.id, ice: (config.iceServers ?? []) as unknown }).catch(() => this.break())
  }

  /**
   * Every command of this connection goes through here, one at a time and in the order the page gave them.
   * The Rust side runs commands concurrently, and the order matters: a connection must exist before it is
   * used, and a data channel must exist before the offer that is meant to carry it. (Commands used to run on
   * the app's main thread, one after another, and the page leaned on that without saying so.)
   */
  private tail: Promise<unknown> = Promise.resolve()
  private run<T = unknown>(cmd: string, args: Record<string, unknown>): Promise<T> {
    const p = this.tail.then(() => this.br.invoke<T>(cmd, args))
    this.tail = p.catch(() => undefined)
    return p
  }

  get connectionState(): RTCPeerConnectionState {
    return this.connState
  }

  get iceGatheringState(): RTCIceGatheringState {
    return this.gatherState
  }

  get localDescription(): RTCSessionDescription | null {
    return this.local ? ({ type: this.local.type, sdp: this.local.sdp } as RTCSessionDescription) : null
  }

  get remoteDescription(): RTCSessionDescription | null {
    return null
  }

  /** The browser's description flows: the offer and answer are built in Rust. */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: '' }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: '' }
  }

  /**
   * Really builds our description: asks Rust for it, which returns it with every
   * candidate already found inside — so by the time this resolves, the description
   * is final and the page's gather wait is over before it starts.
   */
  async setLocalDescription(desc: { type: 'offer' | 'answer'; sdp: string }): Promise<void> {
    await this.tellIntent()
    const sdp = await this.run<string>('pc_local', { id: this.id, kind: desc.type })
    this.local = { type: desc.type, sdp }
    this.gatherState = 'complete'
    const listeners = this.gatherListeners.splice(0)
    for (const fn of listeners) fn()
  }

  /**
   * Applies the other side's description. The audio intent goes out here first if it has
   * not gone out already: a track named after the remote offer would become a second
   * m-line (this stack folds nothing in after the fact), so the answering session's
   * microphone must be declared before the offer lands.
   */
  async setRemoteDescription(desc: { type: 'offer' | 'answer'; sdp: string }): Promise<void> {
    await this.tellIntent()
    await this.run('pc_remote', { id: this.id, kind: desc.type, sdp: desc.sdp })
  }

  /** Declares the page's audio wish at most once, at whichever description step comes first. */
  private async tellIntent(): Promise<void> {
    if (this.wantMic) await this.run('pc_track', { id: this.id, kind: 'mic' })
    else if (this.wantRecv) await this.run('pc_track', { id: this.id, kind: 'recv' })
    this.wantMic = false
    this.wantRecv = false
  }

  /** The browser DOM plumbing the real RTCPeerConnection has. */
  addEventListener(kind: string, fn: () => void): void {
    if (kind === 'icegatheringstatechange') this.gatherListeners.push(fn)
    else if (kind === 'connectionstatechange') this.changeListeners.push(fn)
  }

  removeEventListener(kind: string, fn: () => void): void {
    const list = kind === 'icegatheringstatechange' ? this.gatherListeners : this.changeListeners
    const at = list.indexOf(fn)
    if (at >= 0) list.splice(at, 1)
  }

  /** Sound is only natively wired when the voice work lands; recording the wish is enough now. */
  addTransceiver(kind: string, init?: { direction?: RTCRtpTransceiverDirection }): void {
    if (init?.direction === 'recvonly') this.wantRecv = true
  }

  wantRecv = false

  /** The page's media is not real here (the bridge carries no audio), so the track only marks intent: send the Rust microphone. */
  addTrack(): void {
    this.wantMic = true
  }

  wantMic = false

  /**
   * What this connection is sent: 'mic' (the microphone, and with guests in the room, them too), or 'guest:<name>'
   * for a guest's own connection, which is sent the room instead (see the mixes in media.rs).
   */
  setUplink(tag: string): void {
    void this.run('pc_uplink', { id: this.id, tag }).catch(() => {})
  }

  /** How loud this person plays, 0 to 1, applied while they are mixed for the speakers. */
  setVolume(v: number): void {
    void this.run('pc_volume', { id: this.id, v }).catch(() => {})
  }

  /** Opens one channel. Its 'open' arrives with the connection's own. */
  createDataChannel(label: string, _init?: RTCDataChannelInit): RTCDataChannel {
    const ch = new BridgeChannel(this.br, this.id, label, (cmd, args) => this.run(cmd, args))
    this.channels.set(label, ch)
    void this.run('pc_channel', { id: this.id, label }).catch(() => this.break())
    return ch as unknown as RTCDataChannel
  }

  close(): void {
    if (this.closed) return
    // The state moves first, so the page sees the end; after this, Rust's late
    // events for an already-forgotten connection do not reach it.
    const listeners = [...this.changeListeners]
    for (const ch of this.channels.values()) ch.markClosed()
    events(this.br).off(this.id)
    void this.run('pc_close', { id: this.id }).catch(() => {})
    this.closed = true
    this.connState = 'closed'
    for (const fn of listeners) fn()
  }

  private break(): void {
    if (!this.closed) this.set('failed')
  }

  private set(state: RTCPeerConnectionState): void {
    if (this.closed || this.connState === state) return
    this.connState = state
    const listeners = [...this.changeListeners]
    for (const fn of listeners) fn()
    this.onconnectionstatechange?.()
  }

  private onEvent(e: MediaEvent): void {
    if (this.closed) return
    switch (e.k) {
      case 'state':
        this.set(e.state as RTCPeerConnectionState)
        break
      case 'dc-open': {
        const label = e.label as string
        const mine = this.channels.get(label)
        if (mine) {
          mine.markOpen()
        } else {
          // A channel the other side opened: open it here and hand it over.
          const next = new BridgeChannel(this.br, this.id, label, (cmd, args) => this.run(cmd, args))
          next.markOpen()
          this.channels.set(label, next)
          this.ondatachannel?.({ channel: next as unknown as RTCDataChannel })
        }
        break
      }
      case 'dc-msg': {
        const ch = this.channels.get(e.label as string)
        ch?.deliver(e.text as string, e.b64 as string)
        break
      }
      case 'dc-close': {
        this.channels.get(e.label as string)?.markClosed()
        break
      }
      case 'rms':
        this.onrms?.(e.src as string, e.level as number)
        break
      case 'bye':
        // The other person put their connection down.
        this.set('failed')
        break
      case 'track': {
        // Inbound audio is on: the page gets a quiet stream it can put in an <audio>
        // element (the real sound is Rust's), and the volume feed follows the stream,
        // so the page's meters speak for this person.
        const placeholder =
          typeof MediaStream === 'function' ? new MediaStream() : ({} as unknown as MediaStream)
        streamPc.set(placeholder, this.id)
        this.ontrack?.({ track: null as unknown as MediaStreamTrack, streams: [placeholder] } as unknown as RTCTrackEvent)
        break
      }
    }
  }
}

let counter = 0
function nextId(): number {
  return ++counter
}

/** Which connection's sound a placeholder stream stands for, for the loudness feeds. */
export const streamPc = new WeakMap<MediaStream, number>()

/** Which connection a placeholder stream stands for, or null with no native sound. */
export function streamPcId(stream: MediaStream): number | null {
  return streamPc.get(stream) ?? null
}

/** The shape of a native connection, as the page's voice code uses it. */
export interface NativeVoicePC {
  readonly id: number
  onrms: ((src: string, level: number) => void) | null
  /** What the connection is sent; see NativePC.setUplink. */
  setUplink(tag: string): void
  /** How loud this person plays, 0 to 1. */
  setVolume(v: number): void
}

/**
 * One data channel on one connection. Text travels as text; everything else is
 * base64 across the bridge and comes back as bytes. Nothing is buffered in Rust
 * long for chat-sized sends, so the accounts here only count what this page has
 * handed over and the bridge has not yet accepted.
 */
export class BridgeChannel {
  readonly label: string
  readyState: 'connecting' | 'open' | 'closed' = 'connecting'
  binaryType = 'arraybuffer'
  bufferedAmountLowThreshold = 0
  onopen: ((ev?: unknown) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onbufferedamountlow: ((ev?: unknown) => void) | null = null
  private buf = 0
  private openFired = false
  private closeFired = false

  /** `run` sends a command in the connection's order; without one (a test) the bridge is called directly. */
  constructor(
    private br: Bridge,
    private pc: number,
    label: string,
    private run: (cmd: string, args: Record<string, unknown>) => Promise<unknown> = (cmd, args) => this.br.invoke(cmd, args),
  ) {
    this.label = label
  }

  get bufferedAmount(): number {
    return this.buf
  }

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (this.readyState !== 'open') return
    const args: { id: number; label: string; text?: string; b64?: string } = { id: this.pc, label: this.label }
    let n = 0
    if (typeof data === 'string') {
      args.text = data
      n = new TextEncoder().encode(data).length
    } else {
      const u8 =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      args.b64 = toB64(u8)
      n = u8.byteLength
    }
    this.buf += n
    // In order: chunks of a file must reach the channel in the order they were handed over.
    void this.run('pc_send', args)
      .catch(() => this.onerror?.())
      .finally(() => {
        this.buf = Math.max(0, this.buf - n)
        this.maybeLow(n)
      })
  }

  close(): void {
    // Channels die with their connection; the browser DOM's per-channel close is not
    // part of the bridge yet.
    this.markClosed()
  }

  private maybeLow(sent: number): void {
    const threshold = this.bufferedAmountLowThreshold
    if (threshold > 0 && this.buf <= threshold && this.buf + sent > threshold) this.onbufferedamountlow?.()
  }

  /** From Rust: the channel works now. */
  markOpen(): void {
    if (this.readyState !== 'connecting') return
    this.readyState = 'open'
    this.openFired = true
    const onopen = this.onopen
    if (onopen) setTimeout(onopen, 0)
  }

  /** From Rust: the channel is over, either by its connection or on its own. */
  markClosed(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.closeFired = true
    this.buf = 0
    const onclose = this.onclose
    if (onclose) setTimeout(onclose, 0)
  }

  /** From Rust: a message came in. Text stays text; bytes are decoded. */
  deliver(text: string, b64: string): void {
    if (typeof this.onmessage !== 'function') return
    if (text) this.onmessage({ data: text })
    else if (b64) this.onmessage({ data: fromB64(b64) })
  }
}

function toB64(u8: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode(...u8.subarray(i, i + CHUNK))
  return btoa(s)
}

function fromB64(b64: string): ArrayBuffer {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out.buffer
}

function notNull<T>(v: T | null): T {
  if (v === null) throw new Error('the media bridge is only in the desktop app')
  return v
}

type MediaEvent = Record<string, unknown> & { k: string; id: number }

/**
 * One `media` listener for every connection of the page. Registers per id, and
 * drops the listener once the last connection goes away.
 */
class MediaEvents {
  private byId = new Map<number, (e: MediaEvent) => void>()
  private unlisten: (() => void) | null = null
  private attaching = false

  constructor(private br: Bridge) {}

  on(id: number, fn: (e: MediaEvent) => void): void {
    this.byId.set(id, fn)
    void this.attach()
  }

  off(id: number): void {
    this.byId.delete(id)
    if (this.byId.size === 0 && this.unlisten) {
      const un = this.unlisten
      this.unlisten = null
      un()
    }
  }

  private attach(): Promise<void> {
    if (this.unlisten || this.attaching) return Promise.resolve()
    this.attaching = true
    return this.br
      .listen('media', (payload) => {
        if (!payload || typeof payload !== 'object') return
        const e = payload as MediaEvent
        if (typeof e.id !== 'number') return
        const fn = this.byId.get(e.id)
        if (fn) fn(e)
      })
      .then((un) => {
        if (this.byId.size === 0) un()
        else this.unlisten = un
      })
      .finally(() => {
        this.attaching = false
      })
  }
}

const tables = new WeakMap<Bridge, MediaEvents>()

function events(br: Bridge): MediaEvents {
  let t = tables.get(br)
  if (!t) tables.set(br, (t = new MediaEvents(br)))
  return t
}
