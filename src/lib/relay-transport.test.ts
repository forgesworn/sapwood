import { afterEach, describe, it, expect, vi } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import { hexToBytes } from '@noble/hashes/utils.js'
import {
  newManagementRequestId,
  managementRequestPayload,
  relayPoolCompatibilityOptions,
  RelayTransport,
  requiresManagementMutationChallenge,
  sendReplaySafeManagementRequest,
} from './relay-transport.js'

// Fixed, valid secp256k1 scalars so construction is deterministic and offline:
// no relay is ever contacted by these tests (they exercise the input contract
// and the request lifecycle guards, all of which short-circuit before any I/O).
const OP_SK_HEX = '01'.repeat(32)
const DEVICE_SK_HEX = '02'.repeat(32)
const DEVICE_PUB = getPublicKey(hexToBytes(DEVICE_SK_HEX)) // valid 64-hex x-only key
const RELAYS = ['wss://relay.example']

interface TestPublishedEvent {
  id: string
  sig: string
  content: string
}

interface TestSubscriptionListener {
  onevent(event: { pubkey: string; content: string }): void
}

function fakePool() {
  const close = vi.fn()
  return {
    pool: {
      ensureRelay: vi.fn(async () => ({})),
      subscribe: vi.fn((
        _relays: string[],
        _filter: unknown,
        _listener: TestSubscriptionListener,
      ) => ({ close })),
      publish: vi.fn((_relays: string[], _event: TestPublishedEvent) => [Promise.resolve('saved')]),
      destroy: vi.fn(),
    },
    close,
  }
}

function answerLatestRequest(
  pool: ReturnType<typeof fakePool>['pool'],
  result: Record<string, unknown>,
): void {
  const event = pool.publish.mock.calls.at(-1)?.[1]
  if (!event) throw new Error('no request was published')
  answerRequest(pool, event, result)
}

function answerRequest(
  pool: ReturnType<typeof fakePool>['pool'],
  event: TestPublishedEvent,
  result: Record<string, unknown>,
): void {
  const request = decryptPublishedRequest(event)
  const conversationKey = deviceConversationKey()
  const listener = pool.subscribe.mock.calls[0]?.[2]
  if (!listener) throw new Error('no response subscription was opened')
  listener.onevent({
    pubkey: DEVICE_PUB,
    content: encrypt(JSON.stringify({ id: request.id, result }), conversationKey),
  })
}

function deviceConversationKey(): Uint8Array {
  return getConversationKey(
    hexToBytes(DEVICE_SK_HEX),
    getPublicKey(hexToBytes(OP_SK_HEX)),
  )
}

