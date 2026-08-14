// Provisioning key derivation -- mirrors heartwood-esp32/provision/src/main.rs.
//
// Four modes:
//   tree-mnemonic: BIP-39 mnemonic -> BIP-32 at m/44'/1237'/727'/0'/0' -> 32 bytes
//   tree-nsec: nsec bytes -> HMAC-SHA256(key=nsec, msg="nsec-tree-root") -> 32 bytes
//   bunker: raw nsec bytes (no derivation)
//   named-child: mnemonic -> tree root (as tree-mnemonic) -> nsec-tree child at
//     purpose = the identity's name, index 0. The child key is sent as-is (wire
//     mode byte 0), so the signer signs AS the named identity. Matches
//     nsec-tree derive(root, name) byte-for-byte: the same phrase and name
//     recreate the same identity anywhere.
//
// The derived secret is sent to the ESP32 as a PROVISION frame. It is never
// stored in the browser and is zeroed after transmission.

import { generateMnemonic as bip39GenerateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { buildFrame, FrameType } from './frame.js'

/** BIP-32 derivation path -- must match heartwood-core exactly. */
const MNEMONIC_PATH = "m/44'/1237'/727'/0'/0'"

/** HMAC label for nsec-tree root derivation -- must match nsec-tree fromNsec(). */
const NSEC_ROOT_LABEL = new TextEncoder().encode('nsec-tree-root')

/** Domain prefix for nsec-tree child derivation -- must match nsec-tree derive(). */
const CHILD_DOMAIN_PREFIX = new TextEncoder().encode('nsec-tree\0')

export type ProvisionMode = 'tree-mnemonic' | 'tree-nsec' | 'bunker' | 'named-child'

export interface ProvisionResult {
  secret: Uint8Array    // 32 bytes -- zeroize after use
  npub: string          // bech32 npub for confirmation
}

/**
 * Generate a fresh BIP-39 recovery phrase. 128 bits of entropy -> 12 words,
 * 256 -> 24. This is the newcomer path: the device's identity is created from
 * this phrase, so it is the one thing the owner must write down and keep.
 */
export function generateMnemonic(strength: 128 | 256 = 128): string {
  return bip39GenerateMnemonic(wordlist, strength)
}

/** Derive the 32-byte root secret from a BIP-39 mnemonic. */
export async function deriveFromMnemonic(mnemonic: string, passphrase: string): Promise<ProvisionResult> {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid mnemonic')
  }

  const seed = await mnemonicToSeed(mnemonic, passphrase)
  const master = HDKey.fromMasterSeed(seed)
  const child = master.derive(MNEMONIC_PATH)

  if (!child.privateKey) {
    throw new Error('BIP-32 derivation failed')
  }

  const secret = new Uint8Array(child.privateKey)
  const npub = pubkeyToNpub(secretToTreePubkey(secret))

  return { secret, npub }
}

/** Derive tree root from an existing nsec via HMAC-SHA256. */
export function deriveFromNsec(nsecBytes: Uint8Array): ProvisionResult {
  if (nsecBytes.length !== 32) {
    throw new Error('nsec must be 32 bytes')
  }

  const secret = hmac(sha256, nsecBytes, NSEC_ROOT_LABEL)
  const npub = pubkeyToNpub(secretToTreePubkey(secret))

  return { secret: new Uint8Array(secret), npub }
}

/**
 * Validate an identity name as an nsec-tree purpose string (PROTOCOL.md §3):
 * non-empty, not whitespace-only, ≤255 bytes UTF-8, no null bytes, no `|`.
 * Returns null when valid, or a human-readable reason.
 */
export function nameDeriveError(name: string): string | null {
  if (!name || !name.trim()) return 'Enter a name for the identity'
  if (new TextEncoder().encode(name).length > 255) return 'Name is too long'
  if (name.includes('\0')) return 'Name cannot contain null characters'
  if (name.includes('|')) return 'Name cannot contain the | character'
  return null
}

/**
 * Names the persona tools reserve under the `nostr:persona:` namespace
 * (PROTOCOL v1.1 §3.1): the standard personas, and the dependant pattern.
 */
