// Frame protocol tests -- must produce identical results to heartwood-common/src/frame.rs tests.

import { describe, expect, it } from 'vitest'
import { buildFrame, parseFrame, FrameError, FrameType, OVERHEAD, MAX_PAYLOAD } from './frame.js'
import { crc32 } from './crc32.js'
import {
  buildDeriveIdentity,
  buildGenerateIdentity,
  buildPolicyListRequest,
  buildPolicyRevoke,
  buildPolicyUpdate,
  buildProvisionList,
  buildProvisionRemove,
  buildFactoryReset,
  buildSetNetConfig,
  buildGetNetConfig,
  buildPatchNetConfig,
  buildSetOperator,
  buildWifiScan,
  buildBackupExportRequest,
  buildBackupImportRequest,
  buildVaultSet,
  buildVaultUnlock,
} from './frame.js'

describe('crc32', () => {
  it('produces correct checksum for known input', () => {
    const data = new TextEncoder().encode('hello')
    expect(crc32(data)).toBe(0x3610a686)
  })

  it('handles empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('handles multiple chunks identically to single chunk', () => {
    const full = new Uint8Array([1, 2, 3, 4, 5])
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5])
    expect(crc32(a, b)).toBe(crc32(full))
  })
})

describe('frame roundtrip', () => {
  it('roundtrips a provision frame', () => {
    const payload = new Uint8Array(32).fill(0xab)
    const bytes = buildFrame(FrameType.PROVISION, payload)
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(FrameType.PROVISION)
    expect(frame.payload).toEqual(payload)
  })

  it('roundtrips a NIP-46 request/response', () => {
    const reqPayload = new TextEncoder().encode('{"id":"abc","method":"sign_event","params":["{}"]}')
    const reqBytes = buildFrame(FrameType.NIP46_REQUEST, reqPayload)
    const reqFrame = parseFrame(reqBytes)
    expect(reqFrame.type).toBe(FrameType.NIP46_REQUEST)
    expect(Array.from(reqFrame.payload)).toEqual(Array.from(reqPayload))

    const resPayload = new TextEncoder().encode('{"id":"abc","result":"sig"}')
    const resBytes = buildFrame(FrameType.NIP46_RESPONSE, resPayload)
    const resFrame = parseFrame(resBytes)
    expect(resFrame.type).toBe(FrameType.NIP46_RESPONSE)
    expect(Array.from(resFrame.payload)).toEqual(Array.from(resPayload))
  })

  it('roundtrips an empty ACK frame', () => {
    const bytes = buildFrame(FrameType.ACK)
    expect(bytes.length).toBe(OVERHEAD)
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(FrameType.ACK)
    expect(frame.payload.length).toBe(0)
  })

  it('roundtrips max-size payload', () => {
    const payload = new Uint8Array(MAX_PAYLOAD).fill(0x5a)
    const bytes = buildFrame(FrameType.PROVISION, payload)
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(FrameType.PROVISION)
    expect(frame.payload.length).toBe(MAX_PAYLOAD)
    expect(frame.payload).toEqual(payload)
  })
})

describe('frame validation', () => {
  it('rejects bad magic', () => {
    const bytes = buildFrame(FrameType.ACK)
    bytes[0] = 0xff
    expect(() => parseFrame(bytes)).toThrow(FrameError)
    try { parseFrame(bytes) } catch (e) { expect((e as FrameError).code).toBe('bad_magic') }
  })

  it('rejects bad CRC', () => {
    const bytes = buildFrame(FrameType.PROVISION, new Uint8Array(16).fill(0x01))
    bytes[bytes.length - 1] ^= 0xff
    expect(() => parseFrame(bytes)).toThrow(FrameError)
  })

  it('rejects too-short input', () => {
    try { parseFrame(new Uint8Array([0x48, 0x57, 0x01, 0x00])) } catch (e) { expect((e as FrameError).code).toBe('too_short') }
    try { parseFrame(new Uint8Array(0)) } catch (e) { expect((e as FrameError).code).toBe('too_short') }
  })

  it('rejects oversized payload on build', () => {
    const oversized = new Uint8Array(MAX_PAYLOAD + 1)
    try { buildFrame(FrameType.PROVISION, oversized) } catch (e) { expect((e as FrameError).code).toBe('payload_too_large') }
  })
})

