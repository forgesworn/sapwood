import { describe, it, expect } from 'vitest'
import { rgb565, rgbaToRgb565BE, buildSetIdentityMeta } from './avatar'
import { FrameType, HEADER_SIZE } from './frame'

describe('rgb565 packing', () => {
  it('packs primaries into the right 16-bit value', () => {
    expect(rgb565(255, 255, 255)).toBe(0xffff)
    expect(rgb565(0, 0, 0)).toBe(0x0000)
    expect(rgb565(255, 0, 0)).toBe(0xf800)
    expect(rgb565(0, 255, 0)).toBe(0x07e0)
    expect(rgb565(0, 0, 255)).toBe(0x001f)
  })
})

describe('rgbaToRgb565BE', () => {
  it('emits two big-endian bytes per pixel and ignores alpha', () => {
    // white then red (alpha varied to prove it is ignored)
    const rgba = new Uint8Array([255, 255, 255, 255, 255, 0, 0, 128])
    expect([...rgbaToRgb565BE(rgba)]).toEqual([0xff, 0xff, 0xf8, 0x00])
  })
})

describe('buildSetIdentityMeta', () => {
  const pubkey = 'da19f1cd34beca44be74da4b306d9d1dd86b6343cef94ce22c49c6f59816e5bd'
  const avatar = { w: 2, h: 2, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }

  it('lays out [pubkey][w][h][name_len][name][avatar] after the frame header', () => {
    const frame = buildSetIdentityMeta(pubkey, 'Al', avatar)
    expect(frame[2]).toBe(FrameType.SET_IDENTITY_META) // magic(2), then type
    const payload = frame.slice(HEADER_SIZE, frame.length - 4) // strip header + crc32
    expect(payload.length).toBe(32 + 2 + 1 + 2 + 8)
    expect([...payload.slice(0, 4)]).toEqual([0xda, 0x19, 0xf1, 0xcd]) // pubkey prefix
    expect(payload[32]).toBe(2) // w
    expect(payload[33]).toBe(2) // h
    expect(payload[34]).toBe(2) // name_len
    expect(String.fromCharCode(payload[35]!, payload[36]!)).toBe('Al')
    expect([...payload.slice(37)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('rejects an avatar whose byte length is not w*h*2', () => {
    expect(() => buildSetIdentityMeta(pubkey, 'x', { w: 2, h: 2, bytes: new Uint8Array(3) })).toThrow(/w\*h\*2/)
  })

  it('rejects a non-32-byte pubkey', () => {
    expect(() => buildSetIdentityMeta('dead', 'x', avatar)).toThrow(/32 bytes/)
  })
})
