import { describe, it, expect } from 'vitest'
import { buildConfigBlob, crc32, CONFIG_HEADER_LEN } from './flash-config'
import type { NetConfig } from './frame'

describe('crc32', () => {
  it('matches the standard CRC-32 check value (so it agrees with firmware crc32fast)', () => {
    // The canonical CRC-32/ISO-HDLC check: crc32("123456789") == 0xCBF43926.
    const check = new TextEncoder().encode('123456789')
    expect(crc32(check) >>> 0).toBe(0xcbf43926)
  })
})

describe('buildConfigBlob', () => {
  const cfg: NetConfig = {
    ssid: 'VM0030073',
    password: 'hunter2',
    relays: ['wss://relay.trotters.cc'],
    mode: 'wifi',
  }

  it('lays out HWCF | version | len(LE) | crc(LE) | json — matching boot_config.rs', () => {
    const blob = buildConfigBlob(cfg)
    const json = new TextEncoder().encode(JSON.stringify(cfg))

    // magic "HWCF"
    expect([...blob.slice(0, 4)]).toEqual([0x48, 0x57, 0x43, 0x46])
    // version
    expect(blob[4]).toBe(1)

    const dv = new DataView(blob.buffer)
    // json length, little-endian
    expect(dv.getUint16(5, true)).toBe(json.length)
    // crc32 over the json, little-endian
    expect(dv.getUint32(7, true)).toBe(crc32(json))
    // json payload follows the header verbatim
    expect(new TextDecoder().decode(blob.slice(CONFIG_HEADER_LEN))).toBe(JSON.stringify(cfg))
    // total size
    expect(blob.length).toBe(CONFIG_HEADER_LEN + json.length)
  })

  it('round-trips back to the same NetConfig the firmware would parse', () => {
    const blob = buildConfigBlob(cfg)
    const dv = new DataView(blob.buffer)
    const len = dv.getUint16(5, true)
    const json = new TextDecoder().decode(blob.slice(CONFIG_HEADER_LEN, CONFIG_HEADER_LEN + len))
    expect(JSON.parse(json)).toEqual(cfg)
  })
})
