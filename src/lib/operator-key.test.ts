// The pure operator-key derivation, shared by the browser keyring and the CLI.
// A pinned vector guards the derivation path: if it ever changes, a recovered
// key would no longer match the one a signer was flashed with.

import { describe, expect, it } from 'vitest'
import {
  OP_MGMT_PATH,
  generateOperatorMnemonic,
  isValidOperatorMnemonic,
  normaliseMnemonic,
  operatorFromMnemonic,
  operatorFromSk,
  pubFromSk,
} from './operator-key.js'

// The canonical all-zero-entropy BIP-39 phrase, pinned to its operator key.
const CANONICAL = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const CANONICAL_SK = '5f29af3b9676180290e77a4efad265c4c2ff28a5302461f73597fda26bb25731'
const CANONICAL_PUB = 'e8bcf3823669444d0b49ad45d65088635d9fd8500a75b5f20b59abefa56a144f'

describe('OP_MGMT_PATH', () => {
  it('is the NIP-06 external chain, distinct from the master path', () => {
    expect(OP_MGMT_PATH).toBe("m/44'/1237'/0'/0/0")
    expect(OP_MGMT_PATH).not.toBe("m/44'/1237'/727'/0'/0'")
  })
})

describe('operatorFromMnemonic', () => {
  it('derives the pinned key from the canonical phrase', () => {
    const op = operatorFromMnemonic(CANONICAL)
    expect(op.skHex).toBe(CANONICAL_SK)
    expect(op.pubHex).toBe(CANONICAL_PUB)
    expect(op.mnemonic).toBe(CANONICAL)
  })

  it('is deterministic: same phrase, same key', () => {
    expect(operatorFromMnemonic(CANONICAL).pubHex).toBe(operatorFromMnemonic(CANONICAL).pubHex)
  })
})

describe('operatorFromSk / pubFromSk', () => {
  it('recovers the pinned pubkey from its secret', () => {
    expect(pubFromSk(CANONICAL_SK)).toBe(CANONICAL_PUB)
    expect(operatorFromSk(CANONICAL_SK)).toEqual({ skHex: CANONICAL_SK, pubHex: CANONICAL_PUB })
  })
})

describe('generateOperatorMnemonic', () => {
  it('produces a valid 12-word phrase by default', () => {
    const phrase = generateOperatorMnemonic()
    expect(phrase.split(' ')).toHaveLength(12)
    expect(isValidOperatorMnemonic(phrase)).toBe(true)
  })

  it('produces 24 words at 256 bits', () => {
    expect(generateOperatorMnemonic(256).split(' ')).toHaveLength(24)
  })
})

describe('isValidOperatorMnemonic / normaliseMnemonic', () => {
  it('accepts a phrase regardless of case and spacing', () => {
    expect(isValidOperatorMnemonic(`  ABANDON   abandon\tabandon abandon abandon abandon abandon abandon abandon abandon abandon about `)).toBe(true)
  })

  it('rejects an invalid phrase', () => {
    expect(isValidOperatorMnemonic('not a real recovery phrase at all here today')).toBe(false)
  })

  it('normalises whitespace and case to the canonical form', () => {
    expect(normaliseMnemonic('  Foo   BAR\tBaz ')).toBe('foo bar baz')
  })
})
