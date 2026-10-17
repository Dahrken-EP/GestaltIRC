// The tests run on Node, which has a reference SHA-256. The browser build has no Node types.
// @ts-expect-error no @types/node
import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Sha256, sha256Hex } from './sha256'

const ref = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const enc = (s: string) => new TextEncoder().encode(s)

describe('Sha256', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex(enc(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('matches the one-million-a vector', () => {
    expect(sha256Hex(enc('a'.repeat(1_000_000)))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  })

  it('agrees with a reference implementation at every length around the block boundaries', () => {
    for (let n = 0; n <= 200; n++) {
      const data = randomBytes(n)
      expect(sha256Hex(data), `length ${n}`).toBe(ref(data))
    }
  })

  it('gives the same answer however the input is split', () => {
    const data = randomBytes(10_000)
    const want = ref(data)
    for (const step of [1, 3, 7, 63, 64, 65, 1000, 4097, 10_000]) {
      const h = new Sha256()
      for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, i + step))
      expect(h.digestHex(), `chunks of ${step}`).toBe(want)
    }
  })

  it('handles an empty update and uneven splits across the padding boundary', () => {
    const data = randomBytes(55 + 64)
    const h = new Sha256()
    h.update(new Uint8Array(0)).update(data.subarray(0, 55)).update(new Uint8Array(0)).update(data.subarray(55))
    expect(h.digestHex()).toBe(ref(data))
  })

  it('can be read twice but not updated after finishing', () => {
    const h = new Sha256().update(enc('abc'))
    const a = h.digestHex()
    expect(h.digestHex()).toBe(a)
    expect(() => h.update(enc('more'))).toThrow()
  })

  it('does not change the buffers it is given', () => {
    const data = randomBytes(300)
    const copy = new Uint8Array(data)
    sha256Hex(data)
    expect(Array.from(data)).toEqual(Array.from(copy))
  })
})
