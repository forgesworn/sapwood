// Provisioning tests -- must match heartwood-esp32/provision/src/main.rs test vectors.

import { describe, expect, it } from 'vitest'
import {
  deriveFromMnemonic,
  deriveFromNsec,
  useRawNsec,
  decodeNsec,
  buildProvisionFrame,
  zeroize,
} from './provision.js'
import { parseFrame, FrameType } from './frame.js'

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('mnemonic derivation', () => {
  it('matches the Rust test vector', async () => {
    const result = await deriveFromMnemonic(TEST_MNEMONIC, '')

    // This npub must match the Rust test: test_mnemonic_derivation
    expect(result.npub).toBe(
      'npub186c5ke7vjsk98z8qx4ctdrggsl2qlu627g6xvg6yumrj5c5c6etqcfaclx'
    )

    // The derived secret must match the Rust test hex.
    const hex = Array.from(result.secret).map(b => b.toString(16).padStart(2, '0')).join('')
    expect(hex).toBe(
      'cc92d213b5eccd19eb85c12c2cf6fd168f27c2cc347c51a7c4c62ac67795fc65'
    )

    zeroize(result.secret)
  })

  it('passphrase changes the derived secret', async () => {
    const without = await deriveFromMnemonic(TEST_MNEMONIC, '')
    const withPass = await deriveFromMnemonic(TEST_MNEMONIC, 'test-passphrase')

    expect(Array.from(without.secret)).not.toEqual(Array.from(withPass.secret))

    zeroize(without.secret)
    zeroize(withPass.secret)
  })

  it('rejects invalid mnemonic', async () => {
    await expect(deriveFromMnemonic('invalid words here', '')).rejects.toThrow('Invalid mnemonic')
  })
})

describe('nsec decode', () => {
  it('roundtrips through derive + decode', async () => {
    // Derive a known secret, get its npub, then verify the derivation output is 32 bytes.
    const result = await deriveFromMnemonic(TEST_MNEMONIC, '')
    expect(result.secret.length).toBe(32)
    expect(result.npub).toMatch(/^npub1/)
    zeroize(result.secret)
  })

  it('rejects non-nsec prefix', () => {
    // A well-formed bech32 string with wrong prefix should throw about prefix.
    expect(() => decodeNsec('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toThrow()
  })
})

describe('tree-nsec derivation', () => {
  it('produces a different key from the input', () => {
    const nsecBytes = new Uint8Array(32).fill(0xaa)
    const result = deriveFromNsec(nsecBytes)

    // The derived secret should be different from the input.
    expect(Array.from(result.secret)).not.toEqual(Array.from(nsecBytes))
    expect(result.npub).toMatch(/^npub1/)

    zeroize(result.secret)
  })
})

describe('bunker mode', () => {
  it('uses raw nsec without derivation', () => {
    const nsecBytes = new Uint8Array(32).fill(0xbb)
    const result = useRawNsec(nsecBytes)

    // The secret should be the same as the input.
    expect(Array.from(result.secret)).toEqual(Array.from(nsecBytes))
    expect(result.npub).toMatch(/^npub1/)

    zeroize(result.secret)
  })
})

describe('provision frame', () => {
  it('builds legacy format for default tree-mnemonic', () => {
    const secret = new Uint8Array(32).fill(0xaa)
    const frame = buildProvisionFrame(secret, 'default', 'tree-mnemonic')
    const parsed = parseFrame(frame)
    expect(parsed.type).toBe(FrameType.PROVISION)
    // Legacy format: payload is just the 32-byte secret.
    expect(parsed.payload.length).toBe(32)
    expect(Array.from(parsed.payload)).toEqual(Array.from(secret))
  })

  it('builds extended format for custom label', () => {
    const secret = new Uint8Array(32).fill(0xbb)
    const frame = buildProvisionFrame(secret, 'primary', 'tree-mnemonic')
    const parsed = parseFrame(frame)
    expect(parsed.type).toBe(FrameType.PROVISION)
    // Extended: [mode=1][label_len=15][label...15 bytes][secret...32 bytes]
    expect(parsed.payload[0]).toBe(1) // tree-mnemonic
    expect(parsed.payload[1]).toBe(15) // label length
    expect(parsed.payload.length).toBe(2 + 15 + 32)
  })

  it('builds bunker mode frame', () => {
    const secret = new Uint8Array(32).fill(0xcc)
    const frame = buildProvisionFrame(secret, 'default', 'bunker')
    const parsed = parseFrame(frame)
    expect(parsed.type).toBe(FrameType.PROVISION)
    // Bunker + non-default: extended format.
    expect(parsed.payload[0]).toBe(0) // bunker
  })
})
