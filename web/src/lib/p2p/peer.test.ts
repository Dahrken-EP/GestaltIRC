import { describe, expect, it } from 'vitest'
import { fingerprintOf, safetyCode } from './peer'

const FP_A = Array.from({ length: 32 }, (_, i) => (i * 3).toString(16).padStart(2, '0')).join(':').toUpperCase()
const FP_B = Array.from({ length: 32 }, (_, i) => (i * 5 + 1).toString(16).padStart(2, '0')).join(':').toUpperCase()

describe('fingerprintOf', () => {
  it('finds the sha-256 fingerprint in a description', () => {
    const sdp = `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${FP_A.toLowerCase()}\r\na=setup:actpass\r\n`
    expect(fingerprintOf(sdp)).toBe(FP_A)
  })
  it('returns empty when there is none, or it is malformed or another algorithm', () => {
    expect(fingerprintOf('v=0\r\n')).toBe('')
    expect(fingerprintOf('a=fingerprint:sha-256 AB:CD\r\n')).toBe('')
    expect(fingerprintOf(`a=fingerprint:sha-1 ${FP_A}\r\n`)).toBe('')
  })
})

describe('safetyCode', () => {
  it('is the same from either end', () => {
    expect(safetyCode(FP_A, FP_B)).toBe(safetyCode(FP_B, FP_A))
  })
  it('has five groups of four', () => {
    expect(safetyCode(FP_A, FP_B)).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){4}$/)
  })
  it('changes when either fingerprint changes', () => {
    const other = FP_B.replace(/^../, 'FF')
    expect(safetyCode(FP_A, other)).not.toBe(safetyCode(FP_A, FP_B))
    expect(safetyCode(other, FP_B)).not.toBe(safetyCode(FP_A, FP_B))
  })
  it('is empty until both are known', () => {
    expect(safetyCode(FP_A, '')).toBe('')
    expect(safetyCode('', '')).toBe('')
  })
})
