import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadAvatarRungs, rgb565, rgbaToRgb565BE, rgb332ToRgb565, rgbaToRgb332Dithered, buildSetIdentityMeta } from './avatar'
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
  const avatar = { w: 2, h: 2, format: 'rgb565' as const, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }

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
    expect(() => buildSetIdentityMeta(pubkey, 'x', { w: 2, h: 2, format: 'rgb565', bytes: new Uint8Array(3) })).toThrow(/w\*h\*2/)
    expect(() => buildSetIdentityMeta(pubkey, 'x', { w: 2, h: 2, format: 'rgb332', bytes: new Uint8Array(8) })).toThrow(/w\*h for rgb332/)
  })

  it('builds the shared RGB332 payload vector (40 bytes)', () => {
    const rgb332 = { w: 2, h: 2, format: 'rgb332' as const, bytes: new Uint8Array([0x00, 0xff, 0xe0, 0x03]) }
    const frame = buildSetIdentityMeta('11'.repeat(32), 'A', rgb332)
    const payload = frame.slice(HEADER_SIZE, frame.length - 4)
    expect(payload.length).toBe(40)
    expect([...payload.slice(32)]).toEqual([2, 2, 1, 0x41, 0x00, 0xff, 0xe0, 0x03])
  })

  it('rejects a non-32-byte pubkey', () => {
    expect(() => buildSetIdentityMeta('dead', 'x', avatar)).toThrow(/32 bytes/)
  })
})

describe('RGB332 expansion', () => {
  // Shared with the firmware's common crate: both repos pin this table.
  it.each([
    [0x00, 0x0000],
    [0xff, 0xffff],
    [0xe0, 0xf800],
    [0x1c, 0x07e0],
    [0x03, 0x001f],
    [0x92, 0x9495],
    [0x49, 0x4a4a],
    [0x25, 0x212a],
  ])('expands 0x%s to the shared Rgb565 value', (byte, want) => {
    expect(rgb332ToRgb565(byte)).toBe(want)
  })
})

describe('rgbaToRgb332Dithered', () => {
  const px = (r: number, g: number, b: number) => [r, g, b, 255]

  it('emits one byte per pixel', () => {
    const rgba = new Uint8Array(4 * 3 * 5).fill(200)
    expect(rgbaToRgb332Dithered(rgba, 4, 3).length).toBe(12)
  })

  it('maps exact primaries to their bytes', () => {
    const rgba = new Uint8Array([...px(255, 255, 255), ...px(255, 0, 0), ...px(0, 255, 0), ...px(0, 0, 255)])
    expect([...rgbaToRgb332Dithered(rgba, 4, 1)]).toEqual([0xff, 0xe0, 0x1c, 0x03])
  })

  it('keeps source-black pixels at 0x00 and passes no error into them', () => {
    // 2x2: mid-grey top-left, black elsewhere. Error from the grey must not land on black.
    const rgba = new Uint8Array([...px(100, 100, 100), ...px(0, 0, 0), ...px(0, 0, 0), ...px(0, 0, 0)])
    const out = rgbaToRgb332Dithered(rgba, 2, 2)
    expect([...out.slice(1)]).toEqual([0, 0, 0])
    expect(out[0]).not.toBe(0)
  })

  it('takes no error from black into the pixels after it', () => {
    // A flat row with a black gap: the pixel after the gap is quantised as if it had no history.
    const alone = rgbaToRgb332Dithered(new Uint8Array([...px(0, 0, 0), ...px(100, 100, 100)]), 2, 1)
    const direct = rgbaToRgb332Dithered(new Uint8Array(px(100, 100, 100)), 1, 1)
    expect(alone[1]).toBe(direct[0])
  })

  it('dithers a flat mid-tone into a mix of levels averaging near the source', () => {
    const n = 64
    const rgba = new Uint8Array(n * n * 4)
    for (let i = 0; i < n * n; i++) rgba.set(px(100, 100, 100), i * 4)
    const out = rgbaToRgb332Dithered(rgba, n, n)
    expect(new Set(out).size).toBeGreaterThan(1)
    let sum = 0
    for (const b of out) sum += ((rgb332ToRgb565(b) >> 5) & 0x3f) * 255 / 63
    expect(Math.abs(sum / out.length - 100)).toBeLessThan(4)
  })
})

describe('loadAvatarRungs', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('fetches and decodes once, draws once per side and closes the bitmap', async () => {
    const close = vi.fn()
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob() }))
    const bitmapMock = vi.fn(async () => ({ width: 10, height: 10, close }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('createImageBitmap', bitmapMock)
    const sides: number[] = []
    vi.spyOn(document, 'createElement').mockImplementation(() => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          fillRect() {}, save() {}, beginPath() {}, arc() {}, clip() {}, drawImage() {}, restore() {},
          getImageData: () => { sides.push(canvas.width); return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255) } },
        }),
      }
      return canvas as unknown as HTMLCanvasElement
    })
    const out = await loadAvatarRungs('https://x/a.jpg', [
      { side: 64, format: 'rgb565' }, { side: 64, format: 'rgb332' },
      { side: 48, format: 'rgb565' }, { side: 48, format: 'rgb332' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bitmapMock).toHaveBeenCalledTimes(1)
    expect(sides).toEqual([64, 48])
    expect(close).toHaveBeenCalledTimes(1)
    expect(out.map((a) => [a.w, a.format, a.bytes.length])).toEqual([
      [64, 'rgb565', 8192], [64, 'rgb332', 4096], [48, 'rgb565', 4608], [48, 'rgb332', 2304],
    ])
  })
})
