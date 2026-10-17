// An in-memory pair of data channels for tests. Messages are delivered one per
// macrotask, and `bufferedAmount` counts what has been sent but not yet delivered,
// so back-pressure behaves as it does on a real connection.

import type { DataChannelLike } from './transfer'

export class FakeChannel implements DataChannelLike {
  label = 'test'
  readyState = 'open'
  binaryType = 'blob'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onopen: DataChannelLike['onopen'] = null
  onclose: DataChannelLike['onclose'] = null
  onerror: DataChannelLike['onerror'] = null
  onmessage: DataChannelLike['onmessage'] = null
  onbufferedamountlow: DataChannelLike['onbufferedamountlow'] = null
  peer!: FakeChannel
  /** Highest bufferedAmount seen, to show the sender holds back. */
  peakBuffered = 0
  /** Changes or drops what this side sends. Return null to drop. */
  tamper: ((data: ArrayBuffer | ArrayBufferView | string) => ArrayBuffer | ArrayBufferView | string | null) | null = null
  private queue: Array<ArrayBuffer | string> = []
  private pumping = false

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (this.readyState !== 'open') throw new Error('channel is not open')
    const out = this.tamper ? this.tamper(data) : data
    if (out === null) return
    let item: ArrayBuffer | string
    if (typeof out === 'string') item = out
    else if (out instanceof ArrayBuffer) item = out.slice(0)
    else item = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
    const size = typeof item === 'string' ? item.length : item.byteLength
    this.bufferedAmount += size
    this.peakBuffered = Math.max(this.peakBuffered, this.bufferedAmount)
    this.queue.push(item)
    if (!this.pumping) {
      this.pumping = true
      setTimeout(() => this.pump(), 0)
    }
  }

  private pump(): void {
    const item = this.queue.shift()
    if (item === undefined) {
      this.pumping = false
      return
    }
    const size = typeof item === 'string' ? item.length : item.byteLength
    const before = this.bufferedAmount
    this.bufferedAmount -= size
    if (this.peer.readyState === 'open') this.peer.onmessage?.({ data: item })
    if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.onbufferedamountlow?.()
    }
    setTimeout(() => this.pump(), 0)
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.queue = []
    this.bufferedAmount = 0
    this.onclose?.()
    // The far side hears about it a moment later, like a real connection.
    setTimeout(() => {
      if (this.peer.readyState !== 'closed') {
        this.peer.readyState = 'closed'
        this.peer.onclose?.()
      }
    }, 5)
  }
}

export function channelPair(): [FakeChannel, FakeChannel] {
  const a = new FakeChannel()
  const b = new FakeChannel()
  a.peer = b
  b.peer = a
  return [a, b]
}
