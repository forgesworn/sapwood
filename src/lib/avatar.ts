// Turn a profile picture URL into a small Rgb565 bitmap the signer can blit
// directly, so the device never fetches or JPEG-decodes an image itself (that
// won't fit an ESP32's RAM). Circular-cropped on black: the device blits the
// square onto its black background and it reads as a disc.

import { buildFrame, FrameType } from './frame.js'

/** Pack 8-bit RGB into a 16-bit Rgb565 value. */
export function rgb565(r: number, g: number, b: number): number {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)
}

/**
 * Convert RGBA8 pixels (canvas order) to Rgb565 big-endian bytes, 2 per pixel.
 * Big-endian to match the firmware, which reads each pixel as `u16::from_be_bytes`.
 */
export function rgbaToRgb565BE(rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const n = Math.floor(rgba.length / 4)
  const out = new Uint8Array(n * 2)
  for (let i = 0; i < n; i++) {
    const v = rgb565(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!)
    out[i * 2] = (v >> 8) & 0xff
    out[i * 2 + 1] = v & 0xff
  }
  return out
}

/** `rgb565` is two bytes per pixel, big-endian; `rgb332` is one byte per pixel (`RRRGGGBB`). */
export type AvatarFormat = 'rgb565' | 'rgb332'

export interface Avatar {
  w: number
  h: number
  format: AvatarFormat
  /** w*h*2 bytes of Rgb565 big-endian, or w*h bytes of RGB332, row-major. */
  bytes: Uint8Array
}

/**
 * Expand one RGB332 byte to Rgb565 by bit replication, exactly as the signer
 * does: the full range maps to the full range (0xFF -> 0xFFFF) and 0 stays 0.
 */
export function rgb332ToRgb565(b: number): number {
  const r3 = (b >> 5) & 7
  const g3 = (b >> 2) & 7
  const b2 = b & 3
  const r5 = (r3 << 2) | (r3 >> 1)
  const g6 = (g3 << 3) | g3
  const b5 = (b2 << 3) | (b2 << 1) | (b2 >> 1)
  return (r5 << 11) | (g6 << 5) | b5
}

/** The 8-bit colour the panel shows for an RGB332 byte (Rgb565 widened by bit replication). */
function rgb332Shown(b: number): [number, number, number] {
  const v = rgb332ToRgb565(b)
  const r5 = v >> 11
  const g6 = (v >> 5) & 0x3f
  const b5 = v & 0x1f
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)]
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

/**
 * Convert RGBA8 pixels (canvas order, `w`x`h`) to RGB332 with Floyd-Steinberg
 * dithering. Error is measured against the colours the signer will show, not
 * the nominal 3/3/2-bit levels. Pixels that are exactly black in the source
 * (the circular crop's surround) stay 0x00 and neither take nor pass on error,
 * so the disc keeps a clean edge on the black panel.
 */
export function rgbaToRgb332Dithered(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const err = new Float32Array(w * h * 3)
  const black = (i: number) => rgba[i * 4] === 0 && rgba[i * 4 + 1] === 0 && rgba[i * 4 + 2] === 0
  const spread = (x: number, y: number, k: number, e: [number, number, number]) => {
    if (x < 0 || x >= w || y >= h || black(y * w + x)) return
    const o = (y * w + x) * 3
    err[o] += e[0] * k
    err[o + 1] += e[1] * k
    err[o + 2] += e[2] * k
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (black(i)) continue // out[i] stays 0x00
      const r = clamp255(rgba[i * 4]! + err[i * 3]!)
      const g = clamp255(rgba[i * 4 + 1]! + err[i * 3 + 1]!)
      const b = clamp255(rgba[i * 4 + 2]! + err[i * 3 + 2]!)
      const q = (Math.round((r / 255) * 7) << 5) | (Math.round((g / 255) * 7) << 2) | Math.round((b / 255) * 3)
      out[i] = q
      const [sr, sg, sb] = rgb332Shown(q)
      const e: [number, number, number] = [r - sr, g - sg, b - sb]
      spread(x + 1, y, 7 / 16, e)
      spread(x - 1, y + 1, 3 / 16, e)
      spread(x, y + 1, 5 / 16, e)
      spread(x + 1, y + 1, 1 / 16, e)
    }
  }
  return out
}

