import { describe, expect, it } from 'vitest'
import { channelPair, type FakeChannel } from './fakechannel'
import { CHUNK_BYTES } from './protocol'
import { sha256Hex } from './sha256'
import { FileReceiver, FileSender, HIGH_WATER, TransferError, type TransferFailure } from './transfer'

function bytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n))
  for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 8)) & 0xff
  return out
}

interface Outcome {
  file?: Blob
  hash?: string
  error?: TransferFailure
  progress: number[]
}

function receive(ch: FakeChannel, size: number): { out: Outcome; done: Promise<void> } {
  const out: Outcome = { progress: [] }
  let resolve!: () => void
  const done = new Promise<void>((r) => (resolve = r))
  const rx = new FileReceiver({
    channel: ch,
    size,
    onProgress: (n) => out.progress.push(n),
    onComplete: (file, hash) => {
      out.file = file
      out.hash = hash
      resolve()
    },
    onError: (e) => {
      out.error = e
      resolve()
    },
  })
  void rx
  return { out, done }
}

async function bytesOf(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer())
}

/** toEqual on megabytes of numbers is very slow, so compare digests of large files. */
async function expectSame(b: Blob, data: Uint8Array): Promise<void> {
  expect(b.size).toBe(data.length)
  expect(sha256Hex(await bytesOf(b))).toBe(sha256Hex(data))
}

