// Per-network chat state: buffers, members, unread counts. It turns IRC
// messages from one bouncer connection into this state. It knows nothing about
// the socket; lines go out through the `send` callback.

import { parseInput, HELP, type Action } from './commands'
import type { Batch, Status } from './irc/connection'
import { format, isServerPrefix, nickOf, timeOf, type Message } from './irc/message'
import { pageUnfocused } from './notify'
import type { ChatLine, ChatView } from './p2p/chat'
import { encodeRoster, GUEST_TAG, guestLabel, isGuestPrefix, parseGuestEvent, ROSTER_TAG, type RosterEntry } from './guest/protocol'
import { P2pHub, SIGNAL_TAG } from './p2p/hub'
import type { Signal } from './p2p/signal'
import type { PluginEvent } from './plugins/types'
import type { VoiceSlot } from './voice/active'
import { VoiceCall, type CallView } from './voice/call'
import { formatPresence, parsePresence, VOICE_TAG } from './voice/presence'
import type { RoomMixer } from './voice/mixer'
import { VoiceRoom, type RoomView } from './voice/room'
import { mentions } from './render'
import { settings } from './settings.svelte'

export type Kind =
  | 'msg'
  | 'action'
  | 'notice'
  | 'join'
  | 'part'
  | 'quit'
  | 'nick'
  | 'kick'
  | 'mode'
  | 'topic'
  | 'info'
  | 'error'

export interface ChatMessage {
  id: number
  key: string
  time: number
  kind: Kind
  /** Who the line is from. Empty for local lines. */
  nick: string
  text: string
  /** The kicked nick, or the new nick for a nick change. */
  target?: string
  self: boolean
  mention: boolean
  msgid?: string
  /** The msgid this line answers, from the +draft/reply tag. */
  replyTo?: string
}

export interface Member {
  nick: string
  /** Prefix symbols, highest first, such as "@+". */
  prefix: string
  away?: boolean
}

/** Messages kept in memory per buffer. Older ones are fetched again with CHATHISTORY. */
export const MAX_MESSAGES = 1500
const HISTORY_PAGE = 100
/** Private conversations fetched at start: those with a message in this many days, at most this many. */
const CONVERSATION_DAYS = 90
const MAX_CONVERSATIONS = 25
/** How long "is typing" lasts without another update. Clients refresh it every few seconds. */
const TYPING_TTL_MS = 8000
/** Read markers are sent this long after the last change, so reading a busy channel is one message. */
const MARKER_DELAY_MS = 800
/** At most this often is a typing notice sent for one buffer. */
const TYPING_SEND_GAP_MS = 3000

/** Numerics sent while logging in or reading the MOTD. They go to the status buffer. */
const STATUS_NUMERICS: ReadonlySet<number> = new Set([900, 901, 903, 251, 252, 253, 254, 255, 265, 266, 372, 375, 376, 422])

/** Commands a plugin's `send` may not run, because they act on this browser rather than on the network. */
const PLUGIN_FORBIDDEN: ReadonlySet<string> = new Set(['voice', 'call', 'direct', 'open', 'clear', 'help'])

/** Rings from people we have no call with yet, at most this many unanswered at once. */
const MAX_RINGING = 8

const COUNTS_AS_UNREAD: ReadonlySet<Kind> = new Set(['msg', 'action', 'notice'])

let nextId = 1

export class Buffer {
  readonly name: string
  readonly key: string
  readonly kind: 'status' | 'channel' | 'query' | 'p2p'
  /** What to call the buffer on screen. It is the name, except for a guest, whose nick is made up. */
  title = $state('')

  messages = $state.raw<ChatMessage[]>([])
  topic = $state('')
  unread = $state(0)
  mentionCount = $state(0)
  joined = $state(false)
  historyLoading = $state(false)
  historyExhausted = $state(false)
  /** msgid -> emoji -> nicks who reacted with it. */
  reactions = $state.raw<Map<string, Map<string, string[]>>>(new Map())
  /** Nicks currently typing here. */
  typing = $state.raw<string[]>([])
  /** Bumped whenever `members` changes. Read it to depend on the map. */
  membersRev = $state(0)

  /** For a direct chat: the state of the connection, files and all. Null for other buffers. */
  p2p = $state.raw<ChatView | null>(null)
  /** For a channel: the voice room as we have it, once we have joined it. */
  voice = $state.raw<RoomView | null>(null)
  /** For a channel: nicks seen joining its voice room since we connected. A hint, not a roll call. */
  voiceMembers = $state.raw<string[]>([])
  /** For a direct chat: the voice call with that person. */
  call = $state.raw<CallView | null>(null)
  /** For a channel whose voice room we are in with guests allowed: the link a guest can open to join it. */
  guestLink = $state('')
  /** The bouncer's id for that link, so it can be ended. */
  guestInviteId = ''

  /** Lowercase nick -> member. */
  members = new Map<string, Member>()
  /** Time of the newest message the user has seen. */
  lastRead: number
  /** True once the bouncer has told us where this buffer is read to. */
  markerKnown = false
  /** True until the first batch of history for this buffer has been handled. */
  fresh = true
  /** The next 353 reply starts a fresh member list. */
  namesFresh = true

  private seen = new Set<string>()
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(name: string, kind: Buffer['kind'], lastRead: number) {
    this.name = name
    this.title = name
    // A direct chat's key has a prefix, which no nick can contain, so it never collides with a query.
    this.key = kind === 'status' ? '' : kind === 'p2p' ? 'p2p:' + name.toLowerCase() : name.toLowerCase()
    this.kind = kind
    this.lastRead = lastRead
  }

  /** True for buffers that exist on the IRC network, as opposed to the status buffer and direct chats. */
  get onNetwork(): boolean {
    return this.kind === 'channel' || this.kind === 'query'
  }

  /** Adds a message in time order. Returns false when it is a duplicate. */
  insert(m: ChatMessage, trim: boolean): boolean {
    if (this.seen.has(m.key)) return false
    this.seen.add(m.key)

    const arr = this.messages
    const last = arr[arr.length - 1]
    let next: ChatMessage[]
    if (!last || m.time >= last.time) {
      next = [...arr, m]
    } else {
      let lo = 0
      let hi = arr.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (arr[mid]!.time <= m.time) lo = mid + 1
        else hi = mid
      }
      next = [...arr.slice(0, lo), m, ...arr.slice(lo)]
    }
    if (trim && next.length > MAX_MESSAGES) {
      for (const old of next.slice(0, next.length - MAX_MESSAGES)) this.seen.delete(old.key)
      next = next.slice(-MAX_MESSAGES)
      this.historyExhausted = false
    }
    this.messages = next
    return true
  }

  byMsgId(id: string): ChatMessage | undefined {
    return this.messages.find((m) => m.msgid === id)
  }

  /** Removes a message, for a redaction. Returns false if it is not here. */
  removeByMsgId(id: string): boolean {
    const m = this.byMsgId(id)
    if (!m) return false
    this.messages = this.messages.filter((x) => x !== m)
    this.seen.delete(m.key)
    this.reactions.delete(id)
    this.reactions = new Map(this.reactions)
    if (m.time > this.lastRead && !m.self && COUNTS_AS_UNREAD.has(m.kind)) this.recount()
    return true
  }

  clear(): void {
    this.messages = []
    this.seen.clear()
  }

  touchMembers(): void {
    this.membersRev++
  }

  /** Recounts unread and mentions from what is newer than `lastRead`. */
  recount(): void {
    let unread = 0
    let mentioned = 0
    for (const m of this.messages) {
      if (m.time <= this.lastRead || m.self || !COUNTS_AS_UNREAD.has(m.kind)) continue
      unread++
      if (m.mention) mentioned++
    }
    this.unread = unread
    this.mentionCount = mentioned
  }

  markRead(): void {
    this.unread = 0
    this.mentionCount = 0
    const last = this.messages[this.messages.length - 1]
    this.lastRead = Math.max(this.lastRead, last?.time ?? Date.now())
  }

  addReaction(msgid: string, emoji: string, nick: string): void {
    const byEmoji = new Map(this.reactions.get(msgid) ?? [])
    const nicks = byEmoji.get(emoji) ?? []
    if (nicks.some((n) => n.toLowerCase() === nick.toLowerCase())) return
    byEmoji.set(emoji, [...nicks, nick])
    this.reactions = new Map(this.reactions).set(msgid, byEmoji)
  }

  removeReaction(msgid: string, emoji: string, nick: string): void {
    const byEmoji = new Map(this.reactions.get(msgid) ?? [])
    const nicks = (byEmoji.get(emoji) ?? []).filter((n) => n.toLowerCase() !== nick.toLowerCase())
    if (nicks.length) byEmoji.set(emoji, nicks)
    else byEmoji.delete(emoji)
    const next = new Map(this.reactions)
    if (byEmoji.size) next.set(msgid, byEmoji)
    else next.delete(msgid)
    this.reactions = next
  }

  hasReacted(msgid: string, emoji: string, nick: string): boolean {
    return !!this.reactions.get(msgid)?.get(emoji)?.some((n) => n.toLowerCase() === nick.toLowerCase())
  }

  setTyping(nick: string, on: boolean): void {
    const key = nick.toLowerCase()
    clearTimeout(this.typingTimers.get(key))
    this.typingTimers.delete(key)
    const without = this.typing.filter((n) => n.toLowerCase() !== key)
    if (!on) {
      if (without.length !== this.typing.length) this.typing = without
      return
    }
    this.typing = [...without, nick]
    // Typing that is never followed by "done" must not show forever.
    this.typingTimers.set(key, setTimeout(() => this.setTyping(nick, false), TYPING_TTL_MS))
  }

  dispose(): void {
    for (const t of this.typingTimers.values()) clearTimeout(t)
    this.typingTimers.clear()
  }
}

