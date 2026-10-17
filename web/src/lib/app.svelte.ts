// Application state: who is logged in, the networks they have on the bouncer, and
// which buffer is on screen. Each network is one WebSocket, logged in with the
// session cookie, so no password is kept in the page after the login form.

import { api, websocketUrl, type NetworkInfo, type SessionInfo } from './api'
import { Connection } from './irc/connection'
import { NetworkState, type Buffer, type ChatMessage } from './network.svelte'
import { pageUnfocused, showNotification } from './notify'
import { disablePush } from './push'
import { settings } from './settings.svelte'

export type Phase = 'loading' | 'login' | 'ready'

class App {
  phase = $state<Phase>('loading')
  user = $state('')
  networks = $state.raw<NetworkState[]>([])
  activeId = $state('')
  showSettings = $state(false)
  /** Why the last login failed, or why the session ended. Shown on the login form. */
  loginError = $state('')
  loginBusy = $state(false)

  private conns = new Map<string, Connection>()
  private started = false

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

  /** Called once when the page loads. Resumes an existing session if there is one. */
  async init(): Promise<void> {
    if (this.started) return
    this.started = true
    this.listenForNotificationClicks()
    try {
      const session = await api.session()
      if (session) this.begin(session)
      else this.phase = 'login'
    } catch {
      this.loginError = 'Could not reach the server.'
      this.phase = 'login'
    }
  }

  async login(user: string, password: string): Promise<void> {
    if (this.loginBusy) return
    this.loginBusy = true
    this.loginError = ''
    try {
      await api.login(user.trim(), password)
      const session = await api.session()
      if (!session) throw new Error('Login did not start a session. Are cookies blocked?')
      this.begin(session)
    } catch (e) {
      this.loginError = e instanceof Error ? e.message : 'Login failed.'
    } finally {
      this.loginBusy = false
    }
  }

  async logout(): Promise<void> {
    // The push subscription belongs to the session's user, so it goes first.
    await disablePush()
    try {
      await api.logout()
    } catch {
      // the cookie is cleared by the server; if it cannot be reached, the page still resets
    }
    this.teardown('')
  }

  private begin(session: SessionInfo): void {
    this.user = session.user
    settings.connectRemote(session.prefs, (prefs) => {
      api.putPrefs(prefs).catch(() => {
        // not saved this time; the next change tries again
      })
    })
    this.phase = 'ready'
    for (const n of session.networks) if (n.enabled) this.start(n)

    const open = this.takeDeepLink()
    const first = this.networks[0]
    if (open) this.gotoBuffer(open.network, open.buffer)
    else if (first) this.activate(first.id)
  }

  /** Drops every connection and returns to the login form. */
  private teardown(reason: string): void {
    for (const conn of this.conns.values()) conn.close()
    for (const net of this.networks) net.dispose()
    this.conns.clear()
    this.networks = []
    this.activeId = ''
    this.user = ''
    this.showSettings = false
    settings.disconnectRemote()
    this.loginError = reason
    this.phase = 'login'
  }

  private start(info: NetworkInfo): void {
    const id = crypto.randomUUID()
    const login = `${this.user}/${info.name}`
    let wasConnected = false
    // `net` and `conn` refer to each other, so declare before use.
    let conn: Connection
    const net = new NetworkState(id, login, info.nick, (line) => conn.send(line), {
      onMention: (n, buf, msg) => this.notifyMention(n, buf, msg),
      iceServers: () => api.ice().then((r) => r.iceServers),
    })
    conn = new Connection({
      url: websocketUrl(),
      login,
      password: '', // the session cookie stands in for it
      nick: info.nick,
      onMessage: (m) => net.handleMessage(m),
      onBatch: (b) => net.handleBatch(b),
      onStatus: (status, detail) => {
        net.status = status
        net.statusDetail = detail ?? ''
        if (status === 'connected') {
          wasConnected = true
          net.setCaps(conn.capabilities)
        } else if (status === 'disconnected' || status === 'failed') {
          if (wasConnected) {
            net.connectionLost()
            net.local(net.statusBuffer, 'error', detail ? `Disconnected: ${detail}` : 'Disconnected. Reconnecting...')
            wasConnected = false
          }
          if (status === 'failed') {
            net.local(net.statusBuffer, 'error', `Login failed: ${detail}`)
            void this.checkSession()
          }
        }
      },
    })

    this.conns.set(id, conn)
    this.networks = [...this.networks, net]
    conn.connect()
  }

  /** After a failed login to a network, find out whether the whole session has ended. */
  private async checkSession(): Promise<void> {
    try {
      if ((await api.session()) === null) this.teardown('Your session has ended. Log in again.')
    } catch {
      // the server is unreachable; each connection keeps retrying on its own
    }
  }

  activate(id: string): void {
    this.activeId = id
    for (const n of this.networks) n.viewing = n.id === id
    this.active?.markActiveRead()
  }

  /** Brings a buffer on screen. */
  goto(netId: string, bufKey: string): void {
    this.activate(netId)
    this.active?.select(bufKey)
  }

  /** Opens a buffer by network and buffer name, waiting for it if it is not open yet. */
  gotoBuffer(network: string, buffer: string): void {
    const net = this.networks.find((n) => n.label === network || n.login.endsWith('/' + network))
    if (!net) return
    this.activate(net.id)
    if (!buffer) return
    const existing = net.find(buffer)
    if (existing) net.select(existing.key)
    else net.wantOpen = buffer.toLowerCase()
  }

  /** Moves to the next or previous buffer on the active network. */
  step(delta: 1 | -1): void {
    const net = this.active
    if (!net) return
    const i = net.buffers.findIndex((b) => b === net.active)
    const next = net.buffers[(i + delta + net.buffers.length) % net.buffers.length]
    if (next) net.select(next.key)
  }

  /** A notification opened this page with ?network=&buffer=. Returns it and tidies the address bar. */
  private takeDeepLink(): { network: string; buffer: string } | null {
    if (typeof location === 'undefined') return null
    const params = new URLSearchParams(location.search)
    const network = params.get('network')
    if (!network) return null
    history.replaceState(null, '', location.pathname)
    return { network, buffer: params.get('buffer') ?? '' }
  }

  /** A click on a push notification in an already-open tab switches buffer without a reload. */
  private listenForNotificationClicks(): void {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { type?: string; network?: string; buffer?: string } | null
      if (d?.type === 'open-buffer' && d.network) this.gotoBuffer(d.network, d.buffer ?? '')
    })
  }

  private notifyMention(net: NetworkState, buf: Buffer, msg: ChatMessage): void {
    if (!settings.notify || !pageUnfocused()) return
    const title = buf.kind === 'query' || buf.kind === 'p2p' ? msg.nick : `${msg.nick} in ${buf.name}`
    const body = msg.kind === 'action' ? `* ${msg.nick} ${msg.text}` : msg.text
    showNotification(title, body, () => this.goto(net.id, buf.key))
  }
}

export const app = new App()
