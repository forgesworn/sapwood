import { afterEach, describe, it, expect, vi } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils.js'
import {
  newManagementRequestId,
  managementRequestPayload,
  RelayTransport,
  requiresManagementMutationChallenge,
  sendReplaySafeManagementRequest,
} from './relay-transport.js'

// Fixed, valid secp256k1 scalars so construction is deterministic and offline:
// no relay is ever contacted by these tests (they exercise the input contract
// and the request lifecycle guards, all of which short-circuit before any I/O).
const OP_SK_HEX = '01'.repeat(32)
const DEVICE_PUB = getPublicKey(hexToBytes('02'.repeat(32))) // valid 64-hex x-only key
const RELAYS = ['wss://relay.example']

function fakePool() {
  const close = vi.fn()
  return {
    pool: {
      ensureRelay: vi.fn(async () => ({})),
      subscribe: vi.fn(() => ({ close })),
      publish: vi.fn(() => [Promise.resolve('saved')]),
      destroy: vi.fn(),
    },
    close,
  }
}

afterEach(() => vi.useRealTimers())

describe('RelayTransport construction', () => {
  it('rejects a device pubkey that is not 64 hex chars', () => {
    expect(() => new RelayTransport('not-hex', RELAYS, OP_SK_HEX)).toThrow(
      'device pubkey must be 64 hex chars',
    )
    expect(() => new RelayTransport('ab'.repeat(20), RELAYS, OP_SK_HEX)).toThrow(
      'device pubkey must be 64 hex chars',
    )
  })

  it('rejects an empty relay list', () => {
    expect(() => new RelayTransport(DEVICE_PUB, [], OP_SK_HEX)).toThrow(
      'at least one relay is required',
    )
  })

  it('rejects an operator secret that is not 64 hex chars', () => {
    expect(() => new RelayTransport(DEVICE_PUB, RELAYS, 'deadbeef')).toThrow(
      'operator secret must be 64 hex chars',
    )
  })

  it('accepts valid arguments and derives the operator pubkey', () => {
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX)
    expect(t.operatorPub).toBe(getPublicKey(hexToBytes(OP_SK_HEX)))
    expect(t.relays).toEqual(RELAYS)
    t.close()
  })

  it('lowercases the device pubkey', () => {
    const t = new RelayTransport(DEVICE_PUB.toUpperCase(), RELAYS, OP_SK_HEX)
    expect(t.devicePub).toBe(DEVICE_PUB.toLowerCase())
    t.close()
  })
})

describe('RelayTransport request lifecycle', () => {
  it('rejects connect when every relay fails to open', async () => {
    const { pool } = fakePool()
    pool.ensureRelay.mockRejectedValue(new Error('connection failed'))
    const t = new RelayTransport(DEVICE_PUB, [
      'wss://one.example',
      'wss://two.example',
    ], OP_SK_HEX, pool as never)

    await expect(t.connect()).rejects.toThrow(/could not connect to any relay/i)
    expect(pool.ensureRelay).toHaveBeenCalledTimes(2)
    expect(pool.subscribe).not.toHaveBeenCalled()
    t.close()
  })

  it('connects when one relay opens even if another never settles', async () => {
    const { pool } = fakePool()
    pool.ensureRelay.mockImplementation((url?: string) => url?.includes('open')
      ? Promise.resolve({})
      : new Promise(() => {}))
    const t = new RelayTransport(DEVICE_PUB, [
      'wss://open.example',
      'wss://stalled.example',
    ], OP_SK_HEX, pool as never)

    await expect(t.connect()).resolves.toBeUndefined()
    expect(pool.subscribe).toHaveBeenCalledOnce()
    t.close()
  })

  it('uses unpredictable 128-bit duplicate-delivery ids', () => {
    const ids = Array.from({ length: 64 }, () => newManagementRequestId())
    expect(ids.every((id) => /^[0-9a-f]{32}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('rejects a request made before connect()', async () => {
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX)
    await expect(t.request('ping')).rejects.toThrow('not connected')
    t.close()
  })

  it('rejects a request made after close()', async () => {
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX)
    t.close()
    await expect(t.request('ping')).rejects.toThrow('transport closed')
  })

  it('treats close() as idempotent', () => {
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX)
    t.close()
    expect(() => t.close()).not.toThrow()
  })

  it('treats nostr-tools resolved connection failures as publish failures', async () => {
    const { pool } = fakePool()
    pool.publish.mockReturnValue([Promise.resolve('connection failure: connection failed')])
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX, pool as never)
    await t.connect()

    await expect(t.request('get_status', {}, 1_000)).rejects.toThrow(
      /failed to publish to any relay/i,
    )
    t.close()
  })

  it('times out even when every publish promise stays pending', async () => {
    vi.useFakeTimers()
    const { pool } = fakePool()
    pool.publish.mockReturnValue([new Promise(() => {})])
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX, pool as never)
    await t.connect()

    const request = t.request('get_status', {}, 50)
    const rejection = expect(request).rejects.toThrow(/timeout waiting for device/i)
    await vi.advanceTimersByTimeAsync(50)
    await rejection
    t.close()
  })
})

