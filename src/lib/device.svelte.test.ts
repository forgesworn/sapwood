import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nip19 } from 'nostr-tools'

// Mock the transports so device state logic runs without hardware, and the
// avatar/profile modules so no canvas or relay is needed. The serial mock
// captures the listener device.svelte.ts registers at import, which is the
// only way to feed frames into its (unexported) handleFrame.
const { serialMock, httpOn, resolveMock, loadAvatarMock, placeholderMock, buildMetaMock, relayRequestMock } = vi.hoisted(() => ({
  relayRequestMock: vi.fn(),
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
    async connect() { /* no relay in tests */ }
    request(...args: unknown[]) { return relayRequestMock(...args) }
    close() { /* nothing to tear down */ }
  },
}))

import { device, syncIdentityMeta, configureNetwork, mgmtCreateClient, mgmtRevokeClient, mgmtUpdateClient, mgmtApproveSigning, connectRelay, disconnect } from './device.svelte.js'
import { FrameType } from './frame.js'
import type { MasterInfo } from './types.js'

const FAKE_AVATAR = { w: 2, h: 2, bytes: new Uint8Array(8) }
const FAKE_FRAME = new Uint8Array([0xaa])
const ACK = { type: FrameType.ACK, payload: new Uint8Array() }
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
  device.mode = 'none'
  device.connected = false
  device.masters = []
  device.logs = []
  device.error = null
  resolveMock.mockReset()
  loadAvatarMock.mockReset()
  placeholderMock.mockReset()
  buildMetaMock.mockReset()
  serialMock.sendAndReceive.mockReset()
  relayRequestMock.mockReset()
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
    await expect(mgmtCreateClient('x', false)).rejects.toThrow('not connected')
    await expect(mgmtRevokeClient(0)).rejects.toThrow('not connected')
    await expect(mgmtUpdateClient(0, {})).rejects.toThrow('not connected')
  })

  it('mgmtApproveSigning over USB points at the physical button', async () => {
    device.mode = 'serial'
    device.connected = true
    await expect(mgmtApproveSigning(0)).rejects.toThrow(/PRG press/)
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
    expect(placeholderMock).toHaveBeenCalledWith('bob')
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
    expect(placeholderMock).toHaveBeenCalledWith('carol')
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
    } finally {
      await disconnect() // clears the 4s status poll
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
