import { describe, it, expect } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils.js'
import { RelayTransport } from './relay-transport.js'

// Fixed, valid secp256k1 scalars so construction is deterministic and offline:
// no relay is ever contacted by these tests (they exercise the input contract
// and the request lifecycle guards, all of which short-circuit before any I/O).
const OP_SK_HEX = '01'.repeat(32)
const DEVICE_PUB = getPublicKey(hexToBytes('02'.repeat(32))) // valid 64-hex x-only key
const RELAYS = ['wss://relay.example']

describe('RelayTransport construction', () => {
  it('rejects a device pubkey that is not 64 hex chars', () => {
    expect(() => new RelayTransport('not-hex', RELAYS, OP_SK_HEX)).toThrow(
      'device pubkey must be 64 hex chars',
    )
    expect(() => new RelayTransport('ab'.repeat(20), RELAYS, OP_SK_HEX)).toThrow(
      'device pubkey must be 64 hex chars',
    )
  })

  it('rejects an empty relay list', () => {
    expect(() => new RelayTransport(DEVICE_PUB, [], OP_SK_HEX)).toThrow(
      'at least one relay is required',
    )
  })

  it('rejects an operator secret that is not 64 hex chars', () => {
    expect(() => new RelayTransport(DEVICE_PUB, RELAYS, 'deadbeef')).toThrow(
      'operator secret must be 64 hex chars',
    )
  })

  it('accepts valid arguments and derives the operator pubkey', () => {
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX)
    expect(t.operatorPub).toBe(getPublicKey(hexToBytes(OP_SK_HEX)))
    expect(t.relays).toEqual(RELAYS)
    t.close()
  })

  it('lowercases the device pubkey', () => {
    const t = new RelayTransport(DEVICE_PUB.toUpperCase(), RELAYS, OP_SK_HEX)
    expect(t.devicePub).toBe(DEVICE_PUB.toLowerCase())
    t.close()
  })
})

describe('RelayTransport request lifecycle', () => {
  it('rejects a request made before connect()', async () => {
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX)
    await expect(t.request('ping')).rejects.toThrow('not connected')
    t.close()
  })

  it('rejects a request made after close()', async () => {
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX)
    t.close()
    await expect(t.request('ping')).rejects.toThrow('transport closed')
  })

  it('treats close() as idempotent', () => {
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX)
    t.close()
    expect(() => t.close()).not.toThrow()
  })
})
