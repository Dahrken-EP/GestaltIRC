// One WebSocket to the bouncer. It does the IRC handshake (CAP, SASL PLAIN,
// NICK/USER), collects batches, keeps the socket alive, and reconnects. What
// the messages mean is left to the caller.

import { format, parse, type Message } from './message'

export type Status = 'connecting' | 'connected' | 'disconnected' | 'failed'

export interface Batch {
  type: string
  params: string[]
  messages: Message[]
}

export interface ConnectionOptions {
  url: string
  /** Login as the bouncer expects it: "user/network". */
  login: string
  password: string
  nick: string
  onMessage(m: Message): void
  /** Called when a batch closes, with its lines. Batch lines are not passed to onMessage. */
  onBatch(b: Batch): void
  onStatus(status: Status, detail?: string): void
  /** Replaceable in tests. */
  createSocket?: (url: string) => SocketLike
}

/** The part of WebSocket that Connection uses. */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onerror: (() => void) | null
}

/** Capabilities the client asks for, when the bouncer offers them. */
export const WANTED_CAPS = ['message-tags', 'server-time', 'batch', 'echo-message', 'chathistory', 'message-ids', 'sasl']

const KEEPALIVE_MS = 45_000
const DEAD_AFTER_MS = 120_000
const MAX_BACKOFF_MS = 30_000

export function encodeSaslPlain(login: string, password: string): string[] {
  const bytes = new TextEncoder().encode(`\0${login}\0${password}`)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const b64 = btoa(bin)
  // AUTHENTICATE payloads are sent in chunks of 400. A payload that is an exact
  // multiple of 400 ends with "+".
  const chunks: string[] = []
  for (let i = 0; i < b64.length; i += 400) chunks.push(b64.slice(i, i + 400))
  if (b64.length % 400 === 0) chunks.push('+')
  return chunks
}

export class Connection {
  private ws: SocketLike | null = null
  private opts: ConnectionOptions
  private available = new Set<string>()
  private enabled = new Set<string>()
  private batches = new Map<string, Batch>()
  private backoff = 1000
  private retry: ReturnType<typeof setTimeout> | undefined
  private keepalive: ReturnType<typeof setInterval> | undefined
  private lastRecv = 0
  private stopped = false
  private registered = false

  constructor(opts: ConnectionOptions) {
    this.opts = opts
  }

  get capabilities(): ReadonlySet<string> {
    return this.enabled
  }

  connect(): void {
    this.stopped = false
    this.open()
  }

  /** Ends the connection for good. It does not reconnect. */
  close(): void {
    this.stopped = true
    clearTimeout(this.retry)
    this.teardown()
    this.opts.onStatus('disconnected')
  }

  send(line: string): void {
    if (this.ws && this.registered) this.ws.send(line)
  }

  sendMessage(m: Partial<Message> & { command: string }): void {
    this.send(format(m))
  }

  private raw(line: string): void {
    this.ws?.send(line)
  }

  private open(): void {
    this.teardown()
    this.opts.onStatus('connecting')
    this.available.clear()
    this.enabled.clear()
    this.batches.clear()
    this.registered = false

    const create = this.opts.createSocket ?? ((u: string) => new WebSocket(u, 'text.ircv3.net') as unknown as SocketLike)
    const ws = create(this.opts.url)
    this.ws = ws
    ws.onopen = () => {
      this.lastRecv = Date.now()
      this.raw('CAP LS 302')
      this.raw(`NICK ${this.opts.nick}`)
      this.raw(`USER ${this.opts.nick} 0 * :${this.opts.nick}`)
      this.keepalive = setInterval(() => this.checkAlive(), KEEPALIVE_MS)
    }
    ws.onmessage = (ev) => {
      this.lastRecv = Date.now()
      if (typeof ev.data !== 'string') return
      // A text frame carries one line, but tolerate frames with several.
      for (const line of ev.data.split(/\r?\n/)) {
        const m = line ? parse(line) : null
        if (m) this.handle(m)
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.teardown()
      if (this.stopped) return
      this.opts.onStatus('disconnected')
      this.scheduleRetry()
    }
    ws.onerror = () => {}
  }

  private teardown(): void {
    clearInterval(this.keepalive)
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try {
        ws.close()
      } catch {
        // already closed
      }
    }
  }

  private scheduleRetry(): void {
    clearTimeout(this.retry)
    this.retry = setTimeout(() => !this.stopped && this.open(), this.backoff)
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
  }

  private fail(detail: string): void {
    this.stopped = true
    this.teardown()
    this.opts.onStatus('failed', detail)
  }

  private checkAlive(): void {
    if (Date.now() - this.lastRecv > DEAD_AFTER_MS) {
      // The socket stopped answering. Drop it and let the close path reconnect.
      const ws = this.ws
      this.teardown()
      if (ws && !this.stopped) {
        this.opts.onStatus('disconnected', 'connection timed out')
        this.scheduleRetry()
      }
      return
    }
    this.raw(`PING :${Date.now()}`)
  }

  private handle(m: Message): void {
    switch (m.command) {
      case 'CAP':
        return this.handleCap(m)
      case 'AUTHENTICATE':
        if (m.params[0] === '+') for (const c of encodeSaslPlain(this.opts.login, this.opts.password)) this.raw('AUTHENTICATE ' + c)
        return
      case '903':
        this.raw('CAP END')
        return
      case '902':
      case '904':
      case '905':
      case '906':
      case '907':
        return this.fail(m.params[m.params.length - 1] || 'login failed')
      case '464':
        return this.fail('password incorrect')
      case 'PING':
        this.raw('PONG :' + (m.params[0] ?? ''))
        return
      case 'PONG':
        return
      case '001':
        this.registered = true
        this.backoff = 1000
        this.opts.onStatus('connected')
        break
      case 'BATCH':
        return this.handleBatch(m)
    }

    const id = m.tags.batch
    const batch = id ? this.batches.get(id) : undefined
    if (batch) batch.messages.push(m)
    else this.opts.onMessage(m)
  }

  private handleCap(m: Message): void {
    const sub = (m.params[1] ?? '').toUpperCase()
    const list = m.params[m.params.length - 1] ?? ''
    switch (sub) {
      case 'LS': {
        for (const item of list.split(' ')) if (item) this.available.add(item.split('=')[0]!)
        if (m.params[2] === '*') return // more lines follow
        const want = WANTED_CAPS.filter((c) => this.available.has(c))
        if (!this.available.has('sasl')) return this.fail('the server does not offer SASL login')
        this.raw('CAP REQ :' + want.join(' '))
        return
      }
      case 'ACK':
        for (const c of list.split(' ')) if (c) this.enabled.add(c.replace(/^-/, ''))
        if (this.enabled.has('sasl')) this.raw('AUTHENTICATE PLAIN')
        else this.raw('CAP END')
        return
      case 'NAK':
        return this.fail('the server refused the requested capabilities')
    }
  }

  private handleBatch(m: Message): void {
    const ref = m.params[0] ?? ''
    const id = ref.slice(1)
    if (ref.startsWith('+')) {
      this.batches.set(id, { type: m.params[1] ?? '', params: m.params.slice(2), messages: [] })
    } else if (ref.startsWith('-')) {
      const b = this.batches.get(id)
      if (!b) return
      this.batches.delete(id)
      this.opts.onBatch(b)
    }
  }
}