/** What the plugin system offers a network: to hear about events, and to claim a typed command. */
export interface PluginBus {
  emit(ev: PluginEvent): void
  /** True if a plugin took the command, which then goes nowhere else. */
  alias(net: NetworkState, buf: Buffer, name: string, args: string[], raw: string): boolean
}

export interface NetworkHooks {
  plugins?: PluginBus
  /** A mention or private message arrived live and the user may not be looking. */
  onMention(net: NetworkState, buf: Buffer, msg: ChatMessage): void
  /** STUN and TURN servers for a direct connection. */
  iceServers?(): Promise<RTCIceServer[]>
  /** Makes peer connections for direct chats. Tests pass a fake. */
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection
  /** The microphone, for voice rooms and calls. */
  getMedia?: () => Promise<MediaStream>
  /** Which voice chat holds the microphone. One for the whole page unless a test says otherwise. */
  voiceSlot?: VoiceSlot
  /** Makes a one-time link for a guest, and returns its address, or null when guests are not allowed or it failed. */
  guestLink?(req: { network: string; kind: 'room' | 'direct'; target: string }): Promise<{ url: string; id: string } | null>
  /** Ends a link made by `guestLink`. */
  guestRevoke?(id: string): void
  /** What a link is for, by the id the bouncer gives a guest who came by it. */
  guestInvite?(id: string): { kind: 'room' | 'direct'; target: string } | undefined
  /** Makes the mixer that lets guests hear a voice room and be heard in it. */
  mixer?: () => RoomMixer | null
}

/** Someone connected through a link this user made. */
export interface GuestInfo {
  nick: string
  name: string
  inviteId: string
  /** What the link they came by is for. */
  kind: 'room' | 'direct'
  /** The channel for a room, empty for a direct chat. */
  target: string
}

/** How long a request waits for a sign that the other person's client got it before they are sent a link. */
const GESTALT_WAIT_MS = 8_000

export class NetworkState {
  readonly id: string
  readonly login: string
  /** The name this network was given when it was added, which is not the name the network calls itself. */
  readonly name: string
  label = $state('')
  nick = $state('')
  status = $state<Status>('connecting')
  statusDetail = $state('')
  buffers = $state.raw<Buffer[]>([])
  activeKey = $state('')
  /** True while this network is the one on screen. */
  viewing = $state(false)
  /** Capabilities the bouncer acknowledged for this connection. */
  caps = $state.raw<ReadonlySet<string>>(new Set())
  /** A buffer to switch to as soon as it exists, for a notification click that beat the replay. */
  wantOpen = ''

  chanTypes = '#&'
  /** Prefix symbols from highest to lowest, e.g. "@+". */
  prefixSymbols = '@+'
  /** Mode letter -> symbol, e.g. o -> @. */
  prefixModes = new Map<string, string>([
    ['o', '@'],
    ['v', '+'],
  ])
  /** CHANMODES groups A,B,C,D from ISUPPORT. */
  chanModes: [string, string, string, string] = ['beI', 'k', 'l', 'imnpst']

  private readStore: Record<string, number> = {}
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private markerTimer: ReturnType<typeof setTimeout> | undefined
  private dirtyMarkers = new Set<string>()
  /** Markers that arrived before their buffer existed. */
  private pendingMarkers = new Map<string, number>()
  private typingSent = new Map<string, { at: number; active: boolean }>()
  private activateOnJoin = new Set<string>()
  private send: (line: string) => void
  private hooks: NetworkHooks
  private hub: P2pHub
  private rooms = new Map<string, VoiceRoom>()
  private calls = new Map<string, VoiceCall>()
  /** People connected through links this user made, by lower-case nick. */
  guests = $state.raw<ReadonlyMap<string, GuestInfo>>(new Map())
  /** Who has been sent a link lately, so asking twice does not send two. */
  private linkSent = new Map<string, number>()

  constructor(id: string, login: string, nick: string, send: (line: string) => void, hooks: NetworkHooks) {
    this.id = id
    this.login = login
    this.name = login.split('/')[1] ?? login
    this.label = login.split('/')[1] ?? login
    this.nick = nick
    this.send = send
    this.hooks = hooks
    this.readStore = loadReadStore(login)
    this.buffers = [new Buffer(this.label, 'status', 0)]
    this.hub = new P2pHub({
      ownNick: () => this.nick,
      iceServers: () => this.hooks.iceServers?.() ?? Promise.resolve([]),
      sendSignalLine: (peer, value) => this.tagmsg(peer, SIGNAL_TAG, value),
      createConnection: hooks.createConnection,
      onSignal: (from, sid, payload) => this.onVoiceSignal(from, sid, payload),
      onView: (peer, view) => this.onDirectView(peer, view),
      onLine: (peer, line) => this.onDirectLine(peer, line),
    })
  }

  get statusBuffer(): Buffer {
    return this.buffers[0]!
  }

  get active(): Buffer {
    return this.find(this.activeKey) ?? this.statusBuffer
  }

  /** Total unread across buffers, and whether any holds a mention. */
  get unread(): number {
    return this.buffers.reduce((n, b) => n + b.unread, 0)
  }

  get mentionCount(): number {
    return this.buffers.reduce((n, b) => n + b.mentionCount, 0)
  }

  get canRedact(): boolean {
    return this.caps.has('draft/message-redaction')
  }

  /** Records what the bouncer agreed to, once the connection is up. */
  setCaps(caps: ReadonlySet<string>): void {
    this.caps = new Set(caps)
    this.tellPluginsConnection('CONNECT')
    // A reconnect: we may have missed people joining and leaving the voice rooms we are in.
    for (const room of this.rooms.values()) room.reannounce()
  }

  find(key: string): Buffer | undefined {
    return this.buffers.find((b) => b.key === key.toLowerCase())
  }

  isChannel(name: string): boolean {
    return !!name && this.chanTypes.includes(name[0]!)
  }

  isSelf(nick: string): boolean {
    return nick.toLowerCase() === this.nick.toLowerCase()
  }

