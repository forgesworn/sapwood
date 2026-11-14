import { describe, expect, it } from 'vitest'
import { encodeQR } from '@paulmillr/qr'
import { decodeQR } from '@paulmillr/qr/decode.js'
import { encode } from '@forgesworn/qr'
import { qrSvg } from './qr.js'

// The decoder in @paulmillr/qr stays for the camera scanner; here its encoder
// is the independent reference for the module matrix.
describe('qrSvg', () => {
  const payload = 'bunker://' + 'a'.repeat(64) + '?relay=wss%3A%2F%2Frelay.example&secret=' + 'b'.repeat(32)

  it('draws a transparent SVG with a two-module quiet zone', () => {
    const svg = qrSvg(payload)
    const side = encode(payload, { ecc: 'M' }).size + 4
    expect(svg).toContain(`viewBox="0 0 ${side} ${side}"`)
    expect(svg).not.toContain('<rect')
  })

  it('encodes the same module matrix as the previous encoder at level M', () => {
    const ours = encode(payload, { ecc: 'M' })
    const reference = encodeQR(payload, 'raw', { ecc: 'medium', border: 0 })
    expect(ours.size).toBe(reference.length)
    for (let y = 0; y < ours.size; y++) {
      for (let x = 0; x < ours.size; x++) {
        expect(ours.modules[y * ours.size + x] === 1).toBe(reference[y][x])
      }
    }
  })

  it('reads back through the existing decoder', () => {
    const qr = encode(payload, { ecc: 'M' })
    const scale = 4
    const border = 2
    const side = (qr.size + border * 2) * scale
    const data = new Uint8ClampedArray(side * side * 4).fill(255)
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.modules[y * qr.size + x] !== 1) continue
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const i = (((y + border) * scale + dy) * side + (x + border) * scale + dx) * 4
            data[i] = data[i + 1] = data[i + 2] = 0
          }
        }
      }
    }
    expect(decodeQR({ data, width: side, height: side })).toBe(payload)
  })
})