/** Pack canvas pixels in the wanted format. */
function packAvatar(rgba: Uint8ClampedArray, size: number, format: AvatarFormat): Avatar {
  const bytes = format === 'rgb332' ? rgbaToRgb332Dithered(rgba, size, size) : rgbaToRgb565BE(rgba)
  return { w: size, h: size, format, bytes }
}

/**
 * Fetch `url`, cover-fit it into a `size`x`size` canvas, circular-crop on black,
 * and return Rgb565 bytes ready for the signer. Browser-only (fetch + canvas).
 *
 * Fetched as bytes and decoded via createImageBitmap rather than an <img>
 * element: the app's CSP locks img-src to 'self' (so no picture host would
 * ever load — every push silently fell back to the placeholder disc), while
 * connect-src is necessarily open for relays and bridges. CORS still applies
 * to the fetch; hosts that refuse fall back to the placeholder upstream.
 */
export async function loadAvatar(url: string, size = 64, format: AvatarFormat = 'rgb565'): Promise<Avatar> {
  const resp = await fetch(url, { mode: 'cors', credentials: 'omit' })
  if (!resp.ok) throw new Error(`avatar image fetch failed: ${resp.status} ${url}`)
  const bitmap = await createImageBitmap(await resp.blob())
  try {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d canvas context')

    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
    ctx.clip()
    // Cover-fit: scale so the image fills the square, centre-cropped.
    const scale = Math.max(size / bitmap.width, size / bitmap.height)
    const dw = bitmap.width * scale
    const dh = bitmap.height * scale
    ctx.drawImage(bitmap, (size - dw) / 2, (size - dh) / 2, dw, dh)
    ctx.restore()

    const { data } = ctx.getImageData(0, 0, size, size)
    return packAvatar(data, size, format)
  } finally {
    bitmap.close()
  }
}

/** The firmware's Nostr-purple disc colour (palette.rs NOSTR, Rgb565 17/23/30).
 *  #8c5df7 packs to exactly those channel values, so the browser-drawn disc and
 *  the firmware-drawn one are indistinguishable on the panel. */
const PLACEHOLDER_DISC = '#8c5df7'

/**
 * Draw the fallback identity disc — the profile's initial on a Nostr-purple
 * circle — for identities whose picture is missing or won't load (e.g. a
 * CORS-refusing image host). Pushing this instead of nothing means the signer
 * still gets a complete identity card with the name.
 */
export function placeholderAvatar(name: string, size = 64, format: AvatarFormat = 'rgb565'): Avatar {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d canvas context')

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = PLACEHOLDER_DISC
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.fill()

  const initial = (name.trim().charAt(0) || '?').toUpperCase()
  ctx.fillStyle = '#fff'
  ctx.font = `bold ${Math.round(size * 0.5)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(initial, size / 2, size / 2)

  const { data } = ctx.getImageData(0, 0, size, size)
  return packAvatar(data, size, format)
}

/**
 * Build a SET_IDENTITY_META frame (0x5b) the signer stores and blits.
 * Payload: [pubkey 32][w 1][h 1][name_len 1][name UTF-8][avatar]. The avatar's
 * byte length selects the format: w*h*2 is Rgb565 BE, w*h is RGB332.
 */
export function buildSetIdentityMeta(pubkeyHex: string, name: string, avatar: Avatar): Uint8Array {
  const pubkey = hexToBytes(pubkeyHex)
  if (pubkey.length !== 32) throw new Error('identity pubkey must be 32 bytes (64 hex chars)')
  const nameBytes = new TextEncoder().encode(name)
  if (nameBytes.length > 255) throw new Error('identity name too long for a one-byte length')
  if (avatar.w > 255 || avatar.h > 255) throw new Error('avatar dimensions must fit one byte each')
  const expected = avatar.w * avatar.h * (avatar.format === 'rgb332' ? 1 : 2)
  if (avatar.bytes.length !== expected) {
    throw new Error(`avatar byte length does not match ${avatar.format === 'rgb332' ? 'w*h' : 'w*h*2'} for ${avatar.format}`)
  }

  const payload = new Uint8Array(32 + 2 + 1 + nameBytes.length + avatar.bytes.length)
  let o = 0
  payload.set(pubkey, o)
  o += 32
  payload[o++] = avatar.w
  payload[o++] = avatar.h
  payload[o++] = nameBytes.length
  payload.set(nameBytes, o)
  o += nameBytes.length
  payload.set(avatar.bytes, o)
  return buildFrame(FrameType.SET_IDENTITY_META, payload)
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new Error('hex string must have an even length')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
