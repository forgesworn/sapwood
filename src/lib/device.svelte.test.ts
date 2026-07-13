import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nip19 } from 'nostr-tools'

// Mock the transports so device state logic runs without hardware, and the
// avatar/profile modules so no canvas or relay is needed. The serial mock
// captures the listener device.svelte.ts registers at import, which is the
// only way to feed frames into its (unexported) handleFrame.
const { serialMock, httpOn, resolveMock, loadAvatarMock, placeholderMock, buildMetaMock, relayRequestMock, relayInstances } = vi.hoisted(() => ({
  relayRequestMock: vi.fn(),
  relayInstances: [] as Array<{ relays: string[]; closed: boolean }>,
  serialMock: {
    listeners: [] as Array<(e: unknown) => void>,
    on(fn: (e: unknown) => void) { serialMock.listeners.push(fn); return () => {} },
    connect: vi.fn(),
    disconnect: vi.fn(),
    write: vi.fn(),
    sendAndReceive: vi.fn(),
  },
  httpOn: vi.fn(),
  resolveMock: vi.fn(),
  loadAvatarMock: vi.fn(),
  placeholderMock: vi.fn(),
  buildMetaMock: vi.fn(),
}))
vi.mock('./serial.js', () => ({ transport: serialMock }))
vi.mock('./http.js', () => ({
  httpTransport: { on: httpOn, connect: vi.fn(), disconnect: vi.fn() },
  HttpTransport: class {},
}))
vi.mock('./profiles.js', async (orig) => {
  const actual = await orig<typeof import('./profiles.js')>()
  return { ...actual, resolveProfiles: resolveMock }
})
vi.mock('./avatar.js', () => ({
  loadAvatar: loadAvatarMock,
  placeholderAvatar: placeholderMock,
  buildSetIdentityMeta: buildMetaMock,
}))
vi.mock('./relay-transport.js', () => ({
  RelayTransport: class {
    operatorPub = 'op'
    devicePub: string
    relays: string[]
    closed = false
    constructor(devicePubHex: string, relays: string[], opSkHex: string) {
      this.devicePub = devicePubHex
      this.relays = [...relays]
      this.operatorPub = opSkHex === 'b'.repeat(64) ? 'legacy-op' : 'op'
      relayInstances.push(this)
    }
    async connect() { /* no relay in tests */ }
    request(...args: unknown[]) { return relayRequestMock.apply(this, args) }
    close() { this.closed = true }
  },
}))

import {
  abortNetworkConfig, device, syncIdentityMeta, configureNetwork, configureNetworkRemotely, getNetworkConfig,
  mgmtCreateClient, mgmtRevokeClient, mgmtUpdateClient, mgmtApproveSigning,
  mgmtClientUri, connectRelay, disconnect, refreshRelayAudit,
  refreshUsbNetworkState, setOperatorOverUsb,
} from './device.svelte.js'
import { FrameType } from './frame.js'
import { generateOperatorMnemonic, getOrCreateOperator } from './op-mgmt.js'
import type { MasterInfo } from './types.js'
import { fullClientPolicy } from './client-policy.js'
import {
  listKnownDevices, pendingNetworkHandoff, rememberDevice, savePendingNetworkHandoff,
} from './known-devices.js'

const FAKE_AVATAR = { w: 2, h: 2, bytes: new Uint8Array(8) }
const FAKE_FRAME = new Uint8Array([0xaa])
const ACK = { type: FrameType.ACK, payload: new Uint8Array() }
const LS_MNEMONIC = 'heartwood.opMgmt.mnemonic'
const LS_SK = 'heartwood.opMgmt.skHex'
const SLOT_FP = 'f'.repeat(64)
const FW_RESP = {
  type: FrameType.FIRMWARE_INFO_RESPONSE,
  payload: new TextEncoder().encode('{"version":"0.9.10","board":"tdisplay"}'),
}

/** Answer the pre-push FIRMWARE_INFO ping and ACK everything else. */
function mockResponsiveDevice() {
  serialMock.sendAndReceive.mockImplementation(async (_frame: Uint8Array, expect: number[]) => {
    if (expect.includes(FrameType.FIRMWARE_INFO_RESPONSE)) return FW_RESP
    return ACK
  })
}

/** How many times the identity-meta frame itself was pushed (ignores pings). */
function metaPushes(): number {
  return serialMock.sendAndReceive.mock.calls.filter((c) => c[0] === FAKE_FRAME).length
}

// Distinct pubkey per test: the auto-sync dedupe set is per npub and survives
// across tests in this module (it is module state, deliberately unexported).
let pkCounter = 0
function freshMaster(): { pubHex: string; master: MasterInfo } {
  const pubHex = (++pkCounter).toString(16).padStart(2, '0').repeat(32)
  return {
    pubHex,
    master: { slot: 0, label: 'master', mode: 0, modeLabel: 'USB', npub: nip19.npubEncode(pubHex) },
  }
}

/** Feed a PROVISION_LIST_RESPONSE through the captured serial listener. */
function emitMasterList(masters: MasterInfo[]) {
  const payload = new TextEncoder().encode(JSON.stringify(masters))
  for (const fn of serialMock.listeners) {
    fn({ kind: 'frame', frame: { type: FrameType.PROVISION_LIST_RESPONSE, payload } })
  }
}

