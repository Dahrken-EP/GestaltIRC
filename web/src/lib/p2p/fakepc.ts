// A stand-in for RTCPeerConnection for tests. Two of them find each other through a
// shared `FakeNet` using the fingerprint in the description, and when both
// descriptions are set they connect: data channels one side made appear on the other.

import { channelPair, type FakeChannel } from './fakechannel'

let counter = 0

export class FakeNet {
  byFingerprint = new Map<string, FakePC>()
  /** Called with every config the connections were made with. */
  configs: RTCConfiguration[] = []
  create = (config: RTCConfiguration): RTCPeerConnection => {
    this.configs.push(config)
    return new FakePC(this) as unknown as RTCPeerConnection
  }
}

export class FakePC {
  connectionState = 'new'
  iceGatheringState = 'new'
  localDescription: { type: string; sdp: string } | null = null
  remoteDescription: { type: string; sdp: string } | null = null
  ondatachannel: ((ev: { channel: FakeChannel }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  closed = false
  readonly fingerprint: string
  private listeners = new Set<() => void>()
  private channels: FakeChannel[] = []
  private outbox: Array<{ label: string; local: FakeChannel; remote: FakeChannel }> = []
  private remote: FakePC | null = null
  /** When set, gathering finishes only when told to. */
  holdGathering = false
  /** Makes setRemoteDescription fail. */
  rejectRemote = false

  constructor(private net: FakeNet) {
    const n = ++counter
    this.fingerprint = Array.from({ length: 32 }, (_, i) => ((n * 7 + i * 13) & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(':')
    net.byFingerprint.set(this.fingerprint, this)
  }

  private sdp(kind: string): string {
    return `v=0\r\no=- ${counter} 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${this.fingerprint}\r\na=x-kind:${kind}\r\n`
  }

  async createOffer() {
    return { type: 'offer', sdp: this.sdp('offer') }
  }
  async createAnswer() {
    return { type: 'answer', sdp: this.sdp('answer') }
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d
    if (!this.holdGathering) setTimeout(() => this.finishGathering(), 0)
  }
  finishGathering() {
    this.iceGatheringState = 'complete'
    for (const l of [...this.listeners]) l()
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    if (this.rejectRemote) throw new Error('bad description')
    this.remoteDescription = d
    const m = /a=fingerprint:sha-256 (\S+)/.exec(d.sdp)
    this.remote = (m && this.net.byFingerprint.get(m[1]!)) || null
    // The answerer is connected once it has both; the offerer once it has the answer.
    if (d.type === 'answer' && this.remote) {
      this.link(this.remote)
      this.remote.link(this)
      setTimeout(() => {
        this.remote?.flush()
        this.flush()
      }, 0)
    }
  }
  private link(other: FakePC) {
    this.remote = other
  }

  addEventListener(_t: string, f: () => void) {
    this.listeners.add(f)
  }
  removeEventListener(_t: string, f: () => void) {
    this.listeners.delete(f)
  }

  createDataChannel(label: string) {
    const [local, remote] = channelPair()
    local.label = label
    remote.label = label
    local.readyState = 'connecting'
    remote.readyState = 'connecting'
    this.channels.push(local)
    this.outbox.push({ label, local, remote })
    if (this.connectionState === 'connected') setTimeout(() => this.flush(), 0)
    return local as unknown
  }

  /** Delivers waiting channels and marks the connection up. */
  flush() {
    if (this.closed || !this.remote) return
    if (this.connectionState !== 'connected') {
      this.connectionState = 'connected'
      this.onconnectionstatechange?.()
    }
    for (const { local, remote } of this.outbox.splice(0)) {
      remote.readyState = 'open'
      local.readyState = 'open'
      this.remote.channels.push(remote)
      this.remote.ondatachannel?.({ channel: remote })
      local.onopen?.()
      remote.onopen?.()
    }
    // Channels the other side made before we were ready.
    if (this.remote.outbox.length) setTimeout(() => this.remote?.flush(), 0)
  }

  /** Simulates the network giving up. */
  fail() {
    this.connectionState = 'failed'
    this.onconnectionstatechange?.()
  }

  close() {
    this.closed = true
    this.connectionState = 'closed'
    this.onconnectionstatechange?.()
    // The far side finds out through its channels closing, a little later.
    for (const ch of this.channels) ch.close()
  }
}
