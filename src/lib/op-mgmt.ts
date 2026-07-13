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
// write down. Legacy singleton records are migrated into a pubkey-keyed keyring.
// Importing, restoring or regenerating changes the CURRENT operator but retains
// every previous credential, because different shelf devices may still trust
// those keys. Relay connect tries every stored key (`getOperatorCandidates`),
// while new flashes, Network saves, the backup nudge and the operator display
// use the current key. A phone handoff uses the exact candidate proven by that
// live relay connection.

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
/** Versioned pubkey-keyed operator credential keyring. */
const LS_KEYRING = 'heartwood.opMgmt.keyring.v1'

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

interface StoredOperatorCredential {
  skHex: string
  mnemonic?: string
}

interface OperatorKeyring {
  version: 1
  /** The operator used by singleton APIs and for new device configuration. */
  currentPubHex: string | null
  /** Credentials are keyed by their derived x-only public key. */
  credentials: Record<string, StoredOperatorCredential>
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

function emptyKeyring(): OperatorKeyring {
  return { version: 1, currentPubHex: null, credentials: Object.create(null) }
}

function normaliseMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')
}

function validRawOperator(value: unknown): Operator | null {
  if (typeof value !== 'string') return null
  const clean = value.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(clean)) return null
  try {
    return operatorFromSk(clean)
  } catch {
    // Zero and out-of-range scalars are 64-hex but are not secret keys.
    return null
  }
}

function validMnemonicOperator(value: unknown): Operator | null {
  if (typeof value !== 'string') return null
  const clean = normaliseMnemonic(value)
  if (!validateMnemonic(clean, wordlist)) return null
  try {
    return operatorFromMnemonic(clean)
  } catch {
    return null
  }
}

/** Parse only self-consistent credentials. The map key, secret and optional
 * mnemonic must all derive the same public key; corrupt entries fail closed. */
function readPersistedKeyring(): OperatorKeyring {
  const keyring = emptyKeyring()
  let parsed: unknown
  try {
    const stored = localStorage.getItem(LS_KEYRING)
    if (!stored) return keyring
    parsed = JSON.parse(stored)
  } catch {
    return keyring
  }

  if (!parsed || typeof parsed !== 'object') return keyring
  const record = parsed as Record<string, unknown>
  if (record.version !== 1 || !record.credentials || typeof record.credentials !== 'object') {
    return keyring
  }

  for (const [claimedPubHex, value] of Object.entries(record.credentials as Record<string, unknown>)) {
    const pubHex = claimedPubHex.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pubHex) || !value || typeof value !== 'object') continue
    const credential = value as Record<string, unknown>
    const raw = validRawOperator(credential.skHex)
    if (!raw || raw.pubHex !== pubHex) continue

    if (credential.mnemonic !== undefined) {
      const phrase = validMnemonicOperator(credential.mnemonic)
      if (!phrase || phrase.pubHex !== pubHex || phrase.skHex !== raw.skHex) continue
      keyring.credentials[pubHex] = { skHex: raw.skHex, mnemonic: phrase.mnemonic }
    } else {
      keyring.credentials[pubHex] = { skHex: raw.skHex }
    }
  }

  if (typeof record.currentPubHex === 'string') {
    const current = record.currentPubHex.trim().toLowerCase()
    if (keyring.credentials[current]) keyring.currentPubHex = current
  }
  return keyring
}

/** Read the two pre-keyring singleton slots. Phrase remains first to preserve
 * their historical primary-key precedence when both exist. */
function readLegacyOperators(): Operator[] {
  const operators: Operator[] = []
  const phrase = validMnemonicOperator(localStorage.getItem(LS_MNEMONIC))
  if (phrase) operators.push(phrase)
  const raw = validRawOperator(localStorage.getItem(LS_SK))
  if (raw && !operators.some((operator) => operator.pubHex === raw.pubHex)) operators.push(raw)
  return operators
}

/** Merge legacy singleton records on every read. This keeps direct old-format
 * imports usable even before startup migration runs and makes migration safe to
 * retry. A phrase enriches, rather than downgrades, a raw record for the same key. */
function loadKeyring(): OperatorKeyring {
  const keyring = readPersistedKeyring()
  const legacy = readLegacyOperators()
  for (const operator of legacy) {
    const existing = keyring.credentials[operator.pubHex]
    if (!existing || (!existing.mnemonic && operator.mnemonic)) {
      keyring.credentials[operator.pubHex] = {
        skHex: operator.skHex,
        ...(operator.mnemonic ? { mnemonic: operator.mnemonic } : {}),
      }
    }
  }

  // The singleton slots mirror the keyring current key. If an older Sapwood
  // build later imports a different key, that mirror changes while the keyring
  // cannot; honour the old build's explicit selection on the next load.
  if (keyring.currentPubHex && legacy.length > 0
      && !legacy.some((operator) => operator.pubHex === keyring.currentPubHex)) {
    keyring.currentPubHex = legacy[0]!.pubHex
  } else if (!keyring.currentPubHex) {
    // On first migration retain the historical phrase-first/raw-second order;
    // otherwise fall back to the first validated keyring credential.
    keyring.currentPubHex = legacy[0]?.pubHex ?? Object.keys(keyring.credentials)[0] ?? null
  }
  return keyring
}

function operatorFromCredential(pubHex: string, credential: StoredOperatorCredential): Operator {
  return {
    skHex: credential.skHex,
    pubHex,
    ...(credential.mnemonic ? { mnemonic: credential.mnemonic } : {}),
  }
}

