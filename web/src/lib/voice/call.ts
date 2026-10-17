// A private voice call between two people. Like a direct chat, nothing happens until the
// other person accepts: no connection is made, their microphone stays off, and no network
// address is shared. The microphone is asked for only when a call is placed or accepted.

import { PeerSession, safetyCode, type PeerState } from '../p2p/peer'
import { newSessionId, type Signal } from '../p2p/signal'
import { voiceSlot, type VoiceSlot } from './active'
import { audioMeter, primeAudio, Speaking, type Meter, type MeterFactory } from './meter'
import { stopStream } from './media'

export type CallState = 'idle' | 'calling' | 'incoming' | 'connecting' | 'connected' | 'ended'

export interface CallView {
  state: CallState
  reason: string
  muted: boolean
  speaking: boolean
  remoteSpeaking: boolean
  /** 0 to 1. */
  volume: number
  remote: MediaStream | null
  /** Compare out loud with the other person. Empty until connected. */
  code: string
}

export interface CallOptions {
  sendSignal: (sid: string, payload: object) => void
  iceServers: () => Promise<RTCIceServer[]>
  getMedia: () => Promise<MediaStream>
  onChange: (v: CallView) => void
  wins: () => boolean
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection
  createMeter?: MeterFactory
  newSid?: () => string
  slot?: VoiceSlot
  ringMs?: number
  tickMs?: number
}

export class VoiceCall {
  private view: CallView = { state: 'idle', reason: '', muted: false, speaking: false, remoteSpeaking: false, volume: 1, remote: null, code: '' }
  private sid = ''
  private offer: string | null = null
  private session: PeerSession | null = null
  private local: MediaStream | null = null
  private meters: { local: Meter | null; remote: Meter | null } = { local: null, remote: null }
  private speak = { local: new Speaking(), remote: new Speaking() }
  private timer: ReturnType<typeof setTimeout> | undefined
  private ticker: ReturnType<typeof setInterval> | undefined

  constructor(private o: CallOptions) {}

  get state(): CallState {
    return this.view.state
  }

  private get slot(): VoiceSlot {
    return this.o.slot ?? voiceSlot
  }

  /** Rings the other person. */
  async invite(): Promise<void> {
    const st = this.view.state
    if (st === 'incoming') return this.accept()
    if (st !== 'idle' && st !== 'ended') return
    if (!this.slot.claim(this)) return this.update({ state: 'ended', reason: 'You are already in a voice chat. Leave it first.' })
    primeAudio()
    const sid = (this.sid = (this.o.newSid ?? newSessionId)())
    this.update({ state: 'calling', reason: '', code: '', remote: null, muted: false })
    this.arm('No answer.')
    try {
      const mic = await this.o.getMedia()
      if (this.sid !== sid || this.state !== 'calling') return stopStream(mic)
      this.useLocal(mic)
      const session = await this.makeSession(sid)
      await session.start()
    } catch (e) {
      if (this.sid === sid && this.state === 'calling') this.end(e instanceof Error && e.message !== 'superseded' ? `Could not start the call: ${e.message}` : 'Could not start the call.')
    }
  }

  /** The user agreed to take the call. */
  async accept(): Promise<void> {
    const offer = this.offer
    if (this.view.state !== 'incoming' || !offer) return
    if (!this.slot.claim(this)) return this.decline('You are already in a voice chat. Leave it first.')
    primeAudio()
    const sid = this.sid
    this.offer = null
    clearTimeout(this.timer)
    this.update({ state: 'connecting' })
    this.arm('The call did not connect.')
    try {
      const mic = await this.o.getMedia()
      if (this.sid !== sid || this.state !== 'connecting') return stopStream(mic)
      this.useLocal(mic)
      const session = await this.makeSession(sid)
      await session.accept(offer)
    } catch (e) {
      if (this.sid === sid && this.state === 'connecting') {
        // The caller is waiting for an answer that will not come.
        this.o.sendSignal(sid, { k: 'voice', t: 'reject' })
        this.end(e instanceof Error && e.message !== 'superseded' ? `Could not take the call: ${e.message}` : 'Could not take the call.')
      }
    }
  }

  decline(reason = ''): void {
    if (this.view.state !== 'incoming') return
    this.o.sendSignal(this.sid, { k: 'voice', t: 'reject' })
    this.offer = null
    this.teardown()
    this.update({ state: 'idle', reason })
  }

  hangUp(): void {
    const st = this.view.state
    if (st === 'idle' || st === 'ended') return
    if (st === 'incoming') return this.decline()
    this.o.sendSignal(this.sid, { k: 'voice', t: 'bye' })
    this.end('You ended the call.')
  }

  /** The window is going away: end the call, tell the other person, and ignore anything still on its way. */
  dispose(): void {
    const st = this.view.state
    if (st === 'incoming') this.o.sendSignal(this.sid, { k: 'voice', t: 'reject' })
    else if (st === 'calling' || st === 'connecting' || st === 'connected') this.o.sendSignal(this.sid, { k: 'voice', t: 'bye' })
    clearTimeout(this.timer)
    // With no id, a microphone prompt that is answered later finds nothing to attach to.
    this.sid = ''
    this.teardown()
    this.view = { ...this.view, state: 'idle' }
  }

