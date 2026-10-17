// A voice room: everyone in a channel who has chosen to talk. Each pair of people holds
// one WebRTC connection (a mesh), so there is no media server. The person whose nick sorts
// first makes the offer, which means two people can never both offer at once.
//
// Presence travels as a client-only tag on the channel and the offers and answers as
// signalling messages to each person (see ../p2p/signal.ts); the audio goes browser to browser.

import { PeerSession, safetyCode } from '../p2p/peer'
import { newSessionId, type Signal } from '../p2p/signal'
import { voiceSlot, type VoiceSlot } from './active'
import { stopStream } from './media'
import { audioMeter, primeAudio, Speaking, type Meter, type MeterFactory } from './meter'
import { formatPresence, MAX_VOICE, parsePresence } from './presence'

export type PeerConnState = 'connecting' | 'connected' | 'failed'

export interface Participant {
  nick: string
  state: PeerConnState
  speaking: boolean
  /** 0 to 1. */
  volume: number
  stream: MediaStream | null
  /** Safety code for this pair, to compare out loud. Empty until connected. */
  code: string
}

export interface RoomView {
  state: 'idle' | 'joining' | 'active'
  error: string
  muted: boolean
  /** Joined without a microphone: hears the room, cannot be heard. */
  listenOnly: boolean
  /** The microphone is only open while the talk key or button is held. */
  pushToTalk: boolean
  /** Push to talk is being held right now. */
  talking: boolean
  speaking: boolean
  participants: Participant[]
}

export interface RoomOptions {
  channel: string
  ownNick: () => string
  /** Says something to the channel, or to one person (`here`). */
  sendPresence: (target: string, value: string) => void
  sendSignal: (peer: string, sid: string, payload: object) => void
  iceServers: () => Promise<RTCIceServer[]>
  getMedia: () => Promise<MediaStream>
  onChange: (view: RoomView) => void
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection
  createMeter?: MeterFactory
  newSid?: () => string
  slot?: VoiceSlot
  max?: number
  /** How long to wait for someone's offer before giving up on them. */
  offerTimeoutMs?: number
  /** How often speaking is checked, in milliseconds. */
  tickMs?: number
}

interface Peer {
  nick: string
  sid: string
  offerer: boolean
  session: PeerSession | null
  state: PeerConnState
  stream: MediaStream | null
  meter: Meter | null
  speaking: Speaking
  isSpeaking: boolean
  volume: number
  code: string
  timer: ReturnType<typeof setTimeout> | undefined
}

export class VoiceRoom {
  private view: RoomView = { state: 'idle', error: '', muted: false, listenOnly: false, pushToTalk: false, talking: false, speaking: false, participants: [] }
  private peers = new Map<string, Peer>()
  private local: MediaStream | null = null
  private localMeter: Meter | null = null
  private localSpeaking = new Speaking()
  private ticker: ReturnType<typeof setInterval> | undefined
  /** Counts joins and leaves, so a slow microphone prompt that finishes after leaving is dropped. */
  private epoch = 0
  /** Everyone who has answered our join, to tell when the room was already full. */
  private answered = new Set<string>()
  /** STUN and TURN servers, fetched once for all the connections of a join rather than once per person. */
  private ice: { at: number; servers: Promise<RTCIceServer[]> } | null = null

  constructor(private o: RoomOptions) {}

  private get slot(): VoiceSlot {
    return this.o.slot ?? voiceSlot
  }

  get state(): RoomView['state'] {
    return this.view.state
  }

  get snapshot(): RoomView {
    return this.view
  }

  // --- joining and leaving ---

