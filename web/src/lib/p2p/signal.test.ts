import { describe, expect, it } from 'vitest'
import { encodeSignal, fromBase64Url, MAX_CHUNK, newSessionId, SignalAssembler, toBase64Url } from './signal'

const sid = 'abc123xyz9'
const sdp = 'v=0\r\n' + 'a=candidate:1 1 udp 2130706431 192.168.1.5 50000 typ host\r\n'.repeat(120)

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding or unsafe characters', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n))
      const s = toBase64Url(bytes)
      expect(s).toMatch(/^[A-Za-z0-9_-]*$/)
      expect(Array.from(fromBase64Url(s))).toEqual(Array.from(bytes))
    }
  })

  it('handles large inputs', () => {
    const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 31) % 251)
    const back = fromBase64Url(toBase64Url(bytes))
    expect(back.length).toBe(bytes.length)
    expect(back.every((b, i) => b === bytes[i])).toBe(true)
  })
})

describe('encodeSignal', () => {
  it('splits a large message into tag values that all fit', () => {
    const values = encodeSignal(sid, { k: 'chat', t: 'offer', sdp })
    expect(values.length).toBeGreaterThan(2)
    for (const v of values) {
      expect(v).toMatch(/^[a-z0-9]{6,16}\.\d+\.\d+\.[A-Za-z0-9_-]+$/)
      expect(v.length).toBeLessThan(MAX_CHUNK + 40)
      // Nothing that an IRC tag value would have to escape.
      expect(v).not.toMatch(/[;\s\\]/)
    }
  })

  it('sends a small message as one tag', () => {
    expect(encodeSignal(sid, { k: 'chat', t: 'bye' })).toHaveLength(1)
  })

  it('refuses a bad id or a message that is too large', () => {
    expect(() => encodeSignal('Bad Id!', { k: 'chat', t: 'bye' })).toThrow()
    expect(() => encodeSignal(sid, { k: 'chat', t: 'offer', sdp: 'x'.repeat(30_000) })).toThrow(/large/)
  })

  it('makes unique session ids', () => {
    const ids = new Set(Array.from({ length: 200 }, newSessionId))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{10}$/)
  })
})

