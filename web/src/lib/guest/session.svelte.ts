// A guest's side of a link: a name, a connection to the bouncer, and a small NetworkState that looks to the rest of the
// page like an IRC network with one other person on it, the host. That lets the guest use the same direct chat window
// a Gestalt user has. What the page would send as signalling goes out as frames instead of IRC lines, and the host's
// frames come in as the lines they would have been.

import { format, parse } from '../irc/message'
import { NetworkState } from '../network.svelte'
import { SIGNAL_TAG } from '../p2p/hub'
import { microphone } from '../voice/media'
import { GuestConnection, guestTokenFrom, type GuestEvents, type Welcome } from './connection'

export type GuestPhase = 'name' | 'joining' | 'joined' | 'ended'

/** The tags that cross between a guest and the host. */
export const ROSTER_TAG = '+gestalt/roster'
const TAGS = new Set([SIGNAL_TAG, ROSTER_TAG])
const VALUE_RE = /^[A-Za-z0-9._:-]{1,2000}$/

export interface GuestDeps {
  Socket?: new (url: string) => WebSocket
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection
  getMedia?: () => Promise<MediaStream>
  storage?: Pick<Storage, 'getItem' | 'setItem'>
}

export class GuestSession {
  phase = $state<GuestPhase>('name')
  /** Why joining failed, or why it ended. */
  message = $state('')
  welcome = $state.raw<Welcome | null>(null)
  net = $state.raw<NetworkState | null>(null)

  private conn: GuestConnection
  private nameTried = ''

  constructor(readonly token: string, private deps: GuestDeps = {}) {
    const events: GuestEvents = {
      onWelcome: (w) => this.joined(w),
      onTag: (key, value) => this.fromHost(key, value),
      onEnd: (reason) => this.finish(reason),
      onRefused: (reason) => {
        this.phase = 'name'
        this.message = reason
      },
      onClosed: () => {
        if (this.phase === 'joining') {
          this.phase = 'name'
          this.message = 'Could not reach the server. The link may have run out.'
        } else if (this.phase === 'joined') this.finish('The connection was lost.')
      },
    }
    this.conn = new GuestConnection(token, events, deps.Socket)
  }

  private get storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
    try {
      return this.deps.storage ?? sessionStorage
    } catch {
      return null
    }
  }

  private resumeKey = () => `guest-resume:${this.token}`

  /** Joins under a name. */
  join(name: string): void {
    const n = name.trim()
    if (!n) {
      this.message = 'Enter a name to join with.'
      return
    }
    this.nameTried = n
    this.message = ''
    this.phase = 'joining'
    let resume = ''
    try {
      resume = this.storage?.getItem(this.resumeKey()) ?? ''
    } catch {
      // no stored key: join as new
    }
    this.conn.join(n, resume)
  }

  leave(): void {
    this.conn.leave()
    this.net?.dispose()
    this.finish('You left.')
  }

  private joined(w: Welcome): void {
    try {
      this.storage?.setItem(this.resumeKey(), w.resume)
    } catch {
      // not remembered
    }
    const net = new NetworkState('guest', `guest/${w.host}`, w.nick, (line) => this.toHost(line), {
      onMention: () => {},
      iceServers: () => Promise.resolve(w.ice),
      createConnection: this.deps.createConnection,
      getMedia: this.deps.getMedia ?? microphone,
    })
    net.label = w.host
    net.status = 'connected'
    net.viewing = true
    net.setCaps(new Set(['message-tags']))
    this.welcome = w
    this.net = net
    this.phase = 'joined'
    if (w.kind === 'direct') net.openDirect(w.host)
    else net.callNick(w.host)
  }

  /** What the page would send to the host: only signalling goes anywhere. */
  private toHost(line: string): void {
    const m = parse(line)
    if (!m || m.command !== 'TAGMSG') return
    for (const [key, value] of Object.entries(m.tags)) if (TAGS.has(key) && VALUE_RE.test(value)) this.conn.sendTag(key, value)
  }

  private fromHost(key: string, value: string): void {
    const w = this.welcome
    if (!w || !this.net || !TAGS.has(key) || !VALUE_RE.test(value)) return
    // The line it would have been on IRC, from the host to this guest.
    const m = parse(format({ tags: { [key]: value }, prefix: `${w.host}!${w.host}@gestalt`, command: 'TAGMSG', params: [w.nick] }))
    if (m) this.net.handleMessage(m)
  }

  private finish(reason: string): void {
    this.message = reason
    this.phase = 'ended'
    this.conn.close()
  }

  /** The name last asked to join with, so the form can offer it again. */
  get lastName(): string {
    return this.nameTried
  }
}

export { guestTokenFrom }
