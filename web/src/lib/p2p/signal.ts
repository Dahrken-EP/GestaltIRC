// Signalling for peer to peer connections, carried over IRC itself. A connection
// offer or answer is JSON, which can be a few kilobytes, while one IRC tag value
// is small. So a message is split into chunks, each sent as a TAGMSG with one
// client-only tag, and put back together by the receiver. The IRC network is only
// a postman here: the data channel that follows goes straight between browsers.
//
// The envelope is not specific to chat. `k` says what the connection is for, so
// voice calls (a channel room, or a private call) can use the same wire format.

export const SIGNAL_TAG = '+irc-webclient/p2p'

/** Characters of encoded data per tag, kept well under the limit for client tags. */
export const MAX_CHUNK = 1800
const MAX_CHUNKS = 16
/** The largest message, in bytes of JSON, that will be reassembled. */
export const MAX_MESSAGE_BYTES = 24 * 1024
const PARTIAL_TTL_MS = 30_000
const MAX_PARTIALS_PER_SENDER = 4
const MAX_PARTIALS = 32

const VALUE_RE = /^([a-z0-9]{6,16})\.(\d{1,2})\.(\d{1,2})\.([A-Za-z0-9_-]*)$/

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** A random id for one connection attempt. Both sides use it to tell attempts apart. */
export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
}

/** What a signalling message looks like once decoded. Callers check the fields they use. */
export interface Signal {
  /** What the connection is for: "chat" now, "voice" later. */
  k: string
  /** offer, answer, reject or bye. */
  t: string
  [field: string]: unknown
}

/** Splits a message into tag values, one per TAGMSG, in order. */
export function encodeSignal(sid: string, payload: object, maxChunk = MAX_CHUNK): string[] {
  if (!/^[a-z0-9]{6,16}$/.test(sid)) throw new Error('bad session id')
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  if (bytes.length > MAX_MESSAGE_BYTES) throw new Error('signalling message is too large')
  const data = toBase64Url(bytes)
  const n = Math.max(1, Math.ceil(data.length / maxChunk))
  if (n > MAX_CHUNKS) throw new Error('signalling message needs too many parts')
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(`${sid}.${i}.${n}.${data.slice(i * maxChunk, (i + 1) * maxChunk)}`)
  return out
}

interface Partial {
  sid: string
  sender: string
  n: number
  parts: (string | undefined)[]
  have: number
  size: number
  started: number
}

/**
 * Puts chunks from many senders back together. The input comes from other people on
 * the network, so everything is bounded: how many unfinished messages a sender may
 * have, how many there are in all, how long they live, and how large they get.
 */
export class SignalAssembler {
  private partials = new Map<string, Partial>()

  /** Takes one tag value from `from`. Returns the message when this chunk completes it. */
  add(from: string, value: string, now: number = Date.now()): { sid: string; payload: Signal } | null {
    this.expire(now)
    const m = VALUE_RE.exec(value)
    if (!m) return null
    const sid = m[1]!
    const i = Number(m[2])
    const n = Number(m[3])
    const chunk = m[4]!
    if (n < 1 || n > MAX_CHUNKS || i >= n || chunk.length > MAX_CHUNK) return null

    const sender = from.toLowerCase()
    const key = `${sender}/${sid}`
    let p = this.partials.get(key)
    if (p && p.n !== n) {
      // Same id, different shape: not one message. Start over rather than mix them.
      this.partials.delete(key)
      p = undefined
    }
    if (!p) {
      this.makeRoom(sender)
      p = { sid, sender, n, parts: new Array(n), have: 0, size: 0, started: now }
      this.partials.set(key, p)
    }
    if (p.parts[i] === undefined) {
      p.parts[i] = chunk
      p.have++
      p.size += chunk.length
    }
    if (p.size > Math.ceil((MAX_MESSAGE_BYTES * 4) / 3) + 4) {
      this.partials.delete(key)
      return null
    }
    if (p.have < p.n) return null

    this.partials.delete(key)
    const payload = decode(p.parts.join(''))
    return payload ? { sid, payload } : null
  }

  /** How many unfinished messages are being held. */
  get pending(): number {
    return this.partials.size
  }

  private expire(now: number): void {
    for (const [k, p] of this.partials) if (now - p.started > PARTIAL_TTL_MS) this.partials.delete(k)
  }

  /** Makes space for a new unfinished message by dropping the oldest ones. */
  private makeRoom(sender: string): void {
    const mine = [...this.partials.entries()].filter(([, p]) => p.sender === sender)
    while (mine.length >= MAX_PARTIALS_PER_SENDER) this.partials.delete(mine.shift()![0])
    while (this.partials.size >= MAX_PARTIALS) this.partials.delete(this.partials.keys().next().value!)
  }
}

function decode(data: string): Signal | null {
  try {
    const bytes = fromBase64Url(data)
    if (bytes.length > MAX_MESSAGE_BYTES) return null
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const obj = JSON.parse(text)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    if (typeof obj.k !== 'string' || typeof obj.t !== 'string') return null
    return obj as Signal
  } catch {
    return null
  }
}
