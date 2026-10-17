// Sending and receiving one file over a data channel. The sender reads the file in
// pieces, waits when the channel's buffer is full so memory stays flat, and hashes
// as it goes. The receiver counts what arrives, hashes it, and only hands over the
// file once the size and the checksum both agree with what was offered.
//
// Each file has a channel of its own, so binary pieces and the closing text frame
// stay in order with each other.

import { CHUNK_BYTES } from './protocol'
import { Sha256 } from './sha256'

/** The part of RTCDataChannel that file transfer uses. A fake stands in for it in tests. */
export interface DataChannelLike {
  readonly label: string
  readonly readyState: string
  binaryType: string
  readonly bufferedAmount: number
  bufferedAmountLowThreshold: number
  onopen: ((ev?: unknown) => void) | null
  onclose: ((ev?: unknown) => void) | null
  onerror: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onbufferedamountlow: ((ev?: unknown) => void) | null
  send(data: ArrayBuffer | ArrayBufferView | string): void
  close(): void
}

/** The sender stops reading when this much is waiting to go out, and resumes below LOW. */
export const HIGH_WATER = 1024 * 1024
export const LOW_WATER = 256 * 1024

/** The text frame that follows the last piece of a file. */
interface EndFrame {
  t: 'end'
  sha256: string
}

export type TransferFailure = 'cancelled' | 'closed' | 'too-much-data' | 'short' | 'checksum' | 'bad-data'

export class TransferError extends Error {
  constructor(readonly reason: TransferFailure) {
    super(reason)
  }
}

export interface SendOptions {
  channel: DataChannelLike
  file: Blob
  onProgress?: (sent: number, total: number) => void
}

export class FileSender {
  private cancelled = false
  private closed = false
  private wake: (() => void) | null = null

  constructor(private opts: SendOptions) {
    const ch = opts.channel
    ch.bufferedAmountLowThreshold = LOW_WATER
    ch.onbufferedamountlow = () => this.wake?.()
    ch.onclose = () => {
      this.closed = true
      this.wake?.()
    }
  }

  cancel(): void {
    this.cancelled = true
    this.wake?.()
    this.opts.channel.close()
  }

  /** Sends the whole file. Resolves with its SHA-256 once the last byte is handed to the channel. */
  async run(): Promise<{ sha256: string }> {
    const { channel, file } = this.opts
    const hash = new Sha256()
    let sent = 0
    await this.waitOpen()

    for (let at = 0; at < file.size; at += CHUNK_BYTES) {
      const chunk = new Uint8Array(await file.slice(at, at + CHUNK_BYTES).arrayBuffer())
      // Wait for the buffer to drain before queueing more, or a big file fills memory.
      while (channel.bufferedAmount > HIGH_WATER) {
        this.check()
        await new Promise<void>((resolve) => (this.wake = resolve))
        this.wake = null
      }
      this.check()
      channel.send(chunk)
      hash.update(chunk)
      sent += chunk.length
      this.opts.onProgress?.(sent, file.size)
    }
    this.check()
    const sha256 = hash.digestHex()
    const end: EndFrame = { t: 'end', sha256 }
    channel.send(JSON.stringify(end))
    this.opts.onProgress?.(file.size, file.size)
    return { sha256 }
  }

  private check(): void {
    if (this.cancelled) throw new TransferError('cancelled')
    if (this.closed || this.opts.channel.readyState === 'closed') throw new TransferError('closed')
  }

  private waitOpen(): Promise<void> {
    const ch = this.opts.channel
    if (ch.readyState === 'open') return Promise.resolve()
    return new Promise((resolve, reject) => {
      ch.onopen = () => resolve()
      const fail = () => reject(new TransferError(this.cancelled ? 'cancelled' : 'closed'))
      ch.onerror = fail
      const prev = ch.onclose
      ch.onclose = (e) => {
        prev?.(e)
        fail()
      }
    })
  }
}

export interface ReceiveOptions {
  channel: DataChannelLike
  /** The size that was offered and accepted. */
  size: number
  onProgress?: (received: number, total: number) => void
  /** Called once with the finished file. The hash is the one the sender computed and we verified. */
  onComplete: (file: Blob, sha256: string) => void
  onError: (reason: TransferFailure) => void
}

export class FileReceiver {
  private chunks: ArrayBuffer[] = []
  private received = 0
  private hash = new Sha256()
  private finished = false

  constructor(private opts: ReceiveOptions) {
    const ch = opts.channel
    ch.binaryType = 'arraybuffer'
    ch.onmessage = (ev) => this.onMessage(ev.data)
    ch.onclose = () => this.fail('closed')
    ch.onerror = () => this.fail('closed')
  }

  cancel(): void {
    this.fail('cancelled')
  }

  private fail(reason: TransferFailure): void {
    if (this.finished) return
    this.finished = true
    this.chunks = []
    this.opts.channel.onmessage = null
    try {
      this.opts.channel.close()
    } catch {
      // already closed
    }
    this.opts.onError(reason)
  }

  private onMessage(data: unknown): void {
    if (this.finished) return
    if (typeof data === 'string') return this.onEnd(data)
    if (!(data instanceof ArrayBuffer)) return this.fail('bad-data')
    // More than was offered is a bug or an attack. Stop before it fills memory.
    if (this.received + data.byteLength > this.opts.size) return this.fail('too-much-data')
    this.chunks.push(data)
    this.received += data.byteLength
    this.hash.update(new Uint8Array(data))
    this.opts.onProgress?.(this.received, this.opts.size)
  }

  private onEnd(text: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return this.fail('bad-data')
    }
    const f = frame as Partial<EndFrame> | null
    if (!f || f.t !== 'end' || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return this.fail('bad-data')
    if (this.received !== this.opts.size) return this.fail('short')
    const actual = this.hash.digestHex()
    if (actual !== f.sha256) return this.fail('checksum')

    this.finished = true
    // The sender has nothing more to say; closing here lets it see the end of the channel.
    // The type is fixed, so a file called "x.html" is never rendered when opened from here.
    const file = new Blob(this.chunks, { type: 'application/octet-stream' })
    this.chunks = []
    this.opts.channel.onmessage = null
    this.opts.channel.onclose = null
    this.opts.channel.close()
    this.opts.onComplete(file, actual)
  }
}
