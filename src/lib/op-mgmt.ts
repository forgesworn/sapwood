// Operator key (op_mgmt) for relay-mediated management (kind 24134).
//
// Generated in the browser at flash time and baked into the device's config
// blob (NetConfig.op_mgmt = the operator x-only pubkey hex). The device then
// accepts management commands (create_client, list_clients, get_status, …) over
// relays ONLY when they are signed by this key — see heartwood-esp32
// src/relay.rs `handle_mgmt_event`. The operator holds the matching secret and
// loads it into bray (`NOSTR_SECRET_KEY=<skHex>`).
//
// ## The key is a 12-word recovery phrase
//
// The operator authority is the one credential that lets you manage a shelf
// device remotely, so — like the device's master seed — it is backed by a
// BIP-39 recovery phrase. Write the phrase down and you can restore the exact
// same operator key in any browser; lose the browser and the phrase brings it
// back. The secret key is derived deterministically from the phrase
// (NIP-06 path `m/44'/1237'/0'/0/0`), so the phrase and the key are two views
// of the same authority.
//
// This is NOT the device master seed — it is a separate, lower-stakes authority
// key; the master seed never touches the browser or a relay, and uses a
// different derivation path (`m/44'/1237'/727'/0'/0'`), so the two never collide.
//
// Backwards compatibility: operators created before the phrase existed are a
// raw 32-byte secret with no phrase. Those keep working unchanged (so a device
// already flashed with one is still manageable); they simply have no phrase to
// write down until you rotate to a phrase-backed key (`regenerateOperator()`),
// which mints a new key and needs a re-flash. If both old and new records are
// present, the legacy secret wins: preserving access to already-flashed signers
// matters more than surfacing a newer phrase that was never baked into them.

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  generateMnemonic as bip39GenerateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'

/** localStorage key for a phrase-backed operator (the recovery phrase). */
const LS_MNEMONIC = 'heartwood.opMgmt.mnemonic'
/** localStorage key for a legacy raw-hex operator secret (pre-phrase). */
const LS_SK = 'heartwood.opMgmt.skHex'

/** BIP-32 derivation path for the operator key — NIP-06 default external chain.
 *  Distinct from the device master path (`…/727'/0'/0'`) so they never collide. */
const OP_MGMT_PATH = "m/44'/1237'/0'/0/0"

export interface Operator {
  /** Operator secret (hex). Load into bray: NOSTR_SECRET_KEY=<skHex>. */
  skHex: string
  /** Operator x-only pubkey (hex). Baked into the device config (op_mgmt). */
  pubHex: string
  /** The 12/24-word recovery phrase, when this key is phrase-backed.
   *  Absent for a legacy raw-hex key (nothing to write down). */
  mnemonic?: string
}

function pubFromSk(skHex: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(skHex)))
}

function operatorFromSk(skHex: string): Operator {
  return { skHex, pubHex: pubFromSk(skHex) }
}

/** Derive the operator key from a recovery phrase (deterministic, synchronous). */
function operatorFromMnemonic(mnemonic: string): Operator {
  const seed = mnemonicToSeedSync(mnemonic) // no passphrase
  const child = HDKey.fromMasterSeed(seed).derive(OP_MGMT_PATH)
  if (!child.privateKey) throw new Error('operator key derivation failed')
  const skHex = bytesToHex(child.privateKey)
  return { skHex, pubHex: pubFromSk(skHex), mnemonic }
}

function storedOperators(): Operator[] {
  const out: Operator[] = []
  const legacy = localStorage.getItem(LS_SK) ?? ''
  if (/^[0-9a-f]{64}$/.test(legacy)) {
    out.push(operatorFromSk(legacy))
  }
  const mnemonic = localStorage.getItem(LS_MNEMONIC) ?? ''
  if (mnemonic && validateMnemonic(mnemonic, wordlist)) {
    out.push(operatorFromMnemonic(mnemonic))
  }

  const seen = new Set<string>()
  return out.filter((op) => {
    if (seen.has(op.pubHex)) return false
    seen.add(op.pubHex)
    return true
  })
}

/** Generate a fresh operator recovery phrase. 128 bits → 12 words, 256 → 24. */
export function generateOperatorMnemonic(strength: 128 | 256 = 128): string {
  return bip39GenerateMnemonic(wordlist, strength)
}

/**
 * Return the persisted operator key, creating + persisting a phrase-backed one
 * if none exists. Synchronous so existing call sites need no change.
 *
 * Precedence: a legacy raw-hex secret is honoured unchanged; otherwise a stored
 * recovery phrase wins; otherwise a new phrase-backed key is minted.
 */