  /** Returns the buffer for `name`, creating it if needed. */
  buffer(name: string): Buffer {
    const existing = this.find(name)
    if (existing) return existing
    const kind = this.isChannel(name) ? 'channel' : 'query'
    const key = name.toLowerCase()
    // With read markers, a buffer starts unread-everything and the bouncer's marker
    // says where reading stopped. Without them, a new buffer starts with nothing unread.
    const fallback = this.caps.has('draft/read-marker') ? 0 : Date.now()
    const buf = new Buffer(name, kind, this.readStore[key] ?? fallback)
    this.buffers = [...this.buffers, buf].sort((a, b) => (a.kind === 'status' ? -1 : b.kind === 'status' ? 1 : bufferOrder(a, b)))
    const pending = this.pendingMarkers.get(key)
    if (pending !== undefined) {
      this.pendingMarkers.delete(key)
      this.applyMarker(buf, pending)
    }
    if (this.wantOpen === key) {
      this.wantOpen = ''
      this.select(key)
    }
    return buf
  }

  // --- voice ---

  get canVoice(): boolean {
    return this.caps.has('message-tags')
  }

  private tagmsg(target: string, tag: string, value: string): void {
    this.send(format({ tags: { [tag]: value }, command: 'TAGMSG', params: [target] }))
  }

  private roomFor(buf: Buffer): VoiceRoom {
    let room = this.rooms.get(buf.key)
    if (!room) {
      room = new VoiceRoom({
        channel: buf.name,
        ownNick: () => this.nick,
        sendPresence: (target, value) => this.tagmsg(target, VOICE_TAG, value),
        sendSignal: (peer, sid, payload) => this.hub.send(peer, sid, payload),
        iceServers: () => this.hooks.iceServers?.() ?? Promise.resolve([]),
        getMedia: () => this.getMedia(),
        createConnection: this.hooks.createConnection,
        slot: this.hooks.voiceSlot,
        mixer: this.hooks.mixer,
        onChange: (v) => this.onRoomView(buf, v),
      })
      this.rooms.set(buf.key, room)
    }
    return room
  }

  private onRoomView(buf: Buffer, v: RoomView): void {
    const before = buf.voice?.state
    buf.voice = v
    if (before !== 'active' && v.state === 'active' && !v.listenOnly) void this.announceVoice(buf)
    else if (before === 'active' && v.state !== 'active') this.endVoiceLink(buf)
    this.sendRoster(buf)
  }

  /**
   * With guests allowed, joining a voice room makes a link and says so in the channel, so anyone can join from a
   * browser. The link lives as long as the user is in the room. A listener has no voice to relay guests through, so
   * gets no link.
   */
  private async announceVoice(buf: Buffer): Promise<void> {
    if (!this.hooks.guestLink) return
    let made: { url: string; id: string } | null = null
    try {
      made = await this.hooks.guestLink({ network: this.name, kind: 'room', target: buf.name })
    } catch {
      made = null
    }
    if (!made) return
    if (buf.voice?.state !== 'active' || buf.voice.listenOnly) {
      // They left while the link was being made.
      this.hooks.guestRevoke?.(made.id)
      return
    }
    buf.guestLink = made.url
    buf.guestInviteId = made.id
    if (settings.announceVoice && buf.joined) {
      this.send(`PRIVMSG ${buf.name} :\x01ACTION has entered voice chat. Join from any browser, no account needed: ${made.url}\x01`)
    }
  }

  private endVoiceLink(buf: Buffer): void {
    if (buf.guestInviteId) this.hooks.guestRevoke?.(buf.guestInviteId)
    buf.guestLink = ''
    buf.guestInviteId = ''
  }

  private rosterSent = new Map<string, { value: string; at: number; timer?: ReturnType<typeof setTimeout> }>()

  /** Tells the guests of a room who is in it, when that changes, and at most a few times a second. */
  private sendRoster(buf: Buffer, force = false): void {
    const here = [...this.guests.values()].filter((g) => g.kind === 'room' && g.target.toLowerCase() === buf.key)
    const state = this.rosterSent.get(buf.key)
    if (here.length === 0 || buf.voice?.state !== 'active') {
      if (state?.timer) clearTimeout(state.timer)
      this.rosterSent.delete(buf.key)
      return
    }
    const v = buf.voice
    const entries: RosterEntry[] = [
      { name: this.nick, guest: false, host: true, speaking: v.speaking },
      ...v.participants.filter((p) => p.state === 'connected' || (p.guest && p.state !== 'failed')).map((p) => ({ name: p.label, guest: p.guest, host: false, speaking: p.speaking })),
    ]
    const value = encodeRoster(entries)
    const now = Date.now()
    if (!force && state?.value === value) return
    if (!force && state && now - state.at < 300) {
      if (!state.timer) state.timer = setTimeout(() => ((state.timer = undefined), this.sendRoster(buf)), 300)
      return
    }
    if (state?.timer) clearTimeout(state.timer)
    this.rosterSent.set(buf.key, { value, at: now })
    for (const g of here) this.tagmsg(g.nick, ROSTER_TAG, value)
  }

  private getMedia(): Promise<MediaStream> {
    if (!this.hooks.getMedia) return Promise.reject(new Error('this browser cannot record audio'))
    return this.hooks.getMedia()
  }

  voiceRoom(buf: Buffer): VoiceRoom {
    return this.roomFor(buf)
  }

  /** Joins the channel's voice room. `listenOnly` joins without a microphone; push to talk follows the setting. */
  joinVoice(buf: Buffer, listenOnly = false): void {
    if (buf.kind === 'channel' && buf.joined && this.canVoice) void this.roomFor(buf).join({ listenOnly, pushToTalk: settings.pushToTalk })
  }

  leaveVoice(buf: Buffer): void {
    this.rooms.get(buf.key)?.leave()
  }

  /** Voice calls are with one person, from their direct chat window. */
  callFor(nick: string): VoiceCall {
    const key = nick.toLowerCase()
    let call = this.calls.get(key)
    if (!call) {
      call = new VoiceCall({
        wins: () => this.nick.toLowerCase() < key,
        sendSignal: (sid, payload) => this.hub.send(nick, sid, payload),
        iceServers: () => this.hooks.iceServers?.() ?? Promise.resolve([]),
        getMedia: () => this.getMedia(),
        createConnection: this.hooks.createConnection,
        slot: this.hooks.voiceSlot,
        onChange: (v) => this.onCallView(nick, v),
      })
      this.calls.set(key, call)
    }
    return call
  }

  /** Opens the direct chat window with `nick` and rings them. */
  callNick(nick: string): void {
    const problem = this.directProblem(nick)
    if (problem) {
      this.local(this.active, 'error', problem.replace('direct chat', 'call'))
      return
    }
    const buf = this.directBuffer(nick)
    this.select(buf.key)
    void this.callFor(nick).invite()
    this.watchForGestalt(nick, 'call')
  }

  private onCallView(peer: string, view: CallView): void {
    const buf = this.directBuffer(peer)
    const before = buf.call?.state
    buf.call = view
    if (before === view.state) return
    if (view.state === 'incoming') {
      this.local(buf, 'info', `${peer} is calling. Your microphone stays off until you answer.`)
      if (this.activeKey !== buf.key || !this.viewing || pageUnfocused()) {
        buf.unread++
        buf.mentionCount++
        this.hooks.onMention(this, buf, {
          id: nextId++, key: 'call-incoming', time: Date.now(), kind: 'msg', nick: peer,
          text: 'is calling you', self: false, mention: true,
        })
      }
    } else if (view.state === 'ended') {
      this.local(buf, 'info', view.reason ? `Call ended. ${view.reason}` : 'Call ended.')
    }
  }

  /** The voice room a guest came to, if they came by a link to one and we are still in it. */
  private roomOfGuest(nick: string): VoiceRoom | undefined {
    const g = this.guests.get(nick.toLowerCase())
    if (!g || g.kind !== 'room') return undefined
    const buf = this.find(g.target)
    return buf ? this.rooms.get(buf.key) : undefined
  }