describe('policy management frames', () => {
  it('roundtrips POLICY_LIST_REQUEST', () => {
    const bytes = buildPolicyListRequest(2)
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(FrameType.POLICY_LIST_REQUEST)
    expect(frame.payload).toEqual(new Uint8Array([2]))
  })

  it('roundtrips POLICY_LIST_RESPONSE', () => {
    const json = '[{"client_pubkey":"aa","label":"test","auto_approve":true}]'
    const payload = new TextEncoder().encode(json)
    const bytes = buildFrame(FrameType.POLICY_LIST_RESPONSE, payload)
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(FrameType.POLICY_LIST_RESPONSE)
    expect(new TextDecoder().decode(frame.payload)).toBe(json)
  })

  it('roundtrips POLICY_REVOKE', () => {
    const pubkey = 'a'.repeat(64)
    const bytes = buildPolicyRevoke(0, pubkey)
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(FrameType.POLICY_REVOKE)
    expect(frame.payload.length).toBe(65)
    expect(frame.payload[0]).toBe(0)
    expect(new TextDecoder().decode(frame.payload.slice(1))).toBe(pubkey)
  })

  it('roundtrips POLICY_UPDATE', () => {
    const json = '{"client_pubkey":"bb","auto_approve":false}'
    const bytes = buildPolicyUpdate(1, json)
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(FrameType.POLICY_UPDATE)
    expect(frame.payload[0]).toBe(1)
    expect(new TextDecoder().decode(frame.payload.slice(1))).toBe(json)
  })

  it('roundtrips PROVISION_LIST', () => {
    const bytes = buildProvisionList()
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(FrameType.PROVISION_LIST)
    expect(frame.payload.length).toBe(0)
  })

  it('roundtrips PROVISION_REMOVE with the slot byte', () => {
    const bytes = buildProvisionRemove(3)
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(FrameType.PROVISION_REMOVE)
    expect(Array.from(frame.payload)).toEqual([3])
    expect(() => buildProvisionRemove(-1)).toThrow(RangeError)
    expect(() => buildProvisionRemove(256)).toThrow(RangeError)
  })

  it('roundtrips GENERATE_IDENTITY with label and word count', () => {
    // 12 words is the default.
    let frame = parseFrame(buildGenerateIdentity('vault'))
    expect(frame.type).toBe(FrameType.GENERATE_IDENTITY)
    expect(frame.payload[0]).toBe(5)
    expect(new TextDecoder().decode(frame.payload.slice(1, 6))).toBe('vault')
    expect(frame.payload[6]).toBe(12)

    // 24 words must land in the trailing byte the firmware reads.
    frame = parseFrame(buildGenerateIdentity('deep vault', 24))
    expect(frame.payload[10 + 1]).toBe(24)
    expect(frame.payload.length).toBe(1 + 10 + 1)
  })

  it('roundtrips FACTORY_RESET', () => {
    const bytes = buildFactoryReset()
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(FrameType.FACTORY_RESET)
    expect(frame.payload.length).toBe(0)
  })
})

describe('derive identity frame', () => {
  it('roundtrips DERIVE_IDENTITY as [parent_slot][name utf8]', () => {
    const bytes = buildDeriveIdentity(1, 'pallasite')
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(0x60)
    expect(frame.payload[0]).toBe(1)
    expect(new TextDecoder().decode(frame.payload.slice(1))).toBe('pallasite')
  })

  it('roundtrips DERIVE_IDENTITY_RESPONSE JSON', () => {
    const json = '{"slot":2,"label":"pallasite","npub":"npub1...","parent_slot":1,"purpose":"pallasite","existing":false}'
    const bytes = buildFrame(FrameType.DERIVE_IDENTITY_RESPONSE, new TextEncoder().encode(json))
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(0x61)
    expect(new TextDecoder().decode(frame.payload)).toBe(json)
  })
})