const RESERVED_PERSONA_NAMES = /^(natural-person|persona|professional|dependant-\d+-(np|persona))$/

/**
 * Warn when a named-identity derivation collides with a reserved persona
 * name. The named-identity flow derives at the BARE name and fills a master
 * slot, so typing `natural-person` here produces a DIFFERENT key from the
 * persona `natural-person` that My Signet and the persona tools derive under
 * the `nostr:persona:` namespace. Not an error — the derivation is valid —
 * but almost never what the operator wants.
 */
export function nameReservedWarning(name: string): string | null {
  if (!RESERVED_PERSONA_NAMES.test(name.trim())) return null
  return `“${name.trim()}” is a reserved persona name. This flow derives a plain named identity, `
    + 'which is a different key from the persona of the same name and permanently fills a master slot. '
    + 'For the family personas, use “Add a persona” on the Identity panel instead.'
}

/**
 * Derive an nsec-tree child key: HMAC-SHA256(key = root, msg = "nsec-tree\0" ||
 * name || 0x00 || index_be32). Skips indices that produce invalid secp256k1
 * scalars (probability ~2^-128), exactly as nsec-tree deriveChildKey() and
 * heartwood-common derive() do, so the result matches them byte-for-byte.
 */
export function deriveChild(rootSecret: Uint8Array, name: string, index = 0): ProvisionResult {
  const reason = nameDeriveError(name)
  if (reason) throw new Error(reason)

  const nameBytes = new TextEncoder().encode(name)
  for (let i = index; i <= 0xffffffff; i++) {
    const msg = new Uint8Array(CHILD_DOMAIN_PREFIX.length + nameBytes.length + 1 + 4)
    msg.set(CHILD_DOMAIN_PREFIX, 0)
    msg.set(nameBytes, CHILD_DOMAIN_PREFIX.length)
    msg[CHILD_DOMAIN_PREFIX.length + nameBytes.length] = 0
    new DataView(msg.buffer).setUint32(msg.length - 4, i, false)

    const derived = hmac(sha256, rootSecret, msg)
    try {
      const pubkey = schnorr.getPublicKey(derived)
      // Hand the hmac buffer over as-is: no copy is left behind to linger.
      return { secret: derived, npub: pubkeyToNpub(pubkey) }
    } catch {
      derived.fill(0) // invalid scalar -- scrub and try the next index
    }
  }
  throw new Error('Index overflow: no valid key found')
}

/**
 * Derive a named identity from a BIP-39 mnemonic: tree root (same path as
 * tree-mnemonic mode) then the nsec-tree child at purpose = name, index 0.
 * The same phrase and name always recreate the same identity.
 */
export async function deriveNamedFromMnemonic(
  mnemonic: string,
  passphrase: string,
  name: string,
): Promise<ProvisionResult> {
  const root = await deriveFromMnemonic(mnemonic, passphrase)
  try {
    return deriveChild(root.secret, name)
  } finally {
    zeroize(root.secret)
  }
}

/**
 * Derive a named identity from an existing nsec: tree root via
 * HMAC(nsec, "nsec-tree-root") — the same root nsec-tree fromNsec() builds and
 * the same one the signer itself uses for a bunker-mode master — then the
 * child at purpose = name, index 0. Matches nsec-tree derive(fromNsec(nsec),
 * name) byte-for-byte.
 */
export function deriveNamedFromNsec(nsecBytes: Uint8Array, name: string): ProvisionResult {
  const root = deriveFromNsec(nsecBytes)
  try {
    return deriveChild(root.secret, name)
  } finally {
    zeroize(root.secret)
  }
}

/** Use raw nsec bytes directly (bunker mode, no derivation). */
export function useRawNsec(nsecBytes: Uint8Array): ProvisionResult {
  if (nsecBytes.length !== 32) {
    throw new Error('nsec must be 32 bytes')
  }

  const pubkey = schnorr.getPublicKey(nsecBytes)
  const npub = pubkeyToNpub(pubkey)

  return { secret: new Uint8Array(nsecBytes), npub }
}