  private onVoiceSignal(from: string, sid: string, payload: Signal): void {
    if (payload.k !== 'voice') return
    // A guest of a room is answered by the room, which mixes them in, not rung through as a private call.
    if (!payload.room && this.isGuest(from) && this.roomOfGuest(from)?.handleGuestSignal(from, sid, payload)) return
    if (typeof payload.room === 'string' && payload.room) {
      // Only someone in the channel can be in its voice room. Anyone else sending an offer would otherwise
      // be answered with our microphone.
      if (this.inChannel(payload.room, from)) this.rooms.get(payload.room.toLowerCase())?.handleSignal(from, sid, payload)
      return
    }
    // A call, which has no room. Only an offer can start one.
    const existing = this.calls.get(from.toLowerCase())
    if (existing) existing.handleSignal(sid, payload)
    else if (payload.t === 'offer') {
      // Strangers' rings are limited like their chat requests, so many nicks cannot flood the window list.
      const ringing = [...this.calls.values()].filter((c) => c.state === 'incoming').length
      if (ringing < MAX_RINGING) this.callFor(from).handleSignal(sid, payload)
    }
  }

  /** Someone's voice presence tag, sent to a channel (join, leave) or to us (here). */
  private onVoicePresence(from: string, target: string, value: string): void {
    const p = parsePresence(value)
    if (!p) return
    if (this.isChannel(target)) {
      const buf = this.find(target)
      if (!buf) return
      const others = buf.voiceMembers.filter((n) => n.toLowerCase() !== from.toLowerCase())
      if (p.t === 'join') buf.voiceMembers = [...others, from]
      else if (p.t === 'leave') buf.voiceMembers = others
      this.rooms.get(buf.key)?.handlePresence(from, value)
    } else if (p.t === 'here' && this.inChannel(p.room, from)) {
      this.rooms.get(p.room.toLowerCase())?.handlePresence(from, value)
    }
  }

  private inChannel(channel: string, nick: string): boolean {
    return !!this.find(channel)?.members.has(nick.toLowerCase())
  }

  private voiceGone(nick: string, buf?: Buffer): void {
    for (const b of buf ? [buf] : this.buffers) {
      if (b.kind !== 'channel') continue
      b.voiceMembers = b.voiceMembers.filter((n) => n.toLowerCase() !== nick.toLowerCase())
      this.rooms.get(b.key)?.memberGone(nick)
    }
  }

  /** True for someone who is here through one of our links, not a person on the network. */
  isGuest(nick: string): boolean {
    return this.guests.has(nick.toLowerCase())
  }

  /** How to name someone on screen. */
  displayName(nick: string): string {
    const g = this.guests.get(nick.toLowerCase())
    return g ? guestLabel(g.name) : nick
  }

  private onGuestEvent(nick: string, value: string): void {
    const ev = parseGuestEvent(value)
    if (!ev) return
    const key = nick.toLowerCase()
    const next = new Map(this.guests)
    if (ev.t === 'join') {
      const invite = this.hooks.guestInvite?.(ev.inviteId)
      const info: GuestInfo = { nick, name: ev.name, inviteId: ev.inviteId, kind: invite?.kind ?? 'direct', target: invite?.target ?? '' }
      next.set(key, info)
      this.guests = next
      const buf = this.find('p2p:' + key)
      if (buf) buf.title = guestLabel(ev.name)
      this.local(this.active, 'info', `${guestLabel(ev.name)} joined by your link.`)
      if (info.kind === 'room') {
        const room = this.find(info.target)
        if (!room || !this.rooms.get(room.key)?.guestJoined(nick, ev.name)) {
          this.local(this.active, 'error', `${guestLabel(ev.name)} could not be put in the voice room: it is full, or you are not in it.`)
        } else this.sendRoster(room, true)
      }
      return
    }
    const g = next.get(key)
    if (!g) return
    next.delete(key)
    this.guests = next
    this.local(this.find('p2p:' + key) ?? this.active, 'info', `${guestLabel(g.name)} left.`)
    if (g.kind === 'room') {
      const room = this.find(g.target)
      if (room) this.rooms.get(room.key)?.guestLeft(nick)
    }
  }

  /** Opens a direct chat with `nick` and asks them to connect. */
  openDirect(nick: string, invite = true): void {
    // Without a way to set up the connection, a link is the only way to reach them.
    if (invite && !this.caps.has('message-tags') && this.hooks.guestLink) {
      void this.sendGuestLink(nick, 'this network cannot carry the request for a direct chat')
      return
    }
    const problem = this.directProblem(nick)
    if (problem) {
      this.local(this.active, 'error', problem)
      return
    }
    const buf = this.directBuffer(nick)
    this.select(buf.key)
    if (invite && buf.p2p?.state !== 'connected') {
      void this.hub.chat(nick).invite()
      this.watchForGestalt(nick, 'chat')
    }
  }

  /**
   * Their client confirms it got a request as soon as it does, before they have decided anything. If no
   * confirmation comes, they probably do not use Gestalt, and the way to reach them is a link to a web page.
   */
  private watchForGestalt(nick: string, what: 'chat' | 'call'): void {
    if (!this.hooks.guestLink) return
    setTimeout(() => {
      const buf = this.find('p2p:' + nick.toLowerCase())
      const waiting = what === 'chat' ? buf?.p2p : buf?.call
      if (!waiting || waiting.state !== 'calling' || waiting.acked) return
      void this.sendGuestLink(nick, 'no sign that their client received the request')
    }, GESTALT_WAIT_MS)
  }

  /** Sends `nick` a one-time link to a page where they can talk to us from a browser, and says so here. */
  private async sendGuestLink(nick: string, why: string): Promise<void> {
    const key = nick.toLowerCase()
    const now = Date.now()
    if (now - (this.linkSent.get(key) ?? 0) < 10 * 60_000) return
    this.linkSent.set(key, now)
    const where = this.find('p2p:' + key) ?? this.active
    let url: string | null = null
    try {
      url = (await this.hooks.guestLink?.({ network: this.name, kind: 'direct', target: nick }))?.url ?? null
    } catch {
      url = null
    }
    if (!url) {
      this.linkSent.delete(key)
      this.local(where, 'error', why.startsWith('this network') ? 'This network does not support message tags, which direct chat needs to set up the connection.' : 'No reply came.')
      return
    }
    this.send(`PRIVMSG ${nick} :Hi, ${this.nick} would like to talk with you directly. If your IRC client cannot, open this one-time link in a web browser to join: ${url} (it works once, for 30 minutes)`)
    this.local(where, 'info', `${nick} did not answer (${why}), so they were sent a one-time link to join from a browser. It works once, for 30 minutes.`)
  }