function operatorsFromKeyring(keyring: OperatorKeyring): Operator[] {
  const pubkeys = Object.keys(keyring.credentials)
  if (keyring.currentPubHex) {
    const currentIndex = pubkeys.indexOf(keyring.currentPubHex)
    if (currentIndex > 0) {
      pubkeys.splice(currentIndex, 1)
      pubkeys.unshift(keyring.currentPubHex)
    }
  }
  return pubkeys.map((pubHex) => operatorFromCredential(pubHex, keyring.credentials[pubHex]!))
}

function persistKeyring(keyring: OperatorKeyring): void {
  localStorage.setItem(LS_KEYRING, JSON.stringify(keyring))
}

/** Retain old-version compatibility by mirroring only the current credential
 * into the singleton slots. All non-current credentials remain in the keyring. */
function mirrorCurrentOperator(operator: Operator): void {
  if (operator.mnemonic) {
    localStorage.setItem(LS_MNEMONIC, operator.mnemonic)
    localStorage.removeItem(LS_SK)
  } else {
    localStorage.setItem(LS_SK, operator.skHex)
    localStorage.removeItem(LS_MNEMONIC)
  }
}

function storeCurrentOperator(operator: Operator): Operator {
  const keyring = loadKeyring()
  const existing = keyring.credentials[operator.pubHex]
  // Never discard a known recovery phrase merely because the same credential
  // was later imported in raw-secret form.
  const stored: StoredOperatorCredential = existing?.mnemonic && !operator.mnemonic
    ? existing
    : {
        skHex: operator.skHex,
        ...(operator.mnemonic ? { mnemonic: operator.mnemonic } : {}),
      }
  keyring.credentials[operator.pubHex] = stored
  keyring.currentPubHex = operator.pubHex
  persistKeyring(keyring)
  const current = operatorFromCredential(operator.pubHex, stored)
  mirrorCurrentOperator(current)
  return current
}

/**
 * One-off storage hygiene, run once at startup. A legacy raw-hex operator record
 * (`LS_SK`) that cannot be read as a 64-hex secret can never be used — every
 * reader gates on `/^[0-9a-f]{64}$/` — yet it lingers looking like a usable
 * fallback key and muddies operator diagnostics. Drop such junk so the phrase
 * key is unambiguously the operator. A salvageable value (valid once trimmed and
 * lower-cased) is left untouched; only genuinely malformed records are removed.
 */
export function migrateOperatorStorage(): void {
  try {
    const legacy = localStorage.getItem(LS_SK)
    if (legacy !== null && !validRawOperator(legacy)) {
      localStorage.removeItem(LS_SK)
    }
    const keyring = loadKeyring()
    if (Object.keys(keyring.credentials).length > 0) persistKeyring(keyring)
  } catch { /* storage unavailable — nothing to migrate */ }
}

function storedOperators(): Operator[] {
  return operatorsFromKeyring(loadKeyring())
}

/** Generate a fresh operator recovery phrase. 128 bits → 12 words, 256 → 24. */
export function generateOperatorMnemonic(strength: 128 | 256 = 128): string {
  return bip39GenerateMnemonic(wordlist, strength)
}

/**
 * Return the persisted operator key, creating + persisting a phrase-backed one
 * if none exists. Synchronous so existing call sites need no change.
 *
 * The keyring's current credential wins. During legacy migration a stored
 * recovery phrase wins, otherwise the raw-hex secret is honoured unchanged;
 * with no saved credential a new phrase-backed key is minted.
 */
export function getOrCreateOperator(): Operator {
  const stored = storedOperators()
  if (stored.length > 0) return stored[0]!
  const fresh = generateOperatorMnemonic()
  return storeCurrentOperator(operatorFromMnemonic(fresh))
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

/**
 * Return the already-saved operator whose public key exactly matches `pubHex`.
 *
 * This is intentionally read-only and does not fall back to the primary key or
 * mint a new one. A phone handoff transfers management authority, so guessing a
 * key would produce a valid-looking QR that cannot manage the connected signer.
 */
export function findStoredOperatorByPubHex(pubHex: string): Operator | null {
  const clean = pubHex.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(clean)) return null
  return storedOperators().find((operator) => operator.pubHex === clean) ?? null
}

/** The recovery phrase backing the current operator, or `null` for a legacy
 *  raw-hex key (which has no phrase to write down). */
export function getOperatorMnemonic(): string | null {
  return storedOperators()[0]?.mnemonic ?? null
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

/** Select a fresh phrase-backed operator and return it. Previous credentials
 *  remain fallback candidates for devices that still trust them. */
export function regenerateOperator(): Operator {
  const fresh = generateOperatorMnemonic()
  return storeCurrentOperator(operatorFromMnemonic(fresh))
}

/**
 * Restore an operator from a recovery phrase (e.g. on a new browser, or to
 * match a device flashed elsewhere). Validates the phrase, persists it, and
 * derives the key. This is the phrase-backed counterpart to {@link importOperator}.
 */
export function importOperatorMnemonic(mnemonic: string): Operator {
  const clean = normaliseMnemonic(mnemonic)
  if (!validateMnemonic(clean, wordlist)) {
    throw new Error('invalid recovery phrase: check the words and their order')
  }
  const op = operatorFromMnemonic(clean)
  return storeCurrentOperator(op)
}

/**
 * Persist a specific operator secret (raw-hex import), e.g. from the phone
 * handoff link or to match a device flashed from another browser. The resulting
 * key is not phrase-backed unless the keyring already knows the matching phrase
 * (a raw secret alone cannot recreate one). The legacy singleton mirror switches
 * to the imported current credential, while other keyring entries are retained.
 * Prefer {@link importOperatorMnemonic} when you have the words. Validates 64-hex.
 */
export function importOperator(skHex: string): Operator {
  const clean = skHex.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('operator secret must be 64 hex characters (32 bytes)')
  }
  const op = operatorFromSk(clean) // throws if the secret can't derive a pubkey
  return storeCurrentOperator(op)
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