export function getOrCreateOperator(): Operator {
  const stored = storedOperators()
  if (stored.length > 0) return stored[0]!
  const fresh = generateOperatorMnemonic()
  localStorage.setItem(LS_MNEMONIC, fresh)
  localStorage.removeItem(LS_SK)
  return operatorFromMnemonic(fresh)
}

/** Saved operator keys worth trying for relay management. Browsers that lived
 *  through the raw-key -> recovery-phrase migration can have both records, and
 *  different signers may have been flashed with different ones. Do not guess:
 *  relay connect can try all stored candidates and keep the one the signer
 *  actually answers. If nothing exists yet, mint the normal single operator. */
export function getOperatorCandidates(): Operator[] {
  const stored = storedOperators()
  return stored.length > 0 ? stored : [getOrCreateOperator()]
}

/** The recovery phrase backing the current operator, or `null` for a legacy
 *  raw-hex key (which has no phrase to write down). */
export function getOperatorMnemonic(): string | null {
  const legacy = localStorage.getItem(LS_SK) ?? ''
  if (/^[0-9a-f]{64}$/.test(legacy)) return null
  const mnemonic = localStorage.getItem(LS_MNEMONIC) ?? ''
  return mnemonic && validateMnemonic(mnemonic, wordlist) ? mnemonic : null
}

/** The current operator's x-only pubkey (hex), or `null` if none is stored.
 *  Read-only: unlike `getOrCreateOperator` it never mints a key — used to
 *  detect whether an incoming import would overwrite an existing operator. */
export function peekOperatorPubHex(): string | null {
  return storedOperators()[0]?.pubHex ?? null
}

/** The x-only pubkey (hex) for a raw operator secret, or `null` if malformed.
 *  Lets a caller preview which key a handoff link carries without importing it. */
export function pubHexFromSecret(skHex: string): string | null {
  const clean = skHex.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(clean)) return null
  try {
    return pubFromSk(clean)
  } catch {
    return null
  }
}

/** Replace the operator with a fresh phrase-backed key and return it.
 *  The old key is lost — devices flashed with it need re-flashing. */
export function regenerateOperator(): Operator {
  const fresh = generateOperatorMnemonic()
  localStorage.setItem(LS_MNEMONIC, fresh)
  localStorage.removeItem(LS_SK)
  return operatorFromMnemonic(fresh)
}

/**
 * Restore an operator from a recovery phrase (e.g. on a new browser, or to
 * match a device flashed elsewhere). Validates the phrase, persists it, and
 * derives the key. This is the phrase-backed counterpart to {@link importOperator}.
 */
export function importOperatorMnemonic(mnemonic: string): Operator {
  const clean = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!validateMnemonic(clean, wordlist)) {
    throw new Error('invalid recovery phrase: check the words and their order')
  }
  const op = operatorFromMnemonic(clean)
  localStorage.setItem(LS_MNEMONIC, clean)
  localStorage.removeItem(LS_SK)
  return op
}

/**
 * Persist a specific operator secret (raw-hex import), e.g. from the phone
 * handoff link or to match a device flashed from another browser. The resulting
 * key is NOT phrase-backed (a raw secret can't be expressed as a phrase), so the
 * stored phrase is cleared. Prefer {@link importOperatorMnemonic} when you have
 * the words. Validates 64-hex.
 */
export function importOperator(skHex: string): Operator {
  const clean = skHex.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('operator secret must be 64 hex characters (32 bytes)')
  }
  const op = operatorFromSk(clean) // throws if the secret can't derive a pubkey
  localStorage.setItem(LS_SK, clean)
  localStorage.removeItem(LS_MNEMONIC)
  return op
}

/** localStorage key prefix recording that a given operator key was backed up. */
const LS_BACKUP_PREFIX = 'heartwood.opBackup.'

/**
 * Whether the CURRENT operator key has been backed up (the user confirmed they
 * wrote the phrase/secret down). Keyed by pubkey, so regenerating or importing
 * a different key asks again.
 */
export function isOperatorBackedUp(): boolean {
  try {
    return localStorage.getItem(LS_BACKUP_PREFIX + getOrCreateOperator().pubHex) === '1'
  } catch {
    return false
  }
}

/** Record that the current operator key has been backed up. */
export function markOperatorBackedUp(): void {
  try {
    localStorage.setItem(LS_BACKUP_PREFIX + getOrCreateOperator().pubHex, '1')
  } catch { /* storage unavailable — the card simply shows again */ }
}