describe('SignalAssembler', () => {
  const msg = { k: 'chat', t: 'offer', sdp }

  it('puts the chunks back together, in order', () => {
    const a = new SignalAssembler()
    const values = encodeSignal(sid, msg)
    let got = null
    for (const v of values) got = a.add('bob', v)
    expect(got).toEqual({ sid, payload: msg })
    expect(a.pending).toBe(0)
  })

  it('copes with chunks out of order and repeated', () => {
    const a = new SignalAssembler()
    const values = encodeSignal(sid, msg)
    const shuffled = [...values].reverse()
    shuffled.splice(1, 0, shuffled[0]!) // a repeat
    let got = null
    for (const v of shuffled) got = a.add('bob', v) ?? got
    expect(got?.payload).toEqual(msg)
  })

  it('does not finish while a chunk is missing', () => {
    const a = new SignalAssembler()
    const values = encodeSignal(sid, msg)
    for (const v of values.slice(0, -1)) expect(a.add('bob', v)).toBeNull()
    expect(a.pending).toBe(1)
  })

  it('keeps senders apart, even with the same session id, and ignores case in the nick', () => {
    const a = new SignalAssembler()
    const one = encodeSignal(sid, { k: 'chat', t: 'offer', sdp: 'A'.repeat(4000) })
    const two = encodeSignal(sid, { k: 'chat', t: 'offer', sdp: 'B'.repeat(4000) })
    const results: unknown[] = []
    for (let i = 0; i < one.length; i++) {
      results.push(a.add('Bob', one[i]!), a.add('carol', two[i]!))
    }
    const done = results.filter(Boolean) as { payload: { sdp: string } }[]
    expect(done).toHaveLength(2)
    expect(done.map((d) => d.payload.sdp[0]).sort()).toEqual(['A', 'B'])
    // "BOB" and "bob" are the same sender.
    const b = new SignalAssembler()
    const values = encodeSignal(sid, msg)
    b.add('BOB', values[0]!)
    let got = null
    for (const v of values.slice(1)) got = b.add('bob', v)
    expect(got).not.toBeNull()
  })

  it('forgets an unfinished message after a while', () => {
    const a = new SignalAssembler()
    const values = encodeSignal(sid, msg)
    a.add('bob', values[0]!, 1000)
    a.add('bob', values[1]!, 1000 + 31_000) // too late: the first part is gone
    expect(a.pending).toBe(1)
    let got = null
    for (const v of values.slice(2)) got = a.add('bob', v, 1000 + 31_000)
    expect(got).toBeNull() // the first part is lost, so it cannot complete
  })

  it('ignores anything that is not a well-formed chunk', () => {
    const a = new SignalAssembler()
    for (const bad of [
      '',
      'hello',
      'abc.0.1.',
      'ABCDEF.0.1.AAAA', // upper-case id
      'abc123xyz9.0.0.AAAA', // zero chunks
      'abc123xyz9.5.2.AAAA', // index beyond the count
      'abc123xyz9.0.99.AAAA', // too many chunks
      'abc123xyz9.0.1.AA AA',
      'abc123xyz9.0.1.' + 'A'.repeat(MAX_CHUNK + 1),
      'a.0.1.AAAA', // id too short
      'abc123xyz9.x.1.AAAA',
    ]) {
      expect(a.add('bob', bad), bad).toBeNull()
    }
    expect(a.pending).toBe(0)
  })

  it('rejects a complete message that is not valid JSON, UTF-8 or the right shape', () => {
    const a = new SignalAssembler()
    const wrap = (bytes: Uint8Array) => `${sid}.0.1.${toBase64Url(bytes)}`
    const enc = (s: string) => new TextEncoder().encode(s)
    expect(a.add('bob', wrap(enc('not json')))).toBeNull()
    expect(a.add('bob', wrap(new Uint8Array([0xff, 0xfe, 0xfd])))).toBeNull()
    expect(a.add('bob', wrap(enc('[1,2]')))).toBeNull()
    expect(a.add('bob', wrap(enc('"text"')))).toBeNull()
    expect(a.add('bob', wrap(enc('{"t":"offer"}')))).toBeNull() // no kind
    expect(a.add('bob', wrap(enc('{"k":"chat"}')))).toBeNull() // no type
    expect(a.add('bob', wrap(enc('{"k":"chat","t":"bye"}')))?.payload.t).toBe('bye')
  })

  it('holds only a few unfinished messages per sender, and in all', () => {
    const a = new SignalAssembler()
    for (let i = 0; i < 10; i++) a.add('spammer', `s${String(i).padStart(5, '0')}x.0.2.AAAA`)
    expect(a.pending).toBeLessThanOrEqual(4)
    const b = new SignalAssembler()
    for (let i = 0; i < 200; i++) b.add(`user${i}`, `s${String(i).padStart(5, '0')}x.0.2.AAAA`)
    expect(b.pending).toBeLessThanOrEqual(32)
  })

  it('does not let one sender push out another sender\'s messages', () => {
    const a = new SignalAssembler()
    const values = encodeSignal(sid, msg)
    a.add('friend', values[0]!)
    for (let i = 0; i < 10; i++) a.add('spammer', `s${String(i).padStart(5, '0')}x.0.2.AAAA`)
    let got = null
    for (const v of values.slice(1)) got = a.add('friend', v)
    expect(got).not.toBeNull()
  })

  it('stops a message that grows past the limit', () => {
    const a = new SignalAssembler()
    // 16 chunks of the largest size is more than the 24 KB message limit allows.
    let completed = false
    for (let i = 0; i < 16; i++) completed = !!a.add('bob', `${sid}.${i}.16.${'A'.repeat(MAX_CHUNK)}`) || completed
    expect(completed).toBe(false)
    expect(a.pending).toBe(0)
  })

  it('a different shape for the same id starts over instead of mixing', () => {
    const a = new SignalAssembler()
    const values = encodeSignal(sid, msg)
    a.add('bob', values[0]!)
    a.add('bob', `${sid}.0.9.AAAA`) // same id, different count
    expect(a.pending).toBe(1)
  })
})
