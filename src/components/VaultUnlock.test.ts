import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import { nip19 } from 'nostr-tools'
import VaultUnlock from './VaultUnlock.svelte'
import { device, ensureBridgeAuth, sendVaultKeyOverRelay } from '../lib/device.svelte.js'
import { serialVaultUnlock, serialVaultLockedSlots, storeVaultKey, loadVaultKey } from '../lib/vault.js'

const HEX = 'c'.repeat(64)
const NPUB = nip19.npubEncode(HEX)
const VAULT_KEY = 'a'.repeat(64)
const UNLOCK_PUB = 'd'.repeat(64)

// device.svelte is mocked (no transport); vault.js is real except the serial
// round trip, which would otherwise need a device.
vi.mock('../lib/device.svelte.js', () => {
  const device = {
    connected: true,
    connectionGeneration: 0,
    mode: 'serial',
    masters: [],
    vaultUnlockRequest: null as { unlockPub: string; lastSeen: number } | null,
    relayDevicePub: '',
    vaultRelayTarget: null as { pubHex: string; relays: string[] } | null,
    vaultReconnect: null as { attempt: number; startedAt: number } | null,
    awaitingButton: null as string | null,
  }
  return {
    device,
    serialTransport: { sendAndReceive: vi.fn() },
    ensureBridgeAuth: vi.fn().mockResolvedValue(undefined),
    refreshMasters: vi.fn().mockResolvedValue(undefined),
    sendVaultKeyOverRelay: vi.fn().mockResolvedValue(undefined),
    vaultRelayDevicePub: () => device.relayDevicePub || device.vaultRelayTarget?.pubHex || '',
  }
})

vi.mock('../lib/vault.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/vault.js')>()
  return {
    ...actual,
    serialVaultUnlock: vi.fn().mockResolvedValue(undefined),
    serialVaultLockedSlots: vi.fn().mockResolvedValue(1),
  }
})

const state = device as {
  connected: boolean
  connectionGeneration: number
  mode: string
  masters: unknown[]
  vaultUnlockRequest: { unlockPub: string; lastSeen: number } | null
  relayDevicePub: string
  vaultRelayTarget: { pubHex: string; relays: string[] } | null
  vaultReconnect: { attempt: number; startedAt: number } | null
}

beforeEach(() => {
  localStorage.clear()
  state.connected = true
  state.connectionGeneration = 0
  state.mode = 'serial'
  state.masters = []
  state.vaultUnlockRequest = null
  state.relayDevicePub = ''
  state.vaultRelayTarget = null
  state.vaultReconnect = null
  vi.mocked(ensureBridgeAuth).mockClear()
  vi.mocked(serialVaultUnlock).mockClear()
  vi.mocked(serialVaultLockedSlots).mockClear().mockResolvedValue(1)
  vi.mocked(sendVaultKeyOverRelay).mockClear()
})

