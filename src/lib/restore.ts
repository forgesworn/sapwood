// Restore an existing key onto the signer, from the guided Home flow. Four
// input kinds, each resolved to the exact same (secret, npub, mode) triple that
// Advanced > Provision sends over USB via buildProvisionFrame:
//
//   phrase     -> a 12/24-word BIP-39 recovery phrase pasted here (tree-mnemonic)
//   nsec       -> a bech32 nsec1... (bunker: sign as-is, or tree-nsec: derive new)
//   ncryptsec  -> a NIP-49 password-encrypted key, decrypted here to an nsec first
//   key words  -> a 24-word key backup made here at import: the words ARE the
//                 key's 32 bytes (BIP-39 entropy encoding), not a seed to derive
//                 from, so decoding them restores the identical npub
//
// The crypto lives in provision.ts (derivation) and nostr-tools/nip49 (NIP-49
// decrypt); this module only validates the newcomer's input and wires it to the
// right provision mode. Pure and unit-testable: no device, no serial. Mirrors
// signet-lite's engine/nsec.ts so the two repos stay recognisably the same.
//
// Every path here takes a secret the owner types into the browser, unlike the
// device-generate and on-device phrase-entry paths, whose secret never leaves
// the chip. The UI carries that distinction; this module just does the maths.

import { decrypt as nip49Decrypt } from 'nostr-tools/nip49'
import { validateMnemonic, entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import {
  deriveFromMnemonic, deriveFromNsec, useRawNsec, decodeNsec,
  type ProvisionMode, type ProvisionResult,
} from './provision.js'

/** Whether the input is a valid bech32 nsec (checksum included). */
export function isValidNsec(input: string): boolean {
  try {
    decodeNsec(input)
    return true
  } catch {
    return false
  }
}

// NIP-49 ncryptsec: HRP + bech32 charset (no 1/b/i/o). A cheap gate for the UI;
// the real check is whether it decrypts, which needs the password.
const NCRYPTSEC_RE = /^ncryptsec1[02-9ac-hj-np-z]+$/

/** True for a NIP-49 password-encrypted key string (shape only, not the password). */
export function isValidNcryptsec(input: string): boolean {
  return NCRYPTSEC_RE.test(input.trim())
}

/** Collapse whitespace and lower-case a pasted phrase so BIP-39 validation and
 *  derivation see the canonical form. The passphrase (25th word) is separate and
 *  case-sensitive, so it is never run through this. */
export function normalisePhrase(phrase: string): string {
  return phrase.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Whether the input is a valid 12/24-word BIP-39 phrase. */
export function isValidPhrase(phrase: string): boolean {
  return validateMnemonic(normalisePhrase(phrase), wordlist)
}

/** Whether the input could be a 24-word key backup: a valid BIP-39 phrase whose
 *  24 words carry exactly the 256 bits of a key. A 12-word phrase carries only
 *  128 bits, so it can never spell out an existing key. */
export function isKeyBackupCandidate(phrase: string): boolean {
  const p = normalisePhrase(phrase)
  return p.split(' ').length === 24 && validateMnemonic(p, wordlist)
}

/** Write a 32-byte key out as 24 BIP-39 words. The words are the key's own
 *  bytes used as entropy, not a seed to derive from: wordsToKey gives back the
 *  identical bytes, so the identical npub. */
export function keyToWords(secret: Uint8Array): string {
  if (secret.length !== 32) throw new Error('key must be 32 bytes')
  return entropyToMnemonic(secret, wordlist)
}

/** Decode a 24-word key backup back to its 32 key bytes. Throws on a bad
 *  checksum or a 12-word phrase (too short to hold a full key). The caller
 *  must zeroize the returned bytes after use. */
export function wordsToKey(phrase: string): Uint8Array {
  const entropy = mnemonicToEntropy(normalisePhrase(phrase), wordlist)
  if (entropy.length !== 32) {
    entropy.fill(0)
    throw new Error('Only a 24-word backup holds a full key')
  }
  return entropy
}

/** Decrypt a NIP-49 ncryptsec to its 32 secret bytes. Throws on a wrong password
 *  or malformed input. The caller must zeroize the returned bytes after use. */
export function decryptNcryptsec(ncryptsec: string, password: string): Uint8Array {
  return nip49Decrypt(ncryptsec.trim(), password)
}

/** A restore the owner has described but not yet sent. `derive` picks between
 *  keeping the key's own npub (bunker) and deriving a fresh tree root (tree-nsec);
 *  it is ignored for a phrase, which is always a tree. */
export type RestoreSource =
  | { kind: 'phrase'; phrase: string; passphrase: string }
  | { kind: 'nsec'; nsec: string; derive: boolean }
  | { kind: 'ncryptsec'; ncryptsec: string; password: string; derive: boolean }
  | { kind: 'key-words'; phrase: string; derive: boolean }

export interface ResolvedRestore {
  /** 32-byte root secret, ready for buildProvisionFrame. Zeroize after sending. */
  result: ProvisionResult
  /** The provision mode that matches this secret. */
  mode: ProvisionMode
}

/** How an nsec's raw bytes become a (result, mode) pair: sign as-is, or derive. */
function fromNsecBytes(bytes: Uint8Array, derive: boolean): ResolvedRestore {
  // deriveFromNsec / useRawNsec each copy the bytes into the result, so the
  // caller's input can be wiped straight after.
  return derive
    ? { result: deriveFromNsec(bytes), mode: 'tree-nsec' }
    : { result: useRawNsec(bytes), mode: 'bunker' }
}

/** Resolve a restore source to the secret, its npub (for the confirm step) and
 *  the provision mode. This is the "derive and preview" step; the caller holds
 *  result.secret, shows result.npub for confirmation, sends the frame, then
 *  zeroizes. Throws on invalid input (bad nsec, wrong ncryptsec password, bad
 *  phrase) so the UI can surface a specific message. */
export async function resolveRestore(src: RestoreSource): Promise<ResolvedRestore> {
  switch (src.kind) {
    case 'phrase':
      return { result: await deriveFromMnemonic(normalisePhrase(src.phrase), src.passphrase), mode: 'tree-mnemonic' }
    case 'nsec': {
      const bytes = decodeNsec(src.nsec)
      try {
        return fromNsecBytes(bytes, src.derive)
      } finally {
        bytes.fill(0)
      }
    }
    case 'ncryptsec': {
      const bytes = decryptNcryptsec(src.ncryptsec, src.password)
      try {
        return fromNsecBytes(bytes, src.derive)
      } finally {
        bytes.fill(0)
      }
    }
    case 'key-words': {
      const bytes = wordsToKey(src.phrase)
      try {
        return fromNsecBytes(bytes, src.derive)
      } finally {
        bytes.fill(0)
      }
    }
  }
}