beforeEach(() => {
  localStorage.clear()
  device.mode = 'none'
  device.connected = false
  device.masters = []
  device.logs = []
  device.signerActivity = []
  device.relays = []
  device.relayStatus = null
  device.slotUris = {}
  device.slots = []
  device.error = null
  device.usbNetworkState = null
  device.usbNetworkSupport = 'unknown'
  device.awaitingButton = null
  device.connectionGeneration = 1
  resolveMock.mockReset()
  loadAvatarMock.mockReset()
  placeholderMock.mockReset()
  buildMetaMock.mockReset()
  serialMock.sendAndReceive.mockReset()
  relayRequestMock.mockReset()
  relayInstances.length = 0
})

describe('transport guards', () => {
  it('configureNetwork refuses off-serial with guidance instead of touching the serial port', async () => {
    for (const mode of ['none', 'http', 'relay'] as const) {
      device.mode = mode
      device.connected = mode !== 'none'
      await expect(configureNetwork({ ssid: '', password: '', relays: [], mode: 'usb' }))
        .rejects.toThrow(/over USB/)
    }
    expect(serialMock.sendAndReceive).not.toHaveBeenCalled()
  })

  it('syncIdentityMeta is a quiet no-op on unsupported transports', async () => {
    device.mode = 'http'
    device.connected = true
    device.masters = [freshMaster().master]
    expect(await syncIdentityMeta()).toBeNull()
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it('mgmt actions throw when not connected', async () => {
    await expect(mgmtCreateClient('x', fullClientPolicy(false))).rejects.toThrow('not connected')
    await expect(mgmtRevokeClient(0)).rejects.toThrow('not connected')
    await expect(mgmtUpdateClient(0, {})).rejects.toThrow('not connected')
  })

  it('mgmtApproveSigning over USB points at the physical button', async () => {
    device.mode = 'serial'
    device.connected = true
    await expect(mgmtApproveSigning(0)).rejects.toThrow(/PRG press/)
  })
})

describe('USB redacted network and operator recovery', () => {
  const stateResponse = (overrides: Record<string, unknown> = {}) => ({
    type: FrameType.GET_NET_CONFIG_RESPONSE,
    payload: new TextEncoder().encode(JSON.stringify({
      version: 1,
      configured: true,
      revision: 7,
      mode: 'wifi',
      ssid: 'Home',
      relays: ['wss://relay.example'],
      password_set: true,
      op_mgmt: '11'.repeat(32),
      recovery_ok: true,
      trial: null,
      last_result: null,
      ...overrides,
    })),
  })

  it('loads exact state without ever accepting a password field', async () => {
    device.mode = 'serial'
    device.connected = true
    serialMock.sendAndReceive.mockResolvedValueOnce(stateResponse())
    const state = await refreshUsbNetworkState()
    expect(state).toMatchObject({ ssid: 'Home', password_set: true, revision: 7 })
    expect(device.usbNetworkSupport).toBe('supported')
    expect(JSON.stringify(state)).not.toContain('"password"')

    device.usbNetworkState = null
    device.usbNetworkSupport = 'unknown'
    serialMock.sendAndReceive.mockResolvedValueOnce(stateResponse({ password: 'injected' }))
    expect(await refreshUsbNetworkState()).toBeNull()
    expect(device.usbNetworkState).toBeNull()
    expect(device.error).toMatch(/malformed network state/)
  })

  it('distinguishes an old-firmware NACK from a temporary timeout', async () => {
    device.mode = 'serial'
    device.connected = true
    serialMock.sendAndReceive.mockResolvedValueOnce({ type: FrameType.NACK, payload: new Uint8Array() })
    expect(await refreshUsbNetworkState()).toBeNull()
    expect(device.usbNetworkSupport).toBe('unsupported')

    device.usbNetworkSupport = 'unknown'
    serialMock.sendAndReceive.mockRejectedValueOnce(new Error('Timed out'))
    expect(await refreshUsbNetworkState()).toBeNull()
    expect(device.usbNetworkSupport).toBe('unknown')
  })

  it('resolves a lost operator ACK by read-back and never resends the mutation', async () => {
    vi.useFakeTimers()
    try {
      const operator = getOrCreateOperator()
      device.mode = 'serial'
      device.connected = true
      device.usbNetworkState = {
        version: 1, configured: true, revision: 7, mode: 'wifi', ssid: 'Home',
        relays: ['wss://relay.example'], password_set: true, op_mgmt: '11'.repeat(32), recovery_ok: true,
      }
      serialMock.sendAndReceive
        .mockRejectedValueOnce(new Error('Timed out waiting for response'))
        .mockResolvedValueOnce(stateResponse({ revision: 8, op_mgmt: operator.pubHex }))

      const pending = setOperatorOverUsb(operator.pubHex)
      await vi.runAllTimersAsync()
      const state = await pending
      expect(state.op_mgmt).toBe(operator.pubHex)
      expect(state.revision).toBe(8)
      expect(serialMock.sendAndReceive.mock.calls.filter((call) => call[0][2] === FrameType.SET_OPERATOR)).toHaveLength(1)
      expect(device.awaitingButton).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('staged remote network management', () => {
  it('rejects insecure relay URLs before staging a remote change', async () => {
    const { pubHex } = freshMaster()
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: 'wss://old.example' }
      }
      if (method === 'list_clients') return { clients: [] }
      return { ok: true }
    })

    await connectRelay(pubHex, ['wss://old.example'])
    try {
      await expect(configureNetworkRemotely({
        mode: 'wifi',
        ssid: 'Home',
        relays: ['ws://insecure.example'],
        password: { action: 'keep' },
      })).rejects.toThrow(/must start with wss:\/\//)
      await expect(configureNetworkRemotely({
        mode: 'wifi',
        ssid: 'x'.repeat(33),
        relays: ['wss://safe.example'],
        password: { action: 'keep' },
      })).rejects.toThrow(/SSID must be 1–32 bytes/)
      await expect(configureNetworkRemotely({
        mode: 'wifi',
        ssid: 'Home',
        relays: ['wss://safe.example'],
        password: { action: 'set', value: 'short' },
      })).rejects.toThrow(/password must be 8–63 bytes/)
      await expect(configureNetworkRemotely({
        mode: 'wifi',
        ssid: 'Home',
        relays: Array.from({ length: 9 }, (_, index) => `wss://relay-${index}.example`),
        password: { action: 'keep' },
      })).rejects.toThrow(/at most eight relays/)
      for (const [relay, error] of [
        ['wss://relay.example/path', /paths, queries, and fragments are not supported/],
        ['wss://relay.example?search=x', /paths, queries, and fragments are not supported/],
        ['wss://relay.example#fragment', /paths, queries, and fragments are not supported/],
        ['wss://user@relay.example', /cannot contain credentials/],
        ['wss://relay.example:444', /ports must be 443/],
        ['wss://relay_example', /require an ASCII hostname/],
        ['wss://---', /require an ASCII hostname/],
      ] as const) {
        await expect(configureNetworkRemotely({
          mode: 'wifi',
          ssid: 'Home',
          relays: [relay],
          password: { action: 'keep' },
        })).rejects.toThrow(error)
      }
      await expect(configureNetworkRemotely({
        mode: 'wifi',
        ssid: 'Home',
        relays: ['wss://RELAY.example', 'wss://relay.EXAMPLE/'],
        password: { action: 'keep' },
      })).rejects.toThrow(/must not be duplicated/)
      expect(relayRequestMock.mock.calls.some((call) => call[0] === 'stage_network_config')).toBe(false)
    } finally {
      await disconnect()
    }
  })

  it('rejects a candidate whose serialized NVS config can exceed 512 bytes', async () => {
    const { pubHex } = freshMaster()
    const activeRelays = ['wss://old.example']
    const largeRelaySet = Array.from(
      { length: 8 },
      (_, index) => `wss://${'a'.repeat(45)}${index}.example`,
    )
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: activeRelays[0] }
      }
      if (method === 'list_clients') return { clients: [] }
      if (method === 'get_network_config') {
        return {
          revision: 2,
          active: { mode: 'wifi', ssid: 'Home', relays: activeRelays, password_set: true },
          trial: null,
          last_result: null,
        }
      }
      return { ok: true }
    })

    await connectRelay(pubHex, activeRelays)
    try {
      await expect(configureNetworkRemotely({
        mode: 'wifi',
        ssid: 'Home',
        relays: largeRelaySet,
        password: { action: 'keep' },
      })).rejects.toThrow(/exceeding the signer's 512-byte limit/)
      expect(relayRequestMock.mock.calls.some((call) => call[0] === 'stage_network_config')).toBe(false)
      expect(relayInstances.filter((instance) => !instance.closed)).toHaveLength(1)
    } finally {
      await disconnect()
    }
  })

  it('refuses activation when a mobile recovery route cannot be persisted', async () => {
    const { pubHex } = freshMaster()
    const relays = ['wss://old.example']
    let transactionId = ''
    let activated = false
    let aborted = false
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown, params: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: relays[0] }
      }
      if (method === 'list_clients') return { clients: [] }
      if (method === 'get_network_config') {
        return {
          revision: 4,
          active: { mode: 'wifi', ssid: 'Home', relays, password_set: true },
          trial: null,
          last_result: null,
        }
      }
      if (method === 'stage_network_config') {
        transactionId = (params as { transaction_id: string }).transaction_id
        return { transaction_id: transactionId, staged: true, revision: 5 }
      }
      if (method === 'activate_network_config') {
        activated = true
        return { transaction_id: transactionId, revision: 5, rebooting: true }
      }
      if (method === 'abort_network_config') {
        aborted = true
        return { transaction_id: transactionId, revision: 5, aborted: true }
      }
      return { ok: true }
    })

    await connectRelay(pubHex, relays)
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    try {
      await expect(configureNetworkRemotely({
        mode: 'wifi',
        ssid: 'Home',
        relays: ['wss://new.example'],
        password: { action: 'keep' },
      })).rejects.toThrow(/could not save a recovery route/i)
      expect(activated).toBe(false)
      expect(aborted).toBe(true)
    } finally {
      write.mockRestore()
      await disconnect()
    }
  })

  it('reads only redacted active and trial state over the authenticated relay', async () => {
    const { pubHex } = freshMaster()
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: 'wss://old.example' }
      }
      if (method === 'list_clients') return { clients: [] }
      if (method === 'get_network_config') {
        return {
          revision: 7,
          active: {
            mode: 'wifi', ssid: 'Home', relays: ['wss://old.example'],
            password_set: true, password: 'must-not-escape',
          },
          trial: null,
        }
      }
      return { ok: true }
    })

    await connectRelay(pubHex, ['wss://old.example'])
    try {
      await expect(getNetworkConfig()).resolves.toEqual({
        revision: 7,
        active: { mode: 'wifi', ssid: 'Home', relays: ['wss://old.example'], password_set: true },
        trial: null,
        last_result: null,
      })
      expect(JSON.stringify(await getNetworkConfig())).not.toContain('must-not-escape')
    } finally {
      await disconnect()
    }
  })

  it('stages with a revision, activates, observes the same trial, commits, then replaces relays', async () => {
    const { pubHex } = freshMaster()
    const oldRelays = ['wss://old.example', 'wss://fallback.example']
    const nextRelays = ['wss://new.example:443/']
    let transactionId = ''
    let stageAttempts = 0
    let activated = false
    let committed = false
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown, params: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: oldRelays[0] }
      }
      if (method === 'list_clients') return { clients: [] }
      if (method === 'stage_network_config') {
        stageAttempts++
        const request = params as { transaction_id: string; base_revision: number; patch: Record<string, unknown> }
        expect(request.base_revision).toBe(12)
        expect(request.patch).toEqual({
          mode: 'wifi',
          ssid: 'Away',
          relays: nextRelays,
          password: { action: 'set', value: 'new-network-secret' },
        })
        expect(request.patch).not.toHaveProperty('op_mgmt')
        if (!transactionId) transactionId = request.transaction_id
        expect(request.transaction_id).toBe(transactionId)
        throw new Error('timeout waiting for device (stage_network_config)')
      }
      if (method === 'activate_network_config') {
        expect(params).toEqual({ transaction_id: transactionId, revision: 13 })
        expect(pendingNetworkHandoff(pubHex)).toEqual(expect.objectContaining({
          transactionId,
          revision: 13,
          oldRelays,
          candidateRelays: nextRelays,
        }))
        activated = true
        return { transaction_id: transactionId, revision: 13, rebooting: true }
      }
      if (method === 'get_network_config') {
        if (!transactionId) {
          return {
            revision: 12,
            active: { mode: 'wifi', ssid: 'Home', relays: oldRelays, password_set: true },
            trial: null,
          }
        }
        if (committed) {
          return {
            revision: 13,
            active: { mode: 'wifi', ssid: 'Away', relays: nextRelays, password_set: true },
            trial: null,
            last_result: { transaction_id: transactionId, revision: 13, outcome: 'committed' },
          }
        }
        if (!activated) {
          return {
            revision: 13,
            active: { mode: 'wifi', ssid: 'Home', relays: oldRelays, password_set: true },
            trial: {
              transaction_id: transactionId,
              phase: 'staged',
              attempted: 0,
              mode: 'wifi',
              ssid: 'Away',
              relays: nextRelays,
              password_set: true,
            },
          }
        }
        return {
          revision: 13,
          active: { mode: 'wifi', ssid: 'Home', relays: oldRelays, password_set: true },
          trial: {
            transaction_id: transactionId,
            phase: 'trying',
            attempted: 1,
            mode: 'wifi',
            ssid: 'Away',
            relays: nextRelays,
            password_set: true,
          },
        }
      }
      if (method === 'commit_network_config') {
        expect(params).toEqual({ transaction_id: transactionId, revision: 13 })
        committed = true
        return { transaction_id: transactionId, committed: true, revision: 13 }
      }
      if (method === 'abort_network_config') throw new Error('abort should not run')
      return { ok: true }
    })

    // The live transport may be wider than firmware's committed A route after
    // an earlier crash recovery. The new journal must still record exact A.
    await connectRelay(pubHex, [...oldRelays, 'wss://stale-recovery.example'], 'remote signer')
    try {
      const observed = await configureNetworkRemotely({
        mode: 'wifi',
        ssid: 'Away',
        relays: nextRelays,
        password: { action: 'set', value: 'new-network-secret' },
      })
      expect(observed).toEqual(expect.objectContaining({
        revision: 13,
        active: { mode: 'wifi', ssid: 'Away', relays: nextRelays, password_set: true },
        trial: null,
        last_result: { transaction_id: transactionId, revision: 13, outcome: 'committed' },
      }))

      expect(stageAttempts).toBe(1)
      expect(device.relays).toEqual(nextRelays)
      expect(listKnownDevices().find((known) => known.pubHex === pubHex)?.relays).toEqual(nextRelays)
      expect(pendingNetworkHandoff(pubHex)).toBeNull()
      expect(relayInstances.filter((instance) => !instance.closed)).toHaveLength(1)
      expect(relayInstances.find((instance) => !instance.closed)?.relays).toEqual(nextRelays)
    } finally {
      await disconnect()
    }
  })

  it('recovers a committed candidate route after a mobile page kill', async () => {
    const { pubHex } = freshMaster()
    const oldRelays = ['wss://old.example']
    const nextRelays = ['wss://new.example']
    const transactionId = '03'.repeat(16)
    rememberDevice(pubHex, oldRelays, 'remote signer')
    expect(savePendingNetworkHandoff({
      devicePubHex: pubHex,
      transactionId,
      revision: 52,
      oldRelays,
      candidateRelays: nextRelays,
    })).toBe(true)
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: nextRelays[0] }
      }
      if (method === 'list_clients') return { clients: [] }
      if (method === 'get_network_config') {
        return {
          revision: 52,
          active: { mode: 'wifi', ssid: 'Away', relays: nextRelays, password_set: true },
          trial: null,
          last_result: { transaction_id: transactionId, revision: 52, outcome: 'committed' },
        }
      }
      return { ok: true }
    })

    await connectRelay(pubHex, oldRelays, 'remote signer')
    try {
      expect(pendingNetworkHandoff(pubHex)).toBeNull()
      expect(listKnownDevices().find((known) => known.pubHex === pubHex)?.relays).toEqual(nextRelays)
      expect(device.relays).toEqual(nextRelays)
      expect(relayInstances.filter((instance) => !instance.closed)).toHaveLength(1)
      expect(relayInstances.find((instance) => !instance.closed)?.relays).toEqual(nextRelays)
    } finally {
      await disconnect()
    }
  })

  it.each([
    ['a lost commit ACK', 'timeout'],
    ['a malformed commit ACK', 'malformed'],
    ['an error returned after commit', 'error'],
  ] as const)('uses durable terminal state to recover %s for a password-only change', async (_case, failure) => {
    const { pubHex } = freshMaster()
    const relays = ['wss://same.example']
    let transactionId = ''
    let commitAttempted = false
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown, params: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: relays[0] }
      }
      if (method === 'list_clients') return { clients: [] }
      if (method === 'stage_network_config') {
        transactionId = (params as { transaction_id: string }).transaction_id
        return { transaction_id: transactionId, staged: true, revision: 31 }
      }
      if (method === 'activate_network_config') {
        return { transaction_id: transactionId, revision: 31, rebooting: true }
      }
      if (method === 'commit_network_config') {
        commitAttempted = true
        if (failure === 'timeout') throw new Error('timeout waiting for device (commit_network_config)')
        if (failure === 'error') throw new Error('network outcome cleanup failed')
        return { transaction_id: transactionId, committed: false, revision: 30 }
      }
      if (method === 'get_network_config') {
        if (!transactionId) {
          return {
            revision: 30,
            active: { mode: 'wifi', ssid: 'Home', relays, password_set: true },
            trial: null,
            last_result: null,
          }
        }
        if (!commitAttempted) {
          return {
            revision: 31,
            active: { mode: 'wifi', ssid: 'Home', relays, password_set: true },
            trial: {
              transaction_id: transactionId, phase: 'trying', attempted: 1,
              mode: 'wifi', ssid: 'Home', relays, password_set: true,
            },
            last_result: null,
          }
        }
        return {
          revision: 31,
          active: { mode: 'wifi', ssid: 'Home', relays, password_set: true },
          trial: null,
          last_result: { transaction_id: transactionId, revision: 31, outcome: 'committed' },
        }
      }
      if (method === 'abort_network_config') throw new Error('a committed transaction must not be aborted')
      return { ok: true }
    })

    await connectRelay(pubHex, relays)
    try {
      await expect(configureNetworkRemotely({
        mode: 'wifi',
        ssid: 'Home',
        relays,
        password: { action: 'set', value: 'rotated-secret' },
      })).resolves.toEqual(expect.objectContaining({ revision: 31 }))
      expect(relayRequestMock.mock.calls.some((call) => call[0] === 'abort_network_config')).toBe(false)
      expect(device.relays).toEqual(relays)
    } finally {
      await disconnect()
    }
  })

  it('discards an inert staged transaction using its accepted revision', async () => {
    const { pubHex } = freshMaster()
    const relays = ['wss://old.example']
    let aborted = false
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown, params: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: relays[0] }
      }
      if (method === 'list_clients') return { clients: [] }
      if (method === 'get_network_config') {
        return {
          revision: 41,
          active: { mode: 'wifi', ssid: 'Home', relays, password_set: true },
          trial: aborted ? null : {
            transaction_id: 'recover-me', phase: 'staged', attempted: 0,
            mode: 'wifi', ssid: 'Future', relays: ['wss://future.example'], password_set: true,
          },
          last_result: aborted
            ? { transaction_id: 'recover-me', revision: 41, outcome: 'aborted' }
            : null,
        }
      }
      if (method === 'abort_network_config') {
        expect(params).toEqual({ transaction_id: 'recover-me', revision: 41 })
        aborted = true
        return { transaction_id: 'recover-me', revision: 41, aborted: true }
      }
      return { ok: true }
    })

    await connectRelay(pubHex, relays)
    try {
      await expect(abortNetworkConfig('recover-me')).resolves.toEqual(expect.objectContaining({
        revision: 41,
        trial: null,
        last_result: expect.objectContaining({ outcome: 'aborted' }),
      }))
      expect(aborted).toBe(true)
    } finally {
      await disconnect()
    }
  })

  it('aborts a failed commit and keeps the last committed relays remembered', async () => {
    const { pubHex } = freshMaster()
    const oldRelays = ['wss://old.example']
    const nextRelays = ['wss://bad.example']
    let transactionId = ''
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown, params: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: oldRelays[0] }
      }
      if (method === 'list_clients') return { clients: [] }
      if (method === 'get_network_config') {
        if (!transactionId) {
          return {
            revision: 20,
            active: { mode: 'wifi', ssid: 'Good', relays: oldRelays, password_set: true },
            trial: null,
          }
        }
        return {
          revision: 21,
          active: { mode: 'wifi', ssid: 'Good', relays: oldRelays, password_set: true },
          trial: {
            transaction_id: transactionId, phase: 'trying', attempted: 1,
            mode: 'wifi', ssid: 'Bad', relays: nextRelays, password_set: false,
          },
        }
      }
      if (method === 'stage_network_config') {
        transactionId = (params as { transaction_id: string }).transaction_id
        return { transaction_id: transactionId, staged: true, revision: 21 }
      }
      if (method === 'activate_network_config') return { transaction_id: transactionId, revision: 21, rebooting: true }
      if (method === 'commit_network_config') throw new Error('commit denied')
      if (method === 'abort_network_config') return { transaction_id: transactionId, revision: 21, aborted: true }
      return { ok: true }
    })

    await connectRelay(pubHex, oldRelays, 'remote signer')
    try {
      await expect(configureNetworkRemotely({
        mode: 'wifi', ssid: 'Bad', relays: nextRelays, password: { action: 'clear' },
      })).rejects.toThrow('commit denied')
      expect(relayRequestMock).toHaveBeenCalledWith(
        'abort_network_config',
        { transaction_id: transactionId, revision: 21 },
        8_000,
      )
      expect(device.relays).toEqual(oldRelays)
      expect(listKnownDevices().find((known) => known.pubHex === pubHex)?.relays).toEqual(oldRelays)
      expect(relayInstances.filter((instance) => !instance.closed)).toHaveLength(1)
      expect(relayInstances.find((instance) => !instance.closed)?.relays).toEqual(oldRelays)
    } finally {
      await disconnect()
    }
  })
})

