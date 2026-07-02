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

export interface Avatar {
  w: number
  h: number
  /** w*h*2 bytes, Rgb565 big-endian. */
  bytes: Uint8Array
}

/**
 * Fetch `url`, cover-fit it into a `size`x`size` canvas, circular-crop on black,
 * and return Rgb565 bytes ready for the signer. Browser-only (Image + canvas).
 * Needs the image server to allow CORS (getImageData taints otherwise); callers
 * can route through a CORS-friendly resize proxy if a host refuses.
 */
export async function loadAvatar(url: string, size = 64): Promise<Avatar> {
  const img = await loadImage(url)
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
  const scale = Math.max(size / img.width, size / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh)
  ctx.restore()

  const { data } = ctx.getImageData(0, 0, size, size)
  return { w: size, h: size, bytes: rgbaToRgb565BE(data) }
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
export function placeholderAvatar(name: string, size = 64): Avatar {
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
  return { w: size, h: size, bytes: rgbaToRgb565BE(data) }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous' // required for getImageData on a cross-origin image
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`avatar image load failed: ${url}`))
    img.src = url
  })
}

/**
 * Build a SET_IDENTITY_META frame (0x5b) the signer stores and blits.
 * Payload: [pubkey 32][w 1][h 1][name_len 1][name UTF-8][avatar w*h*2 Rgb565 BE].
 */
export function buildSetIdentityMeta(pubkeyHex: string, name: string, avatar: Avatar): Uint8Array {
  const pubkey = hexToBytes(pubkeyHex)
  if (pubkey.length !== 32) throw new Error('identity pubkey must be 32 bytes (64 hex chars)')
  const nameBytes = new TextEncoder().encode(name)
  if (nameBytes.length > 255) throw new Error('identity name too long for a one-byte length')
  if (avatar.w > 255 || avatar.h > 255) throw new Error('avatar dimensions must fit one byte each')
  if (avatar.bytes.length !== avatar.w * avatar.h * 2) throw new Error('avatar byte length does not match w*h*2')

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
