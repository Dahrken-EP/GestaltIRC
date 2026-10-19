// A voice room: everyone in a channel who has chosen to talk. Each pair of people holds
// one WebRTC connection (a mesh), so there is no media server. The person whose nick sorts
// first makes the offer, which means two people can never both offer at once.
//
// Presence travels as a client-only tag on the channel and the offers and answers as
// signalling messages to each person (see ../p2p/signal.ts); the audio goes browser to browser.

import { PeerSession, safetyCode, type PeerConnectionContext } from '../p2p/peer'
import { newSessionId, type Signal } from '../p2p/signal'
import { voiceSlot, type VoiceSlot } from './active'
import { stopStream } from './media'
import { audioMeter, primeAudio, Speaking, type Meter, type MeterFactory } from './meter'
import type { RoomMixer } from './mixer'
import type { NativeVoice } from '../native/voice'
import type { NativeVoicePC } from '../native/pc'
import { formatPresence, MAX_VOICE, parsePresence } from './presence'

export type PeerConnState = 'connecting' | 'connected' | 'failed'

export interface Participant {
  /** Unique within the room. For a guest it is not a nick on the network. */
  nick: string
  /** What to call them on screen. */
  label: string
  /** Here by a link, with no Gestalt of their own. */
  guest: boolean
  /** For a guest brought by someone else: who. Empty otherwise. Their voice reaches us through that person. */
  via: string
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
  createConnection?: (config: RTCConfiguration, ctx?: PeerConnectionContext) => RTCPeerConnection
  createMeter?: MeterFactory
  newSid?: () => string
  slot?: VoiceSlot
  max?: number
  /** Makes the mixer that lets guests hear the room and the room hear them. Without it a room takes no guests. */
  mixer?: () => RoomMixer | null
  /** How long to wait for someone's offer before giving up on them. */
  offerTimeoutMs?: number
  /** How often speaking is checked, in milliseconds. */
  tickMs?: number
  /** Voice over Rust (the desktop build): the page touches neither microphone nor speakers. */
  nativeVoice?: NativeVoice
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
  /** The connection's native half, when this session runs through the bridge. */
  native: NativeVoicePC | null
}

