// HTTP transport for connecting to the Heartwood bridge management API.
//
// Used when the bridge is running on a Pi and Sapwood is loaded from
// GitHub Pages or another origin. Speaks REST to /api/* endpoints.

import { FrameType } from './frame.js'
import type { Frame, FrameTypeValue } from './frame.js'

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

    // Test connectivity with bridge info endpoint.
    try {
      const res = await fetch(`${this.baseUrl}/api/bridge/info`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this._connected = true
      this.emit({ kind: 'connected', port: `HTTP ${url}` })

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
    this.emit({ kind: 'disconnected' })
  }

  /** Get the saved bridge address from localStorage. */
  static savedAddress(): string | null {
    try { return localStorage.getItem('sapwood-bridge-address') } catch { return null }
  }

  // --- API methods that emit frame-shaped events ---

  async fetchStatus(): Promise<void> {
    try {
      const res = await this.fetch('/api/status')
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
      headers: { 'Content-Type': 'application/octet-stream' },
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
    const res = await fetch(`${this.baseUrl}${path}`, init)
    if (res.status === 423) {
      throw new Error('Device busy -- signing in progress')
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
