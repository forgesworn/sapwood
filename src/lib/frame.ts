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

/** Build a FACTORY_RESET frame (empty payload, requires button confirm on device). */
export function buildFactoryReset(): Uint8Array {
  return buildFrame(FrameType.FACTORY_RESET)
}
