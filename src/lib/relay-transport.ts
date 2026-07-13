// Relay transport — manage a wifi-standalone Heartwood over Nostr relays.
//
// A wifi device never listens on USB; it connects out to its relay and accepts
// operator-authenticated management on kind 24134 (see heartwood-esp32
// src/relay.rs `handle_mgmt_event` / `dispatch_mgmt`). This mirrors bray's
// hw_mgmt_probe.mjs: encrypt {id,method,params} to the device with NIP-44,
// publish a 24134 event p-tagged to the device, and match the decrypted reply
// by id. The operator key (op-mgmt.ts) is the sole management authority.
//
// Request/response runs over ONE persistent subscription (kind 24134 #p=operator)
// with replies routed to pending promises by request id.

import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44'
import { hexToBytes } from '@noble/hashes/utils.js'

export const MGMT_KIND = 24134

/** Decrypted management reply: exactly one of result/error is set. */
export interface MgmtResponse {
  id: string
  result?: Record<string, unknown>
  error?: string
}

interface Pending {
  resolve: (result: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ManagementAttempt {
  method: string
  params: Record<string, unknown>
  timeoutMs: number
  mutationChallenge?: string
}

type ManagementSender = (attempt: ManagementAttempt) => Promise<Record<string, unknown>>

const READ_ONLY_MANAGEMENT_METHODS = new Set([
  'get_management_challenge',
  'get_network_config',
  'list_clients',
  'list_identities',
  'get_status',
])

/** Unknown future methods fail closed as mutations unless explicitly reviewed
 * and added to the read-only set on both Sapwood and firmware. */
export function requiresManagementMutationChallenge(method: string): boolean {
  return !READ_ONLY_MANAGEMENT_METHODS.has(method)
}

/**
 * Attach a fresh device-issued one-time challenge to a mutation. This helper is
 * exported for pure protocol tests; RelayTransport serializes calls around it.
 * A stale challenge is never retried automatically because another manager may
 * have revoked/recreated the referenced slot in the meantime.
 */
export async function sendReplaySafeManagementRequest(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  send: ManagementSender,
): Promise<Record<string, unknown>> {
  if (!requiresManagementMutationChallenge(method)) {
    return send({ method, params, timeoutMs })
  }

  let discovered: Record<string, unknown>
  try {
    discovered = await send({
      method: 'get_management_challenge',
      params: {},
      timeoutMs,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/unknown method.*get_management_challenge/i.test(message)) {
      throw new Error('This signer firmware is too old for replay-safe remote changes. Update it over USB before changing clients or network settings remotely.')
    }
    throw error
  }

  const challenge = typeof discovered.challenge === 'string'
    ? discovered.challenge.toLowerCase()
    : ''
  if (discovered.version !== 1 || !/^[0-9a-f]{64}$/.test(challenge)) {
    throw new Error('The signer did not return a valid replay-safe management challenge; nothing was changed.')
  }

  try {
    return await send({ method, params, timeoutMs, mutationChallenge: challenge })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/stale_management_challenge/i.test(message)) {
      throw new Error('Another phone or manager changed this signer first. Nothing from this request was applied; refresh the device state and try again.')
    }
    throw error
  }
}

/**
 * Unpredictable 128-bit request id. Firmware keeps recent ids in RAM to suppress
 * duplicate delivery across live relays. A separate device-issued one-time NVS
 * challenge is the durable mutation boundary across eviction and reboot.
 */
export function newManagementRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function managementRequestPayload(
  id: string,
  method: string,
  params: Record<string, unknown>,
  mutationChallenge?: string,
): Record<string, unknown> {
  return {
    id,
    method,
    params,
    ...(mutationChallenge ? { mutation_challenge: mutationChallenge } : {}),
  }
}

export class RelayTransport {
  private pool = new SimplePool()
  private sub: { close(): void } | null = null
  private readonly sk: Uint8Array
  private readonly ck: Uint8Array
  readonly operatorPub: string
  readonly devicePub: string
  readonly relays: string[]
  private readonly pending = new Map<string, Pending>()
  private mutationQueue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(devicePubHex: string, relays: string[], opSkHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(devicePubHex)) throw new Error('device pubkey must be 64 hex chars')
    if (!relays.length) throw new Error('at least one relay is required')
    if (!/^[0-9a-f]{64}$/i.test(opSkHex)) throw new Error('operator secret must be 64 hex chars')
    this.devicePub = devicePubHex.toLowerCase()
    this.relays = relays
    this.sk = hexToBytes(opSkHex)
    this.operatorPub = getPublicKey(this.sk)
    this.ck = getConversationKey(this.sk, this.devicePub)
  }

  /** Open the response subscription. Resolves once the relay sends EOSE (or after a short grace). */
  async connect(): Promise<void> {
    if (this.sub) return
    const since = Math.floor(Date.now() / 1000) - 5
    await new Promise<void>((resolve) => {
      let settled = false
      const done = (via: string) => {
        if (settled) return
        settled = true
        console.log(`[hw] relay: subscription ready (${via}) on ${this.relays.join(', ')}`)
        resolve()
      }
      this.sub = this.pool.subscribe(
        this.relays,
        { kinds: [MGMT_KIND], '#p': [this.operatorPub], since },
        {
          onevent: (ev) => this.routeEvent(ev),
          oneose: () => done('relay acknowledged'),
        },
      )
      // Don't block the UI if a relay never sends EOSE.
      setTimeout(() => done('grace — no relay EOSE, relay slow or quiet'), 1500)
    })
  }

  private routeEvent(ev: { pubkey: string; content: string }): void {
    if (ev.pubkey !== this.devicePub) {
      // Scoped to our operator, so this reply was meant for us — but authored by a
      // different signer pubkey than we targeted. Usually a stale target (the
      // signer's identity was restored/changed since we remembered it).
      console.warn(`[hw] relay: reply from ${ev.pubkey.slice(0, 8)}…, but we target ${this.devicePub.slice(0, 8)}… (wrong signer pubkey?)`)
      return
    }
    let resp: MgmtResponse
    try {
      resp = JSON.parse(decrypt(ev.content, this.ck)) as MgmtResponse
    } catch {
      console.warn('[hw] relay: a reply from the signer could not be decrypted (operator-key mismatch?)')
      return
    }
    const p = this.pending.get(resp.id)
    if (!p) { console.warn(`[hw] relay: reply id ${resp.id} matched no pending request`); return }
    clearTimeout(p.timer)
    this.pending.delete(resp.id)
    if (resp.error) p.reject(new Error(resp.error))
    else p.resolve(resp.result ?? {})
  }

  /** Send a management request and await the device's decrypted reply. */
  request(
    method: string,
    params: Record<string, unknown> = {},
    // Generous by default: the round-trip crosses the operator's network, a
    // relay, and the signer's own link. A slow or flaky client connection
    // (rough WiFi, a busy laptop) needs headroom or a status read that would
    // have arrived reports a false "timeout waiting for device".
    timeoutMs = 35_000,
  ): Promise<Record<string, unknown>> {
    if (!requiresManagementMutationChallenge(method)) {
      return this.requestRaw(method, params, timeoutMs)
    }

    const run = () => sendReplaySafeManagementRequest(
      method,
      params,
      timeoutMs,
      (attempt) => this.requestRaw(
        attempt.method,
        attempt.params,
        attempt.timeoutMs,
        attempt.mutationChallenge,
      ),
    )
    const result = this.mutationQueue.then(run, run)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private requestRaw(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    mutationChallenge?: string,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('transport closed'))
    if (!this.sub) return Promise.reject(new Error('not connected'))
    const id = newManagementRequestId()
    const content = encrypt(JSON.stringify(
      managementRequestPayload(id, method, params, mutationChallenge),
    ), this.ck)
    const event = finalizeEvent(
      {
        kind: MGMT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', this.devicePub]],
        content,
      },
      this.sk,
    )
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        console.warn(`[hw] relay: ${method} timed out after ${timeoutMs}ms — the signer never replied (offline, wrong relay, or operator-key mismatch)`)
        reject(new Error(`timeout waiting for device (${method})`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      // publish returns one promise per relay; a single accept is enough.
      Promise.any(this.pool.publish(this.relays, event)).catch(() => {
        clearTimeout(timer)
        this.pending.delete(id)
        console.warn(`[hw] relay: ${method} could not be published to any relay ${JSON.stringify(this.relays)}`)
        reject(new Error('failed to publish to any relay'))
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('transport closed'))
    }
    this.pending.clear()
    try { this.sub?.close() } catch { /* ignore */ }
    try { this.pool.destroy() } catch { /* ignore */ }
    this.sub = null
  }
}
