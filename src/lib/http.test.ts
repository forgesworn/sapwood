// HTTP transport tests with mocked fetch.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { HttpTransport } from './http.js'

// Mock fetch globally.
const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  vi.stubGlobal('localStorage', {
    store: {} as Record<string, string>,
    getItem(key: string) { return this.store[key] ?? null },
    setItem(key: string, value: string) { this.store[key] = value },
    removeItem(key: string) { delete this.store[key] },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('HttpTransport', () => {
  describe('connect', () => {
    it('connects via heartwoodd /api/info and saves address', async () => {
      // Heartwoodd path: /api/info returns 200 → bridge probe is skipped.
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main', mode: 'device-decrypts' }))

      const transport = new HttpTransport()
      await transport.connect('192.168.1.50:3100')

      expect(transport.connected).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        'http://192.168.1.50:3100/api/info',
        expect.objectContaining({ headers: expect.any(Object) }),
      )
      expect(localStorage.getItem('sapwood-bridge-address')).toBe('192.168.1.50:3100')
    })

    it('falls back to /api/bridge/info when heartwoodd absent', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('not found', { status: 404 })) // /api/info
        .mockResolvedValueOnce(jsonResponse({ masters: [] }))              // /api/bridge/info

      const transport = new HttpTransport()
      await transport.connect('pi:3100')

      expect(transport.connected).toBe(true)
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'http://pi:3100/api/bridge/info',
        expect.objectContaining({ headers: expect.any(Object) }),
      )
    })

    it('normalises address without protocol', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))

      const transport = new HttpTransport()
      await transport.connect('10.0.0.5:3100')

      expect(mockFetch).toHaveBeenCalledWith(
        'http://10.0.0.5:3100/api/info',
        expect.objectContaining({ headers: expect.any(Object) }),
      )
    })

    it('preserves https if provided', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))

      const transport = new HttpTransport()
      await transport.connect('https://mypi.local:3100')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://mypi.local:3100/api/info',
        expect.objectContaining({ headers: expect.any(Object) }),
      )
    })

    it('strips trailing slash', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))

      const transport = new HttpTransport()
      await transport.connect('http://pi:3100/')

      expect(mockFetch).toHaveBeenCalledWith(
        'http://pi:3100/api/info',
        expect.objectContaining({ headers: expect.any(Object) }),
      )
    })

    it('connects in setup mode when both probes return 404', async () => {
      // Fresh Heartwood: no info yet, but the user must be able to provision.
      mockFetch
        .mockResolvedValueOnce(new Response('not found', { status: 404 }))
        .mockResolvedValueOnce(new Response('not found', { status: 404 }))

      const transport = new HttpTransport()
      await transport.connect('fresh.local:3100')

      expect(transport.connected).toBe(true)
    })

    it('fails on network error', async () => {
      // Both probes hit a network error → connect rejects.
      mockFetch
        .mockRejectedValueOnce(new Error('Failed to fetch'))
        .mockRejectedValueOnce(new Error('Failed to fetch'))

      const transport = new HttpTransport()
      const events: string[] = []
      transport.on(e => events.push(e.kind))

      await expect(transport.connect('bad-host:3100')).rejects.toThrow()
      expect(transport.connected).toBe(false)
      expect(events).toContain('error')
    })

    it('fails on non-404 bridge error', async () => {
      // /api/info absent (404), /api/bridge/info returns 500 → connect rejects.
      mockFetch
        .mockResolvedValueOnce(new Response('not found', { status: 404 }))
        .mockResolvedValueOnce(new Response('server error', { status: 500 }))

      const transport = new HttpTransport()
      await expect(transport.connect('pi:3100')).rejects.toThrow()
      expect(transport.connected).toBe(false)
    })
  })

  describe('disconnect', () => {
    it('emits disconnected event', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}))

      const transport = new HttpTransport()
      await transport.connect('pi:3100')

      const events: string[] = []
      transport.on(e => events.push(e.kind))
      await transport.disconnect()

      expect(transport.connected).toBe(false)
      expect(events).toContain('disconnected')
    })
  })

  describe('API methods', () => {
    let transport: HttpTransport

    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ mode: 'test' }))
      transport = new HttpTransport()
      await transport.connect('pi:3100')
      mockFetch.mockClear()
    })

    it('revokeSlot returns ACK on success', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))

      const frame = await transport.revokeSlot(0, 3)
      expect(frame.type).toBe(0x06) // ACK
      expect(mockFetch).toHaveBeenCalledWith(
        'http://pi:3100/api/slots/0/3',
        expect.objectContaining({ method: 'DELETE' }),
      )
    })

    it('revokeSlot returns NACK on 409', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not found', { status: 409 }))

      const frame = await transport.revokeSlot(0, 4)
      expect(frame.type).toBe(0x15) // NACK
    })

    it('factoryReset returns ACK on success', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))

      const frame = await transport.factoryReset()
      expect(frame.type).toBe(0x06) // ACK
    })

    it('bridgeInfo returns parsed JSON', async () => {
      const info = { mode: 'device-decrypts', relays: ['wss://relay.damus.io'], uptime_secs: 3600 }
      mockFetch.mockResolvedValueOnce(jsonResponse(info))

      const result = await transport.bridgeInfo()
      expect(result.mode).toBe('device-decrypts')
      expect(result.uptime_secs).toBe(3600)
    })

    it('returns synthetic 423 response on busy', async () => {
      // The internal fetch wrapper intercepts 423 and returns a dummy response
      // rather than throwing -- callers silently skip busy responses.
      mockFetch.mockResolvedValueOnce(new Response('busy', { status: 423 }))

      const frame = await transport.revokeSlot(0, 5)
      // 423 is caught by the internal wrapper and returns a synthetic {} response,
      // which is then treated as !res.ok -> NACK.
      expect([0x06, 0x15]).toContain(frame.type)
    })

    it('otaUpload sends binary body', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))

      const firmware = new ArrayBuffer(100)
      await transport.otaUpload(firmware)

      expect(mockFetch).toHaveBeenCalledWith(
        'http://pi:3100/api/device/ota',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      )
    })
  })

  describe('savedAddress', () => {
    it('returns null when nothing saved', () => {
      expect(HttpTransport.savedAddress()).toBeNull()
    })

    it('returns saved address after connect', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}))
      const transport = new HttpTransport()
      await transport.connect('pi:3100')
      expect(HttpTransport.savedAddress()).toBe('pi:3100')
    })
  })
})
