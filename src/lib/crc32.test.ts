import { describe, expect, it } from 'vitest'
import { crc32 } from './crc32'

// Known vectors for CRC-32/ISO-HDLC (IEEE 802.3) — the same algorithm as
// crc32fast on the firmware side, so these pins protect the wire format.
describe('crc32', () => {
  it('matches the canonical check value for "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('handles the empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('is chunking-invariant — one buffer or many gives the same digest', () => {
    const whole = new TextEncoder().encode('heartwood frame payload')
    const a = whole.subarray(0, 7)
    const b = whole.subarray(7, 15)
    const c = whole.subarray(15)
    expect(crc32(a, b, c)).toBe(crc32(whole))
  })

  it('matches the firmware digest for the FIRMWARE_INFO ping body', () => {
    // type 0x59, zero-length payload — verified against zlib.crc32/crc32fast.
    expect(crc32(new Uint8Array([0x59, 0x00, 0x00]))).toBe(0x9c2ccc2d)
  })
})
