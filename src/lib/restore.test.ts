import { describe, it, expect } from 'vitest'
import { nip19 } from 'nostr-tools'
import { encrypt as nip49Encrypt } from 'nostr-tools/nip49'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  isValidNsec, isValidNcryptsec, isValidPhrase, normalisePhrase,
  decryptNcryptsec, resolveRestore, isKeyBackupCandidate, keyToWords, wordsToKey,
} from './restore.js'

// A fixed, valid secp256k1 scalar (= 1) so npub assertions are reproducible.
const SK = new Uint8Array(32)
SK[31] = 1
const NSEC = nip19.nsecEncode(SK)
const OWN_NPUB = nip19.npubEncode(bytesToHex(schnorr.getPublicKey(SK)))

// The canonical BIP-39 all-"abandon" test vector.
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('input validation', () => {
  it('recognises a valid nsec and rejects junk', () => {
    expect(isValidNsec(NSEC)).toBe(true)
    expect(isValidNsec(`  ${NSEC}  `)).toBe(true) // trims
    expect(isValidNsec('nsec1notreal')).toBe(false)
    expect(isValidNsec(OWN_NPUB)).toBe(false) // right shape, wrong prefix
    expect(isValidNsec('')).toBe(false)
  })

  it('recognises an ncryptsec by shape', () => {
    const ncryptsec = nip49Encrypt(SK, 'hunter2')
    expect(isValidNcryptsec(ncryptsec)).toBe(true)
    expect(isValidNcryptsec(`  ${ncryptsec}  `)).toBe(true)
    expect(isValidNcryptsec(NSEC)).toBe(false)
    expect(isValidNcryptsec('ncryptsec1')).toBe(false)
  })

  it('validates a BIP-39 phrase, normalising whitespace and case', () => {
    expect(isValidPhrase(PHRASE)).toBe(true)
    expect(isValidPhrase(`  ${PHRASE.toUpperCase()}\n `)).toBe(true)
    expect(normalisePhrase('  ABANDON   about ')).toBe('abandon about')
    expect(isValidPhrase('abandon about')).toBe(false) // not a full phrase
  })
})

describe('resolveRestore', () => {
  it('nsec sign-as-is keeps the key\'s own npub (bunker mode)', async () => {
    const { result, mode } = await resolveRestore({ kind: 'nsec', nsec: NSEC, derive: false })
    expect(mode).toBe('bunker')
    expect(result.npub).toBe(OWN_NPUB)
    expect(result.secret).toHaveLength(32)
  })

  it('nsec derive-new gives a different npub (tree-nsec mode)', async () => {
    const { result, mode } = await resolveRestore({ kind: 'nsec', nsec: NSEC, derive: true })
    expect(mode).toBe('tree-nsec')
    expect(result.npub).not.toBe(OWN_NPUB)
  })

  it('ncryptsec decrypts to the same key, then follows the target', async () => {
    const ncryptsec = nip49Encrypt(SK, 'hunter2')
    const asIs = await resolveRestore({ kind: 'ncryptsec', ncryptsec, password: 'hunter2', derive: false })
    expect(asIs.mode).toBe('bunker')
    expect(asIs.result.npub).toBe(OWN_NPUB)

    const derived = await resolveRestore({ kind: 'ncryptsec', ncryptsec, password: 'hunter2', derive: true })
    expect(derived.mode).toBe('tree-nsec')
    // Deriving from the decrypted nsec matches deriving from the plain nsec.
    const viaNsec = await resolveRestore({ kind: 'nsec', nsec: NSEC, derive: true })
    expect(derived.result.npub).toBe(viaNsec.result.npub)
  })

  it('rejects a wrong ncryptsec password', async () => {
    const ncryptsec = nip49Encrypt(SK, 'right')
    expect(() => decryptNcryptsec(ncryptsec, 'wrong')).toThrow()
    await expect(
      resolveRestore({ kind: 'ncryptsec', ncryptsec, password: 'wrong', derive: false }),
    ).rejects.toThrow()
  })

  it('phrase resolves to a tree-mnemonic', async () => {
    const { result, mode } = await resolveRestore({ kind: 'phrase', phrase: PHRASE, passphrase: '' })
    expect(mode).toBe('tree-mnemonic')
    expect(result.npub).toMatch(/^npub1/)
  })

  it('a passphrase changes the derived key', async () => {
    const plain = await resolveRestore({ kind: 'phrase', phrase: PHRASE, passphrase: '' })
    const salted = await resolveRestore({ kind: 'phrase', phrase: PHRASE, passphrase: 'extra' })
    expect(plain.result.npub).not.toBe(salted.result.npub)
  })
})

describe('24-word key backup', () => {
  it('writes a key out as 24 words and decodes back to the identical bytes', () => {
    const words = keyToWords(SK)
    expect(words.split(' ')).toHaveLength(24)
    const back = wordsToKey(words)
    expect(Array.from(back)).toEqual(Array.from(SK))
  })

  it('matches the frozen cross-implementation vector (heartwood-provision CLI)', () => {
    // Must match test_key_backup_words_match_frozen_vector in
    // heartwood-esp32/provision/src/main.rs, or a backup written down in the
    // browser will not restore through the offline CLI.
    expect(keyToWords(SK)).toBe(
      'abandon abandon abandon abandon abandon abandon abandon abandon '
      + 'abandon abandon abandon abandon abandon abandon abandon abandon '
      + 'abandon abandon abandon abandon abandon abandon abandon diesel',
    )
  })

  it('normalises case and whitespace when decoding', () => {
    const words = keyToWords(SK)
    const messy = `  ${words.toUpperCase().replace(/ /g, '\n ')} `
    expect(Array.from(wordsToKey(messy))).toEqual(Array.from(SK))
  })

  it('only a 32-byte key can be written as words', () => {
    expect(() => keyToWords(new Uint8Array(16))).toThrow()
  })

  it('rejects a 12-word phrase: too short to hold a full key', () => {
    expect(() => wordsToKey(PHRASE)).toThrow()
    expect(isKeyBackupCandidate(PHRASE)).toBe(false)
  })

  it('recognises a backup candidate and rejects junk', () => {
    expect(isKeyBackupCandidate(keyToWords(SK))).toBe(true)
    expect(isKeyBackupCandidate('abandon '.repeat(24).trim())).toBe(false) // bad checksum
    expect(isKeyBackupCandidate(NSEC)).toBe(false)
  })

  it('restores the same npub as the nsec it backs up (bunker mode)', async () => {
    const { result, mode } = await resolveRestore({ kind: 'key-words', phrase: keyToWords(SK), derive: false })
    expect(mode).toBe('bunker')
    expect(result.npub).toBe(OWN_NPUB)
    expect(Array.from(result.secret)).toEqual(Array.from(SK))
  })

  it('derive-new from words matches derive-new from the nsec itself', async () => {
    const viaWords = await resolveRestore({ kind: 'key-words', phrase: keyToWords(SK), derive: true })
    const viaNsec = await resolveRestore({ kind: 'nsec', nsec: NSEC, derive: true })
    expect(viaWords.mode).toBe('tree-nsec')
    expect(viaWords.result.npub).toBe(viaNsec.result.npub)
  })
})
