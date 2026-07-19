// Operator-key derivation: the pure maths behind the management (op_mgmt) key,
// shared by the browser keyring (op-mgmt.ts) and the CLI (sapwood operator).
//
// The operator key authorises relay-mediated management (kind 24134); it is NOT
// the device master seed and never signs the owner's events. It is a BIP-39
// recovery phrase deterministically derived at NIP-06 path m/44'/1237'/0'/0/0,
// so the same phrase recreates the exact same operator key anywhere — a browser,
// or a headless host that loads the secret into the bridge daemon
// (NOSTR_SECRET_KEY=<skHex>). The master seed uses a different path
// (m/44'/1237'/727'/0'/0'), so the two authorities never collide.
//
// This module holds no state and touches no storage or browser API, so it runs
// unchanged under Node. Persistence, the keyring and migration live in
// op-mgmt.ts; that is the only place localStorage is involved.

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { generateMnemonic as bip39GenerateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'

/** BIP-32 derivation path for the operator key — NIP-06 default external chain.
 *  Distinct from the device master path (`…/727'/0'/0'`) so they never collide. */
export const OP_MGMT_PATH = "m/44'/1237'/0'/0/0"

/** A derived operator key: its secret and x-only pubkey, and the phrase it came
 *  from when it was derived from one. Both hex fields are 64 characters. */
export interface DerivedOperator {
  skHex: string
  pubHex: string
  mnemonic?: string
}

/** The x-only (schnorr) public key hex for an operator secret. */
export function pubFromSk(skHex: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(skHex)))
}

/** Build an operator from a raw 32-byte secret (hex). Throws if it is not a
 *  usable secret key (zero or out-of-range scalars fail here). */
export function operatorFromSk(skHex: string): DerivedOperator {
  return { skHex, pubHex: pubFromSk(skHex) }
}

/** Derive the operator key from a recovery phrase (deterministic, no passphrase). */
export function operatorFromMnemonic(mnemonic: string): DerivedOperator {
  const seed = mnemonicToSeedSync(mnemonic)
  const child = HDKey.fromMasterSeed(seed).derive(OP_MGMT_PATH)
  if (!child.privateKey) throw new Error('operator key derivation failed')
  const skHex = bytesToHex(child.privateKey)
  return { skHex, pubHex: pubFromSk(skHex), mnemonic }
}

/** Generate a fresh operator recovery phrase. 128 bits → 12 words, 256 → 24. */
export function generateOperatorMnemonic(strength: 128 | 256 = 128): string {
  return bip39GenerateMnemonic(wordlist, strength)
}

/** Collapse whitespace and lower-case a phrase to its canonical BIP-39 form. */
export function normaliseMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Whether the input is a valid BIP-39 phrase once normalised. */
export function isValidOperatorMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normaliseMnemonic(mnemonic), wordlist)
}