describe('file transfer', () => {
  it('moves a multi-chunk file intact and agrees on the hash', async () => {
    const data = bytes(CHUNK_BYTES * 5 + 123)
    const [a, b] = channelPair()
    const { out, done } = receive(b, data.length)
    const sent: number[] = []
    const result = await new FileSender({ channel: a, file: new Blob([data]), onProgress: (n) => sent.push(n) }).run()
    await done
    expect(out.error).toBeUndefined()
    await expectSame(out.file!, data)
    expect(out.hash).toBe(result.sha256)
    expect(out.hash).toBe(sha256Hex(data))
    expect(sent.at(-1)).toBe(data.length)
    expect(out.progress.at(-1)).toBe(data.length)
    expect(out.file!.type).toBe('application/octet-stream')
  })

  it('moves an empty file', async () => {
    const [a, b] = channelPair()
    const { out, done } = receive(b, 0)
    await new FileSender({ channel: a, file: new Blob([]) }).run()
    await done
    expect(out.error).toBeUndefined()
    expect(out.file!.size).toBe(0)
    expect(out.hash).toBe(sha256Hex(new Uint8Array()))
  })

  it('moves a file of exactly one chunk', async () => {
    const data = bytes(CHUNK_BYTES)
    const [a, b] = channelPair()
    const { out, done } = receive(b, data.length)
    await new FileSender({ channel: a, file: new Blob([data]) }).run()
    await done
    await expectSame(out.file!, data)
  })

  it('holds back when the channel is full, so memory stays bounded', async () => {
    const data = bytes(CHUNK_BYTES * 80) // 5 MiB, well over the high-water mark
    const [a, b] = channelPair()
    const { out, done } = receive(b, data.length)
    await new FileSender({ channel: a, file: new Blob([data]) }).run()
    await done
    expect(out.error).toBeUndefined()
    expect(a.peakBuffered).toBeLessThanOrEqual(HIGH_WATER + CHUNK_BYTES)
    expect(a.peakBuffered).toBeGreaterThan(HIGH_WATER / 2)
    await expectSame(out.file!, data)
  })

  it('rejects a corrupted byte', async () => {
    const data = bytes(CHUNK_BYTES * 2)
    const [a, b] = channelPair()
    let n = 0
    a.tamper = (d) => {
      if (d instanceof Uint8Array && n++ === 1) {
        const c = d.slice()
        c[10]! ^= 1
        return c
      }
      return d
    }
    const { out, done } = receive(b, data.length)
    await new FileSender({ channel: a, file: new Blob([data]) }).run()
    await done
    expect(out.error).toBe('checksum')
    expect(out.file).toBeUndefined()
  })

  it('rejects a file that ends short', async () => {
    const data = bytes(CHUNK_BYTES * 2)
    const [a, b] = channelPair()
    let n = 0
    a.tamper = (d) => (d instanceof Uint8Array && n++ === 1 ? null : d)
    const { out, done } = receive(b, data.length)
    await new FileSender({ channel: a, file: new Blob([data]) }).run()
    await done
    expect(out.error).toBe('short')
  })

  it('stops at once when more arrives than was offered', async () => {
    const data = bytes(CHUNK_BYTES * 3)
    const [a, b] = channelPair()
    const { out, done } = receive(b, CHUNK_BYTES + 10)
    await new FileSender({ channel: a, file: new Blob([data]) })
      .run()
      .catch(() => undefined)
    await done
    expect(out.error).toBe('too-much-data')
    expect(out.file).toBeUndefined()
    expect(b.readyState).toBe('closed')
  })

  it.each([
    ['not json', 'oops'],
    ['wrong shape', '{"t":"nope"}'],
    ['bad hash', '{"t":"end","sha256":"xyz"}'],
    ['uppercase hash', `{"t":"end","sha256":"${'A'.repeat(64)}"}`],
  ])('rejects an end frame that is %s', async (_n, frame) => {
    const [a, b] = channelPair()
    const { out, done } = receive(b, 0)
    a.send(frame)
    await done
    expect(out.error).toBe('bad-data')
  })

  it('rejects a Blob or other non-binary message', async () => {
    const [a, b] = channelPair()
    const { out, done } = receive(b, 10)
    b.onmessage?.({ data: new Blob(['x']) })
    await done
    expect(out.error).toBe('bad-data')
    void a
  })

  it('reports a closed channel to the receiver and ignores later data', async () => {
    const [a, b] = channelPair()
    const { out, done } = receive(b, 100)
    a.close()
    await done
    expect(out.error).toBe('closed')
    b.onmessage?.({ data: new ArrayBuffer(4) })
    expect(out.progress).toEqual([])
  })

  it('lets the receiver cancel', async () => {
    const [, b] = channelPair()
    const out: Outcome = { progress: [] }
    const rx = new FileReceiver({
      channel: b,
      size: 10,
      onComplete: () => undefined,
      onError: (e) => (out.error = e),
    })
    rx.cancel()
    rx.cancel() // a second cancel does nothing
    expect(out.error).toBe('cancelled')
    expect(b.readyState).toBe('closed')
  })

  it('lets the sender cancel mid-file, and the receiver notices', async () => {
    const data = bytes(CHUNK_BYTES * 60)
    const [a, b] = channelPair()
    const { out, done } = receive(b, data.length)
    const tx = new FileSender({ channel: a, file: new Blob([data]), onProgress: (n) => n > CHUNK_BYTES * 3 && tx.cancel() })
    const err = await tx.run().catch((e) => e)
    expect(err).toBeInstanceOf(TransferError)
    expect((err as TransferError).reason).toBe('cancelled')
    await done
    expect(out.error).toBe('closed')
    expect(out.file).toBeUndefined()
  })

  it('ends the sender with "closed" when the peer goes away while it waits', async () => {
    const data = bytes(CHUNK_BYTES * 60)
    const [a, b] = channelPair()
    // Nobody receives, so the buffer fills and the sender waits.
    b.onmessage = null
    const tx = new FileSender({ channel: a, file: new Blob([data]) })
    const run = tx.run().catch((e) => e)
    setTimeout(() => b.close(), 20)
    const err = await run
    expect(err).toBeInstanceOf(TransferError)
    expect((err as TransferError).reason).toBe('closed')
  })

  it('waits for the channel to open before sending', async () => {
    const data = bytes(1000)
    const [a, b] = channelPair()
    a.readyState = 'connecting'
    const { out, done } = receive(b, data.length)
    const run = new FileSender({ channel: a, file: new Blob([data]) }).run()
    setTimeout(() => {
      a.readyState = 'open'
      a.onopen?.()
    }, 10)
    await run
    await done
    await expectSame(out.file!, data)
  })

  it('fails if the channel closes before it opens', async () => {
    const [a] = channelPair()
    a.readyState = 'connecting'
    const run = new FileSender({ channel: a, file: new Blob([bytes(10)]) }).run().catch((e) => e)
    setTimeout(() => a.onerror?.(), 5)
    const err = await run
    expect((err as TransferError).reason).toBe('closed')
  })
})
