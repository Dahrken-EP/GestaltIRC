import { describe, expect, it } from 'vitest'
import { keyToBytes, pushSupported } from './push'

describe('keyToBytes', () => {
  it('decodes a base64url VAPID key without padding', () => {
    // 65 bytes: an uncompressed P-256 point, starting with 0x04
    const bytes = Uint8Array.from([4, ...Array.from({ length: 64 }, (_, i) => i)])
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(b64url).not.toContain('=')
    expect([...keyToBytes(b64url)]).toEqual([...bytes])
  })

  it('handles the url-safe alphabet', () => {
    expect([...keyToBytes('-_8')]).toEqual([0xfb, 0xff])
  })
})

describe('pushSupported', () => {
  it('is false where there is no service worker, such as this test environment', () => {
    expect(pushSupported()).toBe(false)
  })
})
