// Operator key (op_mgmt) for relay-mediated management (kind 24134).
//
// Generated in the browser at flash time and baked into the device's config
// blob (NetConfig.op_mgmt = the operator x-only pubkey hex). The device then
// accepts management commands (create_client, list_clients, get_status, …) over
// relays ONLY when they are signed by this key — see heartwood-esp32
// src/relay.rs `handle_mgmt_event`. The operator holds the matching secret and
// loads it into bray (`NOSTR_SECRET_KEY=<skHex>`).
//
// The secret is persisted in localStorage so re-flashing the same machine keeps
// the same operator (bray keeps working). Use `regenerateOperator()` to rotate.
// This is NOT the device master seed — it is a separate, lower-stakes authority
// key; the master seed never touches the browser or a relay.

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

const LS_KEY = 'heartwood.opMgmt.skHex'

export interface Operator {
  /** Operator secret (hex). Load into bray: NOSTR_SECRET_KEY=<skHex>. */
  skHex: string
  /** Operator x-only pubkey (hex). Baked into the device config (op_mgmt). */
  pubHex: string
}

function deriveOperator(skHex: string): Operator {
  return { skHex, pubHex: bytesToHex(schnorr.getPublicKey(hexToBytes(skHex))) }
}

/** Return the persisted operator key, generating + persisting one if absent. */
export function getOrCreateOperator(): Operator {
  const stored = localStorage.getItem(LS_KEY) ?? ''
  if (/^[0-9a-f]{64}$/.test(stored)) {
    return deriveOperator(stored)
  }
  const sk = crypto.getRandomValues(new Uint8Array(32))
  const skHex = bytesToHex(sk)
  sk.fill(0)
  localStorage.setItem(LS_KEY, skHex)
  return deriveOperator(skHex)
}

/** Replace the persisted operator key with a fresh one and return it. */
export function regenerateOperator(): Operator {
  localStorage.removeItem(LS_KEY)
  return getOrCreateOperator()
}

/**
 * Persist a specific operator secret (import), e.g. to match the key baked into
 * a device that was flashed from a different browser. Validates 64-hex.
 */
export function importOperator(skHex: string): Operator {
  const clean = skHex.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('operator secret must be 64 hex characters (32 bytes)')
  }
  const op = deriveOperator(clean) // throws if the secret can't derive a pubkey
  localStorage.setItem(LS_KEY, clean)
  return op
}
