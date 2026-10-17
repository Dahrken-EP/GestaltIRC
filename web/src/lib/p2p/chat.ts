// A direct chat with one other person: the connection, the chat lines, and the
// files. It is driven from outside. Offers and answers come in through
// `handleSignal`, and go out through `options.signal`; what happens on screen is
// reported through `options.onChange` and `options.onMessage`.
//
// Nothing is connected until both people agree. An offer from someone is shown to
// the user first, and no connection is made (so no network address is revealed)
// until they accept.

import { PeerSession, safetyCode, type Description, type PeerState } from './peer'
import { MAX_CHAT_CHARS, MAX_FILE_BYTES, newId, parseControl, type Control } from './protocol'
import { FileReceiver, FileSender, type DataChannelLike, type TransferFailure } from './transfer'

export type ChatState =
  /** No connection. */
  | 'idle'
  /** We sent an offer and are waiting for an answer. */
  | 'calling'
  /** They sent an offer and are waiting for us. */
  | 'incoming'
  /** Both sides agreed; the connection is being made. */
  | 'connecting'
  | 'connected'
  /** It ended. `reason` says why. */
  | 'ended'

export type TransferState = 'offered' | 'waiting' | 'active' | 'done' | 'failed' | 'declined' | 'cancelled'

export interface Transfer {
  id: string
  dir: 'in' | 'out'
  name: string
  size: number
  mime: string
  state: TransferState
  done: number
  /** Why it failed, in words for the user. */
  error?: string
  /** A received file, once complete and verified. */
  blob?: Blob
  sha256?: string
}

export interface ChatView {
  state: ChatState
  reason: string
  /** Five groups of four characters to read aloud and compare. Empty until connected. */
  code: string
  /** Their client confirmed it received our request, so we know they use Gestalt. It says nothing of what they will answer. */
  acked: boolean
  fingerprints: { local: string; remote: string }
  transfers: Transfer[]
}

export interface ChatLine {
  id: string
  text: string
  self: boolean
  time: number
}

export interface DirectChatOptions {
  peer: string
  iceServers: () => Promise<RTCIceServer[]>
  /** Sends a signalling message to the peer. `sid` is the attempt it belongs to. */
  signal: (sid: string, payload: { k: 'chat'; t: string; sdp?: string }) => void
  onChange: (view: ChatView) => void
  onMessage: (line: ChatLine) => void
  /** Makes the connection. Tests pass a fake. */
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection
  newSid: () => string
  /** True if this side should win when both start at once. Decided the same way on both ends. */
  wins: () => boolean
  inviteTimeoutMs?: number
  /** Offers waiting for the user's answer, at most. */
  maxPendingOffers?: number
}

const CHAT_LABEL = 'chat'
const FILE_PREFIX = 'file:'
const MAX_PENDING_OFFERS = 8
const MAX_OPEN_TRANSFERS = 4
/** Offers accepted for the user's attention in any minute, so one peer cannot bury the panel in them. */
const MAX_OFFERS_PER_MINUTE = 12

const FAILURES: Record<TransferFailure, string> = {
  cancelled: 'cancelled',
  closed: 'the connection closed',
  'too-much-data': 'more data arrived than was offered',
  short: 'the file ended early',
  checksum: 'the file did not match its checksum',
  'bad-data': 'unexpected data',
}

interface Live {
  tx?: FileSender
  rx?: FileReceiver
  /** The channel for a file we are sending is opened once they accept. */
  file?: Blob
}

export class DirectChat {
  private view: ChatView = { state: 'idle', reason: '', code: '', acked: false, fingerprints: { local: '', remote: '' }, transfers: [] }
  private sid = ''
  private pending: Description | null = null
  private session: PeerSession | null = null
  private chat: DataChannelLike | null = null
  private live = new Map<string, Live>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastSeenIds = new Set<string>()
  private offerTimes: number[] = []

  constructor(private o: DirectChatOptions) {}

  get state(): ChatState {
    return this.view.state
  }

  // --- starting and ending ---

