// ForgeSworn Recovery Words v1. This byte/word layout is specified in
// nsec-tree/RECOVERY.md and pinned by matching vectors in both repositories.
//
// Seven typed header words precede a canonical BIP-39 payload. The full word
// count is therefore never valid BIP-39, while the payload can still be
// recovered by legacy tooling if the header is damaged or lost.

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import {
  deriveFromMnemonic,
  deriveFromNsec,
  useRawNsec,
  type ProvisionMode,
  type ProvisionResult,
} from './provision.js'

export const RECOVERY_WORDS_VERSION = 1 as const
export const RECOVERY_HEADER_WORDS = 7

export type RecoveryKind =
  | 'nsec-tree-mnemonic-v1'
  | 'raw-nsec-v1'
  | 'nsec-tree-nsec-v1'

export interface DecodedRecoveryWords {
  readonly version: 1
  readonly kind: RecoveryKind
  readonly passphraseRequired: boolean
  readonly fingerprint: string
  /** Secret payload. The caller owns this buffer and must zero-fill it. */
  readonly payload: Uint8Array
}

export interface ResolvedRecoveryWords {
  readonly result: ProvisionResult
  readonly mode: ProvisionMode
  readonly version: 1
  readonly fingerprint: string
}

export type RecoveryWordsInfo = Omit<DecodedRecoveryWords, 'payload'>

const MAGIC = 0x4653n
const HEADER_BITS = BigInt(RECOVERY_HEADER_WORDS * 11)
const CHECKSUM_BITS = 17n
const CHECKSUM_MASK = (1n << CHECKSUM_BITS) - 1n
const FLAG_PASSPHRASE_REQUIRED = 1
const FINGERPRINT_DOMAIN = new TextEncoder().encode('ForgeSworn recovery fingerprint v1\0')
const CHECKSUM_DOMAIN = new TextEncoder().encode('ForgeSworn recovery words v1\0')

const KIND_TO_CODE: Readonly<Record<RecoveryKind, number>> = {
  'nsec-tree-mnemonic-v1': 1,
  'raw-nsec-v1': 2,
  'nsec-tree-nsec-v1': 3,
}
const CODE_TO_KIND = new Map<number, RecoveryKind>(
  Object.entries(KIND_TO_CODE).map(([kind, code]) => [code, kind as RecoveryKind]),
)
const WORD_INDEX = new Map<string, number>(wordlist.map((word, index) => [word, index]))