  setMuted(muted: boolean): void {
    for (const t of this.local?.getAudioTracks() ?? []) t.enabled = !muted
    this.update({ muted })
  }

  setVolume(v: number): void {
    this.update({ volume: Math.min(1, Math.max(0, v)) })
  }

  handleSignal(sid: string, s: Signal): void {
    // Calls have no room. A message with one belongs to a channel's voice room.
    if (s.room !== undefined && s.room !== '') return
    switch (s.t) {
      case 'offer':
        return this.onOffer(sid, s.sdp)
      case 'answer':
        if (sid !== this.sid || this.view.state !== 'calling' || typeof s.sdp !== 'string' || !this.session) return
        clearTimeout(this.timer)
        this.update({ state: 'connecting' })
        this.arm('The call did not connect.')
        this.session.applyAnswer(s.sdp).catch(() => this.end('The answer was not valid.'))
        return
      case 'reject':
        if (sid === this.sid && this.view.state === 'calling') this.end('They declined.')
        return
      case 'bye':
        if (sid === this.sid && this.view.state !== 'idle' && this.view.state !== 'ended') this.end('They ended the call.')
        return
    }
  }

  private onOffer(sid: string, sdp: unknown): void {
    if (typeof sdp !== 'string' || !sdp || !/^[a-z0-9]{6,16}$/.test(sid)) return
    const st = this.view.state
    if (st === 'connected' || st === 'connecting') {
      if (sid !== this.sid) this.o.sendSignal(sid, { k: 'voice', t: 'reject' })
      return
    }
    if (st === 'calling') {
      // Both rang at once. The same one wins on both ends.
      if (!this.o.wins()) {
        this.o.sendSignal(sid, { k: 'voice', t: 'reject' })
        return
      }
      this.teardown()
    }
    if (st === 'incoming' && sid === this.sid) return
    if (this.slot.busy) {
      // Already talking elsewhere: say no without bothering the user.
      this.o.sendSignal(sid, { k: 'voice', t: 'reject' })
      return
    }
    this.teardown()
    this.sid = sid
    this.offer = sdp
    this.update({ state: 'incoming', reason: '', code: '', remote: null })
    this.arm('The call was not answered.')
  }

  // --- internals ---

  private useLocal(mic: MediaStream): void {
    this.local = mic
    const make = this.o.createMeter ?? audioMeter
    this.meters.local = make(mic)
    this.ticker = setInterval(() => this.tick(), this.o.tickMs ?? 50)
  }

  private async makeSession(sid: string): Promise<PeerSession> {
    const servers = await this.o.iceServers().catch(() => [] as RTCIceServer[])
    if (this.sid !== sid || !this.local) throw new Error('superseded')
    const current = () => this.session === session
    const session: PeerSession = new PeerSession({
      iceServers: servers,
      createConnection: this.o.createConnection,
      stream: this.local,
      send: (d) => current() && this.o.sendSignal(sid, { k: 'voice', t: d.t, sdp: d.sdp }),
      onTrack: (s) => {
        if (!current()) return
        this.meters.remote?.close()
        this.meters.remote = (this.o.createMeter ?? audioMeter)(s)
        this.update({ remote: s })
      },
      onState: (s: PeerState) => {
        if (!current()) return
        if (s === 'connected') {
          clearTimeout(this.timer)
          const fp = session.fingerprints
          this.update({ state: 'connected', reason: '', code: safetyCode(fp.local, fp.remote) })
        } else if (s === 'failed') this.end('The call failed. A firewall may be in the way.')
        else if (s === 'closed' && this.view.state !== 'ended' && this.view.state !== 'idle') this.end('The call dropped.')
      },
    })
    this.session = session
    return session
  }

  private tick(): void {
    const now = Date.now()
    const local = this.speak.local.update(this.view.muted ? 0 : (this.meters.local?.level() ?? 0), now)
    const remote = this.view.state === 'connected' && this.speak.remote.update(this.meters.remote?.level() ?? 0, now)
    if (local !== this.view.speaking || remote !== this.view.remoteSpeaking) this.update({ speaking: local, remoteSpeaking: remote })
  }

  private arm(reason: string): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const s = this.view.state
      if (s === 'calling' || s === 'incoming' || s === 'connecting') {
        if (s === 'calling') this.o.sendSignal(this.sid, { k: 'voice', t: 'bye' })
        if (s === 'incoming') this.o.sendSignal(this.sid, { k: 'voice', t: 'reject' })
        this.end(reason)
      }
    }, this.o.ringMs ?? 60_000)
  }

  private end(reason: string): void {
    clearTimeout(this.timer)
    this.teardown()
    this.update({ state: 'ended', reason })
  }

  private teardown(): void {
    clearInterval(this.ticker)
    this.ticker = undefined
    // Detached before closing: closing reports back, and the report must not end the call a second time.
    const session = this.session
    this.session = null
    session?.close()
    this.meters.local?.close()
    this.meters.remote?.close()
    this.meters = { local: null, remote: null }
    if (this.local) stopStream(this.local)
    this.local = null
    this.offer = null
    this.slot.release(this)
    this.view = { ...this.view, speaking: false, remoteSpeaking: false, remote: null }
  }

  private update(patch: Partial<CallView>): void {
    this.view = { ...this.view, ...patch }
    this.o.onChange(this.view)
  }
}
