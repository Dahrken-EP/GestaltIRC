// SHA-256 that can be fed a piece at a time. The Web Crypto API only hashes a whole
// buffer, which would mean holding an entire file in memory just to check it. This
// keeps a running state instead, so a transfer is hashed as it streams.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  private block = new Uint8Array(64)
  private used = 0
  private length = 0 // bytes hashed so far
  private done = false
  private w = new Uint32Array(64)

  update(data: Uint8Array): this {
    if (this.done) throw new Error('Sha256: already finished')
    this.length += data.length
    let i = 0
    // Top up a partly filled block first.
    if (this.used > 0) {
      const take = Math.min(64 - this.used, data.length)
      this.block.set(data.subarray(0, take), this.used)
      this.used += take
      i = take
      if (this.used === 64) {
        this.compress(this.block, 0)
        this.used = 0
      }
    }
    for (; i + 64 <= data.length; i += 64) this.compress(data, i)
    if (i < data.length) {
      this.block.set(data.subarray(i), 0)
      this.used = data.length - i
    }
    return this
  }

  /** The digest as lowercase hex. The hash cannot be updated afterwards. */
  digestHex(): string {
    if (!this.done) {
      const bits = this.length * 8
      // Padding: a 1 bit, zeros, then the length in bits as 64 bits, to fill whole blocks.
      this.block[this.used++] = 0x80
      if (this.used > 56) {
        this.block.fill(0, this.used)
        this.compress(this.block, 0)
        this.used = 0
      }
      this.block.fill(0, this.used, 56)
      const view = new DataView(this.block.buffer)
      view.setUint32(56, Math.floor(bits / 0x100000000))
      view.setUint32(60, bits >>> 0)
      this.compress(this.block, 0)
      this.done = true
    }
    let out = ''
    for (const word of this.h) out += word.toString(16).padStart(8, '0')
    return out
  }

  private compress(data: Uint8Array, at: number): void {
    const w = this.w
    for (let t = 0; t < 16; t++) {
      const j = at + t * 4
      w[t] = (data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!
    }
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15]!
      const b = w[t - 2]!
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0
    }
    let [a, b, c, d, e, f, g, h] = this.h as unknown as number[] as [number, number, number, number, number, number, number, number]
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[t]! + w[t]!) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    this.h[0] = (this.h[0]! + a) | 0
    this.h[1] = (this.h[1]! + b) | 0
    this.h[2] = (this.h[2]! + c) | 0
    this.h[3] = (this.h[3]! + d) | 0
    this.h[4] = (this.h[4]! + e) | 0
    this.h[5] = (this.h[5]! + f) | 0
    this.h[6] = (this.h[6]! + g) | 0
    this.h[7] = (this.h[7]! + h) | 0
  }
}

/** SHA-256 of a whole buffer, as hex. */
export function sha256Hex(data: Uint8Array): string {
  return new Sha256().update(data).digestHex()
}
