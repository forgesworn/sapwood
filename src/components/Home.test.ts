import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, within } from '@testing-library/svelte'
import { nip19 } from 'nostr-tools'
import Home from './Home.svelte'
import { device, refreshSlots, mgmtApproveSigning, mgmtClientUri, mgmtRevokeClient } from '../lib/device.svelte.js'
import { setDeviceLabel } from '../lib/known-devices.js'
import { copyText } from '../lib/clipboard.js'

const HEX = 'c'.repeat(64)
const NPUB = nip19.npubEncode(HEX)

// device.svelte is mocked (no transport); known-devices is REAL so rename persists.
// The factory is hoisted, so it must not reference top-level consts — masters
// are set in beforeEach instead.
vi.mock('../lib/device.svelte.js', () => ({
  device: { connected: true, mode: 'relay', error: null, masters: [], slots: [] },
  refreshSlots: vi.fn(),
  refreshMasters: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  mgmtApproveSigning: vi.fn().mockResolvedValue(undefined),
  mgmtRevokeClient: vi.fn().mockResolvedValue(undefined),
  mgmtUpdateClient: vi.fn().mockResolvedValue(undefined),
  mgmtClientUri: vi.fn().mockResolvedValue('bunker://abc?relay=wss%3A%2F%2Fr&secret=secret'),
  mgmtCanApproveSigning: vi.fn(() => true),
  getFirmwareVersion: vi.fn().mockResolvedValue(null),
  // Pulled in transitively by FirstIdentity (rendered only in the no-master case).
  serialTransport: { sendAndReceive: vi.fn() },
  connectRelay: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../lib/clipboard.js', () => ({
  copyText: vi.fn().mockResolvedValue(true),
}))

beforeEach(() => {
  localStorage.clear()
  ;(device as { masters: unknown[] }).masters = [
    { slot: 0, label: 'master', mode: -1, modeLabel: 'WIFI', npub: NPUB },
  ]
  ;(device as { slots: unknown[] }).slots = []
  vi.mocked(refreshSlots).mockClear()
  vi.mocked(mgmtApproveSigning).mockClear()
  vi.mocked(mgmtClientUri).mockClear()
  vi.mocked(mgmtRevokeClient).mockClear()
  vi.mocked(copyText).mockClear()
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

  it('lets a connected app copy its reusable link from the friendly app row', async () => {
    ;(device as { slots: unknown[] }).slots = [
      { slot_index: 4, label: 'Primal', current_pubkey: 'p'.repeat(64), signing_approved: true, allowed_kinds: [], auto_approve: true },
    ]
    render(Home)
    const card = screen.getByText('Primal').closest('.app-card') as HTMLElement
    await fireEvent.click(within(card).getByText('Copy link'))
    expect(vi.mocked(mgmtClientUri)).toHaveBeenCalledWith(4)
    expect(vi.mocked(copyText)).toHaveBeenCalledWith('bunker://abc?relay=wss%3A%2F%2Fr&secret=secret')
  })

  it('renames the signer and persists it', async () => {
    render(Home)
    await fireEvent.click(screen.getByLabelText('Rename signer'))
    const input = screen.getByPlaceholderText('Name this signer') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'home rig' } })
    await fireEvent.click(screen.getByText('Save'))
    expect(screen.getByText('home rig')).toBeTruthy()
  })

  it('shows the connection + Disconnect in the signer card (no separate panel)', () => {
    render(Home)
    expect(screen.getByText(/Connected over/)).toBeTruthy()
    expect(screen.getByText('Disconnect')).toBeTruthy()
  })

  it('confirms in-app before disconnecting an app (no native dialog)', async () => {
    ;(device as { slots: unknown[] }).slots = [
      { slot_index: 2, label: 'Amethyst', current_pubkey: 'e'.repeat(64), signing_approved: true, allowed_kinds: [], auto_approve: true },
    ]
    render(Home)
    const card = screen.getByText('Amethyst').closest('.app-card') as HTMLElement
    await fireEvent.click(within(card).getByText('Disconnect'))
    // Inline confirmation appears; nothing is revoked until confirmed.
    expect(screen.getByText('Disconnect this app?')).toBeTruthy()
    expect(vi.mocked(mgmtRevokeClient)).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByText('Yes, disconnect'))
    expect(vi.mocked(mgmtRevokeClient)).toHaveBeenCalledWith(2)
  })

  it('nudges an operator-key backup until confirmed, then stays quiet', async () => {
    const first = render(Home)
    expect(screen.getByText('Back up your operator key')).toBeTruthy()
    // Reveal, confirm, and the card goes away…
    await fireEvent.click(screen.getByText(/Show my (recovery phrase|operator secret)/))
    await fireEvent.click(screen.getByText("I've written it down"))
    expect(screen.queryByText('Back up your operator key')).toBeNull()
    // …and stays away on the next visit (persisted per key).
    first.unmount()
    render(Home)
    expect(screen.queryByText('Back up your operator key')).toBeNull()
  })

  it('leads with guided setup when the device has no identity yet (over USB)', () => {
    ;(device as { masters: unknown[] }).masters = []
    ;(device as { mode: string }).mode = 'serial'
    render(Home)
    expect(screen.getByText("Let's give your signer its identity")).toBeTruthy()
    // The connect-an-app hero is hidden until there is an identity to connect to.
    expect(screen.queryByText('Your signer is live')).toBeNull()
  })

  it('asks for a USB cable when there is no identity and no USB link', () => {
    ;(device as { masters: unknown[] }).masters = []
    ;(device as { mode: string }).mode = 'http'
    render(Home)
    expect(screen.getByText('This signer needs an identity')).toBeTruthy()
  })

  it('shows a reaching-over-WiFi state (not "needs an identity") while the relay status is pending', () => {
    ;(device as { masters: unknown[] }).masters = []
    ;(device as { mode: string }).mode = 'relay'
    ;(device as { relayStatus: unknown }).relayStatus = null
    ;(device as { error: unknown }).error = null
    render(Home)
    expect(screen.getByText('Reaching your signer over WiFi…')).toBeTruthy()
    expect(screen.queryByText('This signer needs an identity')).toBeNull()
  })

  it('diagnoses relay/operator mismatch (not "needs an identity") when the device never answers', () => {
    ;(device as { masters: unknown[] }).masters = []
    ;(device as { mode: string }).mode = 'relay'
    ;(device as { relayStatus: unknown }).relayStatus = null
    ;(device as { error: unknown }).error = 'timeout waiting for device (get_status)'
    ;(device as { portInfo: string }).portInfo = 'npub1cc…cc · wss://relay.trotters.cc'
    render(Home)
    expect(screen.getByText("Connected to the relay, but your signer isn't answering")).toBeTruthy()
    expect(screen.getByText(/Operator-key mismatch/)).toBeTruthy()
    expect(screen.queryByText('This signer needs an identity')).toBeNull()
  })
})
