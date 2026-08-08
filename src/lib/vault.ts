// Encrypted-at-rest ("vault key") support — the Sapwood side of
// heartwood-esp32's encrypted-at-rest design.
//
// The signer can encrypt its master seeds at rest under a 32-byte random
// "vault key" that lives ONLY with the host (this browser's storage), never
// on the device. Locked, the device shows "Locked — Await unlock" and refuses
// everything except PROVISION_LIST / FIRMWARE_INFO / SESSION_AUTH /
// PIN_UNLOCK / VAULT_UNLOCK.
//
// Two delivery paths:
//   USB:    VAULT_SET (0x62) enables/disables, VAULT_UNLOCK (0x63) unlocks —
//           both behind an authenticated bridge session (SESSION_AUTH).
//   WiFi:   a locked signer publishes an ephemeral kind-24135 announcement
//           (authored by a one-time unlock keypair, p-tagged to the operator);
//           Sapwood answers with a kind-24136 event p-tagged to that one-time
//           pubkey, content = NIP-44 (operator → unlock pubkey) of the
//           64-char lowercase hex vault key.
//
// The vault key is never logged. Storage follows the repo's localStorage
// pattern (see op-mgmt.ts), keyed by the device's master pubkey hex so
// several signers can be managed from one browser.

import { finalizeEvent } from 'nostr-tools/pure'
import { getConversationKey, encrypt } from 'nostr-tools/nip44'
import { hexToBytes } from '@noble/hashes/utils.js'
import { SimplePool } from 'nostr-tools/pool'
import { FrameType, buildVaultSet, buildVaultUnlock } from './frame.js'
import type { SerialTransport } from './serial.js'

/** Relay kind a locked signer announces on (ephemeral; relays never store it). */
export const VAULT_ANNOUNCE_KIND = 24135
/** Relay kind the operator delivers the vault key on (ephemeral). */
export const VAULT_DELIVER_KIND = 24136

/** localStorage key for the vault-key store: { [devicePubHex]: keyHex }. */
const LS_VAULT_KEYS = 'heartwood.vaultKeys.v1'

const VAULT_KEY_HEX_RE = /^[0-9a-f]{64}$/

/** True when `value` is a well-formed vault key: 64 lowercase-hex characters. */
export function isVaultKeyHex(value: unknown): value is string {
  return typeof value === 'string' && VAULT_KEY_HEX_RE.test(value)
}

/** Normalise operator-pasted input (whitespace/uppercase tolerated) to the
 *  canonical lowercase-hex form, or null when it is not a vault key. */
export function normaliseVaultKeyHex(value: string): string | null {
  const clean = value.trim().toLowerCase()
  return VAULT_KEY_HEX_RE.test(clean) ? clean : null
}

/** Generate a fresh 32-byte vault key as 64 lowercase-hex characters. */
export function generateVaultKeyHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function loadStore(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LS_VAULT_KEYS)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Fail closed per entry: a corrupt value can never read back as a key.
    const out: Record<string, string> = {}
    for (const [deviceHex, keyHex] of Object.entries(parsed as Record<string, unknown>)) {
      const device = deviceHex.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(device) || !isVaultKeyHex(keyHex)) continue
      out[device] = keyHex
    }
    return out
  } catch {
    return {}
  }
}

function saveStore(store: Record<string, string>): void {
  try {
    localStorage.setItem(LS_VAULT_KEYS, JSON.stringify(store))
  } catch { /* storage unavailable — the key simply isn't remembered */ }
}

/** The stored vault key for a device (by master pubkey hex), or null. */
export function loadVaultKey(devicePubHex: string): string | null {
  const device = devicePubHex.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(device)) return null
  return loadStore()[device] ?? null
}

/** Remember a vault key for a device. Throws on malformed input so a typo in
 *  an escrowed key can never be stored and later fail at unlock time. */