  /** Asks the peer to connect. */
  async invite(): Promise<void> {
    if (this.view.state === 'calling' || this.view.state === 'connecting' || this.view.state === 'connected') return
    if (this.view.state === 'incoming') return this.acceptIncoming()
    this.reset()
    const sid = (this.sid = this.o.newSid())
    this.update({ state: 'calling', reason: '', acked: false })
    this.armTimer('No answer.')
    try {
      const session = await this.makeSession()
      const ch = await session.start(CHAT_LABEL)
      if (!ch) throw new Error('no channel')
      // Something else (a competing offer, a hang-up) may have taken over meanwhile.
      if (this.session !== session) return
      this.chat = ch
      this.watchChat(ch)
    } catch {
      if (this.sid === sid && this.state === 'calling') this.end('Could not start the connection.')
    }
  }

  /** The user agreed to an offer that arrived. */
  async acceptIncoming(): Promise<void> {
    const offer = this.pending
    if (this.view.state !== 'incoming' || !offer) return
    this.pending = null
    clearTimeout(this.timer)
    const sid = this.sid
    this.update({ state: 'connecting' })
    this.armTimer('The connection did not complete.')
    try {
      const session = await this.makeSession()
      await session.accept(offer.sdp)
    } catch {
      if (this.sid === sid && this.state === 'connecting') {
        // The caller is waiting for an answer that will not come; tell them so they do not sit through the timeout.
        this.o.signal(sid, { k: 'chat', t: 'reject' })
        this.end('Could not accept the connection.')
      }
    }
  }

  declineIncoming(): void {
    if (this.view.state !== 'incoming') return
    this.o.signal(this.sid, { k: 'chat', t: 'reject' })
    this.pending = null
    this.reset()
    this.update({ state: 'idle', reason: '' })
  }

  /** Ends the connection and tells the other side. */
  hangUp(): void {
    if (this.view.state === 'idle' || this.view.state === 'ended') return
    this.o.signal(this.sid, { k: 'chat', t: 'bye' })
    // Also say it on the connection, which arrives before the connection is seen to drop.
    this.control({ t: 'bye', id: newId() })
    this.end('You closed the chat.', true)
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.teardown()
  }

  // --- signalling in ---

  handleSignal(sid: string, p: { t: string; sdp?: string }): void {
    switch (p.t) {
      case 'offer':
        return this.onOffer(sid, p.sdp)
      case 'answer':
        if (sid !== this.sid || this.view.state !== 'calling' || typeof p.sdp !== 'string' || !this.session) return
        clearTimeout(this.timer)
        this.update({ state: 'connecting' })
        this.armTimer('The connection did not complete.')
        this.session.applyAnswer(p.sdp).catch(() => this.end('The answer was not valid.'))
        return
      case 'ack':
        if (sid === this.sid && this.view.state === 'calling') this.update({ acked: true })
        return
      case 'reject':
        if (sid === this.sid && this.view.state === 'calling') this.end('They declined.')
        return
      case 'bye':
        if (sid === this.sid && this.view.state !== 'idle' && this.view.state !== 'ended') this.end('They closed the chat.')
        return
    }
  }

  private onOffer(sid: string, sdp: unknown): void {
    if (typeof sdp !== 'string' || sdp.length === 0 || !/^[a-z0-9]{6,16}$/.test(sid)) return
    const st = this.view.state
    if (st === 'connected' || st === 'connecting') {
      // A live chat is not replaced by a stranger's offer. A new offer for a finished
      // one, with a fresh id, is a new request and is handled below.
      if (sid !== this.sid) this.o.signal(sid, { k: 'chat', t: 'reject' })
      return
    }
    if (st === 'calling') {
      // Both sides started at once. One wins, the same one on both ends.
      if (!this.o.wins()) {
        this.o.signal(sid, { k: 'chat', t: 'reject' })
        return
      }
      this.teardown()
    }
    if (st === 'incoming' && sid === this.sid) return // a repeat
    this.reset()
    this.sid = sid
    this.pending = { t: 'offer', sdp }
    this.update({ state: 'incoming', reason: '' })
    // Says only that a client got the request, so the caller knows they are not talking to nobody. Nothing
    // is connected and no address is shared until the user accepts.
    this.o.signal(sid, { k: 'chat', t: 'ack' })
    this.armTimer('The request expired.')
  }

