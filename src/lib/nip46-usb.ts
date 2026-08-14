// NIP-46 over USB.
//
// Drives the same encrypted request path the bridge daemon pumps
// (ENCRYPTED_REQUEST 0x10 in, SIGN_ENVELOPE_RESPONSE 0x35 out), from the
// browser. The signer dispatches its full NIP-46 method set behind per-client
// policy, so nothing here adds firmware surface: Sapwood is simply another
// NIP-46 client whose transport is the cable instead of a relay.
//
// Payload layout (mirrors firmware transport.rs):
//   [target_pubkey_32][client_pubkey_32][created_at_u64_be_8][nip44_ciphertext_b64...]
//
// The response frame carries the signed kind:24133 envelope event; its
// `content` is NIP-44 ciphertext under the conversation key of our client
// secret and the responding identity (the envelope author). The chip has no
// wall clock, so `created_at` here is the operator-supplied time, exactly as
// the relay management channel already does.
//
// Sapwood pairs once as a normal client slot (key in localStorage so the
// pairing survives reloads) and can then address any served identity: masters
// and registry personas alike. Everything below the transport call is a pure
// function so the byte layout and envelope parsing are unit-testable without
// a device.

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { FrameType, buildFrame, type Frame } from './frame.js'
import { transport } from './serial.js'

const CLIENT_KEY_STORAGE = 'heartwood_nip46_usb_client_key'

/** The NIP-46 request envelope carried inside the ciphertext. */
export interface Nip46Rpc {
  id: string
  method: string
  params: unknown[]
}

/** Load (or mint and persist) the Sapwood NIP-46 client secret. The key is
 *  transport identity only: it holds no signing authority beyond what the
 *  signer's per-client policy grants the paired slot. */
export function clientSecret(): Uint8Array {
  const stored = localStorage.getItem(CLIENT_KEY_STORAGE)
  if (stored && /^[0-9a-f]{64}$/.test(stored)) return hexToBytes(stored)
  const sk = generateSecretKey()
  localStorage.setItem(CLIENT_KEY_STORAGE, bytesToHex(sk))
  return sk
}

/** Hex pubkey of the Sapwood client key. */
export function clientPubkeyHex(): string {
  return getPublicKey(clientSecret())
}

/** Fresh inner request id: the signer replay-suppresses repeats. */
function newRequestId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
}

/** Build the 0x10 payload for one request. Pure; exported for tests. */
export function buildEncryptedRequestPayload(
  targetPubkeyHex: string,
  sk: Uint8Array,
  rpc: Nip46Rpc,
  createdAt: number,
): Uint8Array {
  const conversationKey = getConversationKey(sk, targetPubkeyHex)
  const ciphertext = new TextEncoder().encode(encrypt(JSON.stringify(rpc), conversationKey))
  const payload = new Uint8Array(72 + ciphertext.length)
  payload.set(hexToBytes(targetPubkeyHex), 0)
  payload.set(hexToBytes(getPublicKey(sk)), 32)
  const view = new DataView(payload.buffer)
  view.setBigUint64(64, BigInt(createdAt), false)
  payload.set(ciphertext, 72)
  return payload
}

/** Parse a SIGN_ENVELOPE_RESPONSE payload and decrypt the RPC reply. Pure;
 *  exported for tests. Throws with a readable message on every failure mode. */
export function parseEnvelopeResponse(
  payload: Uint8Array,
  sk: Uint8Array,
  expectedId: string,
): string {
  let envelope: { pubkey?: unknown; content?: unknown }
  try {
    envelope = JSON.parse(new TextDecoder().decode(payload)) as typeof envelope
  } catch {
    throw new Error('The signer returned a malformed response envelope.')
  }
  if (typeof envelope.pubkey !== 'string' || typeof envelope.content !== 'string') {
    throw new Error('The signer returned a malformed response envelope.')
  }
  let plain: string
  try {
    plain = decrypt(envelope.content, getConversationKey(sk, envelope.pubkey))
  } catch {
    throw new Error('Could not decrypt the signer response. Re-pair Sapwood with the signer.')
  }
  let rpc: { id?: unknown; result?: unknown; error?: unknown }
  try {
    rpc = JSON.parse(plain) as typeof rpc
  } catch {
    throw new Error('The signer returned a malformed response.')
  }
  if (rpc.id !== expectedId) {
    throw new Error('The signer response did not match the request.')
  }
  if (typeof rpc.error === 'string' && rpc.error.length > 0) {
    throw new Error(rpc.error)
  }
  if (typeof rpc.result !== 'string') {
    throw new Error('The signer returned a malformed response.')
  }
  return rpc.result
}

