// Runs one plugin from the page's side. The plugin's code is in a sandbox that can only
// send messages back; this class decides what each message may do. It checks the
// permission the user granted, limits how fast a plugin may act, runs its timers, watches
// that it still answers, and shuts it down if it misbehaves.

import { NEEDS, parseFromWorker, type FromWorker, type ToWorker } from './protocol'
import {
  EVENTS, MAX_ALIASES, MAX_STORAGE_CHARS, MAX_TIMERS, type EventName, type InstalledPlugin, type PluginEvent,
} from './types'

/** The part of the sandbox the host uses. The real one is a worker in a frame; tests use a fake. */
export interface Sandbox {
  post(m: ToWorker): void
  terminate(): void
}

export type SandboxFactory = (handlers: { message: (data: unknown) => void; fatal: (reason: string) => void }) => Sandbox

export interface Services {
  /** The user's nick and the network's name, for the plugin to know where it is. */
  context(): { nick: string; network: string }
  /** Send a message or command as if the user typed it in the window `buffer` ("" for the one on screen). */
  send(line: string, buffer: string, network: string): void
  /** Show a line only the user sees. */
  print(text: string, buffer: string, network: string): void
  /** What the plugin has kept. */
  loadStorage(): Record<string, string>
  saveStorage(all: Record<string, string>): void
  /** True if `name` is a command built into the client, which a plugin may not replace. */
  isBuiltin(name: string): boolean
  log(text: string, kind: 'log' | 'error' | 'info'): void
  /** The plugin stopped for a reason the user should know about. */
  onStop(reason: string): void
  /** Its status changed, for a display that shows it. */
  changed?(): void
}

export type Status = 'stopped' | 'starting' | 'running' | 'failed'

export interface HostOptions {
  /** Milliseconds between checks that the plugin still answers. */
  pingMs?: number
  /** How long an answer may take. */
  pongMs?: number
  startMs?: number
}

const ACTION_BURST = 10
const ACTION_PER_SECOND = 5
const MAX_DROPS = 100
const MAX_BAD_MESSAGES = 5
const MAX_EVENT_TEXT = 2_000

export class PluginInstance {
  private state: Status = 'stopped'
  error = ''

  get status(): Status {
    return this.state
  }

  private set status(s: Status) {
    if (this.state === s) return
    this.state = s
    this.services.changed?.()
  }

  private sandbox: Sandbox | null = null
  private subscribed = new Set<EventName>()
  private aliases = new Set<string>()
  private timers = new Map<number, ReturnType<typeof setTimeout>>()
  private storage: Record<string, string> = {}
  private tokens = ACTION_BURST
  private refilled = 0
  private drops: number[] = []
  private bad = 0
  private ping: ReturnType<typeof setInterval> | undefined
  private deadline: ReturnType<typeof setTimeout> | undefined
  private startTimer: ReturnType<typeof setTimeout> | undefined
  private pingN = 0
  private granted: Set<string>

  constructor(
    readonly plugin: InstalledPlugin,
    private services: Services,
    private makeSandbox: SandboxFactory,
    private opts: HostOptions = {},
  ) {
    this.granted = new Set(plugin.granted)
  }

  get aliasNames(): string[] {
    return [...this.aliases]
  }

  get subscriptions(): EventName[] {
    return [...this.subscribed]
  }

  start(): void {
    if (this.status === 'starting' || this.status === 'running') return
    this.status = 'starting'
    this.error = ''
    this.storage = this.granted.has('storage') ? this.services.loadStorage() : {}
    this.tokens = ACTION_BURST
    this.refilled = Date.now()
    this.bad = 0
    this.drops = []
    this.sandbox = this.makeSandbox({
      message: (d) => this.onMessage(d),
      fatal: (reason) => this.fail(reason),
    })
    const ctx = this.services.context()
    this.sandbox.post({
      t: 'init',
      source: this.plugin.source,
      info: { plugin: this.plugin.manifest.name, version: this.plugin.manifest.version, nick: ctx.nick, network: ctx.network, granted: [...this.granted] as never },
      storage: { ...this.storage },
    })
    this.startTimer = setTimeout(() => this.status === 'starting' && this.fail('did not start in time'), this.opts.startMs ?? 5_000)
  }

  /** Stops the plugin quietly, as when the user turns it off. */
  stop(): void {
    this.teardown()
    this.status = 'stopped'
  }

  // --- into the plugin ---

  dispatch(ev: PluginEvent): void {
    if (this.status !== 'running' || !this.subscribed.has(ev.event)) return
    this.sandbox?.post({ t: 'event', ev: { ...ev, text: ev.text.slice(0, MAX_EVENT_TEXT) } })
  }

  /** Runs one of the plugin's aliases. Returns true if there was one, so the line is not also sent anywhere. */
  runAlias(name: string, args: string[], raw: string, ctx: { network: string; buffer: string; nick: string }): boolean {
    if (this.status !== 'running' || !this.aliases.has(name)) return false
    this.sandbox?.post({ t: 'alias', name, args, raw: raw.slice(0, MAX_EVENT_TEXT), ctx })
    return true
  }

