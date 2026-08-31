import { describe, expect, it } from 'vitest'
import { entropyToMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import {
  createMnemonicRecoveryWords,
  createNsecRecoveryWords,
  decodeRecoveryWords,
  resolveRecoveryWords,
} from './recovery-words.js'
import { deriveFromMnemonic, deriveFromNsec } from './provision.js'

const ZERO_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const MNEMONIC_VECTOR = 'edge obtain doll auto level leave morning abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SCALAR_ONE = new Uint8Array(32)
SCALAR_ONE[31] = 1
const SCALAR_ONE_PAYLOAD = `${'abandon '.repeat(23)}diesel`
const RAW_NSEC_VECTOR = `edge obtain lizard frost kitten own grit ${SCALAR_ONE_PAYLOAD}`
const TREE_NSEC_VECTOR = `edge obtain seed afford today police pyramid ${SCALAR_ONE_PAYLOAD}`

describe('ForgeSworn recovery words interop', () => {
  it('matches the nsec-tree frozen vectors', async () => {
    await expect(createMnemonicRecoveryWords(ZERO_MNEMONIC, '')).resolves.toBe(MNEMONIC_VECTOR)
    expect(createNsecRecoveryWords(SCALAR_ONE, false)).toBe(RAW_NSEC_VECTOR)
    expect(createNsecRecoveryWords(SCALAR_ONE, true)).toBe(TREE_NSEC_VECTOR)
  })

  it('is typed and cannot validate as a bare BIP-39 phrase', async () => {
    const words = await createMnemonicRecoveryWords(ZERO_MNEMONIC, '')
    expect(words.split(' ')).toHaveLength(19)
    expect(validateMnemonic(words, wordlist)).toBe(false)
    const decoded = decodeRecoveryWords(words)
    expect(decoded.kind).toBe('nsec-tree-mnemonic-v1')
    expect(decoded.fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(decoded.payload).toEqual(new Uint8Array(16))
    decoded.payload.fill(0)
  })

  it('restores a mnemonic root and verifies its fingerprint', async () => {
    const expected = await deriveFromMnemonic(ZERO_MNEMONIC, '')
    const recovered = await resolveRecoveryWords(await createMnemonicRecoveryWords(ZERO_MNEMONIC, ''), '')
    expect(recovered.mode).toBe('tree-mnemonic')
    expect(recovered.result.npub).toBe(expected.npub)
    recovered.result.secret.fill(0)
    expected.secret.fill(0)
  })

  it('detects a missing or wrong mnemonic passphrase', async () => {
    const words = await createMnemonicRecoveryWords(ZERO_MNEMONIC, 'correct horse')
    await expect(resolveRecoveryWords(words, '')).rejects.toThrow(/passphrase required/i)
    await expect(resolveRecoveryWords(words, 'wrong')).rejects.toThrow(/fingerprint/i)
    const recovered = await resolveRecoveryWords(words, 'correct horse')
    recovered.result.secret.fill(0)
  })

  it('restores exact-key and tree-nsec meanings without asking the user to remember which', async () => {
    const exact = await resolveRecoveryWords(createNsecRecoveryWords(SCALAR_ONE, false), '')
    expect(exact.mode).toBe('bunker')
    expect(exact.result.secret).toEqual(SCALAR_ONE)
    exact.result.secret.fill(0)

    const expectedTree = deriveFromNsec(SCALAR_ONE)
    const tree = await resolveRecoveryWords(createNsecRecoveryWords(SCALAR_ONE, true), '')
    expect(tree.mode).toBe('tree-nsec')
    expect(tree.result.npub).toBe(expectedTree.npub)
    tree.result.secret.fill(0)
    expectedTree.secret.fill(0)
  })

  it('rejects legacy and corrupted words instead of guessing', async () => {
    expect(() => decodeRecoveryWords(ZERO_MNEMONIC)).toThrow(/ForgeSworn recovery words/i)
    const words = (await createMnemonicRecoveryWords(ZERO_MNEMONIC, '')).split(' ')
    words[4] = words[4] === 'abandon' ? 'ability' : 'abandon'
    expect(() => decodeRecoveryWords(words.join(' '))).toThrow()
  })

  it('roundtrips every supported mnemonic payload strength', async () => {
    for (const [entropyBytes, expectedWords] of [[16, 19], [20, 22], [24, 25], [28, 28], [32, 31]] as const) {
      const entropy = Uint8Array.from({ length: entropyBytes }, (_, index) => (entropyBytes + index) & 0xff)
      const mnemonic = entropyToMnemonic(entropy, wordlist)
      const expected = await deriveFromMnemonic(mnemonic, '')
      const words = await createMnemonicRecoveryWords(mnemonic, '')
      const recovered = await resolveRecoveryWords(words, '')

      expect(words.split(' ')).toHaveLength(expectedWords)
      expect(recovered.result.npub).toBe(expected.npub)
      recovered.result.secret.fill(0)
      expected.secret.fill(0)
      entropy.fill(0)
    }
  })

  it('rejects an invalid nsec scalar for both exact and tree recovery kinds', () => {
    expect(() => createNsecRecoveryWords(new Uint8Array(32), false)).toThrow()
    expect(() => createNsecRecoveryWords(new Uint8Array(32), true)).toThrow()
  })
})
