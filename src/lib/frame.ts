// Serial frame protocol -- TypeScript port of heartwood-common/src/frame.rs.
//
// Frame format:
//   [0x48 0x57] [type_u8] [length_u16_be] [payload...] [crc32_4_be]
//
// CRC32 covers: type byte + length bytes + payload (NOT the magic bytes).

import { crc32 } from './crc32.js'

export const MAGIC = new Uint8Array([0x48, 0x57])
export const HEADER_SIZE = 5 // 2 magic + 1 type + 2 length
export const CRC_SIZE = 4
export const OVERHEAD = HEADER_SIZE + CRC_SIZE
export const MAX_PAYLOAD = 32768

// Frame types (mirrors common/src/types.rs)
export const FrameType = {
  PROVISION:             0x01,
  NIP46_REQUEST:         0x02,
  NIP46_RESPONSE:        0x03,
  PROVISION_REMOVE:      0x04,
  PROVISION_LIST:        0x05,
  ACK:                   0x06,
  PROVISION_LIST_RESPONSE: 0x07,
  GENERATE_IDENTITY:     0x57,
  RESTORE_IDENTITY:      0x58,
  FIRMWARE_INFO:         0x59,
  FIRMWARE_INFO_RESPONSE: 0x5a,
  SET_IDENTITY_META:     0x5b,
  GET_NET_CONFIG:        0x5c,
  GET_NET_CONFIG_RESPONSE: 0x5d,
  PATCH_NET_CONFIG:      0x5e,
  SET_OPERATOR:          0x5f,
  ENCRYPTED_REQUEST:     0x10,
  ENCRYPTED_RESPONSE:    0x11,
  NACK:                  0x15,
  POLICY_PUSH:           0x20,
  SESSION_AUTH:          0x21,
  SESSION_ACK:           0x22,
  SET_BRIDGE_SECRET:     0x23,
  FACTORY_RESET:         0x24,
  SET_PIN:               0x25,
  PIN_UNLOCK:            0x26,
  POLICY_LIST_REQUEST:   0x27,
  POLICY_LIST_RESPONSE:  0x28,
  POLICY_REVOKE:         0x29,
  POLICY_UPDATE:         0x2a,
  OTA_BEGIN:             0x30,
  OTA_CHUNK:             0x31,
  OTA_FINISH:            0x32,
  OTA_STATUS:            0x33,
  CONNSLOT_CREATE:       0x40,
  CONNSLOT_CREATE_RESP:  0x41,
  CONNSLOT_LIST:         0x42,
  CONNSLOT_LIST_RESP:    0x43,
  CONNSLOT_UPDATE:       0x44,
  CONNSLOT_UPDATE_RESP:  0x45,
  CONNSLOT_REVOKE:       0x46,
  CONNSLOT_REVOKE_RESP:  0x47,
  CONNSLOT_URI:          0x48,
  CONNSLOT_URI_RESP:     0x49,
  SET_NET_CONFIG:        0x54,
  WIFI_SCAN_REQUEST:     0x55,
  WIFI_SCAN_RESPONSE:    0x56,
} as const

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType]

export interface Frame {
  type: FrameTypeValue
  payload: Uint8Array
}