  // --- out of the plugin ---

  private onMessage(data: unknown): void {
    const m = parseFromWorker(data)
    if (!m) {
      this.misbehaved('sent a message the host does not understand')
      return
    }
    const need = NEEDS[m.t]
    if (need && !this.granted.has(need)) {
      // The plugin's own code refuses these first, so one arriving means it skipped that.
      this.services.log(`asked for "${need}", which was not granted`, 'error')
      this.misbehaved('used a permission it was not granted')
      return
    }
    switch (m.t) {
      case 'ready':
        clearTimeout(this.startTimer)
        if (this.status !== 'starting') return
        if (!m.ok) {
          this.fail('failed while loading (see the log)')
          return
        }
        this.status = 'running'
        this.watch()
        return
      case 'pong':
        if (m.n === this.pingN) {
          clearTimeout(this.deadline)
          this.deadline = undefined
        }
        return
      case 'log':
        this.services.log(m.text, 'log')
        return
      case 'error':
        this.services.log(m.text, 'error')
        return
      case 'on':
        this.subscribed.add(m.event)
        return
      case 'alias':
        this.addAlias(m.name)
        return
      case 'send':
        if (this.allowed()) this.services.send(m.line, m.buffer, m.network)
        return
      case 'print':
        if (this.allowed()) this.services.print(m.text, m.buffer, m.network)
        return
      case 'timer':
        this.addTimer(m)
        return
      case 'clear':
        this.clearTimer(m.id)
        return
      case 'store':
        this.store(m.key, m.value)
        return
    }
  }

  private addAlias(name: string): void {
    if (this.aliases.has(name)) return
    if (this.services.isBuiltin(name)) {
      this.services.log(`/${name} is a built-in command, so the plugin cannot take it over`, 'error')
      return
    }
    if (this.aliases.size >= MAX_ALIASES) return
    this.aliases.add(name)
  }

  private addTimer(m: Extract<FromWorker, { t: 'timer' }>): void {
    if (this.timers.has(m.id) || this.timers.size >= MAX_TIMERS) return
    const fire = () => {
      if (!m.repeat) this.timers.delete(m.id)
      this.sandbox?.post({ t: 'fire', id: m.id })
    }
    this.timers.set(m.id, m.repeat ? (setInterval(fire, m.ms) as never) : setTimeout(fire, m.ms))
  }

  private clearTimer(id: number): void {
    const t = this.timers.get(id)
    if (t === undefined) return
    clearTimeout(t)
    clearInterval(t)
    this.timers.delete(id)
  }

  private store(key: string, value: string | null): void {
    const next = { ...this.storage }
    if (value === null) delete next[key]
    else next[key] = value
    const size = Object.entries(next).reduce((n, [k, v]) => n + k.length + v.length, 0)
    if (size > MAX_STORAGE_CHARS) {
      this.services.log('its storage is full, so that was not kept', 'error')
      return
    }
    this.storage = next
    this.services.saveStorage(next)
  }

  /** A plugin may act a few times a second. A burst is fine; a flood is dropped, and a long flood stops it. */
  private allowed(): boolean {
    const now = Date.now()
    this.tokens = Math.min(ACTION_BURST, this.tokens + ((now - this.refilled) / 1000) * ACTION_PER_SECOND)
    this.refilled = now
    if (this.tokens >= 1) {
      this.tokens--
      return true
    }
    this.drops = this.drops.filter((t) => now - t < 10_000)
    this.drops.push(now)
    if (this.drops.length >= MAX_DROPS) this.fail('sent far too much too fast')
    return false
  }

  private misbehaved(what: string): void {
    if (++this.bad >= MAX_BAD_MESSAGES) this.fail(what)
  }

  // --- keeping watch ---

  private watch(): void {
    const every = this.opts.pingMs ?? 2_000
    this.ping = setInterval(() => {
      // One check at a time. Moving the deadline on every tick would let a hung plugin go on for ever.
      if (this.status !== 'running' || this.deadline !== undefined) return
      this.pingN++
      this.sandbox?.post({ t: 'ping', n: this.pingN })
      this.deadline = setTimeout(() => this.fail('stopped responding'), this.opts.pongMs ?? 5_000)
    }, every)
  }

  private fail(reason: string): void {
    if (this.status === 'failed' || this.status === 'stopped') return
    this.teardown()
    this.status = 'failed'
    this.error = reason
    this.services.onStop(reason)
  }

  private teardown(): void {
    clearInterval(this.ping)
    clearTimeout(this.deadline)
    this.deadline = undefined
    clearTimeout(this.startTimer)
    for (const id of [...this.timers.keys()]) this.clearTimer(id)
    this.sandbox?.terminate()
    this.sandbox = null
    this.subscribed.clear()
    this.aliases.clear()
  }
}

export { EVENTS }