function normalise(words: string): string {
  return words.trim().toLowerCase().replace(/\s+/g, ' ')
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fingerprintBytes(secret: Uint8Array): Uint8Array {
  const publicKey = schnorr.getPublicKey(secret)
  const input = new Uint8Array(FINGERPRINT_DOMAIN.length + publicKey.length)
  input.set(FINGERPRINT_DOMAIN)
  input.set(publicKey, FINGERPRINT_DOMAIN.length)
  const digest = sha256(input)
  const fingerprint = digest.slice(0, 4)
  publicKey.fill(0)
  input.fill(0)
  digest.fill(0)
  return fingerprint
}

function fingerprintNumber(bytes: Uint8Array): number {
  return (((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0)
}

function numberToFingerprint(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

function checksum(kindCode: number, flags: number, fingerprint: Uint8Array, payload: Uint8Array): number {
  const input = new Uint8Array(CHECKSUM_DOMAIN.length + 3 + fingerprint.length + payload.length)
  input.set(CHECKSUM_DOMAIN)
  let at = CHECKSUM_DOMAIN.length
  input[at++] = RECOVERY_WORDS_VERSION
  input[at++] = kindCode
  input[at++] = flags
  input.set(fingerprint, at)
  input.set(payload, at + fingerprint.length)
  const digest = sha256(input)
  const result = ((digest[0]! << 9) | (digest[1]! << 1) | (digest[2]! >>> 7)) & 0x1ffff
  input.fill(0)
  digest.fill(0)
  return result
}

function headerWords(
  kind: RecoveryKind,
  passphraseRequired: boolean,
  fingerprint: Uint8Array,
  payload: Uint8Array,
): string[] {
  const kindCode = KIND_TO_CODE[kind]
  const flags = passphraseRequired ? FLAG_PASSPHRASE_REQUIRED : 0
  let packed = MAGIC
  packed = (packed << 4n) | BigInt(RECOVERY_WORDS_VERSION)
  packed = (packed << 4n) | BigInt(kindCode)
  packed = (packed << 4n) | BigInt(flags)
  packed = (packed << 32n) | BigInt(fingerprintNumber(fingerprint))
  packed = (packed << CHECKSUM_BITS) | BigInt(checksum(kindCode, flags, fingerprint, payload))

  const words: string[] = []
  for (let shift = HEADER_BITS - 11n; shift >= 0n; shift -= 11n) {
    words.push(wordlist[Number((packed >> shift) & 0x7ffn)]!)
  }
  return words
}

function decodeHeader(words: string[]): {
  kind: RecoveryKind
  flags: number
  fingerprint: Uint8Array
  checksum: number
} {
  if (words.length !== RECOVERY_HEADER_WORDS) throw new Error('ForgeSworn recovery header is incomplete')
  let packed = 0n
  for (const word of words) {
    const index = WORD_INDEX.get(word)
    if (index === undefined) throw new Error(`Unknown recovery word: ${word}`)
    packed = (packed << 11n) | BigInt(index)
  }
  const expectedChecksum = Number(packed & CHECKSUM_MASK)
  packed >>= CHECKSUM_BITS
  const fingerprint = numberToFingerprint(Number(packed & 0xffff_ffffn))
  packed >>= 32n
  const flags = Number(packed & 0xfn)
  packed >>= 4n
  const kindCode = Number(packed & 0xfn)
  packed >>= 4n
  const version = Number(packed & 0xfn)
  packed >>= 4n

  if (packed !== MAGIC) throw new Error('Not ForgeSworn recovery words (bad magic)')
  if (version !== RECOVERY_WORDS_VERSION) throw new Error(`Unsupported ForgeSworn recovery words version: ${version}`)
  if ((flags & ~FLAG_PASSPHRASE_REQUIRED) !== 0) throw new Error('Unsupported ForgeSworn recovery flags')
  const kind = CODE_TO_KIND.get(kindCode)
  if (!kind) throw new Error(`Unsupported ForgeSworn recovery kind: ${kindCode}`)
  if (kind !== 'nsec-tree-mnemonic-v1' && flags !== 0) {
    throw new Error('Passphrase flag is only valid for mnemonic recovery')
  }
  return { kind, flags, fingerprint, checksum: expectedChecksum }
}

function validatePayload(kind: RecoveryKind, payload: Uint8Array): void {
  if (kind === 'nsec-tree-mnemonic-v1') {
    if (![16, 20, 24, 28, 32].includes(payload.length)) throw new Error('Invalid mnemonic recovery payload length')
  } else if (payload.length !== 32) {
    throw new Error('Nsec recovery payload must contain 32 bytes')
  }
}

function encode(
  kind: RecoveryKind,
  payloadWords: string,
  passphraseRequired: boolean,
  derivedSecret: Uint8Array,
): string {
  const canonical = normalise(payloadWords)
  if (!validateMnemonic(canonical, wordlist)) throw new Error('Invalid BIP-39 recovery payload')
  const payload = mnemonicToEntropy(canonical, wordlist)
  const fingerprint = fingerprintBytes(derivedSecret)
  try {
    validatePayload(kind, payload)
    return [...headerWords(kind, passphraseRequired, fingerprint, payload), ...canonical.split(' ')].join(' ')
  } finally {
    payload.fill(0)
    fingerprint.fill(0)
  }
}

export async function createMnemonicRecoveryWords(mnemonic: string, passphrase: string): Promise<string> {
  const canonical = normalise(mnemonic)
  const result = await deriveFromMnemonic(canonical, passphrase)
  try {
    return encode('nsec-tree-mnemonic-v1', canonical, passphrase.length > 0, result.secret)
  } finally {
    result.secret.fill(0)
  }
}

export function createNsecRecoveryWords(nsec: Uint8Array, derive: boolean): string {
  if (nsec.length !== 32) throw new Error('nsec must be 32 bytes')
  const sourcePublicKey = schnorr.getPublicKey(nsec)
  sourcePublicKey.fill(0)
  const payloadWords = entropyToMnemonic(nsec, wordlist)
  const result = derive ? deriveFromNsec(nsec) : useRawNsec(nsec)
  try {
    return encode(derive ? 'nsec-tree-nsec-v1' : 'raw-nsec-v1', payloadWords, false, result.secret)
  } finally {
    result.secret.fill(0)
  }
}

export function decodeRecoveryWords(words: string): DecodedRecoveryWords {
  const parts = normalise(words).split(' ').filter(Boolean)
  if (parts.length <= RECOVERY_HEADER_WORDS) {
    throw new Error('Not ForgeSworn recovery words (missing typed header or payload)')
  }
  const header = decodeHeader(parts.slice(0, RECOVERY_HEADER_WORDS))
  const payloadWords = parts.slice(RECOVERY_HEADER_WORDS).join(' ')
  if (!validateMnemonic(payloadWords, wordlist)) throw new Error('ForgeSworn recovery payload has an invalid BIP-39 checksum')
  const payload = mnemonicToEntropy(payloadWords, wordlist)
  try {
    validatePayload(header.kind, payload)
    if (checksum(KIND_TO_CODE[header.kind], header.flags, header.fingerprint, payload) !== header.checksum) {
      throw new Error('ForgeSworn recovery checksum mismatch')
    }
    return {
      version: 1,
      kind: header.kind,
      passphraseRequired: (header.flags & FLAG_PASSPHRASE_REQUIRED) !== 0,
      fingerprint: bytesToHex(header.fingerprint),
      payload,
    }
  } catch (error) {
    payload.fill(0)
    throw error
  } finally {
    header.fingerprint.fill(0)
  }
}

function matchesFingerprint(secret: Uint8Array, expected: string): boolean {
  const actual = fingerprintBytes(secret)
  const matches = bytesToHex(actual) === expected
  actual.fill(0)
  return matches
}

export async function resolveRecoveryWords(words: string, passphrase: string): Promise<ResolvedRecoveryWords> {
  const decoded = decodeRecoveryWords(words)
  if (decoded.passphraseRequired && !passphrase) {
    decoded.payload.fill(0)
    throw new Error('Recovery passphrase required')
  }
  if (!decoded.passphraseRequired && passphrase) {
    decoded.payload.fill(0)
    throw new Error('These recovery words do not use a passphrase')
  }

  let result: ProvisionResult
  let mode: ProvisionMode
  if (decoded.kind === 'nsec-tree-mnemonic-v1') {
    const mnemonic = entropyToMnemonic(decoded.payload, wordlist)
    decoded.payload.fill(0)
    result = await deriveFromMnemonic(mnemonic, passphrase)
    mode = 'tree-mnemonic'
  } else if (decoded.kind === 'nsec-tree-nsec-v1') {
    let sourcePublicKey: Uint8Array
    try {
      sourcePublicKey = schnorr.getPublicKey(decoded.payload)
    } catch (error) {
      decoded.payload.fill(0)
      throw error
    }
    sourcePublicKey.fill(0)
    result = deriveFromNsec(decoded.payload)
    decoded.payload.fill(0)
    mode = 'tree-nsec'
  } else {
    result = useRawNsec(decoded.payload)
    decoded.payload.fill(0)
    mode = 'bunker'
  }

  if (!matchesFingerprint(result.secret, decoded.fingerprint)) {
    result.secret.fill(0)
    throw new Error('Recovery fingerprint mismatch: check the words and passphrase')
  }
  return { result, mode, version: 1, fingerprint: decoded.fingerprint }
}

export function isRecoveryWords(words: string): boolean {
  try {
    const decoded = decodeRecoveryWords(words)
    decoded.payload.fill(0)
    return true
  } catch {
    return false
  }
}

/** Inspect only non-secret metadata, scrubbing the decoded payload immediately. */
export function inspectRecoveryWords(words: string): RecoveryWordsInfo | null {
  try {
    const decoded = decodeRecoveryWords(words)
    const info: RecoveryWordsInfo = {
      version: decoded.version,
      kind: decoded.kind,
      passphraseRequired: decoded.passphraseRequired,
      fingerprint: decoded.fingerprint,
    }
    decoded.payload.fill(0)
    return info
  } catch {
    return null
  }
}
