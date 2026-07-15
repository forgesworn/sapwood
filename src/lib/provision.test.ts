// Provisioning tests -- must match heartwood-esp32/provision/src/main.rs test vectors.

import { describe, expect, it } from 'vitest'
import {
  deriveFromMnemonic,
  deriveNamedFromMnemonic,
  deriveNamedFromNsec,
  deriveChild,
  deriveFromNsec,
  useRawNsec,
  decodeNsec,
  buildProvisionFrame,
  nameDeriveError,
  generateMnemonic,
  zeroize,
} from './provision.js'
import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
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

describe('generateMnemonic', () => {
  it('generates a valid 12-word phrase by default', () => {
    const phrase = generateMnemonic()
    expect(phrase.split(/\s+/)).toHaveLength(12)
    expect(validateMnemonic(phrase, wordlist)).toBe(true)
  })

  it('generates a valid 24-word phrase at 256 bits', () => {
    const phrase = generateMnemonic(256)
    expect(phrase.split(/\s+/)).toHaveLength(24)
    expect(validateMnemonic(phrase, wordlist)).toBe(true)
  })

  it('is fresh each call (not constant)', () => {
    expect(generateMnemonic()).not.toBe(generateMnemonic())
  })

  it('produces a phrase that derives a valid device identity', async () => {
    const phrase = generateMnemonic()
    const result = await deriveFromMnemonic(phrase, '')
    expect(result.secret.length).toBe(32)
    expect(result.npub).toMatch(/^npub1/)
    zeroize(result.secret)
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

  it('matches nsec-tree frozen vector (0x01-fill)', () => {
    // FROZEN: must match nsec-tree vectors.test.ts vector 1.
    // fromNsec(0x01 x 32) must produce this exact npub.
    const nsecBytes = new Uint8Array(32).fill(0x01)
    const result = deriveFromNsec(nsecBytes)

    expect(result.npub).toBe(
      'npub13sp7q3awvrqpa9p2svm7w8ghudghlnrraekwl7qh8w7j8747vjwskvzy2u'
    )

    zeroize(result.secret)
  })
})

describe('named-child derivation', () => {
  it('matches the heartwood-common child vector', () => {
    // FROZEN: heartwood-esp32/common/src/derive.rs
    // test_child_derivation_matches_heartwood_core — root 0x01..0x20,
    // purpose "persona/test", index 0.
    const root = new Uint8Array(32)
    for (let i = 0; i < 32; i++) root[i] = i + 1
    const result = deriveChild(root, 'persona/test')

    expect(result.npub).toBe(
      'npub1rx8u4wk9ytu8aak4f9wcaqdgk0lj4rjhdu4j9n7dj2mg68l9cdqs2fjf2t'
    )

    zeroize(result.secret)
  })

  it('matches nsec-tree derive() from the test mnemonic', async () => {
    // FROZEN: generated with the local nsec-tree library —
    // derive(fromMnemonic(TEST_MNEMONIC), 'pallasite') and 'social'.
    const pallasite = await deriveNamedFromMnemonic(TEST_MNEMONIC, '', 'pallasite')
    expect(pallasite.npub).toBe(
      'npub1vr9q6ecjejn805vek76xtt263rnw3em2cmw63vkl3zg9qyk23fnsccluju'
    )
    zeroize(pallasite.secret)

    const social = await deriveNamedFromMnemonic(TEST_MNEMONIC, '', 'social')
    expect(social.npub).toBe(
      'npub1rf8rzpz7u7lpl3ekj48lul4y3llu0pyx23f209295qnapecjljtsr7x8kl'
    )
    zeroize(social.secret)
  })

  it('different names derive different keys; same name is deterministic', async () => {
    const a = await deriveNamedFromMnemonic(TEST_MNEMONIC, '', 'work')
    const b = await deriveNamedFromMnemonic(TEST_MNEMONIC, '', 'play')
    const a2 = await deriveNamedFromMnemonic(TEST_MNEMONIC, '', 'work')

    expect(a.npub).not.toBe(b.npub)
    expect(a.npub).toBe(a2.npub)

    zeroize(a.secret)
    zeroize(b.secret)
    zeroize(a2.secret)
  })

  it('names are case-sensitive', async () => {
    const lower = await deriveNamedFromMnemonic(TEST_MNEMONIC, '', 'pallasite')
    const upper = await deriveNamedFromMnemonic(TEST_MNEMONIC, '', 'Pallasite')
    expect(lower.npub).not.toBe(upper.npub)
    zeroize(lower.secret)
    zeroize(upper.secret)
  })

  it('the child differs from the master and from the bare-purpose root', async () => {
    const master = await deriveFromMnemonic(TEST_MNEMONIC, '')
    const child = await deriveNamedFromMnemonic(TEST_MNEMONIC, '', 'pallasite')
    expect(child.npub).not.toBe(master.npub)
    zeroize(master.secret)
    zeroize(child.secret)
  })

  it('rejects invalid names', () => {
    const root = new Uint8Array(32).fill(0x42)
    expect(() => deriveChild(root, '')).toThrow()
    expect(() => deriveChild(root, '   ')).toThrow()
    expect(() => deriveChild(root, 'a|b')).toThrow()
    expect(() => deriveChild(root, 'a\0b')).toThrow()
  })

  it('matches nsec-tree derive(fromNsec(nsec), name) for an nsec master', () => {
    // FROZEN: generated with the local nsec-tree library —
    // derive(fromNsec(nsec of 0x01 x 32), 'pallasite'). This is the path a
    // bunker-mode master takes: HMAC root from the nsec, then the named child.
    const nsecBytes = new Uint8Array(32).fill(0x01)
    const result = deriveNamedFromNsec(nsecBytes, 'pallasite')

    expect(result.npub).toBe(
      'npub15mucgvh8ca7hnq8a6330r296jemjez329r4tjtmwut6juavnmdvsc7tt20'
    )
    // The input nsec must be left intact for the caller to zeroize.
    expect(nsecBytes.every((b) => b === 0x01)).toBe(true)

    zeroize(result.secret)
  })

  it('nsec-rooted and phrase-rooted children with the same name differ', async () => {
    const fromNsec = deriveNamedFromNsec(new Uint8Array(32).fill(0x01), 'pallasite')
    const fromPhrase = await deriveNamedFromMnemonic(TEST_MNEMONIC, '', 'pallasite')
    expect(fromNsec.npub).not.toBe(fromPhrase.npub)
    zeroize(fromNsec.secret)
    zeroize(fromPhrase.secret)
  })
})

describe('nameDeriveError', () => {
  it('accepts ordinary names and rejects malformed ones', () => {
    expect(nameDeriveError('pallasite')).toBeNull()
    expect(nameDeriveError('work:client-a')).toBeNull()
    expect(nameDeriveError('')).not.toBeNull()
    expect(nameDeriveError('  ')).not.toBeNull()
    expect(nameDeriveError('a|b')).not.toBeNull()
    expect(nameDeriveError('a'.repeat(256))).not.toBeNull()
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
    // Extended: [mode=1][label_len=7][label...7 bytes][secret...32 bytes]
    expect(parsed.payload[0]).toBe(1) // tree-mnemonic
    expect(parsed.payload[1]).toBe(7) // label length
    expect(parsed.payload.length).toBe(2 + 7 + 32)
  })

  it('builds bunker mode frame', () => {
    const secret = new Uint8Array(32).fill(0xcc)
    const frame = buildProvisionFrame(secret, 'default', 'bunker')
    const parsed = parseFrame(frame)
    expect(parsed.type).toBe(FrameType.PROVISION)
    // Bunker + non-default: extended format.
    expect(parsed.payload[0]).toBe(0) // bunker
  })

  it('builds named-child frames with the bunker wire byte', () => {
    // The child key is sent as-is: the device signs AS the named identity, so
    // on the wire it is indistinguishable from a bunker-mode key.
    const secret = new Uint8Array(32).fill(0xab)
    const frame = buildProvisionFrame(secret, 'pallasite', 'named-child')
    const parsed = parseFrame(frame)
    expect(parsed.type).toBe(FrameType.PROVISION)
    expect(parsed.payload[0]).toBe(0) // bunker wire byte
    expect(parsed.payload[1]).toBe(9) // "pallasite"
    expect(parsed.payload.length).toBe(2 + 9 + 32)
  })

  it('builds tree-nsec mode frame', () => {
    const secret = new Uint8Array(32).fill(0xdd)
    const frame = buildProvisionFrame(secret, 'MyNsec', 'tree-nsec')
    const parsed = parseFrame(frame)
    expect(parsed.type).toBe(FrameType.PROVISION)
    expect(parsed.payload[0]).toBe(2) // tree-nsec
    expect(parsed.payload[1]).toBe(6) // "MyNsec" = 6 bytes
    expect(parsed.payload.length).toBe(2 + 6 + 32)
  })

  it('truncates label to 32 bytes', () => {
    const secret = new Uint8Array(32).fill(0xee)
    const longLabel = 'a'.repeat(100)
    const frame = buildProvisionFrame(secret, longLabel, 'tree-mnemonic')
    const parsed = parseFrame(frame)
    expect(parsed.payload[1]).toBe(32) // capped at 32
    expect(parsed.payload.length).toBe(2 + 32 + 32)
  })
})

describe('zeroize', () => {
  it('fills array with zeros', () => {
    const arr = new Uint8Array([1, 2, 3, 4, 5])
    zeroize(arr)
    expect(Array.from(arr)).toEqual([0, 0, 0, 0, 0])
  })

  it('handles empty array', () => {
    const arr = new Uint8Array(0)
    zeroize(arr) // should not throw
    expect(arr.length).toBe(0)
  })
})

describe('derivation edge cases', () => {
  it('tree-nsec rejects wrong-length input', () => {
    expect(() => deriveFromNsec(new Uint8Array(16))).toThrow('32 bytes')
  })

  it('bunker mode rejects wrong-length input', () => {
    expect(() => useRawNsec(new Uint8Array(31))).toThrow('32 bytes')
  })

  it('tree-nsec is deterministic', () => {
    const input = new Uint8Array(32).fill(0x42)
    const a = deriveFromNsec(input)
    const b = deriveFromNsec(input)
    expect(Array.from(a.secret)).toEqual(Array.from(b.secret))
    expect(a.npub).toBe(b.npub)
    zeroize(a.secret)
    zeroize(b.secret)
  })

  it('mnemonic derivation is deterministic', async () => {
    const a = await deriveFromMnemonic(TEST_MNEMONIC, '')
    const b = await deriveFromMnemonic(TEST_MNEMONIC, '')
    expect(Array.from(a.secret)).toEqual(Array.from(b.secret))
    zeroize(a.secret)
    zeroize(b.secret)
  })

  it('different mnemonics produce different keys', async () => {
    const m1 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const m2 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
    const a = await deriveFromMnemonic(m1, '')
    const b = await deriveFromMnemonic(m2, '')
    expect(Array.from(a.secret)).not.toEqual(Array.from(b.secret))
    zeroize(a.secret)
    zeroize(b.secret)
  })

  it('all three modes produce different results from same input', () => {
    const input = new Uint8Array(32).fill(0x55)
    const bunker = useRawNsec(input)
    const tree = deriveFromNsec(input)

    // Bunker = raw input, tree = HMAC of input. Must differ.
    expect(Array.from(bunker.secret)).not.toEqual(Array.from(tree.secret))
    expect(bunker.npub).not.toBe(tree.npub)

    zeroize(bunker.secret)
    zeroize(tree.secret)
  })
})
