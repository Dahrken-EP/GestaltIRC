// Application state: the networks the user is connected to and which buffer is
// on screen. Each network is one bouncer login, and so one WebSocket.

import { Connection } from './irc/connection'
import { NetworkState, type Buffer, type ChatMessage } from './network.svelte'
import { pageUnfocused, showNotification } from './notify'
import { settings } from './settings.svelte'

export interface Session {
  id: string
  login: string
  nick: string
  url: string
}

export function defaultUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws`
}

const SESSIONS_KEY = 'irc:sessions'
const LAST_LOGIN_KEY = 'irc:lastLogin'

function readJSON<T>(storage: Storage, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(storage: Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, value)
  } catch {
    // storage unavailable: the session just will not survive a reload
  }
}

class App {
  networks = $state.raw<NetworkState[]>([])
  activeId = $state('')
  showLogin = $state(false)
  showSettings = $state(false)
  /** Why the last login attempt failed, for the login form. */
  loginError = $state('')
  /** What to put in the login form when it reopens after a failure. */
  lastLogin = $state<{ login: string; nick: string; url: string }>({ login: '', nick: '', url: '' })

  private conns = new Map<string, Connection>()
  private sessions: Session[] = []

  get active(): NetworkState | undefined {
    return this.networks.find((n) => n.id === this.activeId)
  }

  /** Unread and mention totals across every network, for the page title. */
  get unread(): number {
    return this.networks.reduce((n, net) => n + net.unread, 0)
  }

  get mentionCount(): number {
    return this.networks.reduce((n, net) => n + net.mentionCount, 0)
  }

  /** Reconnects the sessions saved for this tab. Passwords live only in sessionStorage. */
  restore(): void {
    this.lastLogin = readJSON(localStorage, LAST_LOGIN_KEY, { login: '', nick: '', url: defaultUrl() })
    const saved = readJSON<Session[]>(localStorage, SESSIONS_KEY, [])
    for (const s of saved) {
      const password = readJSON<string | null>(sessionStorage, 'irc:pw:' + s.id, null)
      if (password !== null) this.start(s, password)
    }
    if (this.networks.length === 0) this.showLogin = true
  }

  /** Adds a network. Returns an error message when the login is already in use. */
  add(login: string, password: string, nick: string, url: string): string | null {
    login = login.trim()
    if (!login) return 'Enter a login (user/network).'
    if (this.networks.some((n) => n.login === login)) return 'That login is already connected.'
    nick = nick.trim() || login.split('/')[0]!
    this.lastLogin = { login, nick, url }
    write(localStorage, LAST_LOGIN_KEY, JSON.stringify(this.lastLogin))
    this.loginError = ''
    this.showLogin = false
    const id = crypto.randomUUID()
    this.start({ id, login, nick, url }, password)
    this.activate(id)
    return null
  }

  private start(s: Session, password: string): void {
    let everConnected = false
    let wasConnected = false
    // `net` and `conn` refer to each other, so declare before use.
    let conn: Connection
    const net = new NetworkState(s.id, s.login, s.nick, (line) => conn.send(line), {
      onMention: (n, buf, msg) => this.notifyMention(n, buf, msg),
    })
    conn = new Connection({
      url: s.url,
      login: s.login,
      password,
      nick: s.nick,
      onMessage: (m) => net.handleMessage(m),
      onBatch: (b) => net.handleBatch(b),
      onStatus: (status, detail) => {
        net.status = status
        net.statusDetail = detail ?? ''
        if (status === 'connected') {
          everConnected = wasConnected = true
        } else if (status === 'disconnected' || status === 'failed') {
          if (wasConnected) {
            net.connectionLost()
            net.local(net.statusBuffer, 'error', detail ? `Disconnected: ${detail}` : 'Disconnected. Reconnecting...')
            wasConnected = false
          }
          if (status === 'failed') {
            net.local(net.statusBuffer, 'error', `Login failed: ${detail}`)
            // A login that never worked goes back to the form so it can be corrected.
            if (!everConnected) {
              this.remove(net.id)
              this.loginError = detail ?? 'login failed'
              this.showLogin = true
            }
          }
        }
      },
    })

    this.conns.set(s.id, conn)
    this.sessions = [...this.sessions.filter((x) => x.id !== s.id), s]
    write(localStorage, SESSIONS_KEY, JSON.stringify(this.sessions))
    write(sessionStorage, 'irc:pw:' + s.id, JSON.stringify(password))

    this.networks = [...this.networks, net]
    if (!this.activeId) this.activate(s.id)
    conn.connect()
  }

  remove(id: string): void {
    const conn = this.conns.get(id)
    conn?.send('QUIT')
    conn?.close()
    this.conns.delete(id)
    this.networks.find((n) => n.id === id)?.dispose()
    this.networks = this.networks.filter((n) => n.id !== id)
    this.sessions = this.sessions.filter((s) => s.id !== id)
    write(localStorage, SESSIONS_KEY, JSON.stringify(this.sessions))
    write(sessionStorage, 'irc:pw:' + id, null)
    if (this.activeId === id) {
      this.activeId = ''
      const next = this.networks[0]
      if (next) this.activate(next.id)
      else this.showLogin = true
    }
  }

  activate(id: string): void {
    this.activeId = id
    for (const n of this.networks) n.viewing = n.id === id
    this.active?.active.markRead()
  }

  /** Brings a buffer on screen. */
  goto(netId: string, bufKey: string): void {
    this.activate(netId)
    this.active?.select(bufKey)
  }

  /** Moves to the next or previous buffer on the active network. */
  step(delta: 1 | -1): void {
    const net = this.active
    if (!net) return
    const i = net.buffers.findIndex((b) => b === net.active)
    const next = net.buffers[(i + delta + net.buffers.length) % net.buffers.length]
    if (next) net.select(next.key)
  }

  private notifyMention(net: NetworkState, buf: Buffer, msg: ChatMessage): void {
    if (!settings.notify || !pageUnfocused()) return
    const title = buf.kind === 'query' ? msg.nick : `${msg.nick} in ${buf.name}`
    const body = msg.kind === 'action' ? `* ${msg.nick} ${msg.text}` : msg.text
    showNotification(title, body, () => this.goto(net.id, buf.key))
  }
}

export const app = new App()
