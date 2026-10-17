// Per-network chat state: buffers, members, unread counts. It turns IRC
// messages from one bouncer connection into this state. It knows nothing about
// the socket; lines go out through the `send` callback.

import { parseInput, HELP, type Action } from './commands'
import type { Batch, Status } from './irc/connection'
import { isServerPrefix, nickOf, timeOf, type Message } from './irc/message'
import { pageUnfocused } from './notify'
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
}

/** Messages kept in memory per buffer. Older ones are fetched again with CHATHISTORY. */
export const MAX_MESSAGES = 1500
const HISTORY_PAGE = 100

let nextId = 1

/** Numerics sent while logging in or reading the MOTD. They go to the status buffer. */
const STATUS_NUMERICS: ReadonlySet<number> = new Set([
  900, 901, 903, 251, 252, 253, 254, 255, 265, 266, 372, 375, 376, 422,
])

const COUNTS_AS_UNREAD: ReadonlySet<Kind> = new Set(['msg', 'action', 'notice'])

export class Buffer {
  readonly name: string
  readonly key: string
  readonly kind: 'status' | 'channel' | 'query'

  messages = $state.raw<ChatMessage[]>([])
  topic = $state('')
  unread = $state(0)
  mentionCount = $state(0)
  joined = $state(false)
  historyLoading = $state(false)
  historyExhausted = $state(false)
  /** Bumped whenever `members` changes. Read it to depend on the map. */
  membersRev = $state(0)

  /** Lowercase nick -> { nick, prefix symbols }. */
  members = new Map<string, { nick: string; prefix: string }>()
  /** Time of the newest message the user has seen. */
  lastRead: number
  /** The next 353 reply starts a fresh member list. */
  namesFresh = true

  private seen = new Set<string>()

  constructor(name: string, kind: Buffer['kind'], lastRead: number) {
    this.name = name
    this.key = kind === 'status' ? '' : name.toLowerCase()
    this.kind = kind
    this.lastRead = lastRead
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

  clear(): void {
    this.messages = []
    this.seen.clear()
  }

  touchMembers(): void {
    this.membersRev++
  }

  markRead(): void {
    this.unread = 0
    this.mentionCount = 0
    const last = this.messages[this.messages.length - 1]
    this.lastRead = Math.max(this.lastRead, last?.time ?? Date.now())
  }
}

export interface NetworkHooks {
  /** A mention or private message arrived live and the user may not be looking. */
  onMention(net: NetworkState, buf: Buffer, msg: ChatMessage): void
}

export class NetworkState {
  readonly id: string
  readonly login: string
  label = $state('')
  nick = $state('')
  status = $state<Status>('connecting')
  statusDetail = $state('')
  buffers = $state.raw<Buffer[]>([])
  activeKey = $state('')
  /** True while this network is the one on screen. */
  viewing = $state(false)

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
  private activateOnJoin = new Set<string>()
  private send: (line: string) => void
  private hooks: NetworkHooks

  constructor(id: string, login: string, nick: string, send: (line: string) => void, hooks: NetworkHooks) {
    this.id = id
    this.login = login
    this.label = login.split('/')[1] ?? login
    this.nick = nick
    this.send = send
    this.hooks = hooks
    this.readStore = loadReadStore(login)
    this.buffers = [new Buffer(this.label, 'status', 0)]
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
    // A buffer we have not seen before starts with nothing unread.
    const lastRead = this.readStore[name.toLowerCase()] ?? Date.now()
    const buf = new Buffer(name, kind, lastRead)
    this.buffers = [...this.buffers, buf].sort((a, b) => (a.kind === 'status' ? -1 : b.kind === 'status' ? 1 : bufferOrder(a, b)))
    return buf
  }

  select(key: string): void {
    this.activeKey = key.toLowerCase()
    this.active.markRead()
    this.saveReadSoon()
  }

  removeBuffer(buf: Buffer): void {
    if (buf.kind === 'status') return
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
    for (const b of this.buffers) {
      if (b.kind !== 'channel') continue
      b.joined = false
      b.members.clear()
      b.namesFresh = true
      b.touchMembers()
    }
  }

  // --- input ---

  /** Handles text typed in the active buffer. Each line is a message or a command. */
  submit(input: string): void {
    for (const line of input.split(/\r?\n/)) {
      if (!line.trim()) continue
      const buf = this.active
      const inBuffer = buf.kind !== 'status'
      for (const a of parseInput(line, { target: inBuffer ? buf.name : '', inBuffer, chanTypes: this.chanTypes })) {
        this.run(a, buf)
      }
    }
  }