function decryptPublishedRequest(event: TestPublishedEvent): {
  id: string
  method: string
  params: Record<string, unknown>
} {
  const conversationKey = getConversationKey(
    hexToBytes(DEVICE_SK_HEX),
    getPublicKey(hexToBytes(OP_SK_HEX)),
  )
  return JSON.parse(decrypt(event.content, conversationKey)) as {
    id: string
    method: string
    params: Record<string, unknown>
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

  it('retries a read with fresh inner ids, ciphertext, and signed event ids', async () => {
    vi.useFakeTimers()
    const { pool } = fakePool()
    const onPublishSubmitted = vi.fn()
    const onPublishAccepted = vi.fn()
    pool.publish
      .mockReturnValueOnce([Promise.reject(new Error('signer route still reconnecting'))])
      .mockReturnValue([Promise.resolve('saved')])
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX, pool as never)
    await t.connect()

    const request = t.requestReadWithRepublish('get_status', {}, 20_000, 5_000, {
      onPublishSubmitted,
      onPublishAccepted,
    })
    await Promise.resolve()
    expect(pool.publish).toHaveBeenCalledOnce()
    expect(onPublishSubmitted).toHaveBeenCalledOnce()
    expect(onPublishAccepted).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(pool.publish).toHaveBeenCalledTimes(3)
    expect(onPublishSubmitted).toHaveBeenCalledOnce()
    expect(onPublishAccepted).toHaveBeenCalledOnce()
    const events = pool.publish.mock.calls.map((call) => call[1])
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length)
    expect(new Set(events.map((event) => event.sig)).size).toBe(events.length)
    expect(new Set(events.map((event) => event.content)).size).toBe(events.length)
    const requests = events.map(decryptPublishedRequest)
    expect(new Set(requests.map((inner) => inner.id)).size).toBe(requests.length)
    expect(requests.every((inner) => inner.method === 'get_status')).toBe(true)
    expect(requests.every((inner) => JSON.stringify(inner.params) === '{}')).toBe(true)

    answerLatestRequest(pool, { master_count: 1 })
    await expect(request).resolves.toEqual({ master_count: 1 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pool.publish).toHaveBeenCalledTimes(3)
    t.close()
  })

  it('accepts a later fresh-id response when the first response was lost', async () => {
    vi.useFakeTimers()
    const { pool } = fakePool()
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX, pool as never)
    await t.connect()

    const request = t.requestReadWithRepublish('get_status', {}, 20_000, 5_000)
    await Promise.resolve()
    const first = pool.publish.mock.calls[0]?.[1]
    if (!first) throw new Error('first request was not published')
    const firstInner = decryptPublishedRequest(first)

    // The signer processed attempt one but its response never reached us.
    await vi.advanceTimersByTimeAsync(5_000)
    const second = pool.publish.mock.calls[1]?.[1]
    if (!second) throw new Error('retry was not published')
    const secondInner = decryptPublishedRequest(second)
    expect(secondInner.id).not.toBe(firstInner.id)

    answerLatestRequest(pool, { master_count: 1 })
    await expect(request).resolves.toEqual({ master_count: 1 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pool.publish).toHaveBeenCalledTimes(2)
    t.close()
  })

  it('settles every alias when an earlier attempt answers after a retry starts', async () => {
    vi.useFakeTimers()
    const { pool } = fakePool()
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX, pool as never)
    await t.connect()

    const request = t.requestReadWithRepublish('get_status', {}, 20_000, 5_000)
    const first = pool.publish.mock.calls[0]?.[1]
    if (!first) throw new Error('first request was not published')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(pool.publish).toHaveBeenCalledTimes(2)

    // Attempt two is already live, but a delayed valid response to attempt one
    // must still win and atomically cancel every alias and timer.
    answerRequest(pool, first, { master_count: 1 })
    await expect(request).resolves.toEqual({ master_count: 1 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pool.publish).toHaveBeenCalledTimes(2)
    t.close()
  })

  it('reports submission only after a signed event reaches the relay pool', async () => {
    vi.useFakeTimers()
    const { pool } = fakePool()
    const onPublishSubmitted = vi.fn()
    pool.publish
      .mockImplementationOnce(() => { throw new Error('pool handoff failed') })
      .mockReturnValue([Promise.resolve('saved')])
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX, pool as never)
    await t.connect()

    const request = t.requestReadWithRepublish('get_status', {}, 20_000, 5_000, {
      onPublishSubmitted,
    })
    expect(onPublishSubmitted).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(onPublishSubmitted).toHaveBeenCalledOnce()
    answerLatestRequest(pool, { master_count: 1 })
    await expect(request).resolves.toEqual({ master_count: 1 })
    t.close()
  })

  it('works when older WebKit has neither Promise.any nor AbortSignal.throwIfAborted', async () => {
    const promiseConstructor = Promise as unknown as { any?: unknown }
    const originalAny = promiseConstructor.any
    Object.defineProperty(promiseConstructor, 'any', { value: undefined, configurable: true })
    try {
      const { pool } = fakePool()
      const controller = new AbortController()
      Object.defineProperty(controller.signal, 'throwIfAborted', {
        value: undefined,
        configurable: true,
      })
      const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX, pool as never)
      expect(relayPoolCompatibilityOptions()).toEqual({
        enablePing: false,
        enableReconnect: true,
      })
      await expect(t.connect(controller.signal)).resolves.toBeUndefined()

      const request = t.requestReadWithRepublish('get_status', {}, 20_000, 5_000)
      answerLatestRequest(pool, { master_count: 1 })
      await expect(request).resolves.toEqual({ master_count: 1 })
      t.close()
    } finally {
      Object.defineProperty(promiseConstructor, 'any', {
        value: originalAny,
        configurable: true,
        writable: true,
      })
    }
  })

  it('never enables automatic republish for a mutation or unknown method', async () => {
    const { pool } = fakePool()
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX, pool as never)
    await t.connect()

    for (const method of ['update_client', 'future_method']) {
      await expect(t.requestReadWithRepublish(method, {}, 20_000, 5_000))
        .rejects.toThrow(/read-only/i)
    }
    expect(pool.publish).not.toHaveBeenCalled()
    t.close()
  })

  it('stops republishing when the handoff AbortSignal closes the transport', async () => {
    vi.useFakeTimers()
    const { pool } = fakePool()
    const controller = new AbortController()
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX, pool as never)
    await t.connect(controller.signal)

    const request = t.requestReadWithRepublish('get_status', {}, 20_000, 5_000)
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(pool.publish).toHaveBeenCalledTimes(2)
    controller.abort(new DOMException('phone handoff timed out', 'AbortError'))
    await rejection

    await vi.advanceTimersByTimeAsync(15_000)
    expect(pool.publish).toHaveBeenCalledTimes(2)
  })

  it('keeps the original request deadline while republishing', async () => {
    vi.useFakeTimers()
    const { pool } = fakePool()
    const t = new RelayTransport(DEVICE_PUB, RELAYS, OP_SK_HEX, pool as never)
    await t.connect()

    const request = t.requestReadWithRepublish('get_status', {}, 11_000, 5_000)
    const rejection = expect(request).rejects.toThrow(/timeout waiting for device/i)
    await vi.advanceTimersByTimeAsync(11_000)
    await rejection
    expect(pool.publish).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(pool.publish).toHaveBeenCalledTimes(3)
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
