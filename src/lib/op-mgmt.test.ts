// Operator key (op_mgmt) tests — phrase-backed authority with raw-hex back-compat.

import { beforeEach, describe, expect, it } from 'vitest'
import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import {
  generateOperatorMnemonic,
  getOrCreateOperator,
  getOperatorMnemonic,
  regenerateOperator,
  importOperatorMnemonic,
  importOperator,
  peekOperatorPubHex,
  getOperatorCandidates,
  findStoredOperatorByPubHex,
  migrateOperatorStorage,
  pubHexFromSecret,
} from './op-mgmt.js'

const LS_MNEMONIC = 'heartwood.opMgmt.mnemonic'
const LS_SK = 'heartwood.opMgmt.skHex'
const LS_KEYRING = 'heartwood.opMgmt.keyring.v1'

const HEX64 = /^[0-9a-f]{64}$/

beforeEach(() => localStorage.clear())

describe('generateOperatorMnemonic', () => {
  it('produces a valid 12-word phrase by default', () => {
    const phrase = generateOperatorMnemonic()
    expect(phrase.split(' ')).toHaveLength(12)
    expect(validateMnemonic(phrase, wordlist)).toBe(true)
  })

  it('produces 24 words at 256 bits', () => {
    expect(generateOperatorMnemonic(256).split(' ')).toHaveLength(24)
  })

  it('is different each time', () => {
    expect(generateOperatorMnemonic()).not.toBe(generateOperatorMnemonic())
  })
})

describe('getOrCreateOperator', () => {
  it('mints a phrase-backed key when none exists, and persists it', () => {
    const op = getOrCreateOperator()
    expect(op.skHex).toMatch(HEX64)
    expect(op.pubHex).toMatch(HEX64)
    expect(op.mnemonic).toBeDefined()
    expect(validateMnemonic(op.mnemonic!, wordlist)).toBe(true)
    expect(localStorage.getItem(LS_MNEMONIC)).toBe(op.mnemonic)
  })

  it('returns the same key on repeat calls (deterministic from the phrase)', () => {
    const a = getOrCreateOperator()
    const b = getOrCreateOperator()
    expect(b.skHex).toBe(a.skHex)
    expect(b.pubHex).toBe(a.pubHex)
    expect(b.mnemonic).toBe(a.mnemonic)
  })

  it('honours a legacy raw-hex secret unchanged (no phrase)', () => {
    const legacy = 'a'.repeat(64)
    localStorage.setItem(LS_SK, legacy)
    const op = getOrCreateOperator()
    expect(op.skHex).toBe(legacy)
    expect(op.mnemonic).toBeUndefined()
    // A legacy key is not migrated implicitly — the raw secret stays put.
    expect(localStorage.getItem(LS_SK)).toBe(legacy)
    expect(localStorage.getItem(LS_MNEMONIC)).toBeNull()
  })

  it('prefers the phrase-backed key when a legacy secret is also present', () => {
    const phrase = generateOperatorMnemonic()
    localStorage.setItem(LS_MNEMONIC, phrase)
    localStorage.setItem(LS_SK, 'b'.repeat(64))
    const op = getOrCreateOperator()
    // The recoverable phrase key is the primary; the legacy secret is only a
    // fallback candidate for relay connect (see getOperatorCandidates).
    expect(op.mnemonic).toBe(phrase)
    expect(op.skHex).not.toBe('b'.repeat(64))
  })
})

describe('getOperatorMnemonic', () => {
  it('returns the phrase for a phrase-backed key', () => {
    const op = getOrCreateOperator()
    expect(getOperatorMnemonic()).toBe(op.mnemonic)
  })

  it('returns null for a legacy raw-hex key', () => {
    localStorage.setItem(LS_SK, 'c'.repeat(64))
    getOrCreateOperator()
    expect(getOperatorMnemonic()).toBeNull()
  })

  it('returns the phrase even when a legacy raw-hex key is also present', () => {
    const phrase = generateOperatorMnemonic()
    localStorage.setItem(LS_MNEMONIC, phrase)
    localStorage.setItem(LS_SK, 'c'.repeat(64))
    expect(getOperatorMnemonic()).toBe(phrase)
  })
})