  /** Why a direct chat with `nick` cannot be started, or '' when it can. Checked before anything is sent: the offer carries the sender's network address. */
  private directProblem(nick: string): string {
    if (!/^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,63}$/.test(nick)) return `"${nick}" is not a nick. A direct chat is with one person.`
    if (this.isSelf(nick)) return 'You cannot start a direct chat with yourself.'
    if (!this.caps.has('message-tags')) return 'This network does not support message tags, which direct chat needs to set up the connection.'
    return ''
  }

  private directBuffer(nick: string): Buffer {
    const key = 'p2p:' + nick.toLowerCase()
    const existing = this.find(key)
    if (existing) return existing
    const buf = new Buffer(nick, 'p2p', Date.now())
    if (this.isGuest(nick)) buf.title = this.displayName(nick)
    this.buffers = [...this.buffers, buf].sort((a, b) => (a.kind === 'status' ? -1 : b.kind === 'status' ? 1 : bufferOrder(a, b)))
    return buf
  }

  /** Who the direct chat is with, and what it can do right now, for the page. */
  directChat(buf: Buffer) {
    return this.hub.chat(buf.name)
  }

  private onDirectView(peer: string, view: ChatView): void {
    const buf = this.directBuffer(peer)
    const before = buf.p2p?.state
    buf.p2p = view
    if (before === view.state) return
    switch (view.state) {
      case 'incoming':
        if (this.isGuest(peer)) {
          // They came by a link we made, which is the request, so there is nothing more to ask.
          this.local(buf, 'info', `${this.displayName(peer)} is connecting by your link.`)
          void this.hub.chat(peer).acceptIncoming()
          break
        }
        this.local(buf, 'info', `${peer} wants to start a direct chat. Nothing is connected until you accept.`)
        if (this.activeKey !== buf.key || !this.viewing || pageUnfocused()) {
          buf.unread++
          buf.mentionCount++
          this.hooks.onMention(this, buf, {
            id: nextId++, key: 'p2p-incoming', time: Date.now(), kind: 'msg', nick: peer,
            text: 'wants to start a direct chat', self: false, mention: true,
          })
        }
        break
      case 'connected':
        this.local(buf, 'info', 'Connected directly. Messages and files go straight between the two browsers.')
        break
      case 'ended':
        this.local(buf, 'info', view.reason ? `Direct chat ended. ${view.reason}` : 'Direct chat ended.')
        break
    }
  }

  private onDirectLine(peer: string, line: ChatLine): void {
    const buf = this.directBuffer(peer)
    this.push(
      buf,
      { kind: 'msg', nick: line.self ? this.nick : this.displayName(peer), text: line.text, time: line.time, self: line.self, mention: !line.self, key: 'p2p|' + line.id },
      false,
    )
  }

  select(key: string): void {
    this.activeKey = key.toLowerCase()
    this.markActiveRead()
  }

  /** The user is looking at the active buffer, so everything in it counts as read. */
  markActiveRead(): void {
    const buf = this.active
    buf.markRead()
    this.queueMarker(buf)
    this.saveReadSoon()
  }

  removeBuffer(buf: Buffer): void {
    if (buf.kind === 'status') return
    if (buf.kind === 'p2p') {
      this.hub.close(buf.name)
      this.calls.get(buf.name.toLowerCase())?.dispose()
      this.calls.delete(buf.name.toLowerCase())
    }
    if (buf.kind === 'channel') {
      this.rooms.get(buf.key)?.dispose()
      this.rooms.delete(buf.key)
    }
    buf.dispose()
    this.buffers = this.buffers.filter((b) => b !== buf)
    if (this.activeKey === buf.key) this.activeKey = ''
    delete this.readStore[buf.key]
    this.saveReadSoon()
  }

  /** Closes a buffer: parts a channel, drops a query. */
  closeBuffer(buf: Buffer): void {
    if (buf.kind === 'channel' && buf.joined) this.send(`PART ${buf.name}`)
    else this.removeBuffer(buf)
  }

  openQuery(nick: string): void {
    const buf = this.buffer(nick)
    this.select(buf.key)
  }

  /** Called when the connection drops. Channel state is rebuilt when the bouncer replays it. */
  connectionLost(): void {
    this.tellPluginsConnection('DISCONNECT')
    for (const b of this.buffers) {
      b.typing = []
      if (b.kind !== 'channel') continue
      b.voiceMembers = [] // what we saw before may no longer be true; the next tags rebuild it
      b.joined = false
      b.members.clear()
      b.namesFresh = true
      b.touchMembers()
    }
  }

  // --- input ---

  /**
   * Handles text typed in the active buffer. Each line is a message or a command.
   * `replyTo` is the msgid of the message being answered, if any; it is attached to
   * plain messages, not to commands.
   */
  submit(input: string, replyTo?: string): void {
    this.submitIn(this.active, input, replyTo, true)
  }

  /**
   * Sends text as if it were typed in the window called `bufferName` (the one on screen if empty or
   * not found). Used by plugins, whose lines never run other plugins' aliases, so two cannot set each other off.
   */
  submitTo(bufferName: string, input: string): void {
    this.submitIn((bufferName && this.find(bufferName)) || this.active, input, undefined, false)
  }

  private submitIn(buf: Buffer, input: string, replyTo: string | undefined, aliases: boolean): void {
    for (const line of input.split(/\r?\n/)) {
      if (!line.trim()) continue
      if (aliases && this.hooks.plugins) {
        const m = /^\/([A-Za-z][A-Za-z0-9_]*)(?:\s+(.*))?$/.exec(line.trim())
        if (m) {
          const rest = (m[2] ?? '').trim()
          if (this.hooks.plugins.alias(this, buf, m[1]!.toLowerCase(), rest ? rest.split(/\s+/) : [], rest)) continue
        }
      }
      if (buf.kind === 'p2p') {
        // A direct chat is between two people. A plugin may not speak in it, any more than it may listen.
        if (!aliases) {
          this.local(this.statusBuffer, 'error', 'A plugin tried to write in a direct chat, which plugins may not do.')
          continue
        }
        this.submitDirect(buf, line)
        continue
      }
      const inBuffer = buf.kind !== 'status'
      for (const a of parseInput(line, { target: inBuffer ? buf.name : '', inBuffer, chanTypes: this.chanTypes })) {
        // "Send as me" from a plugin means lines for the network. Commands that act on this browser (the
        // microphone, a connection to someone, the window list) are the user's to give.
        if (!aliases && PLUGIN_FORBIDDEN.has(a.type)) {
          this.local(buf, 'error', 'A plugin tried a command that only you can give, so it was not run.')
          continue
        }
        this.run(a, buf, replyTo)
      }
    }
    // Sending ends any typing notice for this buffer.
    this.sendTyping(buf, 'done')
  }

  private submitDirect(buf: Buffer, line: string): void {
    const text = line.startsWith('//') ? line.slice(1) : line
    if (text.startsWith('/')) {
      this.local(buf, 'error', 'Commands do not work in a direct chat. Use the buttons above, or open the channel or status window.')
      return
    }
    if (!this.hub.chat(buf.name).sendChat(text)) this.local(buf, 'error', 'Not connected, so that was not sent.')
  }

  private run(a: Action, buf: Buffer, replyTo?: string): void {
    switch (a.type) {
      case 'raw': {
        if (/^JOIN /i.test(a.line)) {
          const first = a.line.slice(5).split(' ')[0]!.split(',')[0]!
          this.activateOnJoin.add(first.toLowerCase())
        }
        if (replyTo && a.line.startsWith('PRIVMSG ') && this.caps.has('message-tags')) {
          this.send(format({ tags: { '+draft/reply': replyTo }, command: 'PRIVMSG', params: this.splitPrivmsg(a.line) }))
        } else {
          this.send(a.line)
        }
        break
      }
      case 'open':
        this.openQuery(a.target)
        break
      case 'direct':
        this.openDirect(a.target)
        break
      case 'call':
        this.callNick(a.target)
        break
      case 'voice':
        if (buf.kind !== 'channel') this.local(buf, 'error', '/voice works in a channel.')
        else if (!this.canVoice) this.local(buf, 'error', 'This network does not support message tags, which voice needs.')
        else if (a.on) this.joinVoice(buf, a.listen === true)
        else this.leaveVoice(buf)
        break
      case 'clear':
        buf.clear()
        break
      case 'help':
        for (const line of HELP.split('\n')) this.local(buf, 'info', line)
        break
      case 'error':
        this.local(buf, 'error', a.text)
        break
    }
  }

  /** Splits "PRIVMSG target :text" into its parameters. */
  private splitPrivmsg(line: string): string[] {
    const rest = line.slice('PRIVMSG '.length)
    const sp = rest.indexOf(' :')
    return sp < 0 ? [rest] : [rest.slice(0, sp), rest.slice(sp + 2)]
  }

  /** Adds a line that exists only in this browser. */
  local(buf: Buffer, kind: Kind, text: string): void {
    this.push(buf, { kind, nick: '', text, time: Date.now(), self: false, mention: false }, false)
  }

  // --- typing, reactions, redaction ---

  /** Tells the channel whether we are typing. Throttled, and off unless the user opted in. */
  sendTyping(buf: Buffer, state: 'active' | 'done'): void {
    if (!buf.onNetwork || !settings.sendTyping || !this.caps.has('message-tags')) return
    const prev = this.typingSent.get(buf.key)
    const now = Date.now()
    if (state === 'active' && prev?.active && now - prev.at < TYPING_SEND_GAP_MS) return
    if (state === 'done' && !prev?.active) return
    this.typingSent.set(buf.key, { at: now, active: state === 'active' })
    this.send(format({ tags: { '+typing': state }, command: 'TAGMSG', params: [buf.name] }))
  }

  /** Reacts to a message, or removes our reaction if we already made it. */
  react(buf: Buffer, msg: ChatMessage, emoji: string): void {
    if (!msg.msgid || !buf.onNetwork || !this.caps.has('message-tags')) return
    const removing = buf.hasReacted(msg.msgid, emoji, this.nick)
    const tags: Record<string, string> = removing
      ? { '+draft/unreact': emoji, '+draft/reply': msg.msgid }
      : { '+draft/react': emoji, '+draft/reply': msg.msgid }
    this.send(format({ tags, command: 'TAGMSG', params: [buf.name] }))
    // Show it at once. A network that echoes TAGMSG will repeat it, which changes nothing.
    if (removing) buf.removeReaction(msg.msgid, emoji, this.nick)
    else buf.addReaction(msg.msgid, emoji, this.nick)
  }

  /** Asks the network to delete one of our messages. It disappears when the network confirms. */
  redact(buf: Buffer, msg: ChatMessage): void {
    if (!msg.msgid || !this.canRedact) return
    this.send(`REDACT ${buf.name} ${msg.msgid}`)
  }

  // --- read markers ---

  private applyMarker(buf: Buffer, ms: number): void {
    // The first marker is the bouncer's record and replaces our guess. After that
    // markers only move forward, because the bouncer never moves one back.
    buf.lastRead = buf.markerKnown ? Math.max(buf.lastRead, ms) : ms
    buf.markerKnown = true
    buf.recount()
  }

  private queueMarker(buf: Buffer): void {
    if (!buf.onNetwork || !this.caps.has('draft/read-marker') || buf.lastRead <= 0) return
    this.dirtyMarkers.add(buf.key)
    if (this.markerTimer) return
    this.markerTimer = setTimeout(() => this.flushMarkers(), MARKER_DELAY_MS)
  }

  private flushMarkers(): void {
    this.markerTimer = undefined
    for (const key of this.dirtyMarkers) {
      const buf = this.find(key)
      if (buf && buf.lastRead > 0) this.send(`MARKREAD ${buf.name} timestamp=${new Date(buf.lastRead).toISOString()}`)
    }
    this.dirtyMarkers.clear()
  }

  private onMarkRead(m: Message): void {
    const target = m.params[0] ?? ''
    const value = (m.params[1] ?? '').replace(/^timestamp=/, '')
    if (!target) return
    const ms = value === '*' || value === '' ? 0 : Date.parse(value)
    if (Number.isNaN(ms)) return
    const buf = this.find(target)
    if (buf) this.applyMarker(buf, ms)
    else this.pendingMarkers.set(target.toLowerCase(), ms)
  }

  // --- history ---

  /** Asks the bouncer for messages older than the oldest one shown. */
  loadOlder(buf: Buffer): void {
    if (!buf.onNetwork || buf.historyLoading || buf.historyExhausted) return
    const oldest = buf.messages[0]
    const at = oldest ? new Date(oldest.time).toISOString() : null
    buf.historyLoading = true
    this.send(`CHATHISTORY BEFORE ${buf.name} ${at ? 'timestamp=' + at : '*'} ${HISTORY_PAGE}`)
  }

  /**
   * Private conversations are not joined, so nothing else tells this page they exist after a reload. The bouncer
   * lists the buffers that had a message lately, and handleBatch asks for the latest of each.
   */
  private askForConversations(): void {
    if (!this.caps.has('chathistory') && !this.caps.has('draft/chathistory')) return
    const now = Date.now()
    this.send(`CHATHISTORY TARGETS timestamp=${new Date(now - CONVERSATION_DAYS * 86_400_000).toISOString()} timestamp=${new Date(now + 86_400_000).toISOString()} ${MAX_CONVERSATIONS}`)
  }

  handleBatch(b: Batch): void {
    if (b.type === 'draft/chathistory-targets' || b.type === 'chathistory-targets') {
      const names: string[] = []
      for (const m of b.messages) {
        const name = m.command === 'CHATHISTORY' && m.params[0]?.toUpperCase() === 'TARGETS' ? (m.params[1] ?? '') : ''
        if (name && !this.isChannel(name) && name !== '*') names.push(name)
      }
      // Newest last, so the newest are the ones kept if there are many.
      for (const name of names.slice(-MAX_CONVERSATIONS)) this.send(`CHATHISTORY LATEST ${name} * ${HISTORY_PAGE}`)
      return
    }
    if (b.type !== 'chathistory') {
      for (const m of b.messages) this.handleMessage(m)
      return
    }
    const key = (b.params[0] ?? '').toLowerCase()
    const before = this.find(key)?.messages.length ?? 0
    for (const m of b.messages) this.handleMessage(m, true)
    const target = key ? this.find(key) : undefined
    if (!target) return
    if (target.historyLoading) {
      target.historyLoading = false
      if (target.messages.length === before) target.historyExhausted = true
    }
    this.settleFirstHistory(target)
  }

  /**
   * The first history that arrives for a buffer nobody has marked as read. With no
   * marker from the bouncer and no saved position, "unread" means nothing yet, so
   * what is already there counts as read. A marker that arrives later overrides this.
   */
  private settleFirstHistory(buf: Buffer): void {
    if (!buf.fresh) return
    buf.fresh = false
    if (buf.markerKnown || buf.lastRead !== 0) return
    const newest = buf.messages[buf.messages.length - 1]
    if (!newest) return
    buf.lastRead = newest.time
    buf.recount()
  }

  // --- incoming ---

  handleMessage(m: Message, history = false): void {
    switch (m.command) {
      case '001':
        this.nick = m.params[0] ?? this.nick
        this.local(this.statusBuffer, 'info', m.params[1] ?? 'Connected')
        this.askForConversations()
        break
      case '005':
        this.parseIsupport(m.params.slice(1, -1))
        break
      case 'PRIVMSG':
      case 'NOTICE':
        this.onText(m, history)
        break
      case 'TAGMSG':
        this.onTagmsg(m, history)
        break
      case 'MARKREAD':
        this.onMarkRead(m)
        break
      case 'REDACT':
        this.onRedact(m)
        break
      case 'AWAY':
        this.onAway(m)
        break
      case 'JOIN':
        this.onJoin(m, history)
        break
      case 'PART':
        this.onPart(m, history)
        break
      case 'KICK':
        this.onKick(m)
        break
      case 'QUIT':
        this.onQuit(m)
        break
      case 'NICK':
        this.onNick(m)
        break
      case 'TOPIC':
        this.onTopic(m)
        break
      case 'MODE':
        this.onMode(m)
        break
      case 'INVITE':
        this.local(this.active, 'info', `${nickOf(m.prefix)} invited you to ${m.params[1] ?? ''}`)
        break
      case '332': {
        const buf = this.find(m.params[1] ?? '')
        if (buf) buf.topic = m.params[2] ?? ''
        break
      }
      case '331': {
        const buf = this.find(m.params[1] ?? '')
        if (buf) buf.topic = ''
        break
      }
      case '353':
        this.onNames(m)
        break
      case '366': {
        const buf = this.find(m.params[1] ?? '')
        if (buf) {
          buf.namesFresh = true
          buf.touchMembers()
        }
        break
      }
      case 'ERROR':
        this.local(this.statusBuffer, 'error', m.params[0] ?? 'Connection error')
        break
      case 'FAIL':
      case 'WARN':
      case 'NOTE':
        this.local(this.active, m.command === 'NOTE' ? 'info' : 'error', m.params.slice(1).join(' '))
        break
      default:
        if (/^\d{3}$/.test(m.command)) this.onNumeric(m)
    }
  }

  private parseIsupport(tokens: string[]): void {
    for (const t of tokens) {
      const [k, v = ''] = [t.split('=')[0]!, t.slice(t.indexOf('=') + 1)]
      if (k === 'CHANTYPES' && v) this.chanTypes = v
      else if (k === 'NETWORK' && v) {
        this.label = v
      } else if (k === 'PREFIX') {
        const mm = /^\((.*)\)(.*)$/.exec(v)
        if (mm && mm[1]!.length === mm[2]!.length) {
          this.prefixModes = new Map([...mm[1]!].map((c, i) => [c, mm[2]![i]!]))
          this.prefixSymbols = mm[2]!
        }
      } else if (k === 'CHANMODES') {
        const g = v.split(',')
        if (g.length >= 4) this.chanModes = [g[0]!, g[1]!, g[2]!, g[3]!]
      }
    }
  }

  private onNumeric(m: Message): void {
    const code = Number(m.command)
    // Replies that carry no text for the user, or that other handlers already cover.
    if ([329, 333, 366, 2, 3, 4, 5].includes(code)) return
    const text = m.params.slice(1).join(' ')
    if (!text) return
    // Login and MOTD lines belong in the status buffer, not in whatever is open.
    const target = STATUS_NUMERICS.has(code) ? this.statusBuffer : this.active
    this.local(target, code >= 400 && code < 600 ? 'error' : 'info', text)
  }

  /** The buffer a message to `target` from `from` belongs in, if it is already open. */
  private existingBufferFor(target: string, from: string): Buffer | undefined {
    if (this.isChannel(target)) return this.find(target)
    return this.find(this.isSelf(from) ? target : from)
  }

  private onText(m: Message, history: boolean): void {
    const from = nickOf(m.prefix)
    const target = m.params[0] ?? ''
    let text = m.params[1] ?? ''
    let kind: Kind = m.command === 'NOTICE' ? 'notice' : 'msg'
    const time = timeOf(m)
    const self = !isServerPrefix(m.prefix) && this.isSelf(from)

    const ctcp = /^\x01([^\x01 ]*) ?([^\x01]*)\x01?$/.exec(text)
    if (ctcp) {
      const name = ctcp[1]!.toUpperCase()
      if (name === 'ACTION') {
        kind = 'action'
        text = ctcp[2]!
      } else {
        if (!history && !self) this.onCtcp(m, from, name, ctcp[2]!)
        return
      }
    }

    let buf: Buffer
    if (isServerPrefix(m.prefix)) buf = this.statusBuffer
    else if (this.isChannel(target)) buf = this.buffer(target)
    else buf = this.buffer(self ? target : from)

    // Someone who sends a message has stopped typing.
    if (!self) buf.setTyping(from, false)

    const words = [this.nick, ...settings.keywordsFor(this.name)]
    const isQuery = buf.kind === 'query'
    const mention = !self && buf.kind !== 'status' && (isQuery || mentions(text, words))

    this.push(
      buf,
      {
        kind,
        nick: isServerPrefix(m.prefix) ? m.prefix : from,
        text,
        time,
        self,
        mention,
        msgid: m.tags.msgid,
        replyTo: m.tags['+draft/reply'] || undefined,
      },
      history,
    )
  }

  private onTagmsg(m: Message, history: boolean): void {
    if (history || isServerPrefix(m.prefix)) return
    const from = nickOf(m.prefix)
    // The bouncer says when someone joins or leaves by one of our links. Only its own lines, which carry the guest
    // host, are believed; the bouncer drops the same tag from the network.
    const guestEvent = m.tags[GUEST_TAG]
    if (guestEvent !== undefined) {
      if (isGuestPrefix(m.prefix)) this.onGuestEvent(from, guestEvent)
      return
    }
    const signal = m.tags[SIGNAL_TAG]
    if (signal !== undefined) {
      // Only a message addressed to us, from someone else, can start or answer a direct chat.
      if (!this.isChannel(m.params[0] ?? '') && !this.isSelf(from)) this.hub.receive(from, signal)
      return
    }
    const voice = m.tags[VOICE_TAG]
    if (voice !== undefined) {
      if (!this.isSelf(from)) this.onVoicePresence(from, m.params[0] ?? '', voice)
      return
    }
    const buf = this.existingBufferFor(m.params[0] ?? '', from)
    if (!buf) return
    const self = this.isSelf(from)

    const typing = m.tags['+typing']
    if (typing !== undefined && !self) buf.setTyping(from, typing === 'active')

    const reply = m.tags['+draft/reply']
    if (!reply) return
    const react = m.tags['+draft/react']
    const unreact = m.tags['+draft/unreact']
    if (react) buf.addReaction(reply, react, from)
    if (unreact) buf.removeReaction(reply, unreact, from)
  }

  private onRedact(m: Message): void {
    const buf = this.existingBufferFor(m.params[0] ?? '', nickOf(m.prefix))
    const msgid = m.params[1]
    if (buf && msgid) buf.removeByMsgId(msgid)
  }

  private onAway(m: Message): void {
    const nick = nickOf(m.prefix).toLowerCase()
    // "AWAY :reason" sets away, a bare "AWAY" clears it.
    const away = m.params.length > 0
    for (const buf of this.buffers) {
      const member = buf.members.get(nick)
      if (member && !!member.away !== away) {
        // A new object, not a change in place: the member list redraws a row only when its object changes.
        buf.members.set(nick, { ...member, away })
        buf.touchMembers()
      }
    }
  }

  private onCtcp(m: Message, from: string, name: string, arg: string): void {
    if (m.command === 'NOTICE') {
      this.local(this.statusBuffer, 'info', `CTCP ${name} reply from ${from}: ${arg}`)
      return
    }
    if (name === 'VERSION') this.send(`NOTICE ${from} :\x01VERSION Gestalt\x01`)
    else if (name === 'PING') this.send(`NOTICE ${from} :\x01PING ${arg}\x01`)
    else return
    this.local(this.statusBuffer, 'info', `CTCP ${name} request from ${from}`)
  }

  private onJoin(m: Message, history: boolean): void {
    const nick = nickOf(m.prefix)
    const chan = m.params[0] ?? ''
    if (!chan) return
    const existed = !!this.find(chan)
    const buf = this.buffer(chan)
    if (this.isSelf(nick)) {
      buf.joined = true
      buf.members.clear()
      buf.namesFresh = true
      buf.touchMembers()
      if (this.activateOnJoin.delete(chan.toLowerCase())) this.select(buf.key)
      // A buffer with nothing in it gets its recent history.
      if (!existed && !history) {
        this.send(`CHATHISTORY LATEST ${buf.name} * ${HISTORY_PAGE}`)
      }
      return
    }
    buf.members.set(nick.toLowerCase(), { nick, prefix: '' })
    buf.touchMembers()
    this.push(buf, { kind: 'join', nick, text: '', time: timeOf(m), self: false, mention: false }, false)
  }

  private onPart(m: Message, history: boolean): void {
    const nick = nickOf(m.prefix)
    const buf = this.find(m.params[0] ?? '')
    if (!buf) return
    if (this.isSelf(nick)) {
      if (!history) this.removeBuffer(buf)
      return
    }
    buf.members.delete(nick.toLowerCase())
    buf.setTyping(nick, false)
    buf.touchMembers()
    this.voiceGone(nick, buf)
    this.push(buf, { kind: 'part', nick, text: m.params[1] ?? '', time: timeOf(m), self: false, mention: false }, false)
  }

  private onKick(m: Message): void {
    const buf = this.find(m.params[0] ?? '')
    const victim = m.params[1] ?? ''
    if (!buf) return
    if (this.isSelf(victim)) {
      buf.joined = false
      buf.members.clear()
      buf.touchMembers()
      this.rooms.get(buf.key)?.leave('You were removed from the channel.')
      buf.voiceMembers = []
    } else {
      buf.members.delete(victim.toLowerCase())
      buf.touchMembers()
      this.voiceGone(victim, buf)
    }
    this.push(
      buf,
      { kind: 'kick', nick: nickOf(m.prefix), target: victim, text: m.params[2] ?? '', time: timeOf(m), self: false, mention: this.isSelf(victim) },
      false,
    )
  }

  private onQuit(m: Message): void {
    const nick = nickOf(m.prefix)
    this.voiceGone(nick)
    for (const buf of this.buffers) {
      if (buf.kind === 'channel' && buf.members.delete(nick.toLowerCase())) {
        buf.setTyping(nick, false)
        buf.touchMembers()
        this.push(buf, { kind: 'quit', nick, text: m.params[0] ?? '', time: timeOf(m), self: false, mention: false }, false)
      }
    }
  }

  private onNick(m: Message): void {
    const old = nickOf(m.prefix)
    const next = m.params[0] ?? ''
    if (this.isSelf(old)) this.nick = next
    else {
      for (const room of this.rooms.values()) room.rename(old, next)
      for (const b of this.buffers) {
        if (b.voiceMembers.some((n) => n.toLowerCase() === old.toLowerCase())) {
          b.voiceMembers = b.voiceMembers.map((n) => (n.toLowerCase() === old.toLowerCase() ? next : n))
        }
      }
    }
    for (const buf of this.buffers) {
      const entry = buf.members.get(old.toLowerCase())
      if (buf.kind === 'channel' && entry) {
        buf.members.delete(old.toLowerCase())
        buf.members.set(next.toLowerCase(), { nick: next, prefix: entry.prefix, away: entry.away })
        buf.touchMembers()
        this.push(buf, { kind: 'nick', nick: old, target: next, text: '', time: timeOf(m), self: this.isSelf(next), mention: false }, false)
      }
    }
  }

  private onTopic(m: Message): void {
    const buf = this.find(m.params[0] ?? '')
    if (!buf) return
    buf.topic = m.params[1] ?? ''
    this.push(buf, { kind: 'topic', nick: nickOf(m.prefix), text: buf.topic, time: timeOf(m), self: false, mention: false }, false)
  }

  private onNames(m: Message): void {
    const buf = this.find(m.params[2] ?? '')
    if (!buf) return
    if (buf.namesFresh) {
      buf.members.clear()
      buf.namesFresh = false
    }
    for (const entry of (m.params[3] ?? '').split(' ')) {
      if (!entry) continue
      let i = 0
      while (i < entry.length && this.prefixSymbols.includes(entry[i]!)) i++
      const nick = entry.slice(i)
      if (nick) buf.members.set(nick.toLowerCase(), { nick, prefix: entry.slice(0, i) })
    }
    buf.touchMembers()
  }

  private onMode(m: Message): void {
    const target = m.params[0] ?? ''
    if (!this.isChannel(target)) return
    const buf = this.find(target)
    if (!buf) return
    const changes = parseModeChanges(m.params[1] ?? '', m.params.slice(2), this.chanModes, this.prefixModes)
    for (const c of changes) {
      const symbol = this.prefixModes.get(c.mode)
      if (!symbol || !c.arg) continue
      const key = c.arg.toLowerCase()
      const entry = buf.members.get(key)
      if (!entry) continue
      buf.members.set(key, { ...entry, prefix: this.setPrefix(entry.prefix, symbol, c.add) })
    }
    buf.touchMembers()
    this.push(
      buf,
      { kind: 'mode', nick: isServerPrefix(m.prefix) ? m.prefix : nickOf(m.prefix), text: m.params.slice(1).join(' '), time: timeOf(m), self: false, mention: false },
      false,
    )
  }

  /** Adds or removes a symbol and keeps the symbols in rank order. */
  private setPrefix(current: string, symbol: string, add: boolean): string {
    const set = new Set(current)
    if (add) set.add(symbol)
    else set.delete(symbol)
    return [...this.prefixSymbols].filter((s) => set.has(s)).join('')
  }

  // --- adding messages ---

  /** Adds a message. `history` lines came from the bouncer's store and never notify. */
  private push(buf: Buffer, m: Omit<ChatMessage, 'id' | 'key'> & { key?: string }, history: boolean): void {
    const msg: ChatMessage = {
      ...m,
      id: nextId++,
      key: m.key ?? m.msgid ?? `${m.time}|${m.nick}|${m.kind}|${m.text}`,
    }
    // Lines with no sender (local lines) always show; they are never duplicates.
    if (!m.nick && !m.msgid) msg.key = `local|${msg.id}`
    if (!buf.insert(msg, !history)) return
    if (!history) this.tellPlugins(buf, msg)

    if (m.self || !COUNTS_AS_UNREAD.has(m.kind) || m.time <= buf.lastRead) return

    const watching = this.viewing && this.activeKey === buf.key && !pageUnfocused()
    if (watching && !history) {
      buf.lastRead = Math.max(buf.lastRead, m.time)
      this.queueMarker(buf)
      this.saveReadSoon()
    } else {
      buf.unread++
      if (m.mention) buf.mentionCount++
    }
    if (!history && m.mention) this.hooks.onMention(this, buf, msg)
  }

  /** What happened, for plugins. Direct chats stay between the two people, so they are not passed on. */
  private tellPlugins(buf: Buffer, m: ChatMessage): void {
    const bus = this.hooks.plugins
    if (!bus || buf.kind === 'p2p') return
    const names: Partial<Record<Kind, PluginEvent['event']>> = {
      msg: 'TEXT', action: 'ACTION', notice: 'NOTICE', join: 'JOIN', part: 'PART', quit: 'QUIT', nick: 'NICK', kick: 'KICK', mode: 'MODE', topic: 'TOPIC',
    }
    const event = names[m.kind]
    if (!event) return
    const base = { network: this.label, buffer: buf.kind === 'status' ? '' : buf.name, nick: m.nick, text: m.text, target: m.target ?? '', self: m.self, time: m.time }
    bus.emit({ event, ...base })
    if (m.mention && !m.self && (event === 'TEXT' || event === 'ACTION' || event === 'NOTICE')) bus.emit({ event: 'MENTION', ...base })
  }

  private tellPluginsConnection(event: 'CONNECT' | 'DISCONNECT'): void {
    this.hooks.plugins?.emit({ event, network: this.label, buffer: '', nick: this.nick, text: '', target: '', self: true, time: Date.now() })
  }

  // --- persistence of read positions ---

  private saveReadSoon(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      for (const b of this.buffers) if (b.onNetwork) this.readStore[b.key] = b.lastRead
      saveReadStore(this.login, this.readStore)
    }, 1500)
  }

  dispose(): void {
    for (const r of this.rooms.values()) r.dispose()
    for (const c of this.calls.values()) c.dispose()
    this.hub.dispose()
    clearTimeout(this.saveTimer)
    clearTimeout(this.markerTimer)
    for (const b of this.buffers) b.dispose()
  }
}

