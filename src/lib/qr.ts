import { encode, toSvg } from '@forgesworn/qr'

/**
 * Pairing and invite QR codes as inline SVG. Error correction M and a
 * two-module quiet zone, with no background so the white card around the
 * code shows through.
 */
export function qrSvg(text: string): string {
  return toSvg(encode(text, { ecc: 'M' }), { margin: 2, dark: '#000', light: null })
}