export function storeVaultKey(devicePubHex: string, keyHex: string): void {
  const device = devicePubHex.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(device)) throw new Error('device pubkey must be 64 hex characters')
  const key = normaliseVaultKeyHex(keyHex)
  if (!key) throw new Error('The vault key must be 64 hexadecimal characters (32 bytes).')
  const store = loadStore()
  store[device] = key
  saveStore(store)
}

/** Forget the vault key held for a device (e.g. after disabling encryption). */
export function removeVaultKey(devicePubHex: string): void {
  const device = devicePubHex.trim().toLowerCase()
  const store = loadStore()
  if (!(device in store)) return
  delete store[device]
  saveStore(store)
}

// --- USB (Web Serial) paths ---

/** Read a NACK payload's reason text (empty payload → generic fallback). */
function nackReason(payload: Uint8Array, fallback: string): string {
  const text = new TextDecoder().decode(payload).trim()
  return text || fallback
}

// The signer gives the operator 30 seconds to confirm on the OLED; the frame
// round trip must outlast a person reading and reaching for the button.
const VAULT_SET_TIMEOUT_MS = 40_000
const VAULT_UNLOCK_TIMEOUT_MS = 35_000

/**
 * Enable encrypted-at-rest (`keyHex`) or return to plaintext storage (`null`).
 * The caller must have authenticated the bridge session first. The device asks
 * for physical confirmation on its OLED; on ACK the change is active.
 * Throws with the device's reason on NACK.
 */
export async function serialVaultSet(
  transport: SerialTransport,
  keyHex: string | null,
): Promise<void> {
  let key: Uint8Array | null = null
  if (keyHex !== null) {
    const normalised = normaliseVaultKeyHex(keyHex)
    if (!normalised) throw new Error('The vault key must be 64 hexadecimal characters (32 bytes).')
    key = hexToBytes(normalised)
  }
  const resp = await transport.sendAndReceive(
    buildVaultSet(key),
    [FrameType.ACK, FrameType.NACK],
    VAULT_SET_TIMEOUT_MS,
  )
  if (resp.type !== FrameType.ACK) {
    throw new Error(nackReason(resp.payload, 'The signer rejected the vault-key change.'))
  }
}

/**
 * Unlock a locked signer over USB with its vault key. The caller must have
 * authenticated the bridge session first. Resolves on ACK; throws with a
 * friendly message on NACK ("wrong vault key" / "already unlocked" /
 * "bridge auth required").
 */
export async function serialVaultUnlock(
  transport: SerialTransport,
  keyHex: string,
): Promise<void> {
  const normalised = normaliseVaultKeyHex(keyHex)
  if (!normalised) throw new Error('The vault key must be 64 hexadecimal characters (32 bytes).')
  const resp = await transport.sendAndReceive(
    buildVaultUnlock(hexToBytes(normalised)),
    [FrameType.ACK, FrameType.NACK],
    VAULT_UNLOCK_TIMEOUT_MS,
  )
  if (resp.type === FrameType.ACK) return
  const reason = nackReason(resp.payload, 'The signer refused the vault key.')
  if (/wrong vault key/i.test(reason)) {
    throw new Error('That vault key did not unlock the signer. Check it against your escrowed copy.')
  }
  if (/already unlocked/i.test(reason)) {
    return // the state we wanted anyway — treat as success
  }
  if (/bridge auth required/i.test(reason)) {
    throw new Error('The signer needs the bridge session authenticated first. Try again.')
  }
  throw new Error(reason)
}

// --- WiFi-standalone (relay) paths ---

/**
 * Validate a locked-boot announcement. Returns the one-time unlock pubkey
 * (the event author) when the event asks for its vault key, else null.
 * The caller has already matched kind and #p tag via the subscription filter.
 */
export function parseVaultAnnouncement(event: { pubkey: string; content: string }): string | null {
  if (!/^[0-9a-f]{64}$/.test(event.pubkey)) return null
  try {
    const parsed: unknown = JSON.parse(event.content)
    if (!parsed || typeof parsed !== 'object') return null
    if ((parsed as Record<string, unknown>).status !== 'locked') return null
    return event.pubkey
  } catch {
    return null
  }
}