/** One NIP-46 round trip over the cable. `targetPubkeyHex` is any identity
 *  the signer serves (a master or a registry persona). Interactive tiers can
 *  hold the reply for the on-device button, hence the generous timeout. */
export async function nip46UsbRequest(
  targetPubkeyHex: string,
  method: string,
  params: unknown[],
  timeoutMs = 60_000,
): Promise<string> {
  const sk = clientSecret()
  const rpc: Nip46Rpc = { id: newRequestId(), method, params }
  const payload = buildEncryptedRequestPayload(
    targetPubkeyHex,
    sk,
    rpc,
    Math.floor(Date.now() / 1000),
  )
  const frame: Frame = await transport.sendAndReceive(
    buildFrame(FrameType.ENCRYPTED_REQUEST, payload),
    [FrameType.SIGN_ENVELOPE_RESPONSE, FrameType.NACK],
    timeoutMs,
  )
  if (frame.type === FrameType.NACK) {
    throw new Error(
      'The signer refused the request: Sapwood is not paired with this identity, or policy denies the method. Pair Sapwood from the Identity panel and try again.',
    )
  }
  return parseEnvelopeResponse(frame.payload, sk, rpc.id)
}

// ---------------------------------------------------------------------------
// Persona management calls (C2 and the remove/rename extensions).
// ---------------------------------------------------------------------------

export interface DerivedPersona {
  npub: string
  purpose: string
  index: number
  personaName: string
}

/** Derive (or re-derive: same name, same key, always) a registry persona.
 *  The signer prepends the reserved `nostr:persona:` namespace itself. */
export async function derivePersona(
  masterPubkeyHex: string,
  name: string,
  index = 0,
): Promise<DerivedPersona> {
  const result = await nip46UsbRequest(masterPubkeyHex, 'heartwood_derive_persona', [name, index])
  const parsed = JSON.parse(result) as Partial<DerivedPersona>
  if (typeof parsed.npub !== 'string' || typeof parsed.purpose !== 'string') {
    throw new Error('The signer returned a malformed persona.')
  }
  return {
    npub: parsed.npub,
    purpose: parsed.purpose,
    index: typeof parsed.index === 'number' ? parsed.index : index,
    personaName: typeof parsed.personaName === 'string' ? parsed.personaName : name,
  }
}

/** Remove a registry persona. Registry-only: re-deriving the same name later
 *  reproduces the identity, because the tree root never changes. */
export async function removePersona(
  masterPubkeyHex: string,
  personaPubkeyHex: string,
): Promise<void> {
  await nip46UsbRequest(masterPubkeyHex, 'heartwood_remove_persona', [personaPubkeyHex])
}

/** Rename a registry persona's display label (empty clears it). */
export async function renamePersona(
  masterPubkeyHex: string,
  personaPubkeyHex: string,
  name: string,
): Promise<void> {
  await nip46UsbRequest(masterPubkeyHex, 'heartwood_rename_persona', [personaPubkeyHex, name])
}

/** NIP-46 connect: binds this client key to the slot the secret belongs to.
 *  Needed once per pairing; afterwards the binding is by client pubkey. */
export async function connectWithSecret(
  masterPubkeyHex: string,
  secret: string,
): Promise<void> {
  await nip46UsbRequest(masterPubkeyHex, 'connect', [masterPubkeyHex, secret])
}
