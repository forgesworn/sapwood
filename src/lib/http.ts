// HTTP transport for connecting to the Heartwood bridge management API.
//
// Used when the bridge is running on a Pi and Sapwood is loaded from
// GitHub Pages or another origin. Speaks REST to /api/* endpoints.

import { FrameType } from './frame.js'
import type { Frame, FrameTypeValue } from './frame.js'

/**
 * Read the API bearer token from the meta tag that the Heartwood bridge
 * injects into index.html at serve time. When Sapwood is served from the
 * bridge, this returns the real token; when served from GitHub Pages
 * (Web Serial initial setup flow), the placeholder remains literal and
 * we return null so no auth header is sent.
 */
function readBridgeToken(): string | null {
  if (typeof document === 'undefined') return null
  const meta = document.querySelector('meta[name="heartwood-api-token"]')
  const value = meta?.getAttribute('content') ?? ''
  // Unsubstituted placeholder means we are not served from a bridge with auth.
  if (!value || value === '__HEARTWOOD_API_TOKEN__') return null
  return value
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

export type HttpListener = (event: HttpEvent) => void

/** HTTP transport to the bridge management API. */
export class HttpTransport {
  private baseUrl = ''
  private _connected = false
  private listeners: HttpListener[] = []
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private logSocket: WebSocket | null = null
  /** Bearer token from the bridge-injected meta tag. Null when served from GH Pages. */
  private bridgeToken: string | null = readBridgeToken()

  /** Build the Authorization header, or an empty object if no token. */
  private authHeaders(): Record<string, string> {
    return this.bridgeToken ? { Authorization: `Bearer ${this.bridgeToken}` } : {}
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

  /** Connect to the bridge at the given address. */
  async connect(address: string): Promise<void> {
    // Normalise: strip trailing slash, ensure http://
    let url = address.trim()
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`
    }
    url = url.replace(/\/+$/, '')
    this.baseUrl = url

    // Test connectivity. heartwoodd exposes /api/info; ESP32 bridge exposes
    // /api/bridge/info. Try heartwoodd first, fall back to bridge endpoint.
    // Detection logic:
    //   - probe has 'tier' field  → heartwoodd
    //   - probe has 'masters'     → ESP32 bridge
    //   - neither                 → Pi multi-instance (heartwood-device)
    try {
      let probeOk = false
      try {
        const res = await fetch(`${this.baseUrl}/api/info`, {
          headers: { ...this.authHeaders() },
        })
        if (res.ok) {
          probeOk = true
          try {
            const probe = await res.clone().json()
            if (probe.tier !== undefined) {
              this.heartwooddMode = true
              this.piMode = false
            }
          } catch { /* non-fatal */ }
        }
      } catch { /* heartwoodd not present, try bridge endpoint */ }

      if (!probeOk) {
        const res = await fetch(`${this.baseUrl}/api/bridge/info`, {
          headers: { ...this.authHeaders() },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        probeOk = true
        // Detect Pi multi-instance mode: heartwood-device returns a flat
        // status object (no 'masters' array). ESP32 bridge returns { masters }.
        try {
          const probe = await res.clone().json()
          if (!probe.masters) {
            this.piMode = true
            this.heartwooddMode = false
          } else {
            this.piMode = false
            this.heartwooddMode = false
          }
        } catch { /* non-fatal */ }
      }

      this._connected = true
      this.emit({ kind: 'connected', port: `HTTP ${url}` })

      // Connect WebSocket for log streaming.
      this.connectLogSocket()

      // Save address for next time.
      try { localStorage.setItem('sapwood-bridge-address', address) } catch { /* */ }
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
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/logs'
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
        const res = await fetch(`${this.baseUrl}/api/instance/${inst.name}/status`, {
          headers: { ...this.authHeaders() },
        })
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
      const res = await fetch(`${this.baseUrl}/api/instance/${inst}/clients`, {
        headers: { ...this.authHeaders() },
      })
      if (!res.ok || res.status === 423) return
      const data = await res.json()
      // Translate { approved: { pubkey: {...} }, pending: { ... } } to ConnectSlot[].
      const slots = Object.entries(data.approved ?? {}).map(([pubkey, _info], i) => ({
        slot_index: i,
        label: ((_info as Record<string, unknown>).label as string) ?? pubkey.slice(0, 8),
        secret: '',
        current_pubkey: pubkey,
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
      const res = await fetch(`${this.baseUrl}/api/instance/${inst}/slots/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
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
      const listRes = await fetch(`${this.baseUrl}/api/instance/${inst}/clients`, {
        headers: { ...this.authHeaders() },
      })
      if (!listRes.ok) return { type: FrameType.NACK as FrameTypeValue, payload: new Uint8Array(0) }
      const data = await listRes.json()
      const pubkeys = Object.keys(data.approved ?? {})
      const pubkey = pubkeys[slotIndex]
      if (!pubkey) return { type: FrameType.NACK as FrameTypeValue, payload: new Uint8Array(0) }
      const res = await fetch(`${this.baseUrl}/api/instance/${inst}/clients/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
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
      const res = await fetch(`${this.baseUrl}/api/instance/${inst}/clients/clear`, {
        method: 'POST',
        headers: { ...this.authHeaders() },
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
    const res = await fetch(`${this.baseUrl}/api/instance/${inst}/clients/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
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
      const listRes = await fetch(`${this.baseUrl}/api/instance/${inst}/clients`, {
        headers: { ...this.authHeaders() },
      })
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
      const res = await fetch(`${this.baseUrl}/api/instance/${inst}/clients/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
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
    const res = await fetch(`${this.baseUrl}/api/instance/${inst}/slots`, {
      headers: { ...this.authHeaders() },
    })
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

  async otaUpload(firmware: ArrayBuffer): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/device/ota`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...this.authHeaders(),
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

  // --- Internal ---

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    if (!this._connected && !path.includes('bridge/info')) {
      throw new Error('Not connected')
    }
    const mergedHeaders = {
      ...this.authHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: mergedHeaders,
    })
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