  /**
   * Joins the room. `listenOnly` joins without asking for the microphone (so without a prompt, and without ever being
   * heard); `pushToTalk` starts with the microphone closed until `setTalking(true)`.
   */
  async join(opts: { listenOnly?: boolean; pushToTalk?: boolean } = {}): Promise<void> {
    if (this.view.state !== 'idle') return
    if (!this.slot.claim(this)) {
      this.update({ error: 'You are already in a voice chat. Leave it first.' })
      return
    }
    primeAudio()
    const epoch = ++this.epoch
    const listenOnly = opts.listenOnly === true
    const pushToTalk = !listenOnly && opts.pushToTalk === true
    this.update({ state: 'joining', error: '' })
    let stream: MediaStream | null = null
    if (!listenOnly) {
      try {
        stream = await this.o.getMedia()
      } catch (e) {
        if (epoch === this.epoch) this.fail(`Could not use the microphone: ${e instanceof Error ? e.message : 'not allowed'}`)
        return
      }
      if (epoch !== this.epoch) {
        stopStream(stream)
        return
      }
    }
    this.local = stream
    this.answered.clear()
    this.ice = null
    this.localMeter = stream ? (this.o.createMeter ?? audioMeter)(stream) : null
    this.update({ state: 'active', muted: false, listenOnly, pushToTalk, talking: false })
    this.applyMicrophone()
    this.ticker = setInterval(() => this.tick(), this.o.tickMs ?? 50)
    this.o.sendPresence(this.o.channel, formatPresence({ t: 'join' }))
  }

  leave(reason = ''): void {
    if (this.view.state === 'idle') return
    const wasActive = this.view.state === 'active'
    this.epoch++
    if (wasActive) {
      this.o.sendPresence(this.o.channel, formatPresence({ t: 'leave' }))
      for (const p of this.peers.values()) this.o.sendSignal(p.nick, p.sid, { k: 'voice', t: 'bye', room: this.o.channel })
    }
    this.teardown()
    this.update({ state: 'idle', error: reason, participants: [], speaking: false, talking: false, listenOnly: false })
  }

  dispose(): void {
    this.leave()
  }

  private fail(error: string): void {
    this.teardown()
    this.update({ state: 'idle', error, participants: [], speaking: false, talking: false, listenOnly: false })
  }

  private teardown(): void {
    clearInterval(this.ticker)
    this.ticker = undefined
    for (const p of [...this.peers.values()]) this.dropPeer(p, false)
    this.peers.clear()
    this.localMeter?.close()
    this.localMeter = null
    this.answered.clear()
    if (this.local) stopStream(this.local)
    this.local = null
    this.slot.release(this)
  }

  // --- from the network ---

  /** Someone said something about the room, to the channel or to us. */
  handlePresence(from: string, value: string): void {
    if (this.view.state !== 'active' || this.same(from, this.o.ownNick())) return
    const p = parsePresence(value)
    if (!p) return
    switch (p.t) {
      case 'join':
        // Tell them we are here, whether or not there is room: they will see the room is full.
        this.o.sendPresence(from, formatPresence({ t: 'here', room: this.o.channel }))
        // Joining again means the old connection is dead, whatever we last heard.
        this.forget(from)
        this.meet(from)
        return
      case 'hello':
        // Someone who lost touch. If we are still connected to them there is nothing to do.
        if (this.peers.get(from.toLowerCase())?.state === 'connected') return
        this.o.sendPresence(from, formatPresence({ t: 'here', room: this.o.channel }))
        this.forget(from)
        this.meet(from)
        return
      case 'here':
        if (p.room.toLowerCase() !== this.o.channel.toLowerCase()) return
        this.answered.add(from.toLowerCase())
        if (this.answered.size >= this.max()) {
          this.leave(`This voice room is full (${this.max()} people).`)
          return
        }
        this.meet(from)
        return
      case 'leave':
        this.forget(from)
        return
    }
  }

  /** An offer, answer or goodbye for this room. */
  handleSignal(from: string, sid: string, s: Signal): void {
    if (this.view.state !== 'active' || typeof s.room !== 'string' || s.room.toLowerCase() !== this.o.channel.toLowerCase()) return
    const key = from.toLowerCase()
    const peer = this.peers.get(key)
    switch (s.t) {
      case 'offer': {
        if (typeof s.sdp !== 'string' || !s.sdp) return
        // A new person when we are full is turned away. A known person's fresh offer replaces the old connection.
        if (!peer && this.live() >= this.max() - 1) {
          this.o.sendSignal(from, sid, { k: 'voice', t: 'bye', room: this.o.channel })
          return
        }
        if (peer) this.dropPeer(peer, true)
        void this.answer(from, sid, s.sdp)
        return
      }
      case 'answer':
        if (peer?.offerer && peer.sid === sid && peer.state === 'connecting' && typeof s.sdp === 'string') {
          clearTimeout(peer.timer)
          peer.timer = setTimeout(() => peer.state === 'connecting' && this.markFailed(peer), 45_000)
          peer.session?.applyAnswer(s.sdp).catch(() => this.markFailed(peer))
        }
        return
      case 'bye':
        if (peer && peer.sid === sid) this.forget(from)
        return
    }
  }

