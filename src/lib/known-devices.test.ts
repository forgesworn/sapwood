import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  rememberDevice, listKnownDevices, forgetDevice,
  getDeviceLabel, setDeviceLabel, npubToHex, npubShort, replaceDeviceRelays,
  clearPendingNetworkHandoff, networkRecoveryRelays, pendingNetworkHandoff,
  savePendingNetworkHandoff,
} from './known-devices.js'
import { nip19 } from 'nostr-tools'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)

beforeEach(() => {
  localStorage.clear()
})

describe('npubToHex', () => {
  it('passes through 64-char hex (lower-cased)', () => {
    expect(npubToHex('A'.repeat(64))).toBe('a'.repeat(64))
  })

  it('decodes an npub to x-only hex', () => {
    const npub = nip19.npubEncode(HEX_A)
    expect(npubToHex(npub)).toBe(HEX_A)
  })

  it('returns null for junk', () => {
    expect(npubToHex('not-a-key')).toBeNull()
    expect(npubToHex('')).toBeNull()
  })
})

describe('npubShort', () => {
  it('produces an abbreviated npub', () => {
    const s = npubShort(HEX_A)
    expect(s.startsWith('npub1')).toBe(true)
    expect(s).toContain('…')
  })
})

describe('device labels', () => {
  it('returns null when no device is remembered', () => {
    expect(getDeviceLabel(HEX_A)).toBeNull()
  })

  it('upserts a label for an unknown (relay-less) device', () => {
    setDeviceLabel(HEX_A, "bark's signer")
    expect(getDeviceLabel(HEX_A)).toBe("bark's signer")
    // Created relay-less so it does not masquerade as a connectable known device.
    expect(listKnownDevices().find((d) => d.pubHex === HEX_A)?.relays).toEqual([])
  })

  it('updates the label of an already-remembered device without losing relays', () => {
    rememberDevice(HEX_B, ['wss://relay.example'], 'old')
    setDeviceLabel(HEX_B, 'new name')
    const d = listKnownDevices().find((k) => k.pubHex === HEX_B)
    expect(d?.label).toBe('new name')
    expect(d?.relays).toEqual(['wss://relay.example'])
  })

  it('merges relay updates instead of forgetting older relays', () => {
    rememberDevice(HEX_B, [
      'wss://relay.trotters.cc',
      'wss://nos.lol',
      'wss://relay.damus.io',
    ], 'signer')

    rememberDevice(HEX_B, ['wss://relay.primal.net', 'wss://nos.lol'])

    const d = listKnownDevices().find((k) => k.pubHex === HEX_B)
    expect(d?.relays).toEqual([
      'wss://relay.primal.net',
      'wss://nos.lol',
      'wss://relay.trotters.cc',
      'wss://relay.damus.io',
    ])
  })

  it('replaces relays only for an existing device with a non-empty safe set', () => {
    rememberDevice(HEX_B, ['wss://old.example', 'wss://fallback.example'], 'signer')

    expect(replaceDeviceRelays(HEX_B, [' wss://new.example ', 'wss://new.example'])).not.toBeNull()
    expect(listKnownDevices().find((d) => d.pubHex === HEX_B)?.relays).toEqual(['wss://new.example'])

    expect(replaceDeviceRelays(HEX_B, [])).toBeNull()
    expect(replaceDeviceRelays(HEX_B, ['not-a-relay'])).toBeNull()
    expect(replaceDeviceRelays(HEX_B, ['ws://insecure.example'])).toBeNull()
    expect(replaceDeviceRelays(HEX_A, ['wss://other.example'])).toBeNull()
    expect(listKnownDevices().find((d) => d.pubHex === HEX_B)?.relays).toEqual(['wss://new.example'])
    expect(listKnownDevices().find((d) => d.pubHex === HEX_A)).toBeUndefined()
  })

  it('reports unavailable browser storage without throwing after a commit', () => {
    rememberDevice(HEX_B, ['wss://old.example'], 'signer')
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    try {
      expect(replaceDeviceRelays(HEX_B, ['wss://new.example'])).toBeNull()
    } finally {
      write.mockRestore()
    }
    expect(listKnownDevices().find((d) => d.pubHex === HEX_B)?.relays).toEqual(['wss://old.example'])
  })

  it('ignores a blank label and invalid pubkeys', () => {
    setDeviceLabel(HEX_A, '   ')
    setDeviceLabel('short', 'x')
    expect(listKnownDevices()).toHaveLength(0)
  })

  it('is matched case-insensitively', () => {
    setDeviceLabel(HEX_A, 'one')
    setDeviceLabel(HEX_A.toUpperCase(), 'two')
    expect(getDeviceLabel(HEX_A)).toBe('two')
    expect(listKnownDevices()).toHaveLength(1)
  })

  it('forgetDevice removes the entry', () => {
    setDeviceLabel(HEX_A, 'gone')
    forgetDevice(HEX_A)
    expect(getDeviceLabel(HEX_A)).toBeNull()
  })
})

describe('pending network handoff journal', () => {
  it('adds a password-free A+B recovery route until terminal cleanup', () => {
    rememberDevice(HEX_A, ['wss://old.example'], 'remote signer')
    expect(savePendingNetworkHandoff({
      devicePubHex: HEX_A,
      transactionId: '01'.repeat(16),
      revision: 9,
      oldRelays: ['wss://old.example'],
      candidateRelays: ['wss://new.example'],
    })).toBe(true)

    expect(pendingNetworkHandoff(HEX_A)).toEqual(expect.objectContaining({
      transactionId: '01'.repeat(16),
      revision: 9,
    }))
    expect(networkRecoveryRelays(HEX_A, ['wss://old.example'])).toEqual([
      'wss://new.example',
      'wss://old.example',
    ])
    expect(listKnownDevices()[0]?.relays).toEqual(['wss://new.example', 'wss://old.example'])
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/password|ssid/i)

    expect(clearPendingNetworkHandoff(HEX_A)).toBe(true)
    expect(listKnownDevices()[0]?.relays).toEqual(['wss://old.example'])
  })

  it('rejects malformed or insecure recovery records', () => {
    expect(savePendingNetworkHandoff({
      devicePubHex: HEX_A,
      transactionId: 'too-short',
      revision: 1,
      oldRelays: ['wss://old.example'],
      candidateRelays: ['wss://new.example'],
    })).toBe(false)
    expect(savePendingNetworkHandoff({
      devicePubHex: HEX_A,
      transactionId: '02'.repeat(16),
      revision: 1,
      oldRelays: ['wss://old.example'],
      candidateRelays: ['ws://insecure.example'],
    })).toBe(false)
  })
})
