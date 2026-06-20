// Flash-time config blob for the web flasher (Raspberry Pi Imager model).
//
// Builds the binary blob the flasher writes to the device's `config` partition.
// The firmware reads it at boot (heartwood-esp32 src/boot_config.rs) and seeds
// NVS from it, so the byte layout MUST match that reader exactly:
//
//   "HWCF" (4) | version u8 (1) | json_len u16 LE (2) | crc32 u32 LE (4) | json
//
// The CRC is the standard CRC-32 (IEEE/zlib, poly 0xEDB88320) so it matches the
// firmware's `crc32fast`. See docs/2026-06-19-web-flasher-flash-and-configure.md.

import type { NetConfig } from './frame'

const MAGIC = [0x48, 0x57, 0x43, 0x46] // "HWCF"
const VERSION = 1
export const CONFIG_HEADER_LEN = 11 // 4 magic + 1 version + 2 len + 4 crc

/** Standard CRC-32 (IEEE 802.3 / zlib), matching the firmware's crc32fast. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Build the `config`-partition blob for the given network config. The flasher
 * writes the returned bytes at the partition offset; the rest of the partition
 * stays erased (0xFF), which the firmware ignores.
 */
export function buildConfigBlob(cfg: NetConfig): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(cfg))
  const crc = crc32(json)

  const blob = new Uint8Array(CONFIG_HEADER_LEN + json.length)
  blob.set(MAGIC, 0)
  blob[4] = VERSION
  const dv = new DataView(blob.buffer)
  dv.setUint16(5, json.length, true) // LE
  dv.setUint32(7, crc, true) // LE
  blob.set(json, CONFIG_HEADER_LEN)
  return blob
}
