// Application state: who is logged in, the networks they have on the bouncer, and
// which buffer is on screen. Each network is one WebSocket, logged in with the
// session cookie, so no password is kept in the page after the login form.

import { api, websocketUrl, type GuestInvite, type GuestSettings, type NetworkInfo, type SessionInfo } from './api'
import { formFromNetwork, toRequest } from './networkform'
import { Connection } from './irc/connection'
import { NetworkState, type Buffer, type ChatMessage } from './network.svelte'
import { pageUnfocused, showNotification } from './notify'
import { playAlert } from './audio'
import { plugins } from './plugins/manager.svelte'
import { disablePush } from './push'
import { microphone } from './voice/media'
import { nativeConnection } from './native/pc'
import { nativeMeter, nativeVoice } from './native/voice'
import { audioMeter } from './voice/meter'
import { audioContext } from './voice/meter'
import { RoomMixer } from './voice/mixer'
import { settings } from './settings.svelte'
import { t } from './i18n.svelte'

export interface SwitcherEntry {
  netId: string
  network: string
  key: string
  name: string
  kind: Buffer['kind']
  unread: number
  mentions: number
}

export type Phase = 'loading' | 'login' | 'ready'

class App {
  phase = $state<Phase>('loading')
  user = $state('')
  /** The build the bouncer is running, from the session answer; blank on older bouncers. */
  bouncerVersion = $state('')
  networks = $state.raw<NetworkState[]>([])
  activeId = $state('')
  showSettings = $state(false)
  /** Whether people without Gestalt may be sent links to join a chat, which each account chooses. */
  guests = $state<GuestSettings>({ available: false, enabled: false })
  /** The links this account has open. */
  guestInvites = $state.raw<GuestInvite[]>([])
  /** The quick switcher (Ctrl+K) is open. */
  showSwitcher = $state(false)
  /** Every network the account has, including the ones switched off, which have no connection. */
  configured = $state.raw<NetworkInfo[]>([])
  /** The server dialog: adding a server (`edit` is null) or editing one by its name. Null when closed. */
  serverDialog = $state<{ edit: string | null } | null>(null)
  /** The menu for one server (edit, switch off, remove), anchored to where it was asked for. Null when closed. */
  serverMenu = $state<{ name: string; x: number; y: number } | null>(null)
  /** Why the last login failed, or why the session ended. Shown on the login form. */
  loginError = $state('')
  loginBusy = $state(false)
  /** Screen reader announcements for new messages and status changes. Old ones drop off. */
  unreadAnnouncements = $state.raw<{ id: number; text: string }[]>([])
  private announcementId = 0

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
    // A plugin change made just before the page closes is sent now rather than after its short delay.
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => plugins.flush())
      document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && plugins.flush())
    }
    try {
      const session = await api.session()
      if (session) this.begin(session)
      else this.phase = 'login'
    } catch {
      this.loginError = t('login.no_server')
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
      if (!session) throw new Error(t('login.no_session'))
      this.begin(session)
    } catch (e) {
      this.loginError = e instanceof Error ? e.message : t('login.failed')
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
    this.bouncerVersion = session.version ?? ''
    settings.connectRemote(session.prefs, (prefs) => {
      api.putPrefs(prefs).catch(() => {
        // not saved this time; the next change tries again
      })
    })
    this.phase = 'ready'
    this.configured = session.networks
    void this.loadGuests()
    for (const n of session.networks) if (n.enabled) this.start(n)
    plugins.init(
      session.user,
      {
        network: (label) => this.networks.find((n) => n.label === label),
        active: () => this.active,
      },
      // The plugins an account installed, and what they stored, are kept on the bouncer.
      { load: () => api.getDoc('plugins'), save: (doc) => api.putDoc('plugins', doc as unknown as Record<string, unknown>).then(() => undefined) },
    )

    const open = this.takeDeepLink()
    const first = this.networks[0]
    if (open) this.gotoBuffer(open.network, open.buffer)
    else if (first) this.activate(first.id)
  }

  /** Reads the guest switch and the open links again, as when Settings opens: another browser may have made some. */
  async loadGuests(): Promise<void> {
    try {
      this.guests = await api.getGuests()
      this.guestInvites = this.guests.enabled ? (await api.listGuestInvites()).invites : []
    } catch {
      // an older bouncer, or it cannot be reached: no guest links
      this.guests = { available: false, enabled: false }
    }
  }

  /** Switches guest links on or off for this account. Switching them off ends the open ones. */
  async setGuests(on: boolean): Promise<void> {
    this.guests = await api.putGuests(on)
    this.guestInvites = on ? (await api.listGuestInvites()).invites : []
  }

  async revokeGuestInvite(id: string): Promise<void> {
    await api.revokeGuestInvite(id)
    this.guestInvites = this.guestInvites.filter((i) => i.id !== id)
  }

  /** A link someone can open in a browser to reach us, or null if guests are not allowed. */
  private async makeGuestLink(req: { network: string; kind: 'room' | 'direct'; target: string }): Promise<{ url: string; id: string } | null> {
    if (!this.guests.enabled) return null
    try {
      const inv = await api.createGuestInvite(req)
      this.guestInvites = [...this.guestInvites, inv]
      return { url: location.origin + inv.path, id: inv.id }
    } catch {
      return null
    }
  }

  private endGuestLink(id: string): void {
    this.guestInvites = this.guestInvites.filter((i) => i.id !== id)
    api.revokeGuestInvite(id).catch(() => {
      // already gone, or it will run out by itself
    })
  }

  /**
   * Brings the connections in step with the account's networks after the editor changed them: new
   * ones connect, removed or switched-off ones close. A network whose settings changed keeps its
   * connection, which the bouncer closes and the client reopens by itself.
   */
  async resync(): Promise<void> {
    let session: SessionInfo | null
    try {
      session = await api.session()
    } catch {
      return
    }
    if (!session || this.phase !== 'ready') return
    this.configured = session.networks
    const wanted = new Set(session.networks.filter((n) => n.enabled).map((n) => `${this.user}/${n.name}`))
    for (const net of this.networks) {
      if (wanted.has(net.login)) continue
      this.conns.get(net.id)?.close()
      this.conns.delete(net.id)
      net.dispose()
    }
    this.networks = this.networks.filter((n) => wanted.has(n.login))
    const have = new Set(this.networks.map((n) => n.login))
    for (const info of session.networks) if (info.enabled && !have.has(`${this.user}/${info.name}`)) this.start(info)
    if (!this.active) {
      const first = this.networks[0]
      if (first) this.activate(first.id)
      else this.activeId = ''
    }
  }

  /** Opens the dialog to add a server, or to edit the one with this name. */
  openServerDialog(edit: string | null = null): void {
    this.serverMenu = null
    this.serverDialog = { edit }
  }

  /** Opens the menu for a server, near where the click was. */
  openServerMenu(name: string, x: number, y: number): void {
    this.serverMenu = { name, x, y }
  }

  /** Switches a server on or off, keeping everything else about it. */
  async setServerEnabled(name: string, enabled: boolean): Promise<void> {
    this.serverMenu = null
    const list = await api.listNetworks()
    const detail = list.networks.find((n) => n.name === name)
    if (!detail) return
    const form = formFromNetwork(detail)
    form.enabled = enabled
    await api.updateNetwork(name, toRequest(form))
    await this.resync()
  }

  /** Removes a server and its history, and what this browser's account kept for it. */
  async removeServer(name: string): Promise<void> {
    this.serverMenu = null
    await api.deleteNetwork(name)
    settings.forgetNetwork(name)
    await this.resync()
  }

  /** Brings the server with this name on screen, if it is connected. */
  showServer(name: string): void {
    const net = this.networks.find((n) => n.name === name)
    if (net) this.activate(net.id)
  }

  /** Drops every connection and returns to the login form. */
  private teardown(reason: string): void {
    plugins.dispose()
    for (const conn of this.conns.values()) conn.close()
    for (const net of this.networks) net.dispose()
    this.conns.clear()
    this.networks = []
    this.activeId = ''
    this.user = ''
    this.showSettings = false
    this.showSwitcher = false
    this.configured = []
    this.guests = { available: false, enabled: false }
    this.guestInvites = []
    this.serverDialog = null
    this.serverMenu = null
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
      onNewMessage: (n, buf, msg) => this.announce(`${msg.nick} said in ${buf.name}: ${msg.text.slice(0, 80)}`),
      createConnection: (config, ctx) => nativeConnection(config, ctx),
      createMeter: (stream) => nativeMeter(stream) ?? audioMeter(stream),
      nativeVoice: nativeVoice(),
      iceServers: () => api.ice().then((r) => r.iceServers),
      getMedia: microphone,
      plugins,
      guestLink: (req) => this.makeGuestLink(req),
      guestRevoke: (id) => this.endGuestLink(id),
      guestInvite: (id) => this.guestInvites.find((i) => i.id === id),
      mixer: () => {
        const ctx = audioContext()
        return ctx ? new RoomMixer(ctx) : null
      },
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

  /** Every buffer on every network, in the order they are listed, for the quick switcher. */
  get entries(): SwitcherEntry[] {
    const out: SwitcherEntry[] = []
    for (const net of this.networks) {
      for (const buf of net.buffers) {
        out.push({
          netId: net.id,
          network: net.label,
          key: buf.key,
          name: buf.kind === 'status' ? net.label : buf.name,
          kind: buf.kind,
          unread: buf.unread,
          mentions: buf.mentionCount,
        })
      }
    }
    return out
  }

  /**
   * Goes to the next buffer with anything unread: one with a mention first, otherwise the next
   * unread one after the buffer on screen, wrapping round the networks. Returns false when
   * everything has been read.
   */
  nextUnread(): boolean {
    const all: { net: NetworkState; buf: Buffer }[] = []
    for (const net of this.networks) for (const buf of net.buffers) all.push({ net, buf })
    const here = all.findIndex((e) => e.net.id === this.activeId && e.buf === e.net.active)
    // Walk once round, starting just after where we are, so repeated presses move on.
    const ordered = here < 0 ? all : [...all.slice(here + 1), ...all.slice(0, here)]
    const unread = ordered.filter((e) => e.buf.unread > 0)
    const target = unread.find((e) => e.buf.mentionCount > 0) ?? unread[0]
    if (!target) return false
    this.goto(target.net.id, target.buf.key)
    return true
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

  /** Announce something to screen readers. Old announcements drop off so the live region stays small. */
  announce(text: string): void {
    const id = ++this.announcementId
    this.unreadAnnouncements = [...this.unreadAnnouncements, { id, text }]
    setTimeout(() => {
      this.unreadAnnouncements = this.unreadAnnouncements.filter((a) => a.id !== id)
    }, 3000)
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
    if (!settings.notify || settings.networkMuted[net.name] || !pageUnfocused()) return
    const title = buf.kind === 'query' || buf.kind === 'p2p' ? msg.nick : `${msg.nick} in ${buf.name}`
    const body = msg.kind === 'action' ? `* ${msg.nick} ${msg.text}` : msg.text
    showNotification(title, body, () => this.goto(net.id, buf.key))
    this.announce(`Mention from ${msg.nick}: ${body.slice(0, 80)}`)
    if (settings.audioAlerts) {
      playAlert()
    }
  }
}

export const app = new App()
