// Vault key (encrypted-at-rest) tests — storage, serial frames, and the
// kind-24135/24136 relay announcement/delivery pair.

import { describe, expect, it, beforeEach } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { getConversationKey, decrypt } from 'nostr-tools/nip44'
import { hexToBytes } from '@noble/hashes/utils.js'
import { FrameType, parseFrame } from './frame.js'
import {
  VAULT_ANNOUNCE_KIND,
  VAULT_DELIVER_KIND,
  VaultAnnouncementWatcher,
  buildVaultDeliveryEvent,
  generateVaultKeyHex,
  isVaultKeyHex,
  loadVaultKey,
  normaliseVaultKeyHex,
  parseVaultAnnouncement,
  removeVaultKey,
  serialVaultSet,
  serialVaultUnlock,
  storeVaultKey,
} from './vault.js'
import type { Frame } from './frame.js'

const DEVICE = 'a'.repeat(64)
const OTHER_DEVICE = 'b'.repeat(64)
const KEY = 'c'.repeat(64)
const OPERATOR_SK = '1'.repeat(64)
const UNLOCK_SK = 'd'.repeat(64)
const UNLOCK_PUB = getPublicKey(hexToBytes(UNLOCK_SK))

beforeEach(() => {
  localStorage.clear()
})

describe('vault key generation and validation', () => {
  it('generates 64 lowercase-hex characters (32 bytes)', () => {
    const key = generateVaultKeyHex()
    expect(isVaultKeyHex(key)).toBe(true)
    expect(key).toHaveLength(64)
  })

  it('generates distinct keys', () => {
    expect(generateVaultKeyHex()).not.toBe(generateVaultKeyHex())
  })

  it('rejects malformed keys', () => {
    expect(isVaultKeyHex('abc')).toBe(false)
    expect(isVaultKeyHex('g'.repeat(64))).toBe(false)
    expect(isVaultKeyHex('C'.repeat(64))).toBe(false) // uppercase is not canonical
    expect(isVaultKeyHex(42)).toBe(false)
    expect(isVaultKeyHex(null)).toBe(false)
  })

  it('normalises pasted input (whitespace, uppercase)', () => {
    expect(normaliseVaultKeyHex(`  ${'C'.repeat(64)}\n`)).toBe(KEY)
    expect(normaliseVaultKeyHex('not a key')).toBeNull()
  })
})

describe('vault key storage', () => {
  it('stores and loads a key per device', () => {
    storeVaultKey(DEVICE, KEY)
    expect(loadVaultKey(DEVICE)).toBe(KEY)
    expect(loadVaultKey(OTHER_DEVICE)).toBeNull()
  })

  it('keeps keys for several devices apart', () => {
    storeVaultKey(DEVICE, KEY)
    storeVaultKey(OTHER_DEVICE, 'e'.repeat(64))
    expect(loadVaultKey(DEVICE)).toBe(KEY)
    expect(loadVaultKey(OTHER_DEVICE)).toBe('e'.repeat(64))
  })

  it('normalises on store and rejects malformed keys', () => {
    storeVaultKey(DEVICE, ` ${'C'.repeat(64)} `)
    expect(loadVaultKey(DEVICE)).toBe(KEY)
    expect(() => storeVaultKey(DEVICE, 'short')).toThrow(/64 hexadecimal/)
  })

  it('removes a key', () => {
    storeVaultKey(DEVICE, KEY)
    removeVaultKey(DEVICE)
    expect(loadVaultKey(DEVICE)).toBeNull()
  })

  it('fails closed on a corrupt store', () => {
    localStorage.setItem('heartwood.vaultKeys.v1', '{not json')
    expect(loadVaultKey(DEVICE)).toBeNull()
    localStorage.setItem('heartwood.vaultKeys.v1', JSON.stringify({ [DEVICE]: 'rubbish' }))
    expect(loadVaultKey(DEVICE)).toBeNull()
  })
})

// A minimal SerialTransport stand-in: replies with a queued frame.
function fakeTransport(reply: Frame) {
  const calls: { frame: Uint8Array; types: number[]; timeout: number }[] = []
  return {
    calls,
    transport: {
      sendAndReceive: (frame: Uint8Array, types: number[], timeout: number) => {
        calls.push({ frame, types, timeout })
        return Promise.resolve(reply)
      },
    },
  }
}

function ack(): Frame {
  return { type: FrameType.ACK, payload: new Uint8Array(0) }
}

function nack(reason: string): Frame {
  return { type: FrameType.NACK, payload: new TextEncoder().encode(reason) }
}

describe('serialVaultSet', () => {
  it('sends VAULT_SET (0x62) with the 32-byte key', async () => {
    const { transport, calls } = fakeTransport(ack())
    await serialVaultSet(transport as never, KEY)
    expect(calls).toHaveLength(1)
    const frame = parseFrame(calls[0]!.frame)
    expect(frame.type).toBe(FrameType.VAULT_SET)
    expect(frame.payload).toEqual(hexToBytes(KEY))
    expect(calls[0]!.types).toEqual([FrameType.ACK, FrameType.NACK])
  })

  it('sends an empty payload to disable', async () => {
    const { transport, calls } = fakeTransport(ack())
    await serialVaultSet(transport as never, null)
    const frame = parseFrame(calls[0]!.frame)
    expect(frame.type).toBe(FrameType.VAULT_SET)
    expect(frame.payload).toHaveLength(0)
  })

  it('throws the device reason on NACK', async () => {
    const { transport } = fakeTransport(nack('not confirmed'))
    await expect(serialVaultSet(transport as never, KEY)).rejects.toThrow('not confirmed')
  })

  it('rejects a malformed key before sending', async () => {
    const { transport, calls } = fakeTransport(ack())
    await expect(serialVaultSet(transport as never, 'short')).rejects.toThrow(/64 hexadecimal/)
    expect(calls).toHaveLength(0)
  })
})