export class FrameError extends Error {
  constructor(public readonly code: 'too_short' | 'bad_magic' | 'payload_too_large' | 'bad_crc', message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

/** Build a complete frame from a type byte and payload. */
export function buildFrame(type: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > MAX_PAYLOAD) {
    throw new FrameError('payload_too_large', `Payload ${payload.length} exceeds max ${MAX_PAYLOAD}`)
  }

  const length = payload.length
  const lengthBytes = new Uint8Array([length >> 8, length & 0xff])

  // CRC covers type + length bytes + payload.
  const typeBytes = new Uint8Array([type])
  const checksum = crc32(typeBytes, lengthBytes, payload)

  const frame = new Uint8Array(OVERHEAD + length)
  frame[0] = MAGIC[0]!
  frame[1] = MAGIC[1]!
  frame[2] = type
  frame[3] = lengthBytes[0]!
  frame[4] = lengthBytes[1]!
  frame.set(payload, HEADER_SIZE)

  // CRC32 big-endian.
  frame[HEADER_SIZE + length] = (checksum >>> 24) & 0xff
  frame[HEADER_SIZE + length + 1] = (checksum >>> 16) & 0xff
  frame[HEADER_SIZE + length + 2] = (checksum >>> 8) & 0xff
  frame[HEADER_SIZE + length + 3] = checksum & 0xff

  return frame
}

/** Parse and validate a frame from raw bytes. */
export function parseFrame(data: Uint8Array): Frame {
  if (data.length < OVERHEAD) {
    throw new FrameError('too_short', `Need at least ${OVERHEAD} bytes, got ${data.length}`)
  }

  if (data[0] !== MAGIC[0] || data[1] !== MAGIC[1]) {
    throw new FrameError('bad_magic', `Expected magic 0x4857, got 0x${data[0]!.toString(16)}${data[1]!.toString(16)}`)
  }

  const type = data[2]! as FrameTypeValue
  const length = (data[3]! << 8) | data[4]!

  if (length > MAX_PAYLOAD) {
    throw new FrameError('payload_too_large', `Payload length ${length} exceeds max ${MAX_PAYLOAD}`)
  }

  if (data.length < HEADER_SIZE + length + CRC_SIZE) {
    throw new FrameError('too_short', `Need ${HEADER_SIZE + length + CRC_SIZE} bytes, got ${data.length}`)
  }

  const payload = data.slice(HEADER_SIZE, HEADER_SIZE + length)
  const crcOffset = HEADER_SIZE + length
  const receivedCrc =
    ((data[crcOffset]! << 24) | (data[crcOffset + 1]! << 16) | (data[crcOffset + 2]! << 8) | data[crcOffset + 3]!) >>> 0

  // Recompute CRC over type + length bytes + payload.
  const lengthBytes = new Uint8Array([(length >> 8) & 0xff, length & 0xff])
  const expectedCrc = crc32(new Uint8Array([type]), lengthBytes, payload)

  if (receivedCrc !== expectedCrc) {
    throw new FrameError('bad_crc', `CRC mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${receivedCrc.toString(16)}`)
  }

  return { type, payload }
}

// --- Payload builders for specific frame types ---

/** Build a POLICY_LIST_REQUEST frame. */
export function buildPolicyListRequest(masterSlot: number): Uint8Array {
  return buildFrame(FrameType.POLICY_LIST_REQUEST, new Uint8Array([masterSlot]))
}

/** Build a POLICY_REVOKE frame. */
export function buildPolicyRevoke(masterSlot: number, clientPubkeyHex: string): Uint8Array {
  const payload = new Uint8Array(65)
  payload[0] = masterSlot
  const encoder = new TextEncoder()
  payload.set(encoder.encode(clientPubkeyHex.slice(0, 64)), 1)
  return buildFrame(FrameType.POLICY_REVOKE, payload)
}

/** Build a POLICY_UPDATE frame. */
export function buildPolicyUpdate(masterSlot: number, policyJson: string): Uint8Array {
  const encoder = new TextEncoder()
  const jsonBytes = encoder.encode(policyJson)
  const payload = new Uint8Array(1 + jsonBytes.length)
  payload[0] = masterSlot
  payload.set(jsonBytes, 1)
  return buildFrame(FrameType.POLICY_UPDATE, payload)
}

/** Build a PROVISION_LIST frame (empty payload). */
export function buildProvisionList(): Uint8Array {
  return buildFrame(FrameType.PROVISION_LIST)
}

/**
 * Build a GENERATE_IDENTITY frame (0x57). The device generates its own seed,
 * shows the recovery phrase on its OWN screen, and stores it — no secret is
 * sent either way. Payload: [label_len][label].
 */
export function buildGenerateIdentity(label: string): Uint8Array {
  const labelBytes = new TextEncoder().encode(label.slice(0, 32))
  const payload = new Uint8Array(1 + labelBytes.length)
  payload[0] = labelBytes.length
  payload.set(labelBytes, 1)
  return buildFrame(FrameType.GENERATE_IDENTITY, payload)
}

/**
 * Build a RESTORE_IDENTITY frame (0x58). The device drives an on-screen,
 * one-button picker for the owner to re-enter an EXISTING 12-word recovery
 * phrase — the phrase is typed on the device, never here, and never sent over
 * the cable. The ACK carries only the resulting public npub. Payload:
 * [label_len][label].
 */
export function buildRestoreIdentity(label: string): Uint8Array {
  const labelBytes = new TextEncoder().encode(label.slice(0, 32))
  const payload = new Uint8Array(1 + labelBytes.length)
  payload[0] = labelBytes.length
  payload.set(labelBytes, 1)
  return buildFrame(FrameType.RESTORE_IDENTITY, payload)
}

/** Build a FIRMWARE_INFO frame (0x59, empty payload). Read-only version query. */
export function buildFirmwareInfo(): Uint8Array {
  return buildFrame(FrameType.FIRMWARE_INFO)
}

/** Build a FACTORY_RESET frame (empty payload, requires button confirm on device). */
export function buildFactoryReset(): Uint8Array {
  return buildFrame(FrameType.FACTORY_RESET)
}

/** Build a WIFI_SCAN_REQUEST frame (0x55, empty payload). The device scans nearby
 *  2.4 GHz access points and replies WIFI_SCAN_RESPONSE (0x56). Read-only. */
export function buildWifiScan(): Uint8Array {
  return buildFrame(FrameType.WIFI_SCAN_REQUEST)
}

/** Build a SET_PIN frame. Payload: 4-8 ASCII digit PIN, or empty to clear. */
export function buildSetPin(pin: string): Uint8Array {
  const encoder = new TextEncoder()
  return buildFrame(FrameType.SET_PIN, encoder.encode(pin))
}

export interface NetConfig {
  ssid: string
  password: string
  relays: string[]
  mode: 'usb' | 'wifi'
  /** Operator x-only pubkey (hex) authorised for relay management (kind 24134).
   *  Empty/omitted disables the management channel. */
  op_mgmt?: string
}

export interface LocalNetConfigPatch {
  mode?: 'usb' | 'wifi'
  ssid?: string
  relays?: string[]
  password?: { action: 'keep' | 'set' | 'clear'; value?: string }
}

/** Build a SET_NET_CONFIG frame. Payload: JSON-encoded NetConfig. */
export function buildSetNetConfig(cfg: NetConfig): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(cfg))
  return buildFrame(FrameType.SET_NET_CONFIG, payload)
}

