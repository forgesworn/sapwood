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
} from './op-mgmt.js'

const LS_MNEMONIC = 'heartwood.opMgmt.mnemonic'
const LS_SK = 'heartwood.opMgmt.skHex'

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

  it('preserves a legacy raw-hex secret when a phrase is also present', () => {
    const phrase = generateOperatorMnemonic()
    localStorage.setItem(LS_MNEMONIC, phrase)
    localStorage.setItem(LS_SK, 'b'.repeat(64))
    const op = getOrCreateOperator()
    expect(op.skHex).toBe('b'.repeat(64))
    expect(op.mnemonic).toBeUndefined()
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

  it('returns null when a legacy raw-hex key masks a phrase', () => {
    localStorage.setItem(LS_MNEMONIC, generateOperatorMnemonic())
    localStorage.setItem(LS_SK, 'c'.repeat(64))
    expect(getOperatorMnemonic()).toBeNull()
  })
})

describe('peekOperatorPubHex', () => {
  it('previews the same legacy key getOrCreateOperator will use', () => {
    localStorage.setItem(LS_MNEMONIC, generateOperatorMnemonic())
    localStorage.setItem(LS_SK, 'b'.repeat(64))
    expect(peekOperatorPubHex()).toBe(getOrCreateOperator().pubHex)
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

  it('clears any legacy raw-hex secret', () => {
    localStorage.setItem(LS_SK, 'd'.repeat(64))
    importOperatorMnemonic(generateOperatorMnemonic())
    expect(localStorage.getItem(LS_SK)).toBeNull()
  })
})

describe('regenerateOperator', () => {
  it('mints a new phrase-backed key, replacing the old one', () => {
    const before = getOrCreateOperator()
    const after = regenerateOperator()
    expect(after.skHex).not.toBe(before.skHex)
    expect(after.mnemonic).toBeDefined()
    expect(after.mnemonic).not.toBe(before.mnemonic)
    expect(localStorage.getItem(LS_SK)).toBeNull()
  })
})

describe('importOperator (raw hex)', () => {
  it('persists a raw secret and clears the phrase (not phrase-backed)', () => {
    getOrCreateOperator() // seed a phrase first
    const sk = 'e'.repeat(64)
    const op = importOperator(sk)
    expect(op.skHex).toBe(sk)
    expect(op.mnemonic).toBeUndefined()
    expect(localStorage.getItem(LS_MNEMONIC)).toBeNull()
    expect(getOperatorMnemonic()).toBeNull()
  })

  it('rejects a non-64-hex secret', () => {
    expect(() => importOperator('xyz')).toThrow()
  })
})
