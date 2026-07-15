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
  republishTimer: ReturnType<typeof setInterval> | null
  /** Every fresh read attempt belongs to this one logical operation. A reply
   * to any alias settles it and removes every alias atomically. */
  ids: Set<string>
}

export interface ReadRepublishProgress {
  /** A signed event was successfully handed to the relay pool. */
  onPublishSubmitted?: () => void
  /** At least one relay acknowledged the event. */
  onPublishAccepted?: () => void
}

type RelayPool = Pick<SimplePool, 'ensureRelay' | 'subscribe' | 'publish' | 'destroy'>

/** nostr-tools pingpong uses Promise.any internally. Keep reconnect enabled on
 * older WebKit, but disable only optional ping health checks when that ES2021
 * API is missing. Core connection/publish selection uses firstFulfilled below. */
export function relayPoolCompatibilityOptions(): { enablePing: boolean; enableReconnect: true } {
  return {
    enablePing: typeof (Promise as unknown as { any?: unknown }).any === 'function',
    enableReconnect: true,
  }
}

function defaultRelayPool(): SimplePool {
  return new SimplePool(relayPoolCompatibilityOptions())
}

const RELAY_CONNECT_TIMEOUT_MS = 10_000

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('relay connection aborted', 'AbortError')
}

/** Safari gained AbortSignal.throwIfAborted later than AbortController itself.
 * Keep the mobile handoff on the older, widely-supported `aborted` contract. */
export function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

/** First fulfilled promise without relying on ES2021 Promise.any. Older iPhone
 * WebKit can run Sapwood while lacking that static method entirely. */
export class FirstFulfilledError extends Error {
  readonly errors: unknown[]

  constructor(errors: unknown[]) {
    super('every promise was rejected')
    this.name = 'FirstFulfilledError'
    this.errors = errors
  }
}

