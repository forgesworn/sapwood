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

export type HttpEvent =
  | { kind: 'connected'; port: string }
  | { kind: 'disconnected' }
  | { kind: 'frame'; frame: Frame }
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

    // Test connectivity with bridge info endpoint. This is a public route
    // (no auth required) so it works regardless of whether we have a token.
    // Whether the token we have is *correct* gets verified by the first
    // protected call (fetchStatus below).
    try {
      const res = await fetch(`${this.baseUrl}/api/bridge/info`, {
        headers: { ...this.authHeaders() },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
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

  async fetchStatus(): Promise<void> {
    try {
      const res = await this.fetch('/api/status')
      if (res.status === 423) return
      const data = await res.json()

      // Emit a synthetic PROVISION_LIST_RESPONSE frame.
      const payload = new TextEncoder().encode(JSON.stringify(data.masters))
      this.emit({
        kind: 'frame',
        frame: { type: FrameType.PROVISION_LIST_RESPONSE as FrameTypeValue, payload },
      })
    } catch (e) {
      this.handleError(e)
    }
  }

  async fetchClients(slot: number): Promise<void> {
    try {
      const res = await this.fetch(`/api/clients/${slot}`)
      if (res.status === 423) return
      const payload = new Uint8Array(await res.arrayBuffer())
      this.emit({
        kind: 'frame',
        frame: { type: FrameType.POLICY_LIST_RESPONSE as FrameTypeValue, payload },
      })
    } catch (e) {
      this.handleError(e)
    }
  }

  async revokeClient(slot: number, pubkey: string): Promise<Frame> {
    const res = await this.fetch(`/api/clients/${slot}/${pubkey}`, { method: 'DELETE' })
    const type = res.ok ? FrameType.ACK : FrameType.NACK
    return { type: type as FrameTypeValue, payload: new Uint8Array(0) }
  }

  async updateClient(slot: number, policy: Record<string, unknown>): Promise<Frame> {
    const res = await this.fetch(`/api/clients/${slot}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy),
    })
    const type = res.ok ? FrameType.ACK : FrameType.NACK
    return { type: type as FrameTypeValue, payload: new Uint8Array(0) }
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