describe('peekOperatorPubHex', () => {
  it('previews the phrase-backed key getOrCreateOperator will use', () => {
    localStorage.setItem(LS_MNEMONIC, generateOperatorMnemonic())
    localStorage.setItem(LS_SK, 'b'.repeat(64))
    const op = getOrCreateOperator()
    expect(op.mnemonic).toBeDefined() // the phrase key is the primary
    expect(peekOperatorPubHex()).toBe(op.pubHex)
  })
})

describe('getOperatorCandidates', () => {
  it('returns every distinct saved operator so relay connect can try them', () => {
    const phrase = generateOperatorMnemonic()
    localStorage.setItem(LS_MNEMONIC, phrase)
    localStorage.setItem(LS_SK, 'b'.repeat(64))
    const candidates = getOperatorCandidates()
    expect(candidates).toHaveLength(2)
    // Phrase-backed key first (the recoverable primary), legacy secret second.
    expect(candidates[0]?.mnemonic).toBe(phrase)
    expect(candidates[1]?.skHex).toBe('b'.repeat(64))
  })

  it('mints one operator when none is stored', () => {
    const candidates = getOperatorCandidates()
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.skHex).toMatch(HEX64)
    expect(localStorage.getItem(LS_MNEMONIC)).toBe(candidates[0]?.mnemonic)
  })

  it('does not duplicate the current key mirrored in legacy storage', () => {
    const current = importOperator('b'.repeat(64))
    expect(localStorage.getItem(LS_SK)).toBe(current.skHex)
    expect(getOperatorCandidates()).toEqual([current])
  })
})

describe('findStoredOperatorByPubHex', () => {
  it('selects an exact legacy fallback without returning the phrase-backed primary', () => {
    localStorage.setItem(LS_MNEMONIC, generateOperatorMnemonic())
    localStorage.setItem(LS_SK, 'b'.repeat(64))
    const [primary, legacy] = getOperatorCandidates()

    expect(primary?.mnemonic).toBeDefined()
    expect(legacy?.skHex).toBe('b'.repeat(64))
    expect(findStoredOperatorByPubHex(legacy!.pubHex)).toEqual(legacy)
    expect(findStoredOperatorByPubHex(legacy!.pubHex)?.pubHex).not.toBe(primary!.pubHex)
  })

  it('fails closed without minting or falling back when the key is unavailable', () => {
    expect(findStoredOperatorByPubHex('f'.repeat(64))).toBeNull()
    expect(localStorage.getItem(LS_MNEMONIC)).toBeNull()
    expect(localStorage.getItem(LS_SK)).toBeNull()
  })
})