describe('VaultUnlock banner', () => {
  it('renders nothing when no identity is locked', () => {
    state.masters = [{ slot: 0, label: 'master', npub: NPUB }]
    const { container } = render(VaultUnlock)
    expect(container.querySelector('.vault-banner')).toBeNull()
  })

  it('ignores locked rows when connected over WiFi (the relay path announces instead)', () => {
    state.mode = 'relay'
    state.masters = [{ slot: 0, label: 'master', npub: NPUB, locked: true }]
    const { container } = render(VaultUnlock)
    expect(container.querySelector('.vault-banner')).toBeNull()
  })

  it('offers one-tap USB unlock when this browser holds the key', async () => {
    state.masters = [{ slot: 0, label: 'master', npub: NPUB, locked: true }]
    storeVaultKey(HEX, VAULT_KEY)
    render(VaultUnlock)
    expect(screen.getByText('Signer is locked')).toBeTruthy()
    expect(screen.queryByPlaceholderText('64 hex characters')).toBeNull()
    await fireEvent.click(screen.getByText('Unlock'))
    expect(vi.mocked(ensureBridgeAuth)).toHaveBeenCalled()
    await vi.waitFor(() => expect(vi.mocked(serialVaultLockedSlots)).toHaveBeenCalled())
    await vi.waitFor(() => expect(vi.mocked(serialVaultUnlock)).toHaveBeenCalledWith(expect.anything(), VAULT_KEY, 1))
  })

  it('sizes the USB wait to the sealed count and skips the unlock when nothing is sealed', async () => {
    state.masters = [{ slot: 0, label: 'master', npub: NPUB, locked: true }]
    storeVaultKey(HEX, VAULT_KEY)
    vi.mocked(serialVaultLockedSlots).mockResolvedValue(3)
    render(VaultUnlock)
    await fireEvent.click(screen.getByText('Unlock'))
    await vi.waitFor(() => expect(vi.mocked(serialVaultUnlock)).toHaveBeenCalledWith(expect.anything(), VAULT_KEY, 3))

    // A first attempt whose ACK we missed left the signer unsealed: say so
    // instead of paying the whole KDF to hear "already unlocked".
    vi.mocked(serialVaultUnlock).mockClear()
    vi.mocked(serialVaultLockedSlots).mockResolvedValue(0)
    await vi.waitFor(() => expect(screen.getByText('Unlock')).toBeTruthy()) // first attempt settled
    await fireEvent.click(screen.getByText('Unlock'))
    await vi.waitFor(() => expect(screen.getByText(/already unlocked/)).toBeTruthy())
    expect(vi.mocked(serialVaultUnlock)).not.toHaveBeenCalled()
  })

  it('still unlocks (with the default wait) when the signer will not say what is sealed', async () => {
    state.masters = [{ slot: 0, label: 'master', npub: NPUB, locked: true }]
    storeVaultKey(HEX, VAULT_KEY)
    vi.mocked(serialVaultLockedSlots).mockRejectedValue(new Error('no reply'))
    render(VaultUnlock)
    await fireEvent.click(screen.getByText('Unlock'))
    await vi.waitFor(() => expect(vi.mocked(serialVaultUnlock)).toHaveBeenCalledWith(expect.anything(), VAULT_KEY, null))
  })

  it('prompts for the escrowed key over USB when none is stored, then remembers it', async () => {
    state.masters = [{ slot: 0, label: 'master', npub: NPUB, locked: true }]
    render(VaultUnlock)
    const input = screen.getByPlaceholderText('64 hex characters')
    const button = screen.getByText('Unlock') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await fireEvent.input(input, { target: { value: 'junk' } })
    expect(button.disabled).toBe(true)
    await fireEvent.input(input, { target: { value: VAULT_KEY.toUpperCase() } })
    expect(button.disabled).toBe(false)
    await fireEvent.click(button)
    await vi.waitFor(() => expect(vi.mocked(serialVaultUnlock)).toHaveBeenCalledWith(expect.anything(), VAULT_KEY, 1))
    await vi.waitFor(() => expect(loadVaultKey(HEX)).toBe(VAULT_KEY))
  })

  it('shows the relay ask with the reboot caveat and delivers on tap', async () => {
    state.mode = 'relay'
    state.relayDevicePub = HEX
    state.vaultUnlockRequest = { unlockPub: UNLOCK_PUB, lastSeen: Date.now() }
    storeVaultKey(HEX, VAULT_KEY)
    render(VaultUnlock)
    expect(screen.getByText(/Only do this if you know it just rebooted/)).toBeTruthy()
    await fireEvent.click(screen.getByText('Unlock'))
    expect(vi.mocked(sendVaultKeyOverRelay)).toHaveBeenCalledWith(undefined)
  })

  it('shows the ask for a signer we dialled and could not reach because it was locked', async () => {
    // No session ever formed, so mode is still 'none'; the failed dial left
    // only vaultRelayTarget behind. The banner and the stored key must both
    // key off that, or a locked boot is invisible until it is unlocked.
    state.connected = false
    state.mode = 'none'
    state.relayDevicePub = ''
    state.vaultRelayTarget = { pubHex: HEX, relays: ['wss://relay.example'] }
    state.vaultUnlockRequest = { unlockPub: UNLOCK_PUB, lastSeen: Date.now() }
    storeVaultKey(HEX, VAULT_KEY)
    render(VaultUnlock)
    expect(screen.getByText('Signer is locked')).toBeTruthy()
    expect(screen.queryByPlaceholderText('64 hex characters')).toBeNull()
    await fireEvent.click(screen.getByText('Unlock'))
    expect(vi.mocked(sendVaultKeyOverRelay)).toHaveBeenCalledWith(undefined)
  })

  it('reports the post-delivery reconnect while it dials', () => {
    state.connected = false
    state.mode = 'none'
    state.vaultRelayTarget = { pubHex: HEX, relays: ['wss://relay.example'] }
    state.vaultReconnect = { attempt: 2, startedAt: Date.now() - 30_000 }
    render(VaultUnlock)
    expect(screen.getByText(/attempt 2/)).toBeTruthy()
  })

  it('hides a stale relay announcement (the signer unlocked or went quiet)', () => {
    state.mode = 'relay'
    state.relayDevicePub = HEX
    state.vaultUnlockRequest = { unlockPub: UNLOCK_PUB, lastSeen: Date.now() - 200_000 }
    const { container } = render(VaultUnlock)
    expect(container.querySelector('.vault-banner')).toBeNull()
  })

  it('prompts for the escrowed key over WiFi when none is stored', async () => {
    state.mode = 'relay'
    state.relayDevicePub = HEX
    state.vaultUnlockRequest = { unlockPub: UNLOCK_PUB, lastSeen: Date.now() }
    render(VaultUnlock)
    await fireEvent.input(screen.getByPlaceholderText('64 hex characters'), { target: { value: VAULT_KEY } })
    await fireEvent.click(screen.getByText('Unlock'))
    expect(vi.mocked(sendVaultKeyOverRelay)).toHaveBeenCalledWith(VAULT_KEY)
    expect(loadVaultKey(HEX)).toBe(VAULT_KEY)
  })
})