function bufferOrder(a: Buffer, b: Buffer): number {
  // Channels first, then queries, each alphabetically.
  const rank = (k: Buffer['kind']) => (k === 'channel' ? 0 : k === 'query' ? 1 : 2)
  if (a.kind !== b.kind) return rank(a.kind) - rank(b.kind)
  return a.key.localeCompare(b.key)
}

export interface ModeChange {
  add: boolean
  mode: string
  arg?: string
}

/**
 * Splits a MODE change such as "+ov-b" into one entry per mode letter, giving
 * each its argument. `chanModes` is CHANMODES from ISUPPORT. Letters in
 * `prefixModes` always take an argument.
 */
export function parseModeChanges(
  modes: string,
  args: string[],
  chanModes: [string, string, string, string],
  prefixModes: Map<string, string>,
): ModeChange[] {
  const out: ModeChange[] = []
  let add = true
  let i = 0
  for (const c of modes) {
    if (c === '+') add = true
    else if (c === '-') add = false
    else {
      const takesArg =
        prefixModes.has(c) || chanModes[0].includes(c) || chanModes[1].includes(c) || (add && chanModes[2].includes(c))
      out.push({ add, mode: c, arg: takesArg ? args[i++] : undefined })
    }
  }
  return out
}

function loadReadStore(login: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem('irc:read:' + login) ?? '{}')
  } catch {
    return {}
  }
}

function saveReadStore(login: string, data: Record<string, number>): void {
  try {
    localStorage.setItem('irc:read:' + login, JSON.stringify(data))
  } catch {
    // read positions are not persisted; unread counts start over on reload
  }
}