describe('cross-crate compatibility', () => {
  // These tests verify that the TypeScript frame protocol produces bytes
  // identical to the Rust implementation. The frame format is:
  //   [0x48 0x57] [type] [length_be16] [payload] [crc32_be32]

  it('empty ACK produces correct byte sequence', () => {
    const bytes = buildFrame(FrameType.ACK)
    // Magic: 48 57, Type: 06, Length: 00 00, CRC32 of [06, 00, 00]
    expect(bytes[0]).toBe(0x48)
    expect(bytes[1]).toBe(0x57)
    expect(bytes[2]).toBe(0x06)
    expect(bytes[3]).toBe(0x00)
    expect(bytes[4]).toBe(0x00)
    // Verify CRC matches what the Rust side would compute.
    const expectedCrc = crc32(new Uint8Array([0x06]), new Uint8Array([0x00, 0x00]))
    const actualCrc = (bytes[5]! << 24 | bytes[6]! << 16 | bytes[7]! << 8 | bytes[8]!) >>> 0
    expect(actualCrc).toBe(expectedCrc)
  })

  it('32-byte provision payload matches Rust frame structure', () => {
    const payload = new Uint8Array(32).fill(0xaa)
    const bytes = buildFrame(FrameType.PROVISION, payload)
    // 2 magic + 1 type + 2 length + 32 payload + 4 CRC = 41 bytes
    // This matches the Rust test: test_build_provision_frame
    expect(bytes.length).toBe(41)
    expect(bytes[2]).toBe(0x01) // FRAME_TYPE_PROVISION
    expect(bytes[3]).toBe(0x00) // length high byte
    expect(bytes[4]).toBe(0x20) // length low byte (32)
  })
})

describe('network config frame', () => {
  it('SET_NET_CONFIG value matches Rust 0x54', () => {
    expect(FrameType.SET_NET_CONFIG).toBe(0x54)
  })

  it('buildSetNetConfig roundtrips', () => {
    const cfg = { ssid: 'h', password: 'p', relays: ['wss://r'], mode: 'wifi' as const }
    const bytes = buildSetNetConfig(cfg)
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(FrameType.SET_NET_CONFIG)
    expect(JSON.parse(new TextDecoder().decode(frame.payload))).toEqual(cfg)
  })

  it('USB redacted-state, patch, and operator values match Rust 0x5c-0x5f', () => {
    expect(FrameType.GET_NET_CONFIG).toBe(0x5c)
    expect(FrameType.GET_NET_CONFIG_RESPONSE).toBe(0x5d)
    expect(FrameType.PATCH_NET_CONFIG).toBe(0x5e)
    expect(FrameType.SET_OPERATOR).toBe(0x5f)
  })

  it('buildGetNetConfig has an empty payload', () => {
    const frame = parseFrame(buildGetNetConfig())
    expect(frame.type).toBe(FrameType.GET_NET_CONFIG)
    expect(frame.payload).toHaveLength(0)
  })

  it('buildPatchNetConfig binds the observed revision and never adds op_mgmt', () => {
    const frame = parseFrame(buildPatchNetConfig(7, {
      relays: ['wss://new.example'],
      password: { action: 'keep' },
    }))
    expect(frame.type).toBe(FrameType.PATCH_NET_CONFIG)
    const body = JSON.parse(new TextDecoder().decode(frame.payload))
    expect(body).toEqual({
      base_revision: 7,
      patch: { relays: ['wss://new.example'], password: { action: 'keep' } },
    })
    expect(JSON.stringify(body)).not.toContain('op_mgmt')
  })

  it('buildSetOperator uses u32 big-endian revision plus exactly 32 pubkey bytes', () => {
    const frame = parseFrame(buildSetOperator(0x01020304, 'ab'.repeat(32)))
    expect(frame.type).toBe(FrameType.SET_OPERATOR)
    expect(frame.payload).toHaveLength(36)
    expect([...frame.payload.slice(0, 4)]).toEqual([1, 2, 3, 4])
    expect([...frame.payload.slice(4)]).toEqual(new Array(32).fill(0xab))
    expect(() => buildSetOperator(1, 'aa')).toThrow(/64 hexadecimal/)
    expect(() => buildSetOperator(-1, 'ab'.repeat(32))).toThrow(/uint32/)
  })
})

