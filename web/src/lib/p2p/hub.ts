// All the direct chats of one IRC connection. It receives the signalling tags the
// network hands it, puts the chunks back together, and passes each message to the
// chat with that person. It also sends our own signalling, a little at a time so a
// network's flood protection is not tripped.

import { DirectChat, type ChatLine, type ChatView } from './chat'
import type { PeerConnectionContext } from './peer'
import { encodeSignal, newSessionId, SIGNAL_TAG, SignalAssembler, type Signal } from './signal'

export interface HubOptions {
  /** Sends one tag-carrying line to the network. */
  sendSignalLine: (peer: string, tagValue: string) => void
  ownNick: () => string
  iceServers: () => Promise<RTCIceServer[]>
  onView: (peer: string, view: ChatView) => void
  onLine: (peer: string, line: ChatLine) => void
  createConnection?: (config: RTCConfiguration, ctx?: PeerConnectionContext) => RTCPeerConnection
  /** A signalling message for something other than chat, such as voice. */
  onSignal?: (from: string, sid: string, payload: Signal) => void
  /** Milliseconds between signalling lines. */
  pace?: number
  /** Most people who may have an unanswered request to us at once. */
  maxIncoming?: number
  /** Chats kept at once. Over this, finished ones with nothing in them are forgotten. */
  maxChats?: number
}

export { SIGNAL_TAG }

export class P2pHub {
  private chats = new Map<string, DirectChat>()
  private names = new Map<string, string>()
  private assembler = new SignalAssembler()
  private queue: Array<() => void> = []
  private pacing: ReturnType<typeof setTimeout> | undefined
  private views = new Map<string, ChatView>()

  constructor(private o: HubOptions) {}

  /** The chat with `peer`, made if there is none. */
  chat(peer: string): DirectChat {
    const key = peer.toLowerCase()
    let c = this.chats.get(key)
    if (!c) {
      this.prune()
      this.names.set(key, peer)
      c = new DirectChat({
        peer,
        iceServers: this.o.iceServers,
        createConnection: this.o.createConnection,
        newSid: newSessionId,
        // Both ends compute this from the two nicks and get opposite answers. Our nick can change, so it is read each time.
        wins: () => this.o.ownNick().toLowerCase() < key,
        signal: (sid, payload) => this.sendSignal(peer, sid, payload),
        onChange: (v) => {
          this.views.set(key, v)
          this.o.onView(this.names.get(key) ?? peer, v)
        },
        onMessage: (l) => this.o.onLine(this.names.get(key) ?? peer, l),
      })
      this.chats.set(key, c)
    }
    return c
  }

  /** Forgets chats that ended without ever holding anything, so strangers' passing offers do not pile up. */
  private prune(): void {
    if (this.chats.size < (this.o.maxChats ?? 50)) return
    for (const [key, view] of this.views) {
      if (view.state !== 'ended' && view.state !== 'idle') continue
      if (view.transfers.length) continue
      this.chats.get(key)?.dispose()
      this.chats.delete(key)
      this.views.delete(key)
      this.names.delete(key)
      if (this.chats.size < (this.o.maxChats ?? 50)) return
    }
  }

  has(peer: string): boolean {
    return this.chats.has(peer.toLowerCase())
  }

  view(peer: string): ChatView | undefined {
    return this.views.get(peer.toLowerCase())
  }

  /** Takes the value of one signalling tag from `from`. */
  receive(from: string, value: string): void {
    if (from.toLowerCase() === this.o.ownNick().toLowerCase()) return
    const done = this.assembler.add(from, value)
    if (!done) return
    if (done.payload.k !== 'chat') {
      this.o.onSignal?.(from, done.sid, done.payload)
      return
    }
    const key = from.toLowerCase()
    if (!this.chats.has(key)) {
      // A stranger's first offer. Only so many unanswered ones are kept.
      if (done.payload.t !== 'offer') return
      const waiting = [...this.views.values()].filter((v) => v.state === 'incoming').length
      if (waiting >= (this.o.maxIncoming ?? 8)) return
    }
    this.chat(from).handleSignal(done.sid, done.payload as { t: string; sdp?: string })
  }

  /** Ends and forgets the chat with `peer`. */
  close(peer: string): void {
    const key = peer.toLowerCase()
    const c = this.chats.get(key)
    if (!c) return
    c.hangUp()
    c.dispose()
    this.chats.delete(key)
    this.views.delete(key)
    this.names.delete(key)
  }

  dispose(): void {
    clearTimeout(this.pacing)
    // Goodbyes still waiting their turn go out now, all at once: the page is going away.
    for (const c of this.chats.values()) {
      c.hangUp()
      c.dispose()
    }
    for (const send of this.queue.splice(0)) send()
    this.chats.clear()
    this.views.clear()
  }

  /** Sends a signalling message to `peer`, paced like the chat's own. */
  send(peer: string, sid: string, payload: object): void {
    this.sendSignal(peer, sid, payload)
  }

  private sendSignal(peer: string, sid: string, payload: object): void {
    for (const value of encodeSignal(sid, payload)) this.queue.push(() => this.o.sendSignalLine(peer, value))
    this.drain()
  }

  private drain(): void {
    if (this.pacing !== undefined) return
    const next = this.queue.shift()
    if (!next) return
    next()
    this.pacing = setTimeout(() => {
      this.pacing = undefined
      this.drain()
    }, this.o.pace ?? 100)
  }
}
