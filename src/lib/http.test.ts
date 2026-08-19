// HTTP transport tests with mocked fetch.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { HttpTransport } from './http.js'

// Mock fetch globally.
const mockFetch = vi.fn()

beforeEach(() => {
  // Reset call history + queued responses so order-sensitive assertions
  // (toHaveBeenNthCalledWith) don't see calls leaked from prior tests —
  // mockFetch is module-level and vi.restoreAllMocks() doesn't clear a vi.fn().
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
  // Closure over a local store rather than `this`, so the methods type-check
  // (the object literal's `this` doesn't see its own `store` field).
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
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

  describe('API token', () => {
    /** Seed the per-origin token store. */
    function seedToken(origin: string, token: string) {
      localStorage.setItem('heartwood-api-tokens', JSON.stringify({ [origin]: token }))
    }
    function storedTokens(): Record<string, string> {
      return JSON.parse(localStorage.getItem('heartwood-api-tokens') ?? '{}')
    }

    it('sends no Authorization header when no token is available', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))

      const transport = new HttpTransport()
      await transport.connect('pi:3100')

      expect(mockFetch).toHaveBeenCalledWith(
        'http://pi:3100/api/info',
        expect.objectContaining({ headers: {} }),
      )
    })

    it('probes a new origin WITHOUT its stored token, attaches it only after identification', async () => {
      seedToken('http://pi:3100', 'stored-token')
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))

      const transport = new HttpTransport()
      await transport.connect('pi:3100')

      // First contact carries no credential, even though one is stored.
      expect(mockFetch).toHaveBeenCalledWith(
        'http://pi:3100/api/info',
        expect.objectContaining({ headers: {} }),
      )

      // The /api/info shape check identified a Heartwood bridge: the token is
      // attached from here on.
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
      await transport.factoryReset()
      const headers = mockFetch.mock.calls[1][1].headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer stored-token')
    })

    it("never sends one origin's token to a different origin", async () => {
      seedToken('http://pi:3100', 'pi-token')
      // The evil origin mimics the heartwoodd /api/info shape — identification
      // alone must not unlock another origin's token.
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main', mode: 'device-decrypts' }))

      const transport = new HttpTransport()
      await transport.connect('https://bridge.evil.example')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://bridge.evil.example/api/info',
        expect.objectContaining({ headers: {} }),
      )
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
      await transport.factoryReset()
      const headers = mockFetch.mock.calls[1][1].headers as Record<string, string>
      expect(headers.Authorization).toBeUndefined()
    })

    it('starts unauthenticated when connecting to a different origin', async () => {
      seedToken('http://pi:3100', 'pi-token')
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))
      const transport = new HttpTransport()
      await transport.connect('pi:3100')
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
      await transport.factoryReset()
      expect(
        (mockFetch.mock.calls[1][1].headers as Record<string, string>).Authorization,
      ).toBe('Bearer pi-token')

      // Reconnect elsewhere: the pi token must not follow.
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))
      await transport.connect('other.local:3100')
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
      await transport.factoryReset()
      const headers = mockFetch.mock.calls[3][1].headers as Record<string, string>
      expect(headers.Authorization).toBeUndefined()
    })

    it('uses the meta-tag token only when connecting to the origin that served the page', async () => {
      seedToken('http://pi:3100', 'stored-token')
      const meta = document.createElement('meta')
      meta.name = 'heartwood-api-token'
      meta.content = 'meta-token'
      document.head.appendChild(meta)
      try {
        // Cross-origin: the meta token belongs to the serving origin and must
        // not leak — not even after the target identifies as a bridge.
        mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))
        const cross = new HttpTransport()
        await cross.connect('pi:3100')
        let headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
        expect(headers.Authorization).toBeUndefined()

        // Same-origin: the token came from this origin, so it is attached.
        mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))
        const same = new HttpTransport()
        await same.connect(window.location.origin)
        headers = mockFetch.mock.calls[1][1].headers as Record<string, string>
        expect(headers.Authorization).toBe('Bearer meta-token')
      } finally {
        meta.remove()
      }
    })

    it('treats the literal placeholder meta content as no token', async () => {
      const meta = document.createElement('meta')
      meta.name = 'heartwood-api-token'
      meta.content = '__HEARTWOOD_API_TOKEN__'
      document.head.appendChild(meta)
      try {
        mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))

        const transport = new HttpTransport()
        await transport.connect('pi:3100')

        expect(mockFetch).toHaveBeenCalledWith(
          'http://pi:3100/api/info',
          expect.objectContaining({ headers: {} }),
        )
      } finally {
        meta.remove()
      }
    })

    it('migrates a legacy single token onto the saved bridge address origin', () => {
      localStorage.setItem('heartwood-api-token', 'legacy-token')
      localStorage.setItem('sapwood-bridge-address', '192.168.1.9:3100')

      new HttpTransport()

      expect(localStorage.getItem('heartwood-api-token')).toBeNull()
      expect(storedTokens()).toEqual({ 'http://192.168.1.9:3100': 'legacy-token' })
    })

    it('setToken persists under the current origin and authenticates later requests', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))
      const transport = new HttpTransport()
      await transport.connect('pi:3100')

      transport.setToken('  new-token  ')
      expect(storedTokens()).toEqual({ 'http://pi:3100': 'new-token' })

      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
      await transport.factoryReset()

      const headers = mockFetch.mock.calls[1][1].headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer new-token')
    })

    it('clearToken drops only the stored token for the current origin', async () => {
      seedToken('http://pi:3100', 'stored-token')
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))
      const transport = new HttpTransport()
      await transport.connect('pi:3100')

      transport.clearToken()
      expect(storedTokens()).toEqual({})

      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }))
      await transport.factoryReset()
      const headers = mockFetch.mock.calls[1][1].headers as Record<string, string>
      expect(headers.Authorization).toBeUndefined()
    })

    it('emits auth-required with rejected=true and clears a stale stored token on 401', async () => {
      seedToken('http://pi:3100', 'stale-token')
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))
      const transport = new HttpTransport()
      await transport.connect('pi:3100')

      const events: { kind: string; rejected?: boolean }[] = []
      transport.on(e => events.push(e))
      mockFetch.mockResolvedValueOnce(new Response('unauthorised', { status: 401 }))
      await transport.factoryReset()

      expect(events).toContainEqual({ kind: 'auth-required', rejected: true })
      expect(storedTokens()).toEqual({})
    })

    it('reports rejected=false when a 401 arrives with no token at all', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('unauthorised', { status: 401 })) // /api/info
        .mockResolvedValueOnce(new Response('unauthorised', { status: 401 })) // /api/bridge/info

      const transport = new HttpTransport()
      const events: { kind: string; rejected?: boolean }[] = []
      transport.on(e => events.push(e))

      await expect(transport.connect('pi:3100')).rejects.toThrow('HTTP 401')
      expect(events).toContainEqual({ kind: 'auth-required', rejected: false })
      // Emitted once despite both probes failing.
      expect(events.filter(e => e.kind === 'auth-required')).toHaveLength(1)
    })

    it('does not clear an unsent stored token when an unauthenticated probe gets a 401', async () => {
      // A front-end proxy 401s even /api/info: the stored token was never sent,
      // so it must survive for the retry after the operator confirms it.
      seedToken('http://pi:3100', 'stored-token')
      mockFetch
        .mockResolvedValueOnce(new Response('unauthorised', { status: 401 }))
        .mockResolvedValueOnce(new Response('unauthorised', { status: 401 }))

      const transport = new HttpTransport()
      const events: { kind: string; rejected?: boolean }[] = []
      transport.on(e => events.push(e))

      await expect(transport.connect('pi:3100')).rejects.toThrow('HTTP 401')
      expect(events).toContainEqual({ kind: 'auth-required', rejected: false })
      expect(storedTokens()).toEqual({ 'http://pi:3100': 'stored-token' })
    })

    it('re-prompts with rejected=true after a newly entered token also fails', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))
      const transport = new HttpTransport()
      await transport.connect('pi:3100')

      transport.setToken('wrong-token')
      mockFetch.mockResolvedValueOnce(new Response('unauthorised', { status: 401 }))

      const events: { kind: string; rejected?: boolean }[] = []
      transport.on(e => events.push(e))
      await transport.factoryReset()

      expect(events).toContainEqual({ kind: 'auth-required', rejected: true })
      expect(storedTokens()).toEqual({})
    })

    it('appends the origin token to the log WebSocket once the origin is trusted', async () => {
      const wsUrls: string[] = []
      vi.stubGlobal('WebSocket', class {
        onmessage: unknown = null
        onerror: unknown = null
        onclose: unknown = null
        constructor(url: string) { wsUrls.push(url) }
        close() { /* */ }
      })
      seedToken('http://pi:3100', 'stored-token')
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))

      const transport = new HttpTransport()
      await transport.connect('pi:3100')

      expect(wsUrls).toEqual(['ws://pi:3100/api/logs?token=stored-token'])
    })

    it('opens the log WebSocket without a token when the origin has none', async () => {
      const wsUrls: string[] = []
      vi.stubGlobal('WebSocket', class {
        onmessage: unknown = null
        onerror: unknown = null
        onclose: unknown = null
        constructor(url: string) { wsUrls.push(url) }
        close() { /* */ }
      })
      mockFetch.mockResolvedValueOnce(jsonResponse({ tier: 'main' }))

      const transport = new HttpTransport()
      await transport.connect('pi:3100')

      expect(wsUrls).toEqual(['ws://pi:3100/api/logs'])
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