describe('replay-safe management mutations', () => {
  it('places the challenge at the envelope boundary, outside strict method params', () => {
    expect(managementRequestPayload(
      'request-id',
      'stage_network_config',
      { transaction_id: 'tx', base_revision: 7, patch: {} },
      '61'.repeat(32),
    )).toEqual({
      id: 'request-id',
      method: 'stage_network_config',
      params: { transaction_id: 'tx', base_revision: 7, patch: {} },
      mutation_challenge: '61'.repeat(32),
    })
  })

  it('explicitly enumerates reads and treats mutations or future methods as protected', () => {
    for (const method of [
      'get_management_challenge',
      'get_network_config',
      'list_clients',
      'list_identities',
      'get_status',
    ]) expect(requiresManagementMutationChallenge(method)).toBe(false)

    for (const method of [
      'create_client',
      'create_client_v2',
      'nostrconnect',
      'nostrconnect_v2',
      'approve_signing',
      'revoke_client',
      'update_client',
      'client_uri',
      'set_identity_meta',
      'stage_network_config',
      'activate_network_config',
      'commit_network_config',
      'abort_network_config',
      'future_method',
    ]) expect(requiresManagementMutationChallenge(method)).toBe(true)
  })

  it('discovers a challenge and attaches it only to the mutation envelope', async () => {
    const attempts: Array<Record<string, unknown>> = []
    const result = await sendReplaySafeManagementRequest(
      'update_client',
      { slot_index: 4, label: 'phone' },
      12_000,
      async (attempt) => {
        attempts.push({ ...attempt })
        if (attempt.method === 'get_management_challenge') {
          return { version: 1, challenge: 'AB'.repeat(32) }
        }
        return { updated: true }
      },
    )

    expect(result).toEqual({ updated: true })
    expect(attempts).toEqual([
      {
        method: 'get_management_challenge',
        params: {},
        timeoutMs: 12_000,
      },
      {
        method: 'update_client',
        params: { slot_index: 4, label: 'phone' },
        timeoutMs: 12_000,
        mutationChallenge: 'ab'.repeat(32),
      },
    ])
  })

  it('does not silently fall back to an unprotected mutation on old firmware', async () => {
    const methods: string[] = []
    await expect(sendReplaySafeManagementRequest(
      'revoke_client',
      { slot_index: 2 },
      10_000,
      async (attempt) => {
        methods.push(attempt.method)
        throw new Error('unknown method: get_management_challenge')
      },
    )).rejects.toThrow(/too old for replay-safe remote changes.*USB/i)
    expect(methods).toEqual(['get_management_challenge'])
  })

  it('does not retry a stale or ambiguously acknowledged slot mutation', async () => {
    for (const mutationError of [
      new Error('stale_management_challenge: another manager changed the device'),
      new Error('timeout waiting for device (update_client)'),
    ]) {
      const methods: string[] = []
      await expect(sendReplaySafeManagementRequest(
        'update_client',
        { slot_index: 1, label: 'new label' },
        10_000,
        async (attempt) => {
          methods.push(attempt.method)
          if (attempt.method === 'get_management_challenge') {
            return { version: 1, challenge: '44'.repeat(32) }
          }
          throw mutationError
        },
      )).rejects.toThrow()
      expect(methods).toEqual(['get_management_challenge', 'update_client'])
    }
  })

  it('serializes mutations on one phone so they cannot invalidate each other', async () => {
    const transport = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX)
    const calls: string[] = []
    let releaseFirst!: () => void
    const firstMutation = new Promise<Record<string, unknown>>((resolve) => {
      releaseFirst = () => resolve({ updated: true })
    })
    let discovery = 0
    const internals = transport as unknown as {
      requestRaw: (
        method: string,
        params: Record<string, unknown>,
        timeoutMs: number,
        mutationChallenge?: string,
      ) => Promise<Record<string, unknown>>
    }
    vi.spyOn(internals, 'requestRaw').mockImplementation(async (
      method: string,
    ) => {
      calls.push(method)
      if (method === 'get_management_challenge') {
        discovery += 1
        return { version: 1, challenge: (discovery === 1 ? '51' : '52').repeat(32) }
      }
      if (method === 'update_client') return firstMutation
      return { revoked: true }
    })

    const first = transport.request('update_client', { slot_index: 1 })
    const second = transport.request('revoke_client', { slot_index: 2 })
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['get_management_challenge', 'update_client'])

    releaseFirst()
    await expect(first).resolves.toEqual({ updated: true })
    await expect(second).resolves.toEqual({ revoked: true })
    expect(calls).toEqual([
      'get_management_challenge',
      'update_client',
      'get_management_challenge',
      'revoke_client',
    ])
    transport.close()
  })
})