/** Someone here by a link, who talks to the room through this browser. */
interface GuestPeer {
  nick: string
  name: string
  sid: string
  session: PeerSession | null
  state: PeerConnState
  stream: MediaStream | null
  meter: Meter | null
  speaking: Speaking
  isSpeaking: boolean
  volume: number
  code: string
  timer: ReturnType<typeof setTimeout> | undefined
  /** The guest's native connection, when this room runs through the bridge. */
  native: NativeVoicePC | null
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
  private mixer: RoomMixer | null = null
  /** When the voice runs in Rust: the card for it, and what we tell PeerSession the stream is (the bridge carries no audio). */
  private nat: NativeVoice | null = null
  private ghost: MediaStream | null = null
  /** True when this room's join opened the Rust microphone, so leaving gives the ref back. */
  private micStarted = false
  private guestPeers = new Map<string, GuestPeer>()
  /** Guests other people said they brought, by lower-case nick of whoever brought them. */
  private brought = new Map<string, { from: string; names: string[] }>()
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
    const nat = this.o.nativeVoice ?? null
    this.nat = nat
    primeAudio()
    const epoch = ++this.epoch
    const listenOnly = opts.listenOnly === true
    const pushToTalk = !listenOnly && opts.pushToTalk === true
    this.update({ state: 'joining', error: '' })
    let stream: MediaStream | null = null
    if (nat) {
      // The mic is Rust's. The page asks it to open, and hands PeerSession a stream that
      // means "the bridge owns the sound" — so a session knows to send the Rust mic.
      if (!listenOnly) {
        try {
          await nat.mic().start()
        } catch (e) {
          if (epoch === this.epoch) this.fail(`Could not use the microphone: ${e instanceof Error ? e.message : 'no microphone'}`)
          return
        }
        if (epoch !== this.epoch) {
          nat.mic().stop()
          return
        }
        this.micStarted = true
        this.ghost = nat.ghost()
      }
    } else if (!listenOnly) {
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
    // Loudness: the mic's feed comes from Rust's pass; a real stream is measured here.
    this.localMeter = this.nat && !listenOnly ? this.nat.localMeter() : stream ? (this.o.createMeter ?? audioMeter)(stream) : null
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
    for (const g of [...this.guestPeers.values()]) this.dropGuest(g)
    this.brought.clear()
    this.mixer?.close()
    this.mixer = null
    this.ghost = null
    if (this.micStarted) {
      this.nat?.mic().stop()
      this.micStarted = false
    }
    this.nat = null
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
        this.tellGuests(from)
        // Joining again means the old connection is dead, whatever we last heard.
        this.forget(from)
        this.meet(from)
        return
      case 'hello':
        // Someone who lost touch. If we are still connected to them there is nothing to do.
        if (this.peers.get(from.toLowerCase())?.state === 'connected') return
        this.o.sendPresence(from, formatPresence({ t: 'here', room: this.o.channel }))
        this.tellGuests(from)
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
      case 'guests':
        if (p.names.length) this.brought.set(from.toLowerCase(), { from, names: p.names })
        else this.brought.delete(from.toLowerCase())
        this.publish()
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

  // --- guests ---

  /** The names of the people here by a link, through this browser. */
  get guestNames(): string[] {
    return [...this.guestPeers.values()].map((g) => g.name)
  }

  /** Someone came by a link to this room, and their offer will follow. False if this room cannot take them. */
  guestJoined(nick: string, name: string): boolean {
    // (In the desktop app the microphone is Rust's, so there is no stream of ours to look for.)
    if (this.view.state !== 'active' || (!this.local && !this.nat)) return false
    const key = nick.toLowerCase()
    if (this.guestPeers.has(key)) return true
    // In a browser the page mixes for its guests; in the desktop app Rust does, so there is no mixer to make.
    if (this.live() >= this.max() - 1 || (!this.nat && !this.ensureMixer())) return false
    const g: GuestPeer = {
      nick, name, sid: '', session: null, state: 'connecting', stream: null, meter: null,
      speaking: new Speaking(), isSpeaking: false, volume: 1, code: '', timer: undefined, native: null,
    }
    g.timer = setTimeout(() => g.state === 'connecting' && !g.session && this.guestFailed(g), this.o.offerTimeoutMs ?? 30_000)
    this.guestPeers.set(key, g)
    this.publish()
    this.announceGuests()
    return true
  }

  /** A guest closed their page, or the link ended. */
  guestLeft(nick: string): void {
    const g = this.guestPeers.get(nick.toLowerCase())
    if (!g) return
    this.dropGuest(g)
    this.publish()
    this.announceGuests()
  }

  /** An offer or goodbye from a guest. Returns true if it was for one of this room's guests. */
  handleGuestSignal(nick: string, sid: string, s: Signal): boolean {
    const g = this.guestPeers.get(nick.toLowerCase())
    if (!g) return false
    if (s.t === 'offer' && typeof s.sdp === 'string' && s.sdp) void this.answerGuest(g, sid, s.sdp)
    else if (s.t === 'bye' && sid === g.sid) this.guestLeft(nick)
    return true
  }

  private ensureMixer(): RoomMixer | null {
    // In the desktop app the mixing is Rust's, per connection (see mix_pass in media.rs).
    if (this.nat) return null
    if (this.mixer) return this.mixer
    const m = this.o.mixer?.() ?? null
    if (!m) return null
    this.mixer = m
    m.setMic(this.local)
    for (const p of this.peers.values()) if (p.stream) m.setPeer(p.nick.toLowerCase(), p.stream)
    // Connections made before the first guest sent the bare microphone; from here they send the mix.
    const track = m.outbound.getAudioTracks()[0]
    if (track) for (const p of this.peers.values()) void p.session?.replaceAudio(track)
    return m
  }

  private async answerGuest(g: GuestPeer, sid: string, sdp: string): Promise<void> {
    const key = g.nick.toLowerCase()
    g.sid = sid
    clearTimeout(g.timer)
    g.session?.close()
    g.session = null
    g.state = 'connecting'
    this.publish()
    try {
      const servers = await this.servers()
      const mixer = this.mixer
      if ((!mixer && !this.nat) || this.guestPeers.get(key) !== g || g.sid !== sid || this.view.state !== 'active') return
      const session: PeerSession = new PeerSession({
        iceServers: servers,
        createConnection: this.o.createConnection,
        // A guest is sent the room: from the page's mixer, or in the app a marker that Rust makes that mix for them.
        stream: this.nat ? (this.ghost ?? this.nat.ghost()) : mixer!.addGuest(key),
        receiveAudio: true,
        send: (d) => this.guestPeers.get(key) === g && g.sid === sid && this.o.sendSignal(g.nick, sid, { k: 'voice', t: d.t, sdp: d.sdp }),
        onTrack: (s) => this.guestPeers.get(key) === g && this.gotGuestStream(g, s),
        onState: (s) => {
          if (g.session !== session) return
          if (s === 'connected') {
            clearTimeout(g.timer)
            g.state = 'connected'
            const fp = session.fingerprints
            g.code = safetyCode(fp.local, fp.remote)
            this.publish()
          } else if (s === 'failed' || s === 'closed') this.guestFailed(g)
        },
      })
      g.session = session
      const npc = session.nativeVoice
      if (npc && this.nat) {
        this.nat.wire(npc)
        npc.setUplink('guest:' + key)
        g.native = npc
      }
      g.timer = setTimeout(() => g.state === 'connecting' && this.guestFailed(g), 45_000)
      await session.accept(sdp)
    } catch {
      if (this.guestPeers.get(key) === g && g.sid === sid) this.guestFailed(g)
    }
  }

  private gotGuestStream(g: GuestPeer, stream: MediaStream): void {
    g.stream = stream
    g.meter?.close()
    g.meter = (this.o.createMeter ?? audioMeter)(stream)
    this.mixer?.setGuestSource(g.nick.toLowerCase(), stream)
    this.publish()
  }

  private guestFailed(g: GuestPeer): void {
    if (g.state === 'failed') return
    clearTimeout(g.timer)
    g.state = 'failed'
    g.isSpeaking = false
    g.meter?.close()
    g.meter = null
    this.mixer?.removeGuest(g.nick.toLowerCase())
    const session = g.session
    g.session = null
    session?.close()
    this.publish()
  }

  private dropGuest(g: GuestPeer): void {
    clearTimeout(g.timer)
    g.meter?.close()
    const session = g.session
    g.session = null
    session?.close()
    this.mixer?.removeGuest(g.nick.toLowerCase())
    this.guestPeers.delete(g.nick.toLowerCase())
  }

  /** Tells the channel who we brought, so everyone in the room sees them. */
  private announceGuests(): void {
    if (this.view.state === 'active') this.o.sendPresence(this.o.channel, formatPresence({ t: 'guests', names: this.guestNames }))
  }

  /** Tells one person who we brought, as they arrive. */
  private tellGuests(to: string): void {
    if (this.guestPeers.size) this.o.sendPresence(to, formatPresence({ t: 'guests', names: this.guestNames }))
  }

  /** What the room should send: the microphone, or the mix once guests are in. */
  private outgoing(): MediaStream | null {
    // The bridge carries no audio, so a native room announces its own mic another way.
    return this.nat ? this.ghost : (this.mixer?.outbound ?? this.local)
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
    return this.nat
      ? this.view.pushToTalk ? this.view.talking : !this.view.muted
      : !!this.local && (this.view.pushToTalk ? this.view.talking : !this.view.muted)
  }

  private applyMicrophone(): void {
    if (this.nat) {
      this.nat.mic().mute(!this.sending())
      return
    }
    const on = this.sending()
    for (const t of this.local?.getAudioTracks() ?? []) t.enabled = on
  }

  setVolume(nick: string, volume: number): void {
    const p = this.peers.get(nick.toLowerCase()) ?? this.guestPeers.get(nick.toLowerCase())
    if (!p) return
    p.volume = Math.min(1, Math.max(0, volume))
    // In Rust the volume is applied while mixing; the page's slider only records it.
    p.native?.setVolume(p.volume)
    this.publish()
  }

  // --- internals ---

  private max(): number {
    return this.o.max ?? MAX_VOICE
  }

  /** People we hold or are making a connection to. One whose connection failed does not take up room. */
  private live(): number {
    let n = this.guestPeers.size
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
      speaking: new Speaking(), isSpeaking: false, volume: 1, code: '', timer: undefined, native: null,
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
      stream: this.outgoing() ?? undefined,
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
    const npc = session.nativeVoice
    if (npc && this.nat) {
      this.nat.wire(npc)
      peer.native = npc
    }
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
    this.mixer?.setPeer(peer.nick.toLowerCase(), stream)
    peer.meter?.close()
    peer.meter = (this.o.createMeter ?? audioMeter)(stream)
    this.publish()
  }

  private markFailed(peer: Peer): void {
    if (peer.state === 'failed') return
    this.mixer?.setPeer(peer.nick.toLowerCase(), null)
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
    this.brought.delete(nick.toLowerCase())
    const peer = this.peers.get(nick.toLowerCase())
    if (peer) this.dropPeer(peer, true)
    else this.publish()
  }

  private dropPeer(peer: Peer, publish: boolean): void {
    this.mixer?.setPeer(peer.nick.toLowerCase(), null)
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
    for (const g of this.guestPeers.values()) {
      const s = g.state === 'connected' && g.speaking.update(g.meter?.level() ?? 0, now)
      if (s !== g.isSpeaking) {
        g.isSpeaking = s
        changed = true
      }
    }
    if (changed) this.publish()
  }

  private publish(): void {
    const people = [...this.peers.values()]
      .sort((a, b) => a.nick.localeCompare(b.nick, undefined, { sensitivity: 'base' }))
      .map((p): Participant => ({ nick: p.nick, label: p.nick, guest: false, via: '', state: p.state, speaking: p.isSpeaking, volume: p.volume, stream: p.stream, code: p.code }))
    const mine = [...this.guestPeers.values()]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map((g): Participant => ({ nick: g.nick, label: g.name, guest: true, via: '', state: g.state, speaking: g.isSpeaking, volume: g.volume, stream: g.stream, code: g.code }))
    // Guests of other people have no connection to us. They are listed so everyone sees who is in the room.
    const others = [...this.brought.values()].flatMap(({ from, names }) =>
      names.map((name): Participant => ({ nick: `guest:${from}:${name}`, label: name, guest: true, via: from, state: 'connected', speaking: false, volume: 1, stream: null, code: '' })),
    )
    this.update({ participants: [...people, ...mine, ...others] })
  }

  private update(patch: Partial<RoomView>): void {
    this.view = { ...this.view, ...patch }
    this.o.onChange(this.view)
  }
}