  /** Someone left the channel or the network. */
  memberGone(nick: string): void {
    this.forget(nick)
  }

  /** Someone in the room changed nick. Their connection carries on under the new name. */
  rename(from: string, to: string): void {
    const peer = this.peers.get(from.toLowerCase())
    if (!peer || this.peers.has(to.toLowerCase())) return
    this.peers.delete(from.toLowerCase())
    peer.nick = to
    this.peers.set(to.toLowerCase(), peer)
    this.publish()
  }

  /** Our IRC connection dropped and came back, so we may have missed people joining and leaving. */
  reannounce(): void {
    if (this.view.state === 'active') this.o.sendPresence(this.o.channel, formatPresence({ t: 'hello' }))
  }

  // --- controls ---

  setMuted(muted: boolean): void {
    this.update({ muted })
    this.applyMicrophone()
  }

  /** Switches between an open microphone (mute and unmute) and one that is open only while the talk key is held. */
  setPushToTalk(on: boolean): void {
    if (this.view.listenOnly) return
    this.update({ pushToTalk: on, talking: false })
    this.applyMicrophone()
  }

  /** The talk key or button went down (true) or up (false). Does nothing unless push to talk is on. */
  setTalking(talking: boolean): void {
    if (!this.view.pushToTalk || this.view.state !== 'active' || this.view.talking === talking) return
    this.update({ talking })
    this.applyMicrophone()
  }

  /** True while what the microphone picks up is going out. */
  private sending(): boolean {
    return !!this.local && (this.view.pushToTalk ? this.view.talking : !this.view.muted)
  }

  private applyMicrophone(): void {
    const on = this.sending()
    for (const t of this.local?.getAudioTracks() ?? []) t.enabled = on
  }

  setVolume(nick: string, volume: number): void {
    const p = this.peers.get(nick.toLowerCase())
    if (!p) return
    p.volume = Math.min(1, Math.max(0, volume))
    this.publish()
  }

  // --- internals ---

  private max(): number {
    return this.o.max ?? MAX_VOICE
  }

  /** People we hold or are making a connection to. One whose connection failed does not take up room. */
  private live(): number {
    let n = 0
    for (const p of this.peers.values()) if (p.state !== 'failed') n++
    return n
  }

  private same(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase()
  }

  /** Starts a connection to someone in the room, if there is room and we are the one to offer. */
  private meet(nick: string): void {
    const key = nick.toLowerCase()
    const existing = this.peers.get(key)
    if (existing && existing.state !== 'failed') return
    if (existing) this.dropPeer(existing, true)
    if (this.live() >= this.max() - 1) return
    const offerer = this.o.ownNick().toLowerCase() < key
    const peer = this.addPeer(nick, (this.o.newSid ?? newSessionId)(), offerer)
    if (offerer) void this.offer(peer)
    else this.expectOffer(peer)
  }

  private addPeer(nick: string, sid: string, offerer: boolean): Peer {
    const peer: Peer = {
      nick, sid, offerer, session: null, state: 'connecting', stream: null, meter: null,
      speaking: new Speaking(), isSpeaking: false, volume: 1, code: '', timer: undefined,
    }
    this.peers.set(nick.toLowerCase(), peer)
    this.publish()
    return peer
  }

  /** If the person we expected to offer never does, say so instead of waiting for ever. */
  private expectOffer(peer: Peer): void {
    peer.timer = setTimeout(() => peer.state === 'connecting' && !peer.session && this.markFailed(peer), this.o.offerTimeoutMs ?? 30_000)
  }