/** Read password-redacted network/operator state over a locally attached USB cable. */
export function buildGetNetConfig(): Uint8Array {
  return buildFrame(FrameType.GET_NET_CONFIG)
}

/** Physically confirmed partial network update. It cannot rotate op_mgmt. */
export function buildPatchNetConfig(baseRevision: number, patch: LocalNetConfigPatch): Uint8Array {
  if (!Number.isInteger(baseRevision) || baseRevision < 0 || baseRevision > 0xffffffff) {
    throw new Error('base network revision must be a uint32')
  }
  const payload = new TextEncoder().encode(JSON.stringify({ base_revision: baseRevision, patch }))
  return buildFrame(FrameType.PATCH_NET_CONFIG, payload)
}

/** Physically confirmed management-operator rotation.
 * Payload: observed network revision (u32 BE) + x-only pubkey (32 bytes). */
export function buildSetOperator(baseRevision: number, operatorPubHex: string): Uint8Array {
  if (!Number.isInteger(baseRevision) || baseRevision < 0 || baseRevision > 0xffffffff) {
    throw new Error('base network revision must be a uint32')
  }
  const pubkey = hexToBytes32(operatorPubHex)
  const payload = new Uint8Array(36)
  new DataView(payload.buffer).setUint32(0, baseRevision, false)
  payload.set(pubkey, 4)
  return buildFrame(FrameType.SET_OPERATOR, payload)
}

/**
 * Build a SET_BRIDGE_SECRET frame. Payload: 32 bytes (hex-decoded secret).
 * Requires button confirmation. Rejected if bridge is currently authenticated.
 */
export function buildSetBridgeSecret(hexSecret: string): Uint8Array {
  return buildFrame(FrameType.SET_BRIDGE_SECRET, hexToBytes32(hexSecret))
}

/** Build a SESSION_AUTH frame. Payload: the 32-byte bridge secret. */
export function buildSessionAuth(hexSecret: string): Uint8Array {
  return buildFrame(FrameType.SESSION_AUTH, hexToBytes32(hexSecret))
}

function hexToBytes32(hexSecret: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hexSecret)) {
    throw new Error('expected 64 hexadecimal characters')
  }
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hexSecret.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// --- Connection-slot (client) management over serial (mirrors CONNSLOT_* frames) ---

/** CONNSLOT_CREATE: payload [master_slot][label utf8]. Requires bridge auth. */
export function buildConnSlotCreate(masterSlot: number, label: string): Uint8Array {
  const labelBytes = new TextEncoder().encode(label)
  const payload = new Uint8Array(1 + labelBytes.length)
  payload[0] = masterSlot
  payload.set(labelBytes, 1)
  return buildFrame(FrameType.CONNSLOT_CREATE, payload)
}

/** CONNSLOT_LIST: payload [master_slot]. No auth required (secrets redacted). */
export function buildConnSlotList(masterSlot: number): Uint8Array {
  return buildFrame(FrameType.CONNSLOT_LIST, new Uint8Array([masterSlot]))
}

/** CONNSLOT_UPDATE: payload [master_slot][JSON {slot_index, label?, allowed_kinds?, auto_approve?}]. Button-confirmed. */
export function buildConnSlotUpdate(masterSlot: number, changes: Record<string, unknown>): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(changes))
  const payload = new Uint8Array(1 + jsonBytes.length)
  payload[0] = masterSlot
  payload.set(jsonBytes, 1)
  return buildFrame(FrameType.CONNSLOT_UPDATE, payload)
}

/** CONNSLOT_REVOKE: payload [master_slot][slot_index]. Requires bridge auth. */
export function buildConnSlotRevoke(masterSlot: number, slotIndex: number): Uint8Array {
  return buildFrame(FrameType.CONNSLOT_REVOKE, new Uint8Array([masterSlot, slotIndex]))
}

/** CONNSLOT_URI: payload [master_slot][slot_index][relays JSON]. Returns the bunker URI. */
export function buildConnSlotUri(masterSlot: number, slotIndex: number, relays: string[]): Uint8Array {
  const relayBytes = new TextEncoder().encode(JSON.stringify(relays))
  const payload = new Uint8Array(2 + relayBytes.length)
  payload[0] = masterSlot
  payload[1] = slotIndex
  payload.set(relayBytes, 2)
  return buildFrame(FrameType.CONNSLOT_URI, payload)
}
