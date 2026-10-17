// A guest's connection to the bouncer. It carries the same signalling a Gestalt user's browser would send over IRC,
// as JSON frames: the bouncer hands it to the person who made the link, and hands their replies back.

export interface Welcome {
  /** The nick this guest is known by to the host, such as g-Sam. */
  nick: string
  name: string
  kind: 'room' | 'direct'
  /** The channel for a room, the person's nick for a direct link. */
  target: string
  /** The host's nick, which signalling is addressed to. */
  host: string
  network: string
  /** Lets the same guest come back to a link that works once. */
  resume: string
  ice: RTCIceServer[]
}

export interface GuestEvents {
  onWelcome(w: Welcome): void
  onTag(key: string, value: string): void
  /** The host or the bouncer ended it. */
  onEnd(reason: string): void
  /** The bouncer would not let this guest in. */
  onRefused(reason: string): void
  /** The connection went, for a reason nobody said. */
  onClosed(): void
}

type SocketCtor = new (url: string) => WebSocket

export function guestSocketUrl(token: string, loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/guest/ws?token=${encodeURIComponent(token)}`
}

/** The token in a guest page's address, or null for any other page. */
export function guestTokenFrom(path: string): string | null {
  const m = /^\/guest\/([A-Za-z0-9_-]{8,64})\/?$/.exec(path)
  return m ? m[1]! : null
}

export class GuestConnection {
  private ws: WebSocket | null = null
  private settled = false

  constructor(
    private token: string,
    private events: GuestEvents,
    private Socket: SocketCtor = WebSocket,
    private url?: string,
  ) {}

  /** Opens the connection and asks to join under `name`. */
  join(name: string, resume = ''): void {
    this.close()
    this.settled = false
    const ws = new this.Socket(this.url ?? guestSocketUrl(this.token))
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name, resume }))
    ws.onmessage = (e) => this.onFrame(typeof e.data === 'string' ? e.data : '')
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      if (!this.settled) {
        this.settled = true
        this.events.onClosed()
      }
    }
    ws.onerror = () => {}
  }

  sendTag(key: string, value: string): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'tag', key, value }))
  }

  /** Leaves politely. */
  leave(): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'bye' }))
    this.close()
  }

  close(): void {
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.onmessage = null
      ws.close()
    }
  }

  private onFrame(data: string): void {
    let f: Record<string, unknown>
    try {
      f = JSON.parse(data)
    } catch {
      return
    }
    switch (f.t) {
      case 'welcome':
        if (typeof f.nick === 'string' && typeof f.host === 'string' && (f.kind === 'room' || f.kind === 'direct')) {
          this.events.onWelcome({
            nick: f.nick,
            name: typeof f.name === 'string' ? f.name : f.nick,
            kind: f.kind,
            target: typeof f.target === 'string' ? f.target : '',
            host: f.host,
            network: typeof f.network === 'string' ? f.network : '',
            resume: typeof f.resume === 'string' ? f.resume : '',
            ice: Array.isArray(f.ice) ? (f.ice as RTCIceServer[]) : [],
          })
        }
        return
      case 'tag':
        if (typeof f.key === 'string' && typeof f.value === 'string') this.events.onTag(f.key, f.value)
        return
      case 'end':
        this.settled = true
        this.events.onEnd(typeof f.reason === 'string' ? f.reason : 'The link ended.')
        return
      case 'error':
        this.settled = true
        this.events.onRefused(typeof f.reason === 'string' ? f.reason : 'Could not join.')
        return
    }
  }
}