  private run(a: Action, buf: Buffer): void {
    switch (a.type) {
      case 'raw': {
        if (/^JOIN /i.test(a.line)) {
          const first = a.line.slice(5).split(' ')[0]!.split(',')[0]!
          this.activateOnJoin.add(first.toLowerCase())
        }
        this.send(a.line)
        break
      }
      case 'open':
        this.openQuery(a.target)
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

  /** Adds a line that exists only in this browser. */
  local(buf: Buffer, kind: Kind, text: string): void {
    this.push(buf, { kind, nick: '', text, time: Date.now(), self: false, mention: false }, false)
  }

  // --- history ---

  /** Asks the bouncer for messages older than the oldest one shown. */
  loadOlder(buf: Buffer): void {
    if (buf.kind === 'status' || buf.historyLoading || buf.historyExhausted) return
    const oldest = buf.messages[0]
    const at = oldest ? new Date(oldest.time).toISOString() : null
    buf.historyLoading = true
    this.send(`CHATHISTORY BEFORE ${buf.name} ${at ? 'timestamp=' + at : '*'} ${HISTORY_PAGE}`)
  }

  handleBatch(b: Batch): void {
    if (b.type !== 'chathistory') {
      for (const m of b.messages) this.handleMessage(m)
      return
    }
    const target = b.params[0] ? this.find(b.params[0]) : undefined
    const before = target?.messages.length ?? 0
    for (const m of b.messages) this.handleMessage(m, true)
    if (target?.historyLoading) {
      target.historyLoading = false
      if (target.messages.length === before) target.historyExhausted = true
    }
  }

  // --- incoming ---

  handleMessage(m: Message, history = false): void {
    switch (m.command) {
      case '001':
        this.nick = m.params[0] ?? this.nick
        this.local(this.statusBuffer, 'info', m.params[1] ?? 'Connected')
        break
      case '005':
        this.parseIsupport(m.params.slice(1, -1))
        break
      case 'PRIVMSG':
      case 'NOTICE':
        this.onText(m, history)
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

    const words = [this.nick, ...settings.keywords]
    const isQuery = buf.kind === 'query'
    const mention = !self && buf.kind !== 'status' && (isQuery || mentions(text, words))

    this.push(
      buf,
      { kind, nick: isServerPrefix(m.prefix) ? m.prefix : from, text, time, self, mention, msgid: m.tags.msgid },
      history,
    )
  }

  private onCtcp(m: Message, from: string, name: string, arg: string): void {
    if (m.command === 'NOTICE') {
      this.local(this.statusBuffer, 'info', `CTCP ${name} reply from ${from}: ${arg}`)
      return
    }
    if (name === 'VERSION') this.send(`NOTICE ${from} :\x01VERSION irc-webclient\x01`)
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
      if (!existed && !history) this.send(`CHATHISTORY LATEST ${buf.name} * ${HISTORY_PAGE}`)
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
    buf.touchMembers()
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
    } else {
      buf.members.delete(victim.toLowerCase())
      buf.touchMembers()
    }
    this.push(
      buf,
      { kind: 'kick', nick: nickOf(m.prefix), target: victim, text: m.params[2] ?? '', time: timeOf(m), self: false, mention: this.isSelf(victim) },
      false,
    )
  }

  private onQuit(m: Message): void {
    const nick = nickOf(m.prefix)
    for (const buf of this.buffers) {
      if (buf.kind === 'channel' && buf.members.delete(nick.toLowerCase())) {
        buf.touchMembers()
        this.push(buf, { kind: 'quit', nick, text: m.params[0] ?? '', time: timeOf(m), self: false, mention: false }, false)
      }
    }
  }

  private onNick(m: Message): void {
    const old = nickOf(m.prefix)
    const next = m.params[0] ?? ''
    if (this.isSelf(old)) this.nick = next
    for (const buf of this.buffers) {
      const entry = buf.members.get(old.toLowerCase())
      if (buf.kind === 'channel' && entry) {
        buf.members.delete(old.toLowerCase())
        buf.members.set(next.toLowerCase(), { nick: next, prefix: entry.prefix })
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
      const entry = buf.members.get(c.arg.toLowerCase())
      if (!entry) continue
      entry.prefix = this.setPrefix(entry.prefix, symbol, c.add)
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

  private push(
    buf: Buffer,
    m: Omit<ChatMessage, 'id' | 'key'>,
    history: boolean,
  ): void {
    const msg: ChatMessage = {
      ...m,
      id: nextId++,
      key: m.msgid ?? `${m.time}|${m.nick}|${m.kind}|${m.text}`,
    }
    // Lines with no sender (local lines) always show; they are never duplicates.
    if (!m.nick && !m.msgid) msg.key = `local|${msg.id}`
    if (!buf.insert(msg, !history)) return

    if (m.self || !COUNTS_AS_UNREAD.has(m.kind) || m.time <= buf.lastRead) return

    const watching = this.viewing && this.activeKey === buf.key && !pageUnfocused()
    if (watching && !history) {
      buf.lastRead = Math.max(buf.lastRead, m.time)
      this.saveReadSoon()
    } else {
      buf.unread++
      if (m.mention) buf.mentionCount++
    }
    if (!history && m.mention) this.hooks.onMention(this, buf, msg)
  }

  // --- persistence of read positions ---

  private saveReadSoon(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      for (const b of this.buffers) if (b.kind !== 'status') this.readStore[b.key] = b.lastRead
      saveReadStore(this.login, this.readStore)
    }, 1500)
  }

  dispose(): void {
    clearTimeout(this.saveTimer)
  }
}

function bufferOrder(a: Buffer, b: Buffer): number {
  // Channels first, then queries, each alphabetically.
  if (a.kind !== b.kind) return a.kind === 'channel' ? -1 : 1
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