describe('wifi scan frame', () => {
  it('WIFI_SCAN request/response values match Rust 0x55/0x56', () => {
    expect(FrameType.WIFI_SCAN_REQUEST).toBe(0x55)
    expect(FrameType.WIFI_SCAN_RESPONSE).toBe(0x56)
  })

  it('buildWifiScan is an empty-payload 0x55 frame', () => {
    const bytes = buildWifiScan()
    const frame = parseFrame(bytes)
    expect(frame.type).toBe(FrameType.WIFI_SCAN_REQUEST)
    expect(frame.payload.length).toBe(0)
  })
})

describe('backup frames', () => {
  it('BACKUP frame type values match Rust 0x50-0x53', () => {
    expect(FrameType.BACKUP_EXPORT_REQUEST).toBe(0x50)
    expect(FrameType.BACKUP_EXPORT_RESPONSE).toBe(0x51)
    expect(FrameType.BACKUP_IMPORT_REQUEST).toBe(0x52)
    expect(FrameType.BACKUP_IMPORT_RESPONSE).toBe(0x53)
  })

  it('buildBackupExportRequest is an empty-payload 0x50 frame', () => {
    const frame = parseFrame(buildBackupExportRequest())
    expect(frame.type).toBe(FrameType.BACKUP_EXPORT_REQUEST)
    expect(frame.payload.length).toBe(0)
  })

  it('buildBackupImportRequest carries the payload JSON as a 0x52 frame', () => {
    const json = '{"created_at":0,"masters":[]}'
    const frame = parseFrame(buildBackupImportRequest(json))
    expect(frame.type).toBe(FrameType.BACKUP_IMPORT_REQUEST)
    expect(new TextDecoder().decode(frame.payload)).toBe(json)
  })
})

describe('vault frames', () => {
  it('VAULT frame type values match firmware 0x62/0x63', () => {
    expect(FrameType.VAULT_SET).toBe(0x62)
    expect(FrameType.VAULT_UNLOCK).toBe(0x63)
  })

  it('buildVaultSet carries the 32-byte key, or an empty payload to disable', () => {
    const key = new Uint8Array(32).fill(0x11)
    const set = parseFrame(buildVaultSet(key))
    expect(set.type).toBe(FrameType.VAULT_SET)
    expect(set.payload).toEqual(key)

    const clear = parseFrame(buildVaultSet(null))
    expect(clear.type).toBe(FrameType.VAULT_SET)
    expect(clear.payload.length).toBe(0)
  })

  it('buildVaultUnlock carries the 32-byte key', () => {
    const key = new Uint8Array(32).fill(0x22)
    const frame = parseFrame(buildVaultUnlock(key))
    expect(frame.type).toBe(FrameType.VAULT_UNLOCK)
    expect(frame.payload).toEqual(key)
  })

  it('rejects keys that are not 32 bytes', () => {
    expect(() => buildVaultSet(new Uint8Array(31))).toThrow(/32 bytes/)
    expect(() => buildVaultUnlock(new Uint8Array(0))).toThrow(/32 bytes/)
  })
})