/**
 * Build the signed kind-24136 delivery event: NIP-44 encryption (operator →
 * one-time unlock pubkey) of the 64-char lowercase-hex vault key, p-tagged to
 * the announced unlock pubkey.
 */
export function buildVaultDeliveryEvent(
  operatorSkHex: string,
  unlockPubHex: string,
  vaultKeyHex: string,
): { kind: number; pubkey: string; id: string; created_at: number; tags: string[][]; content: string; sig: string } {
  if (!/^[0-9a-f]{64}$/i.test(operatorSkHex)) throw new Error('operator secret must be 64 hex chars')
  if (!/^[0-9a-f]{64}$/.test(unlockPubHex)) throw new Error('unlock pubkey must be 64 hex chars')
  const key = normaliseVaultKeyHex(vaultKeyHex)
  if (!key) throw new Error('The vault key must be 64 hexadecimal characters (32 bytes).')
  const sk = hexToBytes(operatorSkHex)
  const ck = getConversationKey(sk, unlockPubHex)
  return finalizeEvent(
    {
      kind: VAULT_DELIVER_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', unlockPubHex]],
      content: encrypt(key, ck),
    },
    sk,
  )
}

type Pool = Pick<SimplePool, 'subscribe' | 'publish' | 'destroy'>

/**
 * Watch a signer's relays for locked-boot announcements (kind 24135 p-tagged
 * to the operator). Deliberately separate from the management transport: a
 * locked signer cannot serve authenticated management replies, so this runs
 * on its own lightweight pool.
 */
export class VaultAnnouncementWatcher {
  private readonly pool: Pool
  private sub: { close(): void } | null = null

  constructor(
    private readonly relays: string[],
    private readonly operatorPubHex: string,
    private readonly onAnnouncement: (unlockPubHex: string) => void,
    pool: Pool = new SimplePool(),
  ) {
    if (!relays.length) throw new Error('at least one relay is required')
    if (!/^[0-9a-f]{64}$/.test(operatorPubHex)) throw new Error('operator pubkey must be 64 hex chars')
    this.pool = pool
  }

  /** Open the announcement subscription. Idempotent. */
  start(): void {
    if (this.sub) return
    this.sub = this.pool.subscribe(
      this.relays,
      { kinds: [VAULT_ANNOUNCE_KIND], '#p': [this.operatorPubHex] },
      {
        onevent: (ev) => {
          const unlockPub = parseVaultAnnouncement(ev)
          if (unlockPub) this.onAnnouncement(unlockPub)
        },
      },
    )
  }

  /** Publish a kind-24136 delivery on this watcher's relays and pool. */
  async publishDelivery(operatorSkHex: string, unlockPubHex: string, vaultKeyHex: string): Promise<void> {
    await publishVaultDelivery(this.pool, this.relays, operatorSkHex, unlockPubHex, vaultKeyHex)
  }

  close(): void {
    try { this.sub?.close() } catch { /* ignore */ }
    this.sub = null
    try { this.pool.destroy() } catch { /* ignore */ }
  }
}

/**
 * Publish a kind-24136 vault-key delivery to the given relays. Resolves once
 * at least one relay has accepted the event; rejects when none does.
 */
export async function publishVaultDelivery(
  pool: Pick<SimplePool, 'publish'>,
  relays: string[],
  operatorSkHex: string,
  unlockPubHex: string,
  vaultKeyHex: string,
): Promise<void> {
  const event = buildVaultDeliveryEvent(operatorSkHex, unlockPubHex, vaultKeyHex)
  const publishes = pool.publish(relays, event as Parameters<SimplePool['publish']>[1])
  if (publishes.length === 0) throw new Error('failed to publish to any relay')
  const results = await Promise.allSettled(publishes)
  if (results.some((r) => r.status === 'fulfilled' && !/^connection failure:/i.test(String(r.value)))) return
  throw new Error('failed to publish to any relay')
}
