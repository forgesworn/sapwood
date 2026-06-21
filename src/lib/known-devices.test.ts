import { describe, it, expect, beforeEach } from 'vitest'
import {
  rememberDevice, listKnownDevices, forgetDevice,
  getDeviceLabel, setDeviceLabel, npubToHex, npubShort,
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
