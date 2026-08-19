// HTTP transport for connecting to the Heartwood bridge management API.
//
// Used when the bridge is running on a Pi and Sapwood is loaded from
// GitHub Pages or another origin. Speaks REST to /api/* endpoints.

import { FrameType } from './frame.js'
import type { Frame, FrameTypeValue } from './frame.js'

/**
 * Read the API bearer token from the meta tag that older Heartwood bridges
 * injected into index.html at serve time. Current heartwoodd deliberately does
 * NOT template the token (any unauthenticated LAN client could fetch `/` and
 * lift it), so the placeholder stays literal and we return null — the operator
 * is prompted for the token instead. Only ever sent back to the same origin
 * that served the page.
 */
function readBridgeToken(): string | null {
  if (typeof document === 'undefined') return null
  const meta = document.querySelector('meta[name="heartwood-api-token"]')
  const value = meta?.getAttribute('content') ?? ''
  // Unsubstituted placeholder means we are not served from a bridge with auth.
  if (!value || value === '__HEARTWOOD_API_TOKEN__') return null
  return value
}

/** localStorage key for operator-entered API tokens, keyed by exact origin.
 *  A token saved for one bridge origin must never be sent to another. */
const TOKENS_STORAGE_KEY = 'heartwood-api-tokens'

/** Legacy single-token key (pre origin-keying); migrated on first use. */
const LEGACY_TOKEN_STORAGE_KEY = 'heartwood-api-token'

/** Read the per-origin token map (persists across reloads). */
function readStoredTokens(): Record<string, string> {
  try {
    const raw = localStorage.getItem(TOKENS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
  } catch { /* corrupted or unavailable storage — start empty */ }
  return {}
}

function writeStoredTokens(tokens: Record<string, string>): void {
  try { localStorage.setItem(TOKENS_STORAGE_KEY, JSON.stringify(tokens)) } catch { /* */ }
}

/** Normalise an operator-entered address to its exact origin, or null. */
function originOf(address: string): string | null {
  let url = address.trim()
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = `http://${url}`
  url = url.replace(/\/+$/, '')
  try { return new URL(url).origin } catch { return null }
}

/** One-time migration: the pre-origin-keying build kept a single token under
 *  LEGACY_TOKEN_STORAGE_KEY and attached it to whatever bridge address was
 *  connected. Re-key it to the saved bridge address's exact origin, then drop
 *  the legacy key. If the address can't be parsed the token is dropped and the
 *  operator is simply re-prompted. */
function migrateLegacyToken(): void {
  let legacy: string | null = null
  try {
    legacy = localStorage.getItem(LEGACY_TOKEN_STORAGE_KEY)
    if (!legacy) return
    localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY)
  } catch { return }
  const address = HttpTransport.savedAddress()
  const origin = address ? originOf(address) : null
  if (!origin || !legacy.trim()) return
  const tokens = readStoredTokens()
  if (!tokens[origin]) {
    tokens[origin] = legacy.trim()
    writeStoredTokens(tokens)
  }
}

export interface PendingClientInfo {
  pubkey: string
  firstSeen: string
  lastSeen: string
  attempts: number
}

export type HttpEvent =
  | { kind: 'connected'; port: string }
  | { kind: 'disconnected' }
  | { kind: 'frame'; frame: Frame }
  | { kind: 'pending-clients'; clients: PendingClientInfo[] }
  | { kind: 'log'; line: string }
  | { kind: 'error'; message: string }
  /** The bridge answered 401: it needs a token we do not have, or rejected the
   *  one we sent (`rejected` distinguishes "wrong token" from "no token yet"). */
  | { kind: 'auth-required'; rejected: boolean }

export type HttpListener = (event: HttpEvent) => void