  private async session(peer: Peer): Promise<PeerSession> {
    const servers = await this.servers()
    if (this.peers.get(peer.nick.toLowerCase()) !== peer || this.view.state !== 'active') throw new Error('superseded')
    const session: PeerSession = new PeerSession({
      iceServers: servers,
      createConnection: this.o.createConnection,
      stream: this.local ?? undefined,
      receiveAudio: true,
      send: (d) => this.peers.get(peer.nick.toLowerCase()) === peer && this.o.sendSignal(peer.nick, peer.sid, { k: 'voice', t: d.t, room: this.o.channel, sdp: d.sdp }),
      onTrack: (s) => this.peers.get(peer.nick.toLowerCase()) === peer && this.gotStream(peer, s),
      onState: (s) => {
        if (peer.session !== session) return
        if (s === 'connected') {
          clearTimeout(peer.timer)
          peer.state = 'connected'
          const fp = session.fingerprints
          peer.code = safetyCode(fp.local, fp.remote)
          this.publish()
        } else if (s === 'failed' || s === 'closed') this.markFailed(peer)
      },
    })
    peer.session = session
    return session
  }

  /** One request serves everyone who connects in the next few minutes. Later ones ask again, since credentials expire. */
  private servers(): Promise<RTCIceServer[]> {
    const now = Date.now()
    if (!this.ice || now - this.ice.at > 5 * 60_000) {
      this.ice = { at: now, servers: this.o.iceServers().catch(() => [] as RTCIceServer[]) }
    }
    return this.ice.servers
  }

  private async offer(peer: Peer): Promise<void> {
    try {
      const session = await this.session(peer)
      peer.timer = setTimeout(() => peer.state === 'connecting' && this.markFailed(peer), 45_000)
      await session.start()
    } catch {
      if (this.peers.get(peer.nick.toLowerCase()) === peer) this.markFailed(peer)
    }
  }

  private async answer(nick: string, sid: string, sdp: string): Promise<void> {
    const peer = this.addPeer(nick, sid, false)
    try {
      const session = await this.session(peer)
      peer.timer = setTimeout(() => peer.state === 'connecting' && this.markFailed(peer), 45_000)
      await session.accept(sdp)
    } catch {
      if (this.peers.get(nick.toLowerCase()) === peer) this.markFailed(peer)
    }
  }

  private gotStream(peer: Peer, stream: MediaStream): void {
    peer.stream = stream
    peer.meter?.close()
    peer.meter = (this.o.createMeter ?? audioMeter)(stream)
    this.publish()
  }

  private markFailed(peer: Peer): void {
    if (peer.state === 'failed') return
    clearTimeout(peer.timer)
    peer.state = 'failed'
    peer.isSpeaking = false
    peer.meter?.close()
    peer.meter = null
    peer.session?.close()
    this.publish()
  }

  /** Removes someone from the room and closes their connection. */
  private forget(nick: string): void {
    const peer = this.peers.get(nick.toLowerCase())
    if (peer) this.dropPeer(peer, true)
  }

  private dropPeer(peer: Peer, publish: boolean): void {
    clearTimeout(peer.timer)
    peer.meter?.close()
    // Detached before closing: closing reports back, and the report must not mark them failed.
    const session = peer.session
    peer.session = null
    session?.close()
    this.peers.delete(peer.nick.toLowerCase())
    if (publish) this.publish()
  }

  private tick(): void {
    const now = Date.now()
    let changed = false
    const mine = this.localSpeaking.update(this.sending() ? (this.localMeter?.level() ?? 0) : 0, now)
    if (mine !== this.view.speaking) {
      this.view = { ...this.view, speaking: mine }
      changed = true
    }
    for (const p of this.peers.values()) {
      const s = p.state === 'connected' && p.speaking.update(p.meter?.level() ?? 0, now)
      if (s !== p.isSpeaking) {
        p.isSpeaking = s
        changed = true
      }
    }
    if (changed) this.publish()
  }

  private publish(): void {
    const participants = [...this.peers.values()]
      .sort((a, b) => a.nick.localeCompare(b.nick, undefined, { sensitivity: 'base' }))
      .map((p): Participant => ({ nick: p.nick, state: p.state, speaking: p.isSpeaking, volume: p.volume, stream: p.stream, code: p.code }))
    this.update({ participants })
  }

  private update(patch: Partial<RoomView>): void {
    this.view = { ...this.view, ...patch }
    this.o.onChange(this.view)
  }
}