  // --- chat and files ---

  sendChat(text: string): boolean {
    const t = text.slice(0, MAX_CHAT_CHARS)
    if (!t.trim() || this.view.state !== 'connected' || this.chat?.readyState !== 'open') return false
    const id = newId()
    this.chat.send(JSON.stringify({ t: 'chat', id, text: t }))
    this.o.onMessage({ id, text: t, self: true, time: Date.now() })
    return true
  }

  /** Offers a file. It is sent only if the other side accepts. */
  offerFile(file: File): string | null {
    if (this.view.state !== 'connected' || this.chat?.readyState !== 'open') return null
    const id = newId()
    if (file.size > MAX_FILE_BYTES) {
      this.addTransfer({ id, dir: 'out', name: file.name, size: file.size, mime: file.type, state: 'failed', done: 0, error: 'too large to send' })
      return id
    }
    this.live.set(id, { file })
    this.addTransfer({ id, dir: 'out', name: file.name || 'file', size: file.size, mime: file.type, state: 'waiting', done: 0 })
    this.chat.send(JSON.stringify({ t: 'file-offer', id, name: file.name || 'file', size: file.size, mime: file.type || 'application/octet-stream' }))
    return id
  }

  acceptFile(id: string): void {
    const t = this.transfer(id)
    if (!t || t.dir !== 'in' || t.state !== 'offered') return
    // The offer stays, so it can be accepted once another transfer has finished.
    if (this.openCount() >= MAX_OPEN_TRANSFERS) return this.setTransfer(id, { error: 'wait for another transfer to finish' })
    this.setTransfer(id, { state: 'active', error: undefined })
    this.control({ t: 'file-accept', id })
  }

  declineFile(id: string): void {
    const t = this.transfer(id)
    if (!t || t.dir !== 'in' || t.state !== 'offered') return
    this.fileMessage('file-reject', id, 'declined')
  }

  cancelTransfer(id: string): void {
    const t = this.transfer(id)
    if (!t || (t.state !== 'active' && t.state !== 'waiting' && t.state !== 'offered')) return
    const live = this.live.get(id)
    live?.tx?.cancel()
    live?.rx?.cancel()
    if (t.state === 'offered') return this.fileMessage('file-reject', id, 'declined')
    this.control({ t: 'file-cancel', id })
    this.setTransfer(id, { state: 'cancelled' })
    this.live.delete(id)
  }

  /** Forgets finished transfers so the list stays short. */
  clearFinished(): void {
    const keep = this.view.transfers.filter((t) => t.state === 'offered' || t.state === 'waiting' || t.state === 'active')
    this.update({ transfers: keep })
  }

  // --- internals ---

  private async makeSession(): Promise<PeerSession> {
    const sid = this.sid
    const servers = await this.o.iceServers().catch(() => [] as RTCIceServer[])
    if (this.sid !== sid) throw new Error('superseded')
    // A connection that was replaced can still report in (it closes a moment after hang-up).
    // Only the current one may affect the chat.
    const current = () => this.session === session
    const session: PeerSession = new PeerSession({
      iceServers: servers,
      createConnection: this.o.createConnection,
      send: (d) => current() && this.o.signal(sid, { k: 'chat', t: d.t, sdp: d.sdp }),
      onChannel: (ch) => (current() ? this.onChannel(ch) : ch.close()),
      onState: (s) => current() && this.onPeerState(s),
    })
    this.session = session
    return session
  }

  private onPeerState(s: PeerState): void {
    if (s === 'failed') this.end('The connection failed. A firewall may be in the way.')
    else if (s === 'closed' && this.view.state !== 'ended' && this.view.state !== 'idle') this.end('The connection closed.')
  }