/** Decode an nsec1... bech32 string to 32 raw bytes. */
export function decodeNsec(nsec: string): Uint8Array {
  // Simple bech32 decode (nsec uses bech32, not bech32m).
  const { prefix, words } = bech32Decode(nsec.trim())
  if (prefix !== 'nsec') {
    throw new Error(`Expected nsec prefix, got ${prefix}`)
  }
  const bytes = convertBits(words, 5, 8, false)
  if (bytes.length !== 32) {
    throw new Error(`nsec decoded to ${bytes.length} bytes, expected 32`)
  }
  return new Uint8Array(bytes)
}

/** Build a PROVISION frame. Matches provision CLI build_provision_frame(). */
export function buildProvisionFrame(secret: Uint8Array, label: string, mode: ProvisionMode): Uint8Array {
  // A named child is a raw key the device signs with as-is, so it ships with
  // the bunker wire byte; the derivation already happened in the browser.
  const modeByte = mode === 'bunker' || mode === 'named-child' ? 0 : mode === 'tree-mnemonic' ? 1 : 2

  // Legacy format for default label + tree-mnemonic: just 32 bytes.
  if (label === 'default' && modeByte === 1) {
    return buildFrame(FrameType.PROVISION, secret)
  }

  // Extended format: [mode][label_len][label...][secret]
  const labelBytes = new TextEncoder().encode(label.slice(0, 32))
  const payload = new Uint8Array(2 + labelBytes.length + 32)
  payload[0] = modeByte
  payload[1] = labelBytes.length
  payload.set(labelBytes, 2)
  payload.set(secret, 2 + labelBytes.length)
  return buildFrame(FrameType.PROVISION, payload)
}

/** Zeroize a Uint8Array. */
export function zeroize(arr: Uint8Array): void {
  arr.fill(0)
}

// --- Internal helpers ---

/** Derive the tree master pubkey from a root secret (HMAC child at index 0). */
function secretToTreePubkey(secret: Uint8Array): Uint8Array {
  // The tree root's pubkey is derived from the secret using the same
  // HMAC-based child derivation as heartwood-common/src/derive.rs.
  // For display purposes we use the direct schnorr pubkey of the secret.
  return schnorr.getPublicKey(secret)
}

/** Encode a 32-byte pubkey as npub1... bech32. */
function pubkeyToNpub(pubkey: Uint8Array): string {
  const words = convertBits(Array.from(pubkey), 8, 5, true)
  return bech32Encode('npub', words)
}

// --- Minimal bech32 (no external dep) ---

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i]!
    }
  }
  return chk
}

function bech32HrpExpand(hrp: string): number[] {
  const result: number[] = []
  for (let i = 0; i < hrp.length; i++) result.push(hrp.charCodeAt(i) >> 5)
  result.push(0)
  for (let i = 0; i < hrp.length; i++) result.push(hrp.charCodeAt(i) & 31)
  return result
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1
  const result: number[] = []
  for (let i = 0; i < 6; i++) result.push((polymod >> (5 * (5 - i))) & 31)
  return result
}

function bech32Encode(hrp: string, data: number[]): string {
  const checksum = bech32CreateChecksum(hrp, data)
  return hrp + '1' + [...data, ...checksum].map(d => CHARSET[d]).join('')
}

function bech32Decode(str: string): { prefix: string; words: number[] } {
  const pos = str.lastIndexOf('1')
  if (pos < 1) throw new Error('Invalid bech32: no separator')
  const hrp = str.slice(0, pos).toLowerCase()
  const dataStr = str.slice(pos + 1).toLowerCase()
  const data: number[] = []
  for (const c of dataStr) {
    const idx = CHARSET.indexOf(c)
    if (idx === -1) throw new Error(`Invalid bech32 character: ${c}`)
    data.push(idx)
  }
  if (bech32Polymod([...bech32HrpExpand(hrp), ...data]) !== 1) {
    throw new Error('Invalid bech32 checksum')
  }
  return { prefix: hrp, words: data.slice(0, -6) }
}

function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0
  let bits = 0
  const result: number[] = []
  const maxv = (1 << toBits) - 1
  for (const value of data) {
    acc = (acc << fromBits) | value
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      result.push((acc >> bits) & maxv)
    }
  }
  if (pad && bits > 0) {
    result.push((acc << (toBits - bits)) & maxv)
  }
  return result
}
