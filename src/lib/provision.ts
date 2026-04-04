// Provisioning key derivation -- mirrors heartwood-esp32/provision/src/main.rs.
//
// Three modes:
//   tree-mnemonic: BIP-39 mnemonic -> BIP-32 at m/44'/1237'/727'/0'/0' -> 32 bytes
//   tree-nsec: nsec bytes -> HMAC-SHA256(key="nsec-tree\0", data=nsec) -> 32 bytes
//   bunker: raw nsec bytes (no derivation)
//
// The derived secret is sent to the ESP32 as a PROVISION frame. It is never
// stored in the browser and is zeroed after transmission.

import { mnemonicToSeed, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { buildFrame, FrameType } from './frame.js'

/** BIP-32 derivation path -- must match heartwood-core exactly. */
const MNEMONIC_PATH = "m/44'/1237'/727'/0'/0'"

/** HMAC domain prefix for nsec-tree derivation. */
const DOMAIN_PREFIX = new TextEncoder().encode('nsec-tree\0')

export type ProvisionMode = 'tree-mnemonic' | 'tree-nsec' | 'bunker'

export interface ProvisionResult {
  secret: Uint8Array    // 32 bytes -- zeroize after use
  npub: string          // bech32 npub for confirmation
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

  const secret = hmac(sha256, DOMAIN_PREFIX, nsecBytes)
  const npub = pubkeyToNpub(secretToTreePubkey(secret))

  return { secret: new Uint8Array(secret), npub }
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
  const modeByte = mode === 'bunker' ? 0 : mode === 'tree-mnemonic' ? 1 : 2

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
