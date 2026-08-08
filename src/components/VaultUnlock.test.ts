import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import { nip19 } from 'nostr-tools'
import VaultUnlock from './VaultUnlock.svelte'
import { device, ensureBridgeAuth, sendVaultKeyOverRelay } from '../lib/device.svelte.js'
import { serialVaultUnlock, storeVaultKey, loadVaultKey } from '../lib/vault.js'

const HEX = 'c'.repeat(64)
const NPUB = nip19.npubEncode(HEX)
const VAULT_KEY = 'a'.repeat(64)
const UNLOCK_PUB = 'd'.repeat(64)

// device.svelte is mocked (no transport); vault.js is real except the serial
// round trip, which would otherwise need a device.
vi.mock('../lib/device.svelte.js', () => ({
  device: {
    connected: true,
    mode: 'serial',
    masters: [],
    vaultUnlockRequest: null,
    relayDevicePub: '',
  },
  serialTransport: { sendAndReceive: vi.fn() },
  ensureBridgeAuth: vi.fn().mockResolvedValue(undefined),
  refreshMasters: vi.fn().mockResolvedValue(undefined),
  sendVaultKeyOverRelay: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../lib/vault.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/vault.js')>()
  return { ...actual, serialVaultUnlock: vi.fn().mockResolvedValue(undefined) }
})

const state = device as {
  mode: string
  masters: unknown[]
  vaultUnlockRequest: { unlockPub: string; lastSeen: number } | null
  relayDevicePub: string
}

beforeEach(() => {
  localStorage.clear()
  state.mode = 'serial'
  state.masters = []
  state.vaultUnlockRequest = null
  state.relayDevicePub = ''
  vi.mocked(ensureBridgeAuth).mockClear()
  vi.mocked(serialVaultUnlock).mockClear()
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
    expect(vi.mocked(serialVaultUnlock)).toHaveBeenCalledWith(expect.anything(), VAULT_KEY)
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
    expect(vi.mocked(serialVaultUnlock)).toHaveBeenCalledWith(expect.anything(), VAULT_KEY)
    expect(loadVaultKey(HEX)).toBe(VAULT_KEY)
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
