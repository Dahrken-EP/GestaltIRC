// One WebRTC connection to one other browser. It knows nothing about IRC or chat:
// whatever carries the offer and answer (the `send` callback) and whatever is said
// over the data channels belong to the caller. Chat and file transfer use it now;
// voice will use the same class, for a channel room and for a private call alike.

import { sha256Hex } from './sha256'
import type { DataChannelLike } from './transfer'

export type PeerState = 'new' | 'connecting' | 'connected' | 'failed' | 'closed'

export interface Description {
  t: 'offer' | 'answer'
  sdp: string
}

export interface PeerOptions {
  iceServers: RTCIceServer[]
  /** Sends our offer or answer to the other side. */
  send: (d: Description) => void
  /** The other side opened a data channel. */
  onChannel?: (ch: DataChannelLike) => void
  onState?: (s: PeerState) => void
  /** Our microphone, sent to the other side. Not owned by this session: closing it leaves the tracks running. */
  stream?: MediaStream
  /** With no stream of our own, still ask to receive the other side's audio (a listener in a voice room). */
  receiveAudio?: boolean
  /** The other side's audio arrived. */
  onTrack?: (stream: MediaStream) => void
  /** Makes the connection. Tests pass a fake. */
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection
  /** How long to wait for candidates before sending what has been found. */
  gatherTimeoutMs?: number
}

const asLike = (ch: RTCDataChannel) => ch as unknown as DataChannelLike

export class PeerSession {
  state: PeerState = 'new'
  private pc: RTCPeerConnection
  private localFp = ''
  private remoteFp = ''

  constructor(private opts: PeerOptions) {
    const make = opts.createConnection ?? ((c) => new RTCPeerConnection(c))
    this.pc = make({ iceServers: opts.iceServers })
    this.pc.ondatachannel = (ev) => opts.onChannel?.(asLike(ev.channel))
    this.pc.ontrack = (ev) => opts.onTrack?.(ev.streams[0] ?? new MediaStream([ev.track]))
    this.pc.onconnectionstatechange = () => {
      switch (this.pc.connectionState) {
        case 'connected':
          this.set('connected')
          break
        case 'failed':
          this.set('failed')
          break
        case 'closed':
          this.set('closed')
          break
        // 'disconnected' often heals by itself, so it is not treated as the end.
      }
    }
  }

  private set(s: PeerState): void {
    if (this.state === 'closed' || this.state === s) return
    // A failure or close is final; a late "connected" must not undo it.
    if (this.state === 'failed' && s === 'connected') return
    this.state = s
    this.opts.onState?.(s)
  }

  /** The certificate fingerprints of both ends, once both descriptions are known. */
  get fingerprints(): { local: string; remote: string } {
    return { local: this.localFp, remote: this.remoteFp }
  }

  /** Opens a data channel from our side. */
  openChannel(label: string): DataChannelLike {
    return asLike(this.pc.createDataChannel(label, { ordered: true }))
  }

  private addLocalTracks(): void {
    for (const track of this.opts.stream?.getTracks() ?? []) this.pc.addTrack(track, this.opts.stream!)
  }

  /**
   * Starts a connection: creates the first channel (if one is named) and an offer, and
   * sends it. A connection that only carries audio names no channel.
   */
  async start(firstChannel?: string): Promise<DataChannelLike | null> {
    this.set('connecting')
    const ch = firstChannel ? this.openChannel(firstChannel) : null
    this.addLocalTracks()
    if (!this.opts.stream && this.opts.receiveAudio) this.pc.addTransceiver('audio', { direction: 'recvonly' })
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    await this.gathered()
    this.send('offer')
    return ch
  }

  /** Answers an offer from the other side. */
  async accept(sdp: string): Promise<void> {
    this.set('connecting')
    this.remoteFp = fingerprintOf(sdp)
    await this.pc.setRemoteDescription({ type: 'offer', sdp })
    this.addLocalTracks()
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    await this.gathered()
    this.send('answer')
  }

  /** Takes the other side's answer to our offer. */
  async applyAnswer(sdp: string): Promise<void> {
    this.remoteFp = fingerprintOf(sdp)
    await this.pc.setRemoteDescription({ type: 'answer', sdp })
  }

  close(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    try {
      this.pc.close()
    } catch {
      // already closed
    }
    this.opts.onState?.('closed')
  }

  private send(t: 'offer' | 'answer'): void {
    const sdp = this.pc.localDescription?.sdp ?? ''
    this.localFp = fingerprintOf(sdp)
    this.opts.send({ t, sdp })
  }

  /** Waits until candidates are gathered, or a short time passes. All go in one message, with no trickling. */
  private gathered(): Promise<void> {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.pc.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') done()
      }
      const timer = setTimeout(done, this.opts.gatherTimeoutMs ?? 4000)
      this.pc.addEventListener('icegatheringstatechange', check)
    })
  }
}

/**
 * The certificate fingerprint a description commits to, upper-case. It is '' unless the
 * description has fingerprint lines and they all agree on one SHA-256 value. A description
 * with two different ones, or one this code cannot read, is not trusted: the browser might
 * use a different one from the one a person would compare.
 */
export function fingerprintOf(sdp: string): string {
  const found = new Set<string>()
  let any = false
  for (const m of sdp.matchAll(/^a=fingerprint:(\S+) (\S+)\s*$/gm)) {
    any = true
    if (m[1]!.toLowerCase() !== 'sha-256' || !/^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31}$/.test(m[2]!)) return ''
    found.add(m[2]!.toUpperCase())
  }
  return any && found.size === 1 ? [...found][0]! : ''
}

/**
 * A short code both people can read aloud and compare. It is computed from both
 * fingerprints in a fixed order, so the two browsers show the same code only if
 * each saw the other's real certificate. If something altered the offer or answer
 * on its way through IRC, the codes differ.
 */
export function safetyCode(a: string, b: string): string {
  if (!a || !b) return ''
  const [x, y] = [a, b].sort()
  const hex = sha256Hex(new TextEncoder().encode(`${x}|${y}`))
  // 20 hex digits is 80 bits, written as five groups of four.
  return hex.slice(0, 20).replace(/(.{4})(?=.)/g, '$1 ').toUpperCase()
}