  private onChannel(ch: DataChannelLike): void {
    if (ch.label === CHAT_LABEL && !this.chat) {
      this.chat = ch
      this.watchChat(ch)
    } else if (ch.label.startsWith(FILE_PREFIX)) {
      this.onFileChannel(ch)
    } else {
      ch.close()
    }
  }

  private watchChat(ch: DataChannelLike): void {
    const opened = () => {
      clearTimeout(this.timer)
      const fp = this.session?.fingerprints ?? { local: '', remote: '' }
      const code = safetyCode(fp.local, fp.remote)
      if (!code) {
        // Without a certificate to compare there is nothing to verify, so nothing is sent.
        this.o.signal(this.sid, { k: 'chat', t: 'bye' })
        this.end("Could not read the other browser's certificate, so the chat was closed.")
        return
      }
      this.update({ state: 'connected', reason: '', fingerprints: fp, code })
    }
    if (ch.readyState === 'open') opened()
    else ch.onopen = opened
    ch.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      const c = parseControl(ev.data)
      if (c) this.onControl(c)
    }
    ch.onclose = () => {
      if (this.chat === ch && this.view.state !== 'ended') this.end('The connection closed.')
    }
  }

  private onControl(c: Control): void {
    switch (c.t) {
      case 'chat':
        // The same id twice (a replay) is shown once.
        if (this.lastSeenIds.has(c.id)) return
        this.lastSeenIds.add(c.id)
        if (this.lastSeenIds.size > 500) this.lastSeenIds.delete(this.lastSeenIds.values().next().value!)
        this.o.onMessage({ id: c.id, text: c.text, self: false, time: Date.now() })
        return
      case 'file-offer': {
        if (this.transfer(c.id)) return
        const now = Date.now()
        this.offerTimes = this.offerTimes.filter((t) => now - t < 60_000)
        if (this.offerTimes.length >= MAX_OFFERS_PER_MINUTE) return this.control({ t: 'file-reject', id: c.id })
        this.offerTimes.push(now)
        const pendingOffers = this.view.transfers.filter((t) => t.dir === 'in' && t.state === 'offered').length
        if (pendingOffers >= (this.o.maxPendingOffers ?? MAX_PENDING_OFFERS)) return this.control({ t: 'file-reject', id: c.id })
        this.addTransfer({ id: c.id, dir: 'in', name: c.name, size: c.size, mime: c.mime, state: 'offered', done: 0 })
        return
      }
      case 'file-accept': {
        const t = this.transfer(c.id)
        const live = this.live.get(c.id)
        if (!t || t.dir !== 'out' || t.state !== 'waiting' || !live?.file || !this.session) return
        this.setTransfer(c.id, { state: 'active' })
        this.sendFile(c.id, live)
        return
      }
      case 'file-reject': {
        const t = this.transfer(c.id)
        if (t?.dir === 'out' && (t.state === 'waiting' || t.state === 'active')) {
          this.live.get(c.id)?.tx?.cancel()
          this.live.delete(c.id)
          this.setTransfer(c.id, { state: 'declined' })
        }
        return
      }
      case 'file-cancel': {
        const t = this.transfer(c.id)
        // A cancelled file's channel can close before the message about it arrives, which
        // looks like a failure first. The message says what really happened.
        if (t && (t.state === 'offered' || t.state === 'active' || t.state === 'waiting' || t.state === 'failed')) {
          const live = this.live.get(c.id)
          live?.tx?.cancel()
          live?.rx?.cancel()
          this.live.delete(c.id)
          this.setTransfer(c.id, { state: 'cancelled' })
        }
        return
      }
      case 'bye':
        this.end('They closed the chat.')
        return
      case 'file-done': {
        const t = this.transfer(c.id)
        if (t?.dir === 'out' && t.state === 'active') {
          this.setTransfer(c.id, c.ok ? { state: 'done', done: t.size } : { state: 'failed', error: 'the other side could not verify it' })
          this.live.delete(c.id)
        }
        return
      }
    }
  }

  private sendFile(id: string, live: Live): void {
    const ch = this.session!.openChannel(FILE_PREFIX + id)
    const tx = new FileSender({
      channel: ch,
      file: live.file!,
      onProgress: (sent) => this.setTransfer(id, { done: sent }),
    })
    live.tx = tx
    tx.run().catch((e: { reason?: TransferFailure }) => {
      const t = this.transfer(id)
      if (t?.state === 'active') this.setTransfer(id, { state: 'failed', error: FAILURES[e.reason ?? 'closed'] })
    })
  }

  private onFileChannel(ch: DataChannelLike): void {
    const id = ch.label.slice(FILE_PREFIX.length)
    const t = this.transfer(id)
    // Only a file the user accepted may arrive, and only once.
    if (!t || t.dir !== 'in' || t.state !== 'active' || this.live.get(id)?.rx) {
      ch.close()
      return
    }
    const rx = new FileReceiver({
      channel: ch,
      size: t.size,
      onProgress: (n) => this.setTransfer(id, { done: n }),
      onComplete: (blob, sha256) => {
        this.live.delete(id)
        this.setTransfer(id, { state: 'done', done: t.size, blob, sha256 })
        this.control({ t: 'file-done', id, ok: true })
      },
      onError: (reason) => {
        this.live.delete(id)
        const cur = this.transfer(id)
        if (cur?.state === 'active') {
          this.setTransfer(id, { state: reason === 'cancelled' ? 'cancelled' : 'failed', error: FAILURES[reason] })
          if (reason !== 'cancelled') this.control({ t: 'file-done', id, ok: false })
        }
      },
    })
    this.live.set(id, { rx })
  }

  private fileMessage(kind: 'file-reject', id: string, state: TransferState): void {
    this.control({ t: kind, id })
    this.setTransfer(id, { state })
    this.live.delete(id)
  }

  private control(c: Control): void {
    if (this.chat?.readyState === 'open') {
      try {
        this.chat.send(JSON.stringify(c))
      } catch {
        // the channel closed under us; the close handler ends the chat
      }
    }
  }

  private openCount(): number {
    return this.view.transfers.filter((t) => t.state === 'active').length
  }

  private transfer(id: string): Transfer | undefined {
    return this.view.transfers.find((t) => t.id === id)
  }

  private addTransfer(t: Transfer): void {
    this.update({ transfers: [...this.view.transfers, t] })
  }

  private setTransfer(id: string, patch: Partial<Transfer>): void {
    this.update({ transfers: this.view.transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
  }

  private armTimer(reason: string): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const s = this.view.state
      if (s === 'calling' || s === 'incoming' || s === 'connecting') {
        if (s === 'calling') this.o.signal(this.sid, { k: 'chat', t: 'bye' })
        this.end(reason)
      }
    }, this.o.inviteTimeoutMs ?? 60_000)
  }

  private end(reason: string, graceful = false): void {
    clearTimeout(this.timer)
    this.teardown(graceful)
    // Transfers that were running cannot finish now.
    const transfers = this.view.transfers.map((t): Transfer =>
      t.state === 'active' || t.state === 'waiting' ? { ...t, state: 'failed', error: 'the connection closed' } : t.state === 'offered' ? { ...t, state: 'cancelled' } : t,
    )
    this.update({ state: 'ended', reason, transfers })
  }

  /** `graceful` gives a goodbye just sent on the connection a moment to get out before it is closed. */
  private teardown(graceful = false): void {
    for (const l of this.live.values()) {
      l.tx?.cancel()
      l.rx?.cancel()
    }
    this.live.clear()
    // Detached first: closing reports back, and a session that is no longer ours must not end the chat again.
    const session = this.session
    this.session = null
    this.chat = null
    this.pending = null
    if (session && graceful) setTimeout(() => session.close(), 300)
    else session?.close()
  }

  private reset(): void {
    this.teardown()
    this.view = { ...this.view, code: '', fingerprints: { local: '', remote: '' } }
  }

  private update(patch: Partial<ChatView>): void {
    this.view = { ...this.view, ...patch }
    this.o.onChange(this.view)
  }
}
