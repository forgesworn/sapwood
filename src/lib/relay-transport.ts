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

/** A short request id; only needs to be unique per in-flight request. */
function newId(): string {
  return 'm' + Math.random().toString(36).slice(2, 10)
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
      const done = () => { if (!settled) { settled = true; resolve() } }
      this.sub = this.pool.subscribe(
        this.relays,
        { kinds: [MGMT_KIND], '#p': [this.operatorPub], since },
        {
          onevent: (ev) => this.routeEvent(ev),
          oneose: done,
        },
      )
      // Don't block the UI if a relay never sends EOSE.
      setTimeout(done, 1500)
    })
  }

  private routeEvent(ev: { pubkey: string; content: string }): void {
    if (ev.pubkey !== this.devicePub) return
    let resp: MgmtResponse
    try {
      resp = JSON.parse(decrypt(ev.content, this.ck)) as MgmtResponse
    } catch {
      return // not for us / undecryptable
    }
    const p = this.pending.get(resp.id)
    if (!p) return
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
    if (this.closed) return Promise.reject(new Error('transport closed'))
    if (!this.sub) return Promise.reject(new Error('not connected'))
    const id = newId()
    const content = encrypt(JSON.stringify({ id, method, params }), this.ck)
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
        reject(new Error(`timeout waiting for device (${method})`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      // publish returns one promise per relay; a single accept is enough.
      Promise.any(this.pool.publish(this.relays, event)).catch(() => {
        clearTimeout(timer)
        this.pending.delete(id)
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