describe('identity card auto-sync on serial master list', () => {
  it('pushes name + avatar once the master npub is known, and dedupes repeats', async () => {
    const { pubHex, master } = freshMaster()
    device.mode = 'serial'
    device.connected = true
    resolveMock.mockResolvedValue(new Map([[pubHex, { name: 'alice', picture: 'https://x/a.jpg' }]]))
    loadAvatarMock.mockResolvedValue(FAKE_AVATAR)
    buildMetaMock.mockReturnValue(FAKE_FRAME)
    mockResponsiveDevice()

    emitMasterList([master])
    await vi.waitFor(() => expect(serialMock.sendAndReceive).toHaveBeenCalledWith(FAKE_FRAME, [FrameType.ACK, FrameType.NACK], 20_000))
    expect(device.masters).toEqual([master])
    expect(device.logs.join('\n')).toContain('identity card synced to signer: alice')

    // A second list refresh must not rewrite the signer's NVS.
    emitMasterList([master])
    await new Promise((r) => setTimeout(r, 0))
    expect(metaPushes()).toBe(1)
  })

  it('falls back to the placeholder disc when the profile has no picture', async () => {
    const { pubHex, master } = freshMaster()
    device.mode = 'serial'
    device.connected = true
    resolveMock.mockResolvedValue(new Map([[pubHex, { name: 'bob' }]]))
    placeholderMock.mockReturnValue(FAKE_AVATAR)
    buildMetaMock.mockReturnValue(FAKE_FRAME)
    mockResponsiveDevice()

    emitMasterList([master])
    await vi.waitFor(() => expect(metaPushes()).toBe(1))
    expect(placeholderMock).toHaveBeenCalledWith('bob', 64)
    expect(loadAvatarMock).not.toHaveBeenCalled()
  })

  it('falls back to the placeholder disc when the picture host refuses (CORS)', async () => {
    const { pubHex, master } = freshMaster()
    device.mode = 'serial'
    device.connected = true
    resolveMock.mockResolvedValue(new Map([[pubHex, { name: 'carol', picture: 'https://x/c.jpg' }]]))
    loadAvatarMock.mockRejectedValue(new Error('tainted canvas'))
    placeholderMock.mockReturnValue(FAKE_AVATAR)
    buildMetaMock.mockReturnValue(FAKE_FRAME)
    mockResponsiveDevice()

    emitMasterList([master])
    await vi.waitFor(() => expect(metaPushes()).toBe(1))
    expect(placeholderMock).toHaveBeenCalledWith('carol', 64)
  })

  it('releases the dedupe guard when no profile exists yet, so a later refresh retries', async () => {
    const { pubHex, master } = freshMaster()
    device.mode = 'serial'
    device.connected = true
    resolveMock.mockResolvedValue(new Map()) // nothing on the relays yet

    emitMasterList([master])
    await vi.waitFor(() => expect(resolveMock).toHaveBeenCalledTimes(1))
    // Let the first (fruitless) run finish and release the dedupe guard before
    // the next list refresh arrives.
    await new Promise((r) => setTimeout(r, 10))
    expect(serialMock.sendAndReceive).not.toHaveBeenCalled()

    // Profile appears later — the next master list refresh must push it.
    resolveMock.mockResolvedValue(new Map([[pubHex, { name: 'dave', picture: 'https://x/d.jpg' }]]))
    loadAvatarMock.mockResolvedValue(FAKE_AVATAR)
    buildMetaMock.mockReturnValue(FAKE_FRAME)
    mockResponsiveDevice()
    emitMasterList([master])
    await vi.waitFor(() => expect(metaPushes()).toBe(1))
  })

  it('auto-syncs over the relay once get_status resolves the master', async () => {
    const { pubHex } = freshMaster()
    resolveMock.mockResolvedValue(new Map([[pubHex, { name: 'erin', picture: 'https://x/e.jpg' }]]))
    loadAvatarMock.mockResolvedValue(FAKE_AVATAR)
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: 'wss://r' }
      }
      if (method === 'list_clients') return { clients: [] }
      return { ok: true }
    })

    await connectRelay(pubHex, ['wss://r.example'])
    try {
      await vi.waitFor(() => {
        expect(relayRequestMock).toHaveBeenCalledWith(
          'set_identity_meta',
          expect.objectContaining({ name: 'erin', w: 2, h: 2, avatar_b64: expect.any(String) }),
          30_000,
        )
      })
      // Relay pushes shrink to 48x48 — a 64x64 event OOM-rebooted a T-Display.
      expect(loadAvatarMock).toHaveBeenCalledWith('https://x/e.jpg', 48)
    } finally {
      await disconnect() // clears the 4s status poll
    }
  })

  it('adds signer audit entries from relay status to the log', async () => {
    const { pubHex } = freshMaster()
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') {
        return {
          master_count: 1,
          master_npub_hex: pubHex,
          mode: 'wifi-standalone',
          relay: 'wss://r',
          audit: [
            {
              seq: 1,
              method: 'sign_event',
              label: 'Primal',
              client: 'a'.repeat(64),
              kind: 0,
              preview: '{"name":"alice"}',
              outcome: 'signed',
            },
            {
              seq: 2,
              method: 'nip04_decrypt',
              label: 'Primal',
              client: 'b'.repeat(64),
              kind: null,
              preview: 'peer 12345678 - content redacted',
              outcome: 'ok',
            },
            {
              seq: 3,
              method: 'sign_event',
              label: '',
              client: 'c'.repeat(64),
              kind: 999999,
              preview: '{"custom":true}',
              outcome: 'signed',
            },
          ],
        }
      }
      if (method === 'list_clients') return { clients: [] }
      return { ok: true }
    })

    await connectRelay(pubHex, ['wss://r.example'])
    try {
      expect(device.logs.join('\n')).toContain('Sign audit: signed Profile (kind 0) for Primal from client aaaaaaaa; preview: {"name":"alice"}')
      expect(device.logs.join('\n')).toContain('Sign audit: nip04_decrypt ok for Primal from client bbbbbbbb; preview: peer 12345678 - content redacted')
      expect(device.logs.join('\n')).toContain('Sign audit: signed unknown Nostr kind 999999 for unknown app from client cccccccc; preview: {"custom":true}')
      expect(device.signerActivity).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'relay-audit',
          action: 'signed',
          app: 'Primal',
          client: 'aaaaaaaa',
          kind: 0,
          kindText: 'Profile (kind 0)',
          preview: '{"name":"alice"}',
        }),
        expect.objectContaining({
          source: 'relay-audit',
          action: 'nip04_decrypt ok',
          app: 'Primal',
          client: 'bbbbbbbb',
          kind: null,
          preview: 'peer 12345678 - content redacted',
        }),
        expect.objectContaining({
          source: 'relay-audit',
          action: 'signed',
          app: 'unknown app',
          client: 'cccccccc',
          kind: 999999,
          kindText: 'unknown Nostr kind 999999',
          preview: '{"custom":true}',
        }),
      ]))
    } finally {
      await disconnect()
    }
  })

  it('records signer activity from structured firmware log lines', () => {
    for (const fn of serialMock.listeners) {
      fn({
        kind: 'log',
        line: 'sign_event signed: App Data (30078) for primal — {"subkey":"user-home-feeds"}',
      })
    }

    expect(device.signerActivity).toHaveLength(1)
    expect(device.signerActivity[0]).toEqual(expect.objectContaining({
      source: 'device-log',
      method: 'sign_event',
      outcome: 'signed',
      action: 'signed',
      app: 'primal',
      client: '',
      kind: 30078,
      kindText: 'App Data (kind 30078)',
      preview: '{"subkey":"user-home-feeds"}',
    }))
  })

  it('maps remembered client pubkeys from relay slot listings', async () => {
    const { pubHex } = freshMaster()
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: 'wss://r' }
      }
      if (method === 'list_clients') {
        return {
          clients: [
            {
              slot_index: 0,
              label: 'Primal',
              current_pubkey: 'a'.repeat(64),
              authorized_pubkeys: ['a'.repeat(64), 'b'.repeat(64)],
              allowed_methods: ['sign_event', 'nip04_decrypt'],
              allowed_kinds: [30078],
              auto_approve: true,
              signing_approved: true,
            },
          ],
        }
      }
      return { ok: true }
    })

    await connectRelay(pubHex, ['wss://r.example'])
    try {
      expect(device.slots[0]?.authorized_pubkeys).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    } finally {
      await disconnect()
    }
  })

  it('summarizes multi-relay WiFi connections without hiding the full relay set', async () => {
    const { pubHex } = freshMaster()
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: 'wss://r' }
      }
      if (method === 'list_clients') return { clients: [] }
      return { ok: true }
    })

    const relays = ['wss://relay.trotters.cc', 'wss://nos.lol', 'wss://relay.primal.net']
    await connectRelay(pubHex, relays)
    try {
      expect(device.portInfo).toContain('3 relays')
      expect(device.relays).toEqual(relays)
    } finally {
      await disconnect()
    }
  })

  it('falls back to another saved operator key when the signer ignores the first', async () => {
    const { pubHex } = freshMaster()
    localStorage.setItem(LS_SK, 'b'.repeat(64))
    localStorage.setItem(LS_MNEMONIC, generateOperatorMnemonic())
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(function (this: { operatorPub?: string }, method: unknown) {
      if (method === 'get_status') {
        if (this.operatorPub === 'legacy-op') {
          return Promise.reject(new Error('timeout waiting for device (get_status)'))
        }
        return Promise.resolve({ master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: 'wss://r' })
      }
      if (method === 'list_clients') return Promise.resolve({ clients: [] })
      return Promise.resolve({ ok: true })
    })

    await connectRelay(pubHex, ['wss://r.example'])
    try {
      expect(device.operatorPub).toBe('op')
      const getStatusCalls = relayRequestMock.mock.calls.filter((c) => c[0] === 'get_status')
      expect(getStatusCalls).toHaveLength(2)
      expect(device.masters[0]?.npub).toBe(nip19.npubEncode(pubHex))
      expect(device.error).toBeNull()
    } finally {
      await disconnect()
    }
  })

  it('uses the long relay status timeout when refreshing signing audit', async () => {
    const { pubHex } = freshMaster()
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') {
        return {
          master_count: 1,
          master_npub_hex: pubHex,
          mode: 'wifi-standalone',
          relay: 'wss://r',
          audit: [],
        }
      }
      if (method === 'list_clients') return { clients: [] }
      return { ok: true }
    })

    await connectRelay(pubHex, ['wss://r.example'])
    relayRequestMock.mockClear()
    try {
      await refreshRelayAudit()
      expect(relayRequestMock).toHaveBeenCalledWith('get_status', {}, 75_000)
      expect(relayRequestMock).toHaveBeenCalledWith('list_clients', {}, 75_000)
    } finally {
      await disconnect()
    }
  })

  it('logs relay status timeouts so a busy signer is visible', async () => {
    const { pubHex } = freshMaster()
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') throw new Error('timeout waiting for device (get_status)')
      if (method === 'list_clients') return { clients: [] }
      return { ok: true }
    })

    await connectRelay(pubHex, ['wss://r.example'])
    try {
      expect(device.logs.join('\n')).toContain('WiFi status read timed out; signer may be busy signing or reconnecting.')
      expect(device.logs.join('\n')).toContain('timeout waiting for device (get_status)')
    } finally {
      await disconnect()
    }
  })

  it('re-fetches a pending bunker URI over relay management when the session cache is empty', async () => {
    const { pubHex } = freshMaster()
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: 'wss://r' }
      }
      if (method === 'list_clients') return { clients: [{
        slot_index: 3,
        label: 'pending',
        allowed_methods: ['get_public_key'],
        allowed_kinds: [],
        secret_fingerprint: SLOT_FP,
      }] }
      if (method === 'client_uri') return {
        slot_index: 3,
        secret_fingerprint: SLOT_FP,
        bunker_uri: 'bunker://abc?relay=wss%3A%2F%2Fr&secret=secret',
      }
      return { ok: true }
    })

    await connectRelay(pubHex, ['wss://r.example'])
    try {
      await expect(mgmtClientUri(3, SLOT_FP)).resolves.toBe('bunker://abc?relay=wss%3A%2F%2Fr&secret=secret')
      expect(relayRequestMock).toHaveBeenCalledWith('client_uri', {
        slot_index: 3,
        expected_secret_fingerprint: SLOT_FP,
      }, 35_000)
    } finally {
      await disconnect()
    }
  })

  it('creates a relay client with one versioned exact-policy request', async () => {
    const { pubHex } = freshMaster()
    const policy = fullClientPolicy()
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown, params: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: 'wss://r' }
      }
      if (method === 'list_clients') return { clients: [] }
      if (method === 'create_client_v2') {
        expect(params).toEqual({ label: 'Damus', policy })
        return {
          slot_index: 4,
          bunker_uri: 'bunker://abc?relay=wss%3A%2F%2Fr&secret=sek',
          secret: 'sek',
          signing_approved: true,
          secret_fingerprint: SLOT_FP,
          policy_version: 2,
          ...policy,
        }
      }
      return { ok: true }
    })

    await connectRelay(pubHex, ['wss://r.example'])
    try {
      await expect(mgmtCreateClient('Damus', policy)).resolves.toEqual(expect.objectContaining({ slot_index: 4 }))
      expect(relayRequestMock).toHaveBeenCalledWith('create_client_v2', { label: 'Damus', policy }, 35_000)
      expect(device.slotUris[4]).toBeUndefined()
    } finally {
      await disconnect()
    }
  })

  it('refreshes the slot list before surfacing a cross-manager mutation conflict', async () => {
    const { pubHex } = freshMaster()
    let clientReads = 0
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: 'wss://r' }
      }
      if (method === 'list_clients') {
        clientReads += 1
        return {
          clients: [{
            slot_index: 1,
            label: clientReads === 1 ? 'old occupant' : 'replacement occupant',
            allowed_methods: [],
            allowed_kinds: [],
          }],
        }
      }
      if (method === 'update_client') {
        throw new Error('Another phone or manager changed this signer first. Nothing from this request was applied; refresh the device state and try again.')
      }
      return { ok: true }
    })

    await connectRelay(pubHex, ['wss://r.example'])
    try {
      expect(device.slots[0]?.label).toBe('old occupant')
      await expect(mgmtUpdateClient(1, { label: 'unsafe stale edit' }, SLOT_FP))
        .rejects.toThrow(/Another phone or manager/)
      expect(clientReads).toBe(2)
      expect(device.slots[0]?.label).toBe('replacement occupant')
    } finally {
      await disconnect()
    }
  })

  it('revokes a relay client and hides its link when effective policy mismatches', async () => {
    const { pubHex } = freshMaster()
    const policy = fullClientPolicy()
    resolveMock.mockResolvedValue(new Map())
    relayRequestMock.mockImplementation(async (method: unknown) => {
      if (method === 'get_status') {
        return { master_count: 1, master_npub_hex: pubHex, mode: 'wifi-standalone', relay: 'wss://r' }
      }
      if (method === 'list_clients') return { clients: [] }
      if (method === 'create_client_v2') {
        return {
          slot_index: 5,
          bunker_uri: 'bunker://abc?secret=must-not-leak',
          secret: 'must-not-leak',
          secret_fingerprint: SLOT_FP,
          signing_approved: true,
          policy_version: 2,
          allowed_methods: ['get_public_key'],
          allowed_kinds: [],
          auto_approve: true,
        }
      }
      return { ok: true }
    })

    await connectRelay(pubHex, ['wss://r.example'])
    try {
      await expect(mgmtCreateClient('bad echo', policy)).rejects.toThrow(/did not confirm the exact app policy/)
      expect(relayRequestMock).toHaveBeenCalledWith('revoke_client', {
        slot_index: 5,
        expected_secret_fingerprint: SLOT_FP,
      }, 35_000)
      expect(device.slotUris[5]).toBeUndefined()
    } finally {
      await disconnect()
    }
  })

  it('never auto-syncs from an http master list', async () => {
    const { pubHex, master } = freshMaster()
    device.mode = 'http'
    device.connected = true
    resolveMock.mockResolvedValue(new Map([[pubHex, { name: 'eve', picture: 'https://x/e.jpg' }]]))

    emitMasterList([master]) // http mode receives the same frame shape
    await new Promise((r) => setTimeout(r, 0))
    expect(resolveMock).not.toHaveBeenCalled()
    expect(serialMock.sendAndReceive).not.toHaveBeenCalled()
  })
})