describe('serialVaultUnlock', () => {
  it('sends VAULT_UNLOCK (0x63) with the 32-byte key', async () => {
    const { transport, calls } = fakeTransport(ack())
    await serialVaultUnlock(transport as never, KEY)
    const frame = parseFrame(calls[0]!.frame)
    expect(frame.type).toBe(FrameType.VAULT_UNLOCK)
    expect(frame.payload).toEqual(hexToBytes(KEY))
  })

  it('maps "wrong vault key" to a friendly error', async () => {
    const { transport } = fakeTransport(nack('wrong vault key'))
    await expect(serialVaultUnlock(transport as never, KEY)).rejects.toThrow(/did not unlock/)
  })

  it('treats "already unlocked" as success', async () => {
    const { transport } = fakeTransport(nack('already unlocked'))
    await expect(serialVaultUnlock(transport as never, KEY)).resolves.toBeUndefined()
  })

  it('maps "bridge auth required" to a retry hint', async () => {
    const { transport } = fakeTransport(nack('bridge auth required'))
    await expect(serialVaultUnlock(transport as never, KEY)).rejects.toThrow(/bridge session/)
  })

  it('surfaces unknown NACK reasons as-is', async () => {
    const { transport } = fakeTransport(nack('busy'))
    await expect(serialVaultUnlock(transport as never, KEY)).rejects.toThrow('busy')
  })
})

describe('vault announcements (kind 24135)', () => {
  it('accepts a locked announcement and returns the one-time unlock pubkey', () => {
    expect(parseVaultAnnouncement({ pubkey: UNLOCK_PUB, content: '{"status":"locked"}' })).toBe(UNLOCK_PUB)
  })

  it('rejects malformed announcements', () => {
    expect(parseVaultAnnouncement({ pubkey: UNLOCK_PUB, content: 'not json' })).toBeNull()
    expect(parseVaultAnnouncement({ pubkey: UNLOCK_PUB, content: '{"status":"unlocked"}' })).toBeNull()
    expect(parseVaultAnnouncement({ pubkey: 'nope', content: '{"status":"locked"}' })).toBeNull()
  })

  it('watcher routes valid announcements and ignores the rest', () => {
    const seen: string[] = []
    const events: { pubkey: string; content: string }[] = []
    const pool = {
      subscribe: (_relays: string[], filter: Record<string, unknown>, params: { onevent: (ev: { pubkey: string; content: string }) => void }) => {
        expect(filter.kinds).toEqual([VAULT_ANNOUNCE_KIND])
        expect(filter['#p']).toEqual([getPublicKey(hexToBytes(OPERATOR_SK))])
        for (const ev of events) params.onevent(ev)
        return { close: () => {} }
      },
      publish: () => [],
      destroy: () => {},
    }
    const watcher = new VaultAnnouncementWatcher(
      ['wss://relay.example'],
      getPublicKey(hexToBytes(OPERATOR_SK)),
      (pub) => seen.push(pub),
      pool,
    )
    events.push(
      { pubkey: 'junk', content: '{"status":"locked"}' },
      { pubkey: UNLOCK_PUB, content: '{"status":"locked"}' },
      { pubkey: UNLOCK_PUB, content: '{"status":"other"}' },
    )
    watcher.start()
    expect(seen).toEqual([UNLOCK_PUB])
    watcher.close()
  })
})

describe('vault delivery (kind 24136)', () => {
  it('builds an operator-signed event p-tagged to the unlock pubkey', () => {
    const ev = buildVaultDeliveryEvent(OPERATOR_SK, UNLOCK_PUB, KEY)
    expect(ev.kind).toBe(VAULT_DELIVER_KIND)
    expect(ev.pubkey).toBe(getPublicKey(hexToBytes(OPERATOR_SK)))
    expect(ev.tags).toContainEqual(['p', UNLOCK_PUB])
  })

  it('encrypts the hex vault key so only the unlock keypair can read it', () => {
    const ev = buildVaultDeliveryEvent(OPERATOR_SK, UNLOCK_PUB, KEY)
    const ck = getConversationKey(hexToBytes(UNLOCK_SK), ev.pubkey)
    expect(decrypt(ev.content, ck)).toBe(KEY)
  })

  it('normalises pasted keys before encrypting', () => {
    const ev = buildVaultDeliveryEvent(OPERATOR_SK, UNLOCK_PUB, ` ${'C'.repeat(64)} `)
    const ck = getConversationKey(hexToBytes(UNLOCK_SK), ev.pubkey)
    expect(decrypt(ev.content, ck)).toBe(KEY)
  })

  it('rejects malformed inputs', () => {
    expect(() => buildVaultDeliveryEvent('short', UNLOCK_PUB, KEY)).toThrow(/operator secret/)
    expect(() => buildVaultDeliveryEvent(OPERATOR_SK, 'short', KEY)).toThrow(/unlock pubkey/)
    expect(() => buildVaultDeliveryEvent(OPERATOR_SK, UNLOCK_PUB, 'short')).toThrow(/64 hexadecimal/)
  })
})
