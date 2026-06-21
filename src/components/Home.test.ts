import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import { nip19 } from 'nostr-tools'
import Home from './Home.svelte'
import { device, refreshSlots, mgmtApproveSigning } from '../lib/device.svelte.js'
import { setDeviceLabel } from '../lib/known-devices.js'

const HEX = 'c'.repeat(64)
const NPUB = nip19.npubEncode(HEX)

// device.svelte is mocked (no transport); known-devices is REAL so rename persists.
// The factory is hoisted, so it must not reference top-level consts — masters
// are set in beforeEach instead.
vi.mock('../lib/device.svelte.js', () => ({
  device: { connected: true, mode: 'relay', error: null, masters: [], slots: [] },
  refreshSlots: vi.fn(),
  mgmtApproveSigning: vi.fn().mockResolvedValue(undefined),
  mgmtRevokeClient: vi.fn().mockResolvedValue(undefined),
  mgmtCanApproveSigning: vi.fn(() => true),
}))

beforeEach(() => {
  localStorage.clear()
  ;(device as { masters: unknown[] }).masters = [
    { slot: 0, label: 'master', mode: -1, modeLabel: 'WIFI', npub: NPUB },
  ]
  ;(device as { slots: unknown[] }).slots = []
  vi.mocked(refreshSlots).mockClear()
  vi.mocked(mgmtApproveSigning).mockClear()
})

describe('Home', () => {
  it('shows the signer with a friendly default name and abbreviated address', () => {
    render(Home)
    expect(screen.getByText('Your signer is live')).toBeTruthy()
    expect(screen.getByText('Your signer')).toBeTruthy()
    expect(screen.getByText(/^npub1/)).toBeTruthy()
  })

  it('prefers a saved device label over the default', () => {
    setDeviceLabel(HEX, "bark's signer")
    render(Home)
    expect(screen.getByText("bark's signer")).toBeTruthy()
  })

  it('shows the empty state when no apps are connected', () => {
    render(Home)
    expect(screen.getByText(/No apps connected yet/)).toBeTruthy()
  })

  it('lists connected apps and can allow signing on an unapproved one', async () => {
    ;(device as { slots: unknown[] }).slots = [
      { slot_index: 1, label: 'Damus', current_pubkey: 'd'.repeat(64), signing_approved: false, allowed_kinds: [], auto_approve: false },
    ]
    render(Home)
    expect(screen.getByText('Damus')).toBeTruthy()
    await fireEvent.click(screen.getByText('Allow signing'))
    expect(vi.mocked(mgmtApproveSigning)).toHaveBeenCalledWith(1)
  })

  it('renames the signer and persists it', async () => {
    render(Home)
    await fireEvent.click(screen.getByLabelText('Rename signer'))
    const input = screen.getByPlaceholderText('Name this signer') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'home rig' } })
    await fireEvent.click(screen.getByText('Save'))
    expect(screen.getByText('home rig')).toBeTruthy()
  })
})