describe('migrateOperatorStorage', () => {
  it('drops a malformed legacy secret (wrong length)', () => {
    // A 65-char record: not a valid 32-byte secret, silently ignored by readers.
    localStorage.setItem(LS_SK, 'a'.repeat(65))
    migrateOperatorStorage()
    expect(localStorage.getItem(LS_SK)).toBeNull()
  })

  it('drops a legacy secret containing non-hex characters', () => {
    localStorage.setItem(LS_SK, 'z'.repeat(64))
    migrateOperatorStorage()
    expect(localStorage.getItem(LS_SK)).toBeNull()
  })

  it('keeps a well-formed legacy secret', () => {
    const legacy = 'a'.repeat(64)
    localStorage.setItem(LS_SK, legacy)
    migrateOperatorStorage()
    expect(localStorage.getItem(LS_SK)).toBe(legacy)
  })

  it('keeps a salvageable upper-case legacy secret', () => {
    const legacy = 'A'.repeat(64)
    localStorage.setItem(LS_SK, legacy)
    migrateOperatorStorage()
    expect(localStorage.getItem(LS_SK)).toBe(legacy)
  })

  it('leaves a phrase-backed key alone', () => {
    const phrase = generateOperatorMnemonic()
    localStorage.setItem(LS_MNEMONIC, phrase)
    migrateOperatorStorage()
    expect(localStorage.getItem(LS_MNEMONIC)).toBe(phrase)
  })

  it('persists both legacy singleton credentials in the keyring', () => {
    const phrase = generateOperatorMnemonic()
    localStorage.setItem(LS_MNEMONIC, phrase)
    localStorage.setItem(LS_SK, 'b'.repeat(64))

    migrateOperatorStorage()
    expect(localStorage.getItem(LS_KEYRING)).not.toBeNull()

    // Prove this is a real migration, not continued dependence on old slots.
    localStorage.removeItem(LS_MNEMONIC)
    localStorage.removeItem(LS_SK)
    const candidates = getOperatorCandidates()
    expect(candidates).toHaveLength(2)
    expect(candidates[0]?.mnemonic).toBe(phrase)
    expect(candidates[1]?.skHex).toBe('b'.repeat(64))
  })

  it('normalises a salvageable legacy secret in the keyring', () => {
    const upper = 'B'.repeat(64)
    localStorage.setItem(LS_SK, upper)
    migrateOperatorStorage()
    localStorage.removeItem(LS_SK)
    expect(getOperatorCandidates()[0]?.skHex).toBe(upper.toLowerCase())
  })

  it('drops a 64-hex value that is not a valid secret scalar', () => {
    localStorage.setItem(LS_SK, '0'.repeat(64))
    migrateOperatorStorage()
    expect(localStorage.getItem(LS_SK)).toBeNull()
    expect(localStorage.getItem(LS_KEYRING)).toBeNull()
  })
})

describe('importOperatorMnemonic', () => {
  it('restores the exact same key from a phrase (round-trip across browsers)', () => {
    const original = getOrCreateOperator()
    localStorage.clear() // simulate a fresh browser
    const restored = importOperatorMnemonic(original.mnemonic!)
    expect(restored.skHex).toBe(original.skHex)
    expect(restored.pubHex).toBe(original.pubHex)
  })

  it('normalises whitespace and case', () => {
    const phrase = generateOperatorMnemonic()
    const messy = `  ${phrase.toUpperCase().replace(/ /g, '   ')}  `
    const op = importOperatorMnemonic(messy)
    expect(op.mnemonic).toBe(phrase)
  })

  it('rejects an invalid phrase', () => {
    expect(() => importOperatorMnemonic('not a real recovery phrase at all')).toThrow()
  })

  it('selects the phrase in the legacy mirror but retains the raw credential', () => {
    const raw = importOperator('d'.repeat(64))
    const restored = importOperatorMnemonic(generateOperatorMnemonic())
    expect(localStorage.getItem(LS_SK)).toBeNull()
    expect(localStorage.getItem(LS_MNEMONIC)).toBe(restored.mnemonic)
    expect(getOperatorCandidates()).toHaveLength(2)
    expect(findStoredOperatorByPubHex(raw.pubHex)).toEqual(raw)
  })
})

describe('regenerateOperator', () => {
  it('mints and selects a new phrase-backed key while retaining the old one', () => {
    const before = getOrCreateOperator()
    const after = regenerateOperator()
    expect(after.skHex).not.toBe(before.skHex)
    expect(after.mnemonic).toBeDefined()
    expect(after.mnemonic).not.toBe(before.mnemonic)
    expect(localStorage.getItem(LS_SK)).toBeNull()
    expect(getOperatorCandidates()).toEqual([after, before])
    expect(findStoredOperatorByPubHex(before.pubHex)).toEqual(before)
  })
})

describe('importOperator (raw hex)', () => {
  it('selects a raw secret without deleting the prior phrase-backed credential', () => {
    const prior = getOrCreateOperator()
    const sk = 'e'.repeat(64)
    const op = importOperator(sk)
    expect(op.skHex).toBe(sk)
    expect(op.mnemonic).toBeUndefined()
    expect(localStorage.getItem(LS_MNEMONIC)).toBeNull()
    expect(getOperatorMnemonic()).toBeNull()
    expect(getOperatorCandidates()).toEqual([op, prior])
    expect(findStoredOperatorByPubHex(prior.pubHex)).toEqual(prior)
  })

  it('rejects a non-64-hex secret', () => {
    expect(() => importOperator('xyz')).toThrow()
  })
})