/** HTTP transport to the bridge management API. */
export class HttpTransport {
  private baseUrl = ''
  /** Exact origin (scheme://host[:port]) of the current baseUrl; '' until a
   *  connect is attempted. Tokens are keyed by this and never leave it. */
  private origin = ''
  private _connected = false
  private listeners: HttpListener[] = []
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private logSocket: WebSocket | null = null
  /** API token for the CURRENT origin only — operator-entered (per-origin
   *  store) or the meta-tag token of the very origin that served this page.
   *  Loaded in connect(), never carried across origins. */
  private bridgeToken: string | null = null
  /** True once the current origin has proven itself a Heartwood bridge (probe
   *  shape check) or the operator entered a token for it. Until then requests
   *  go out WITHOUT the token: the first contact with any origin is an
   *  unauthenticated probe, so a freshly entered address can never receive a
   *  stored credential it has no claim to. */
  private originTrusted = false
  /** Set once a 401 has been surfaced, so polling does not spam auth-required. */
  private authPrompted = false

  constructor() {
    migrateLegacyToken()
  }

  /** Build the Authorization header, or an empty object when there is no token
   *  for this origin or the origin has not yet been trusted. */
  private authHeaders(): Record<string, string> {
    return this.originTrusted && this.bridgeToken
      ? { Authorization: `Bearer ${this.bridgeToken}` }
      : {}
  }

  get connected(): boolean {
    return this._connected
  }