export function firstFulfilled<T>(values: Iterable<PromiseLike<T> | T>): Promise<T> {
  const entries = Array.from(values)
  return new Promise<T>((resolve, reject) => {
    if (entries.length === 0) {
      reject(new FirstFulfilledError([]))
      return
    }
    const errors = new Array<unknown>(entries.length)
    let rejected = 0
    entries.forEach((entry, index) => {
      Promise.resolve(entry).then(resolve, (error) => {
        errors[index] = error
        rejected += 1
        if (rejected === entries.length) reject(new FirstFulfilledError(errors))
      })
    })
  })
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
  private readonly pool: RelayPool
  private sub: { close(): void } | null = null
  private readonly sk: Uint8Array
  private readonly ck: Uint8Array
  /** Conversation keys per management target (a signer serves several
   *  identities; each is addressed by its own pubkey with its own key). */
  private readonly cks = new Map<string, Uint8Array>()
  readonly operatorPub: string
  readonly devicePub: string
  readonly relays: string[]
  private readonly pending = new Map<string, Pending>()
  private mutationQueue: Promise<void> = Promise.resolve()
  private closed = false
  private abortSignal: AbortSignal | null = null
  private abortHandler: (() => void) | null = null

  constructor(
    devicePubHex: string,
    relays: string[],
    opSkHex: string,
    pool: RelayPool = defaultRelayPool(),
  ) {
    if (!/^[0-9a-f]{64}$/i.test(devicePubHex)) throw new Error('device pubkey must be 64 hex chars')
    if (!relays.length) throw new Error('at least one relay is required')
    if (!/^[0-9a-f]{64}$/i.test(opSkHex)) throw new Error('operator secret must be 64 hex chars')
    this.devicePub = devicePubHex.toLowerCase()
    this.relays = relays
    this.sk = hexToBytes(opSkHex)
    this.operatorPub = getPublicKey(this.sk)
    this.ck = getConversationKey(this.sk, this.devicePub)
    this.cks.set(this.devicePub, this.ck)
    this.pool = pool
  }

  /** Conversation key for a management target, cached per identity. */
  private targetCk(targetHex: string): Uint8Array {
    const hex = targetHex.toLowerCase()
    let ck = this.cks.get(hex)
    if (!ck) {
      if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('management target must be 64 hex chars')
      ck = getConversationKey(this.sk, hex)
      this.cks.set(hex, ck)
    }
    return ck
  }

  /** Open the response subscription only after at least one real relay socket
   * has connected. EOSE is a query boundary, not connection proof: aggregate
   * subscriptions also report it when every relay failed. */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('transport closed')
    if (this.sub) return
    throwIfSignalAborted(signal)

    if (signal) {
      this.abortSignal = signal
      this.abortHandler = () => this.close(abortError(signal))
      signal.addEventListener('abort', this.abortHandler, { once: true })
    }

    try {
      await firstFulfilled(this.relays.map((relay) => this.pool.ensureRelay(relay, {
        connectionTimeout: RELAY_CONNECT_TIMEOUT_MS,
        abort: signal,
      })))
      throwIfSignalAborted(signal)
    } catch (error) {
      this.unbindAbort()
      if (signal?.aborted) throw abortError(signal)
      throw new Error('could not connect to any relay', { cause: error })
    }

    const since = Math.floor(Date.now() / 1000) - 5
    try {
      this.sub = this.pool.subscribe(
        this.relays,
        { kinds: [MGMT_KIND], '#p': [this.operatorPub], since },
        {
          onevent: (ev) => this.routeEvent(ev),
          onclose: () => {
            this.sub = null
            this.rejectPending(new Error('relay connection closed'))
          },
          abort: signal,
        },
      )
      console.log(`[hw] relay: at least one socket connected; response subscription opened on ${this.relays.join(', ')}`)
    } catch (error) {
      this.unbindAbort()
      throw error
    }
  }

  private unbindAbort(): void {
    if (this.abortSignal && this.abortHandler) {
      this.abortSignal.removeEventListener('abort', this.abortHandler)
    }
    this.abortSignal = null
    this.abortHandler = null
  }

  private rejectPending(error: Error): void {
    for (const id of [...this.pending.keys()]) {
      this.removePending(id)?.reject(error)
    }
  }

  private removePending(id: string): Pending | undefined {
    const pending = this.pending.get(id)
    if (!pending) return undefined
    clearTimeout(pending.timer)
    if (pending.republishTimer) clearInterval(pending.republishTimer)
    for (const alias of pending.ids) this.pending.delete(alias)
    pending.ids.clear()
    return pending
  }

  private routeEvent(ev: { pubkey: string; content: string }): void {
    // Replies are authored by the identity a request was ADDRESSED to — the
    // session's primary or any other identity this session has targeted.
    const ck = this.cks.get(ev.pubkey)
    if (!ck) {
      // Scoped to our operator, so this reply was meant for us — but authored by a
      // signer pubkey this session never targeted. Usually a stale target (the
      // signer's identity was restored/changed since we remembered it).
      console.warn(`[hw] relay: reply from ${ev.pubkey.slice(0, 8)}…, an identity this session never targeted (stale signer pubkey?)`)
      return
    }
    let resp: MgmtResponse
    try {
      resp = JSON.parse(decrypt(ev.content, ck)) as MgmtResponse
    } catch {
      console.warn('[hw] relay: a reply from the signer could not be decrypted (operator-key mismatch?)')
      return
    }
    const p = this.removePending(resp.id)
    if (!p) { console.warn(`[hw] relay: reply id ${resp.id} matched no pending request`); return }
    if (resp.error) p.reject(new Error(resp.error))
    else p.resolve(resp.result ?? {})
  }

  /** Send a management request and await the device's decrypted reply.
   * `targetHex` addresses a specific identity the signer serves (its x-only
   * pubkey); omitted, the session's primary identity is addressed. The
   * mutation challenge is device-global, so replay safety holds across
   * targets and the shared mutation queue keeps rotations serialised. */
  request(
    method: string,
    params: Record<string, unknown> = {},
    // Generous by default: the round-trip crosses the operator's network, a
    // relay, and the signer's own link. A slow or flaky client connection
    // (rough WiFi, a busy laptop) needs headroom or a status read that would
    // have arrived reports a false "timeout waiting for device".
    timeoutMs = 35_000,
    targetHex?: string,
  ): Promise<Record<string, unknown>> {
    if (!requiresManagementMutationChallenge(method)) {
      return this.requestRaw(method, params, timeoutMs, undefined, undefined, undefined, targetHex)
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
        // The challenge fetch is an idempotent read (the nonce only rotates
        // when a mutation lands), so republishing lets it ride over a signer
        // relay failover (~11s) instead of failing a user-visible action.
        // The mutation itself must NEVER republish.
        requiresManagementMutationChallenge(attempt.method) ? undefined : 5_000,
        undefined,
        targetHex,
      ),
    )
    const result = this.mutationQueue.then(run, run)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Retry one idempotent read while waiting for its reply.
   * This exists for protected phone handoff: the signer may reconnect just
   * after the phone's first ephemeral management event was delivered, or its
   * first response may be lost. Each retry gets a fresh inner request id,
   * NIP-44 ciphertext, and signed Nostr event. All ids share one deadline and
   * cleanup owner, so a valid response to any attempt settles the operation.
   * Mutations and unknown future methods are rejected here rather than ever
   * gaining automatic retry semantics. */
  requestReadWithRepublish(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 35_000,
    republishIntervalMs = 5_000,
    progress: ReadRepublishProgress = {},
  ): Promise<Record<string, unknown>> {
    if (requiresManagementMutationChallenge(method)) {
      return Promise.reject(new Error('automatic republish is restricted to reviewed read-only management methods'))
    }
    if (!Number.isFinite(republishIntervalMs) || republishIntervalMs <= 0) {
      return Promise.reject(new Error('republish interval must be positive'))
    }
    return this.requestRaw(method, params, timeoutMs, undefined, republishIntervalMs, progress)
  }

  private requestRaw(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    mutationChallenge?: string,
    republishIntervalMs?: number,
    progress?: ReadRepublishProgress,
    targetHex?: string,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('transport closed'))
    if (!this.sub) return Promise.reject(new Error('not connected'))
    const target = (targetHex ?? this.devicePub).toLowerCase()
    let targetCk: Uint8Array
    try { targetCk = this.targetCk(target) } catch (e) { return Promise.reject(e) }
    const firstId = newManagementRequestId()
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.removePending(firstId)) return
        console.warn(`[hw] relay: ${method} timed out after ${timeoutMs}ms — the signer never replied (offline, wrong relay, or operator-key mismatch)`)
        reject(new Error(`timeout waiting for device (${method})`))
      }, timeoutMs)
      const pending: Pending = {
        resolve,
        reject,
        timer,
        republishTimer: null,
        ids: new Set([firstId]),
      }
      this.pending.set(firstId, pending)
      let publishSubmittedReported = false
      let publishAcceptedReported = false

      const publishFailed = () => {
        if (!this.pending.has(firstId)) return
        // A protected read handoff keeps the logical operation pending and
        // retries with a fresh id. Its overall timeout/AbortSignal still owns
        // cleanup. Ordinary reads preserve their fail-fast behaviour.
        if (republishIntervalMs) return
        this.removePending(firstId)
        console.warn(`[hw] relay: ${method} could not be published to any relay ${JSON.stringify(this.relays)}`)
        reject(new Error('failed to publish to any relay'))
      }
      const publish = (requestId: string) => {
        if (!this.pending.has(firstId)) return
        try {
          // Fresh inner and outer ids are both essential. The signer suppresses
          // a repeated inner id after processing it, so reusing one could never
          // recover when only the first response was lost.
          const payload = JSON.stringify(managementRequestPayload(
            requestId,
            method,
            params,
            mutationChallenge,
          ))
          const event = finalizeEvent(
            {
              kind: MGMT_KIND,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['p', target]],
              content: encrypt(payload, targetCk),
            },
            this.sk,
          )
          // publish returns one promise per relay; a single accept is enough.
          // nostr-tools 2.x can resolve a failed connection with a
          // "connection failure:" string, so turn that false success back into
          // a rejection before the first-fulfilled selector accepts it.
          const publishes = this.pool.publish(this.relays, event).map((published) =>
            published.then((reason) => {
              if (/^connection failure:/i.test(reason)) throw new Error(reason)
              return reason
            }))
          if (publishes.length === 0) {
            publishFailed()
            return
          }
          if (!publishSubmittedReported) {
            publishSubmittedReported = true
            try { progress?.onPublishSubmitted?.() } catch { /* progress is advisory */ }
          }
          void firstFulfilled(publishes).then(() => {
            if (!this.pending.has(firstId) || publishAcceptedReported) return
            publishAcceptedReported = true
            try { progress?.onPublishAccepted?.() } catch { /* progress is advisory */ }
          }, publishFailed)
        } catch {
          publishFailed()
        }
      }

      if (republishIntervalMs) {
        pending.republishTimer = setInterval(() => {
          if (!this.pending.has(firstId)) return
          const retryId = newManagementRequestId()
          pending.ids.add(retryId)
          this.pending.set(retryId, pending)
          publish(retryId)
        }, republishIntervalMs)
      }
      publish(firstId)
    })
  }

  close(reason: Error = new Error('transport closed')): void {
    if (this.closed) return
    this.closed = true
    this.unbindAbort()
    this.rejectPending(reason)
    try { this.sub?.close() } catch { /* ignore */ }
    try { this.pool.destroy() } catch { /* ignore */ }
    this.sub = null
  }
}