describe('pubkey-keyed operator keyring', () => {
  it('retains every distinct imported signer credential and keeps the newest current', () => {
    const first = importOperator('b'.repeat(64))
    const second = importOperator('c'.repeat(64))
    const third = importOperatorMnemonic(generateOperatorMnemonic())

    expect(getOrCreateOperator()).toEqual(third)
    expect(peekOperatorPubHex()).toBe(third.pubHex)
    expect(getOperatorMnemonic()).toBe(third.mnemonic)
    expect(getOperatorCandidates()).toEqual([third, first, second])
    expect(findStoredOperatorByPubHex(first.pubHex)).toEqual(first)
    expect(findStoredOperatorByPubHex(second.pubHex)).toEqual(second)
    expect(findStoredOperatorByPubHex(third.pubHex)).toEqual(third)
  })

  it('reselects an existing credential without duplicating or downgrading it', () => {
    const phrase = getOrCreateOperator()
    const raw = importOperator('b'.repeat(64))

    // A handoff can carry the raw encoding of an already phrase-backed key.
    // Selecting it must not discard the locally known recovery phrase.
    const selected = importOperator(phrase.skHex)
    expect(selected).toEqual(phrase)
    expect(getOperatorMnemonic()).toBe(phrase.mnemonic)
    expect(getOperatorCandidates()).toEqual([phrase, raw])
  })

  it('restoring an older phrase makes it current without deleting newer keys', () => {
    const first = getOrCreateOperator()
    const second = regenerateOperator()
    const raw = importOperator('b'.repeat(64))

    const restored = importOperatorMnemonic(first.mnemonic!)
    expect(restored).toEqual(first)
    expect(getOperatorCandidates()).toEqual([first, second, raw])
  })

  it('ignores corrupt or pubkey-mismatched keyring entries', () => {
    const validSk = 'b'.repeat(64)
    const otherSk = 'c'.repeat(64)
    const validPub = pubHexFromSecret(validSk)!
    const otherPub = pubHexFromSecret(otherSk)!
    localStorage.setItem(LS_KEYRING, JSON.stringify({
      version: 1,
      currentPubHex: otherPub,
      credentials: {
        [validPub]: { skHex: validSk },
        // Claimed map key does not match the credential's derived public key.
        [otherPub]: { skHex: validSk },
        malformed: { skHex: otherSk },
      },
    }))

    expect(getOperatorCandidates()).toEqual([{
      skHex: validSk,
      pubHex: validPub,
    }])
    expect(peekOperatorPubHex()).toBe(validPub)
    expect(findStoredOperatorByPubHex(otherPub)).toBeNull()
  })

  it('uses valid legacy credentials when the keyring JSON is unreadable', () => {
    localStorage.setItem(LS_KEYRING, '{not-json')
    localStorage.setItem(LS_SK, 'b'.repeat(64))
    expect(getOperatorCandidates()).toEqual([{
      skHex: 'b'.repeat(64),
      pubHex: pubHexFromSecret('b'.repeat(64)),
    }])
  })

  it('honours a current-key change made by an older singleton-only build', () => {
    const original = getOrCreateOperator()
    const fallback = importOperator('b'.repeat(64))

    // Simulate an older app restoring another raw key: it knows only LS_SK and
    // cannot update LS_KEYRING. The next new-app read must adopt that selection
    // without losing either credential already saved in the keyring.
    const oldBuildSelection = 'c'.repeat(64)
    localStorage.setItem(LS_SK, oldBuildSelection)
    localStorage.removeItem(LS_MNEMONIC)

    const current = getOrCreateOperator()
    expect(current.skHex).toBe(oldBuildSelection)
    expect(getOperatorCandidates().map((operator) => operator.pubHex)).toEqual([
      pubHexFromSecret(oldBuildSelection),
      original.pubHex,
      fallback.pubHex,
    ])
  })
})
