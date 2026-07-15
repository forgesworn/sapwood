import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import AppsPanel from './AppsPanel.svelte'
import { device } from '../lib/device.svelte.js'

// Mock the transport layer; the panel's rendering logic is real.
vi.mock('../lib/device.svelte.js', () => ({
  device: {
    mode: 'serial',
    connected: true,
    error: null,
    masters: [] as { slot: number; npub: string; label: string; mode: number }[],
    selectedSlot: 0,
    slots: [],
    pendingClients: [],
    approvals: [],
    relays: [],
  },
  refreshSlots: vi.fn(),
  httpTransport: {},
  mgmtCreateClient: vi.fn(),
  mgmtApproveSigning: vi.fn(),
  mgmtRevokeClient: vi.fn(),
  mgmtUpdateClient: vi.fn(),
  mgmtCanApproveSigning: vi.fn(() => false),
  mgmtClientUri: vi.fn(),
}))

vi.mock('../lib/profiles.svelte.js', () => ({
  ensureProfiles: vi.fn(),
  profileName: vi.fn(() => null),
}))

const MASTERS = [
  { slot: 0, npub: 'npub1master', label: 'default', mode: 1 },
  { slot: 1, npub: 'npub1child', label: 'pallasite', mode: 0 },
]

beforeEach(() => {
  device.mode = 'serial'
  device.masters = []
  device.selectedSlot = 0
})

describe('AppsPanel identity picker', () => {
  it('shows the picker over USB when the signer holds more than one identity', () => {
    // The regression: the picker was gated to bridge mode, so a second
    // identity added over USB could never be chosen for new app connections.
    device.masters = MASTERS
    render(AppsPanel)

    const picker = screen.getByLabelText('Identity apps sign as') as HTMLSelectElement
    const labels = Array.from(picker.options).map((o) => o.textContent)
    expect(labels).toEqual(['default', 'pallasite'])
  })

  it('shows the picker over the bridge too', () => {
    device.mode = 'http'
    device.masters = MASTERS
    render(AppsPanel)
    expect(screen.getByLabelText('Identity apps sign as')).toBeTruthy()
  })

  it('hides the picker with a single identity', () => {
    device.masters = [MASTERS[0]!]
    render(AppsPanel)
    expect(screen.queryByLabelText('Identity apps sign as')).toBeNull()
  })

  it('excludes derived personas: they share their owner slot table', () => {
    // A persona row carries its OWNING master's slot, so offering it as a
    // separate target would duplicate slot 0. One real master + personas
    // means there is still nothing to pick between.
    device.masters = [
      MASTERS[0]!,
      { slot: 0, npub: 'npub1personakey', label: 'pallasite', persona: true } as never,
    ]
    render(AppsPanel)
    expect(screen.queryByLabelText('Identity apps sign as')).toBeNull()
  })
})