  on(listener: HttpListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private emit(event: HttpEvent) {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* */ }
    }
  }

  /** Supply an API token at runtime. Persisted to localStorage under the
   *  CURRENT origin only, so a returning operator is not re-prompted; it is
   *  never sent to any other origin. Entering a token is the operator vouching
   *  for this origin, so it also marks the origin trusted. */
  setToken(token: string): void {
    const trimmed = token.trim()
    if (!trimmed) return
    this.bridgeToken = trimmed
    this.authPrompted = false
    this.originTrusted = true
    if (this.origin) {
      const tokens = readStoredTokens()
      tokens[this.origin] = trimmed
      writeStoredTokens(tokens)
    }
  }

  /** Drop the operator-entered token for the current origin. A bridge-injected
   *  meta token, if the bridge still injects one, is unaffected. */
  clearToken(): void {
    if (this.origin) {
      const tokens = readStoredTokens()
      delete tokens[this.origin]
      writeStoredTokens(tokens)
    }
    this.bridgeToken = this.sameOriginMetaToken()
    this.authPrompted = false
  }

  /** The meta-tag token, but only when the current target IS the origin that
   *  served this page — the token came from that origin, so returning it there
   *  exposes nothing. Null in every other case. */
  private sameOriginMetaToken(): string | null {
    if (typeof window === 'undefined' || !this.origin) return null
    return this.origin === window.location.origin ? readBridgeToken() : null
  }

  /** A 401 means the bridge requires a token we do not have, or the one we
   *  sent is wrong/stale. `rejected` is true only when we actually sent a
   *  token (an unauthenticated probe that gets a 401 is not a rejection and
   *  must not clear a stored token we never sent). Surface auth-required
   *  (once, until a new token is supplied) instead of a generic error. */
  private handleUnauthorized(rejected: boolean): void {
    if (rejected) {
      this.bridgeToken = null
      if (this.origin) {
        const tokens = readStoredTokens()
        delete tokens[this.origin]
        writeStoredTokens(tokens)
      }
    }
    if (!this.authPrompted) {
      this.authPrompted = true
      this.emit({ kind: 'auth-required', rejected })
    }
  }

  /** Connect to the bridge at the given address. */
  async connect(address: string): Promise<void> {
    // Normalise: strip trailing slash, ensure http://
    let url = address.trim()
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`
    }
    url = url.replace(/\/+$/, '')
    const origin = originOf(url)
    if (!origin) {
      const err = new Error(`Invalid bridge address: ${address}`)
      this.emit({ kind: 'error', message: err.message })
      throw err
    }

    // Connecting to a different origin starts unauthenticated: tokens are
    // keyed by exact origin, so the previous origin's token never follows us
    // here, and the operator is re-prompted if this origin needs one.
    if (origin !== this.origin) {
      this.origin = origin
      this.originTrusted = false
    }
    this.baseUrl = url
    // Load this origin's own token (operator-entered), or the meta token when
    // the target is the origin that served this page. A same-origin meta token
    // came FROM this origin, so it is trusted by construction.
    const metaToken = this.sameOriginMetaToken()
    if (metaToken) {
      this.bridgeToken = metaToken
      this.originTrusted = true
    } else {
      this.bridgeToken = readStoredTokens()[origin] ?? null
    }

    // Save the address on attempt (not just on success) so the token-entry
    // retry after a 401 knows where to reconnect.
    try { localStorage.setItem('sapwood-bridge-address', address) } catch { /* */ }

    // Test connectivity. heartwoodd exposes /api/info; ESP32 bridge exposes
    // /api/bridge/info. Try heartwoodd first, fall back to bridge endpoint.
    // Detection logic:
    //   - probe has 'tier' field  → heartwoodd
    //   - probe has 'masters'     → ESP32 bridge
    //   - neither                 → Pi multi-instance (heartwood-device)
    // The first probe of an untrusted origin deliberately carries NO token;
    // only once a reply passes the shape check (or the operator enters a
    // token) is the stored token attached to further requests.
    const probeAuth = { skipAuth: !this.originTrusted }
    try {
      let probeOk = false
      try {
        const res = await this.apiFetch(`${this.baseUrl}/api/info`, undefined, probeAuth)
        if (res.ok) {
          probeOk = true
          try {
            const probe = await res.clone().json()
            if (probe.tier !== undefined) {
              this.heartwooddMode = true
              this.piMode = false
              this.originTrusted = true
            }
          } catch { /* non-fatal */ }
        }
      } catch { /* heartwoodd not present, try bridge endpoint */ }

      if (!probeOk) {
        const res = await this.apiFetch(`${this.baseUrl}/api/bridge/info`, undefined, probeAuth)
        // 404 is OK (fresh Heartwood in setup mode). Anything else is a real error.
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)

        if (res.ok) {
          probeOk = true
          // Detect Pi multi-instance mode: heartwood-device returns a flat
          // status object (no 'masters' array). ESP32 bridge returns { masters }.
          try {
            const probe = await res.clone().json()
            if (probe && typeof probe === 'object') this.originTrusted = true
            if (!probe.masters) {
              this.piMode = true
              this.heartwooddMode = false
            } else {
              this.piMode = false
              this.heartwooddMode = false
            }
          } catch { /* non-fatal */ }
        }
      }

      this._connected = true
      // Connected: any earlier auth prompt is resolved, so a later 401 (e.g.
      // the token was rotated) re-prompts rather than failing silently.
      this.authPrompted = false
      this.emit({ kind: 'connected', port: `HTTP ${url}` })

      // Connect WebSocket for log streaming.
      this.connectLogSocket()
    } catch (e) {
      this._connected = false
      this.emit({ kind: 'error', message: e instanceof Error ? e.message : 'Connection failed' })
      throw e
    }
  }

  async disconnect(): Promise<void> {
    this._connected = false
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    if (this.logSocket) {
      this.logSocket.close()
      this.logSocket = null
    }
    this.emit({ kind: 'disconnected' })
  }

  private connectLogSocket(): void {
    // heartwoodd authenticates this socket with the bearer token as a query
    // param (browsers cannot set headers on a WebSocket upgrade). The token is
    // this origin's own and only sent once the origin is trusted — exactly the
    // same policy as the Authorization header. Older daemons that leave
    // /api/logs public simply ignore the param; setups without a token connect
    // without it as before.
    const base = this.baseUrl.replace(/^http/, 'ws') + '/api/logs'
    const wsUrl = this.originTrusted && this.bridgeToken
      ? `${base}?token=${encodeURIComponent(this.bridgeToken)}`
      : base
    try {
      const ws = new WebSocket(wsUrl)
      ws.onmessage = (event) => {
        if (typeof event.data === 'string' && event.data.trim()) {
          this.emit({ kind: 'log', line: event.data.trim() })
        }
      }
      ws.onerror = () => {
        // Non-fatal -- log streaming is best-effort.
      }
      ws.onclose = () => {
        this.logSocket = null
        // Reconnect if still connected.
        if (this._connected) {
          setTimeout(() => this.connectLogSocket(), 2000)
        }
      }
      this.logSocket = ws
    } catch {
      // WebSocket not available or blocked -- continue without logs.
    }
  }

  /** Get the saved bridge address from localStorage. */
  static savedAddress(): string | null {
    try { return localStorage.getItem('sapwood-bridge-address') } catch { return null }
  }

  // --- API methods that emit frame-shaped events ---

  /** Known Pi instances exposed via nginx /api/instance/<name>/. */
  private static readonly PI_INSTANCES: { name: string; label: string; port: number }[] = [
    { name: 'personal', label: 'The Crypto Donkey', port: 3000 },
    { name: 'forgesworn', label: 'ForgeSworn', port: 3001 },
  ]

  async fetchStatus(): Promise<void> {
    try {
      if (this.heartwooddMode) {
        // heartwoodd: /api/status returns { masters: [...], daemon: {...} }
        const res = await this.fetch('/api/status')
        if (res.status === 423) return
        if (!res.ok) return
        const data = await res.json()
        const payload = new TextEncoder().encode(JSON.stringify(data.masters))
        this.emit({
          kind: 'frame',
          frame: { type: FrameType.PROVISION_LIST_RESPONSE as FrameTypeValue, payload },
        })
        return
      }

      // ESP32 bridge format (returns { masters: [...] }).
      const res = await this.fetch('/api/status')
      if (res.status === 423) return
      const data = await res.json()

      if (data.masters) {
        // ESP32 bridge — use as-is.
        const payload = new TextEncoder().encode(JSON.stringify(data.masters))
        this.emit({
          kind: 'frame',
          frame: { type: FrameType.PROVISION_LIST_RESPONSE as FrameTypeValue, payload },
        })
        return
      }

      // Pi multi-instance: query each instance via nginx proxy.
      const masters = await this.fetchPiInstances()
      const payload = new TextEncoder().encode(JSON.stringify(masters))
      this.emit({
        kind: 'frame',
        frame: { type: FrameType.PROVISION_LIST_RESPONSE as FrameTypeValue, payload },
      })
    } catch (e) {
      this.handleError(e)
    }
  }

  /** Query all Pi heartwood instances and return as MasterInfo[]. */
  private async fetchPiInstances() {
    const results = await Promise.allSettled(
      HttpTransport.PI_INSTANCES.map(async (inst, slot) => {
        const res = await this.apiFetch(`${this.baseUrl}/api/instance/${inst.name}/status`)
        if (!res.ok) return null
        const data = await res.json()
        return {
          slot,
          label: inst.label,
          mode: data.mode === 'hsm' ? 3 : data.mode === 'bunker' ? 0 : data.mode === 'tree-mnemonic' ? 1 : data.mode === 'tree-nsec' ? 2 : 0,
          npub: data.npub ?? '',
          instanceName: inst.name,
          bunkerUri: data.bunker_uri ?? '',
          status: data.status ?? 'unknown',
          locked: data.locked ?? false,
        }
      }),
    )
    return results
      .map((r) => (r.status === 'fulfilled' ? r.value : null))
      .filter((m) => m !== null)
  }

  /** Get the instance name for a given master slot index. */
  private instanceForSlot(slot: number): string {
    return HttpTransport.PI_INSTANCES[slot]?.name ?? 'hsm'
  }

  /** True once we know the backend is a Pi (no /api/slots/ endpoint). */
  private piMode = false

  /** True once we know the backend is heartwoodd (native daemon API). */
  private heartwooddMode = false

  async fetchSlots(slot: number): Promise<void> {
    try {
      if (this.heartwooddMode) {
        // heartwoodd: /api/slots/{master} returns ConnectSlot[] directly.
        const res = await this.fetch(`/api/slots/${slot}`)
        if (res.status === 423) return
        const data = await res.json()
        this.emit({
          kind: 'frame',
          frame: { type: 0x43 as FrameTypeValue, payload: new TextEncoder().encode(JSON.stringify(data)) },
        })
        return
      }

      if (!this.piMode) {
        // Try ESP32 bridge endpoint first.
        const res = await this.fetch(`/api/slots/${slot}`)
        if (res.status === 404) {
          this.piMode = true
        } else {
          if (res.status === 423) return
          const data = await res.json()
          this.emit({
            kind: 'frame',
            frame: { type: 0x43 as FrameTypeValue, payload: new TextEncoder().encode(JSON.stringify(data)) },
          })
          return
        }
      }

      // Pi mode: fetch from per-instance clients endpoint.
      const inst = this.instanceForSlot(slot)
      const res = await this.apiFetch(`${this.baseUrl}/api/instance/${inst}/clients`)
      if (!res.ok || res.status === 423) return
      const data = await res.json()
      // Translate { approved: { pubkey: {...} }, pending: { ... } } to ConnectSlot[].
      const slots = Object.entries(data.approved ?? {}).map(([pubkey, _info], i) => ({
        slot_index: i,
        label: ((_info as Record<string, unknown>).label as string) ?? pubkey.slice(0, 8),
        secret: '',
        current_pubkey: pubkey,
        authorized_pubkeys: [pubkey],
        allowed_methods: ((_info as Record<string, unknown>).allowed_methods as string[]) ?? ['sign_event'],
        allowed_kinds: ((_info as Record<string, unknown>).allowedKinds as number[]) ?? ((_info as Record<string, unknown>).allowed_kinds as number[]) ?? [],
        auto_approve: true,
        signing_approved: true,
      }))
      this.emit({
        kind: 'frame',
        frame: { type: 0x43 as FrameTypeValue, payload: new TextEncoder().encode(JSON.stringify(slots)) },
      })
      // Emit pending clients separately.
      const pending: PendingClientInfo[] = Object.entries(data.pending ?? {}).map(([pubkey, info]) => ({
        pubkey,
        firstSeen: (info as Record<string, unknown>).firstSeen as string ?? '',
        lastSeen: (info as Record<string, unknown>).lastSeen as string ?? '',
        attempts: (info as Record<string, unknown>).attempts as number ?? 0,
      }))
      this.emit({ kind: 'pending-clients', clients: pending })
    } catch (e) {
      this.handleError(e)
    }
  }

  /**
   * Remove an identity from the signer (heartwoodd only). In Hard mode the
   * device shows the slot + npub on its OLED and waits for a physical hold
   * before deleting, then reboots — so this can take a human's worth of time
   * and the device drops off the USB bus right after succeeding.
   */
  async deleteMaster(slot: number): Promise<void> {
    if (!this.heartwooddMode) {
      throw new Error('Removing an identity over HTTP needs heartwoodd')
    }
    const res = await this.fetch(`/api/masters/${slot}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      throw new Error((err as Record<string, string>).error ?? `Remove failed: ${res.status}`)
    }
  }

  async createSlot(masterSlot: number, label: string): Promise<Record<string, unknown>> {
    if (this.heartwooddMode) {
      const res = await this.fetch(`/api/slots/${masterSlot}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error((err as Record<string, string>).error ?? `Create failed: ${res.status}`)
      }
      return res.json()
    }
    if (this.piMode) {
      // Pi mode: create a pre-authorised connect slot with a secret.
      // The bunker auto-approves clients that connect with the matching secret.
      const inst = this.instanceForSlot(masterSlot)
      const res = await this.apiFetch(`${this.baseUrl}/api/instance/${inst}/slots/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error((err as Record<string, string>).error ?? `Create failed: ${res.status}`)
      }
      return res.json()
    }
    const res = await this.fetch(`/api/slots/${masterSlot}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    })
    if (!res.ok) throw new Error(`Create slot failed: ${res.status}`)
    return res.json()
  }

  async revokeSlot(masterSlot: number, slotIndex: number): Promise<Frame> {
    if (this.heartwooddMode) {
      const res = await this.fetch(`/api/slots/${masterSlot}/${slotIndex}`, { method: 'DELETE' })
      const type = res.ok ? FrameType.ACK : FrameType.NACK
      return { type: type as FrameTypeValue, payload: new Uint8Array(0) }
    }
    if (this.piMode) {
      // In Pi mode, slotIndex is the index into the approved clients list.
      // We need the pubkey to revoke. Fetch clients first, then revoke by pubkey.
      const inst = this.instanceForSlot(masterSlot)
      const listRes = await this.apiFetch(`${this.baseUrl}/api/instance/${inst}/clients`)
      if (!listRes.ok) return { type: FrameType.NACK as FrameTypeValue, payload: new Uint8Array(0) }
      const data = await listRes.json()
      const pubkeys = Object.keys(data.approved ?? {})
      const pubkey = pubkeys[slotIndex]
      if (!pubkey) return { type: FrameType.NACK as FrameTypeValue, payload: new Uint8Array(0) }
      const res = await this.apiFetch(`${this.baseUrl}/api/instance/${inst}/clients/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey }),
      })
      const type = res.ok ? FrameType.ACK : FrameType.NACK
      return { type: type as FrameTypeValue, payload: new Uint8Array(0) }
    }
    const res = await this.fetch(`/api/slots/${masterSlot}/${slotIndex}`, { method: 'DELETE' })
    const type = res.ok ? FrameType.ACK : FrameType.NACK
    return { type: type as FrameTypeValue, payload: new Uint8Array(0) }
  }

  /** Clear all approved and pending clients for a Pi instance. Not used in heartwooddMode. */
  async clearClients(masterSlot: number): Promise<Frame> {
    if (this.heartwooddMode) {
      // heartwoodd uses per-slot revocation; no bulk clear endpoint.
      return { type: FrameType.NACK as FrameTypeValue, payload: new Uint8Array(0) }
    }
    if (this.piMode) {
      const inst = this.instanceForSlot(masterSlot)
      const res = await this.apiFetch(`${this.baseUrl}/api/instance/${inst}/clients/clear`, {
        method: 'POST',
      })
      const type = res.ok ? FrameType.ACK : FrameType.NACK
      return { type: type as FrameTypeValue, payload: new Uint8Array(0) }
    }
    // ESP32 mode: revoke one by one (no bulk clear endpoint)
    return { type: FrameType.NACK as FrameTypeValue, payload: new Uint8Array(0) }
  }

  /** Approve a pending client by pubkey (Pi mode). */
  async approveClient(masterSlot: number, pubkey: string, label?: string): Promise<boolean> {
    const inst = this.instanceForSlot(masterSlot)
    const res = await this.apiFetch(`${this.baseUrl}/api/instance/${inst}/clients/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey, label }),
    })
    return res.ok
  }

  async updateSlot(masterSlot: number, slotIndex: number, changes: Record<string, unknown>): Promise<Frame> {
    if (this.heartwooddMode) {
      const res = await this.fetch(`/api/slots/${masterSlot}/${slotIndex}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      })
      const type = res.ok ? FrameType.ACK : FrameType.NACK
      return { type: type as FrameTypeValue, payload: new Uint8Array(0) }
    }
    if (this.piMode) {
      // Pi mode: look up pubkey from client list, then re-approve with updated fields.
      const inst = this.instanceForSlot(masterSlot)
      const listRes = await this.apiFetch(`${this.baseUrl}/api/instance/${inst}/clients`)
      if (!listRes.ok) return { type: FrameType.NACK as FrameTypeValue, payload: new Uint8Array(0) }
      const data = await listRes.json()
      const pubkeys = Object.keys(data.approved ?? {})
      const pubkey = pubkeys[slotIndex]
      if (!pubkey) return { type: FrameType.NACK as FrameTypeValue, payload: new Uint8Array(0) }
      const existing = data.approved[pubkey] ?? {}
      // Build the approve payload. If allowed_kinds is explicitly null, omit it
      // to clear restrictions. If it's an array, send it.
      const approveBody: Record<string, unknown> = { pubkey, label: existing.label }
      const newKinds = 'allowed_kinds' in changes ? changes.allowed_kinds : existing.allowedKinds
      if (newKinds != null) {
        approveBody.allowed_kinds = newKinds
      }
      const res = await this.apiFetch(`${this.baseUrl}/api/instance/${inst}/clients/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(approveBody),
      })
      const type = res.ok ? FrameType.ACK : FrameType.NACK
      return { type: type as FrameTypeValue, payload: new Uint8Array(0) }
    }
    const res = await this.fetch(`/api/slots/${masterSlot}/${slotIndex}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    })
    const type = res.ok ? FrameType.ACK : FrameType.NACK
    return { type: type as FrameTypeValue, payload: new Uint8Array(0) }
  }

  /** Fetch connect slots (Pi mode) — returns array of { label, secret, bunker_uri, clients }. */
  async getConnectSlots(masterSlot: number): Promise<{ label: string; secret: string; bunker_uri: string; clients: string[] }[]> {
    if (!this.piMode) return []
    const inst = this.instanceForSlot(masterSlot)
    const res = await this.apiFetch(`${this.baseUrl}/api/instance/${inst}/slots`)
    if (!res.ok) return []
    return res.json()
  }

  async getSlotUri(masterSlot: number, slotIndex: number): Promise<string> {
    const res = await this.fetch(`/api/slots/${masterSlot}/${slotIndex}/uri`)
    const data = await res.json()
    return data.bunker_uri as string
  }

  async factoryReset(): Promise<Frame> {
    const res = await this.fetch('/api/device/factory-reset', { method: 'POST' })
    const type = res.ok ? FrameType.ACK : FrameType.NACK
    return { type: type as FrameTypeValue, payload: new Uint8Array(0) }
  }

  async bridgeInfo(): Promise<Record<string, unknown>> {
    const res = await this.fetch('/api/bridge/info')
    return res.json()
  }

  async otaUpload(firmware: ArrayBuffer, signatureHex?: string): Promise<void> {
    const res = await this.apiFetch(`${this.baseUrl}/api/device/ota`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        // The release signature rides a header; the daemon forwards it to the
        // device in OTA_BEGIN (signature-enforcing firmware refuses without it).
        ...(signatureHex ? { 'X-Firmware-Signature': signatureHex } : {}),
      },
      body: firmware,
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      throw new Error((body as Record<string, string>).error ?? `OTA failed: ${res.status}`)
    }
  }

  async bridgeRestart(): Promise<void> {
    await this.fetch('/api/bridge/restart', { method: 'POST' })
    this._connected = false
    this.emit({ kind: 'disconnected' })
  }

  /** Fetch pending approval requests. */
  async fetchApprovals(): Promise<Record<string, unknown>[]> {
    if (!this.heartwooddMode) return []
    try {
      const res = await this.fetch('/api/approvals')
      if (!res.ok) return []
      return res.json()
    } catch { return [] }
  }

  /** Approve or deny a pending request. */
  async resolveApproval(id: string, action: 'approve' | 'deny'): Promise<boolean> {
    if (!this.heartwooddMode) return false
    try {
      const res = await this.fetch(`/api/approvals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      return res.ok
    } catch { return false }
  }

  // --- Internal ---

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    if (!this._connected && !path.includes('bridge/info')) {
      throw new Error('Not connected')
    }
    return this.apiFetch(`${this.baseUrl}${path}`, init)
  }

  /** Raw fetch with auth headers merged and 401 surfaced as auth-required.
   *  The token itself is never logged or included in errors.
   *  `opts.skipAuth` forces an unauthenticated request (used for the first
   *  probe of an origin, before it has identified as a Heartwood bridge). */
  private async apiFetch(url: string, init?: RequestInit, opts?: { skipAuth?: boolean }): Promise<Response> {
    const auth = opts?.skipAuth ? {} : this.authHeaders()
    const mergedHeaders = {
      ...auth,
      ...(init?.headers as Record<string, string> | undefined),
    }
    const res = await fetch(url, { ...init, headers: mergedHeaders })
    if (res.status === 401) {
      this.handleUnauthorized('Authorization' in auth)
      return res
    }
    return this.handleBusy(res)
  }

  private handleBusy(res: Response): Response {
    if (res.status === 423) {
      // Device busy (serial lock held by relay handler). Silently skip —
      // the next poll cycle will retry. Not an error worth surfacing.
      return new Response('{}', { status: 423 })
    }
    return res
  }

  private handleError(e: unknown) {
    const msg = e instanceof Error ? e.message : 'Request failed'
    this.emit({ kind: 'error', message: msg })
    // If it's a network error, mark as disconnected.
    if (msg.includes('fetch') || msg.includes('NetworkError') || msg.includes('Failed to fetch')) {
      this._connected = false
      this.emit({ kind: 'disconnected' })
    }
  }
}

export const httpTransport = new HttpTransport()
