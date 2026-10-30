import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import AppsPanel from './AppsPanel.svelte'
import {
  device,
  refreshSlots,
  mgmtCreateClient,
  mgmtRevokeClient,
  mgmtApplyPresetPermissions,
} from '../lib/device.svelte.js'

// Mock the transport layer; the panel's rendering logic is real.
vi.mock('../lib/device.svelte.js', () => ({
  device: {
    mode: 'serial',
    connected: true,
    error: null,
    masters: [] as { slot: number; npub: string; label: string; mode: number }[],
    selectedSlot: 0,
    connectionGeneration: 0,
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
  mgmtApplyPresetPermissions: vi.fn(),
}))

vi.mock('../lib/profiles.svelte.js', () => ({
  ensureProfiles: vi.fn(),
  profileName: vi.fn(() => null),
}))

const MASTERS = [
  { slot: 0, npub: 'npub1master', label: 'default', mode: 1 },
  { slot: 1, npub: 'npub1child', label: 'pallasite', mode: 0 },
]

// A strict (exact-policy) signed app slot, eligible for the KithMoot upgrade.
function strictSignedSlot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slot_index: 1,
    label: 'Damus',
    current_pubkey: 'a'.repeat(64),
    authorized_pubkeys: [],
    signing_approved: true,
    strict_permissions: true,
    allowed_methods: ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'],
    allowed_kinds: [1, 7],
    auto_approve: true,
    secret_fingerprint: 'fp1',
    ...overrides,
  }
}

// A legacy (non-strict) signed app slot.
function legacySignedSlot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return strictSignedSlot({
    label: 'Old app',
    strict_permissions: false,
    allowed_methods: ['get_public_key', 'sign_event'],
    allowed_kinds: [1],
    ...overrides,
  })
}

async function openReview(slot: Record<string, unknown>, presetId = 'kithmoot-private') {
  // The review is only reachable when the panel knows which signer it is
  // acting for: seed a realistic connected master so the identity picker
  // doesn't gate the "Add preset" control.
  device.masters = [MASTERS[0]!]
  device.slots = [slot as never]
  render(AppsPanel)
  await choosePreset(presetId)
  await fireEvent.click(screen.getByText('Add preset'))
}

async function choosePreset(id: string) {
  await fireEvent.change(screen.getByLabelText('Preset to add'), { target: { value: id } })
}

beforeEach(() => {
  vi.clearAllMocks()
  device.mode = 'serial'
  device.connected = true
  device.error = null
  device.masters = []
  device.selectedSlot = 0
  device.connectionGeneration = 0
  device.slots = []
  device.pendingClients = []
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

describe('AppsPanel KithMoot permission review', () => {
  it('opening the review is explicit: no backend call until Confirm', async () => {
    await openReview(strictSignedSlot())
    expect(screen.getByText(/Add KithMoot private rooms to/)).toBeTruthy()
    expect(mgmtApplyPresetPermissions).not.toHaveBeenCalled()
  })

  it('a legacy signed slot can also be reviewed', async () => {
    await openReview(legacySignedSlot())
    expect(screen.getByText(/Add KithMoot private rooms to/)).toBeTruthy()
    expect(mgmtApplyPresetPermissions).not.toHaveBeenCalled()
  })

  it('confirm sends the full methods/kinds snapshot once and never creates or revokes', async () => {
    await openReview(strictSignedSlot())
    // Snapshot copy is rendered from the pinned review slot.
    expect(screen.getByText('Final signing methods:')).toBeTruthy()
    expect(screen.getByText('Sign events')).toBeTruthy()
    expect(screen.getByText('Encrypt messages (NIP-44)')).toBeTruthy()
    expect(screen.getByText('Final event kinds:')).toBeTruthy()
    expect(screen.getByText('Note')).toBeTruthy()
    expect(screen.getByText('Reaction')).toBeTruthy()

    const initialRefreshCalls = vi.mocked(refreshSlots).mock.calls.length
    await fireEvent.click(screen.getByText('Confirm'))

    await waitFor(() => expect(mgmtApplyPresetPermissions).toHaveBeenCalledTimes(1))
    expect(mgmtApplyPresetPermissions).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: expect.objectContaining({
          slot_index: 1,
          allowed_methods: ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'],
          allowed_kinds: [1, 7],
        }),
        masterSlot: 0,
        connectionGeneration: 0,
        mode: 'serial',
        preset: expect.objectContaining({ id: 'kithmoot-private' }),
      }),
    )
    expect(mgmtCreateClient).not.toHaveBeenCalled()
    expect(mgmtRevokeClient).not.toHaveBeenCalled()
    expect(refreshSlots).toHaveBeenCalledTimes(initialRefreshCalls)
    await waitFor(() =>
      expect(screen.getByText('KithMoot rooms added. Existing permissions were kept.')).toBeTruthy(),
    )
  })

  it('cancel performs no writes and closes the review', async () => {
    await openReview(strictSignedSlot())
    await fireEvent.click(screen.getByText('Cancel'))
    expect(mgmtApplyPresetPermissions).not.toHaveBeenCalled()
    expect(mgmtCreateClient).not.toHaveBeenCalled()
    expect(mgmtRevokeClient).not.toHaveBeenCalled()
    expect(screen.queryByText(/Add KithMoot private rooms to/)).toBeNull()
  })

  it('a slot already covered by the upgrade is disabled with a reason', async () => {
    await openReview(strictSignedSlot({ allowed_kinds: [1, 7, 20460, 21236, 30078] }))
    await choosePreset('kithmoot-private')
    const btn = screen.getByText('Add preset') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.queryByText('Confirm')).toBeNull()
    expect(mgmtApplyPresetPermissions).not.toHaveBeenCalled()
  })

  it('a slot that cannot sign is disabled', async () => {
    await openReview(strictSignedSlot({ allowed_methods: ['get_public_key'] }))
    await choosePreset('kithmoot-private')
    const btn = screen.getByText('Add preset') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(mgmtApplyPresetPermissions).not.toHaveBeenCalled()
  })

  it('review copy states the manual-signing setting is preserved', async () => {
    await openReview(strictSignedSlot({ auto_approve: false }))
    expect(
      screen.getByText(
        'Manual signing is kept: each signature still needs a press of the button on the device.',
      ),
    ).toBeTruthy()
  })

  it('a retained-only upgrade shows that all kinds are already allowed', async () => {
    // An empty kind ceiling remains unrestricted; a retained key is sufficient.
    await openReview(
      strictSignedSlot({
        allowed_kinds: [],
        allowed_methods: ['get_public_key', 'sign_event'],
        current_pubkey: null,
        authorized_pubkeys: ['b'.repeat(64)],
      }),
    )
    expect(screen.getByText('All event kinds already allowed.')).toBeTruthy()
  })

  it('a backend failure shows the error and no success message', async () => {
    vi.mocked(mgmtApplyPresetPermissions).mockRejectedValueOnce(new Error('device refused'))
    await openReview(strictSignedSlot())
    await fireEvent.click(screen.getByText('Confirm'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('device refused')
    expect(screen.queryByText('KithMoot rooms added. Existing permissions were kept.')).toBeNull()
  })

  it('aborts a review whose connection generation changed', async () => {
    await openReview(strictSignedSlot())
    device.connectionGeneration = 9
    await fireEvent.click(screen.getByText('Confirm'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('changed since the review opened')
    expect(mgmtApplyPresetPermissions).not.toHaveBeenCalled()
  })

  it('aborts a review whose slot policy changed on the device', async () => {
    await openReview(strictSignedSlot())
    ;(device.slots[0] as { allowed_kinds: number[] }).allowed_kinds = [1, 7, 20460]
    await fireEvent.click(screen.getByText('Confirm'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("permissions changed since the review opened")
    expect(mgmtApplyPresetPermissions).not.toHaveBeenCalled()
  })
})

describe('AppsPanel V4V preset review', () => {
  it('reviews V4V listener with its heading, note and final kinds', async () => {
    await openReview(strictSignedSlot(), 'v4v-listener')
    expect(screen.getByText(/Add V4V listener to/)).toBeTruthy()
    expect(screen.getByText(/zap requests, live chat, playlist notes/)).toBeTruthy()
    expect(screen.getByText(/account-wide and not restricted to V4V/)).toBeTruthy()
    expect(screen.getByText('Final event kinds:')).toBeTruthy()
    expect(screen.queryByText(/device credentials including person scope/)).toBeNull()
  })

  it('confirm applies the chosen V4V preset', async () => {
    await openReview(strictSignedSlot(), 'v4v-listener')
    await fireEvent.click(screen.getByText('Confirm'))
    await waitFor(() => expect(mgmtApplyPresetPermissions).toHaveBeenCalledTimes(1))
    expect(mgmtApplyPresetPermissions).toHaveBeenCalledWith(
      expect.objectContaining({ preset: expect.objectContaining({ id: 'v4v-listener' }) }),
    )
    await waitFor(() =>
      expect(screen.getByText('V4V listener added. Existing permissions were kept.')).toBeTruthy(),
    )
  })

  it('V4V artist warns about money terms', async () => {
    await openReview(strictSignedSlot(), 'v4v-artist')
    expect(screen.getByText(/Add V4V artist to/)).toBeTruthy()
    expect(screen.getByText(/set or move money terms/)).toBeTruthy()
  })

  it('Sign in only says it adds the sign-in proof and nothing else', async () => {
    await openReview(strictSignedSlot(), 'sign-in')
    expect(screen.getByText(/Add Sign in only to/)).toBeTruthy()
    expect(screen.getByText(/adds the account sign-in proof \(kind 21236\) and nothing else/)).toBeTruthy()
  })

  it('keeps the manual-signing line for a V4V preset', async () => {
    await openReview(strictSignedSlot({ auto_approve: false }), 'v4v-artist')
    expect(
      screen.getByText('Manual signing is kept: each signature still needs a press of the button on the device.'),
    ).toBeTruthy()
  })

  it('disables a preset already covered, with its reason, while others stay available', async () => {
    device.masters = [MASTERS[0]!]
    device.slots = [strictSignedSlot({ allowed_kinds: [21236] }) as never]
    render(AppsPanel)
    await choosePreset('sign-in')
    expect((screen.getByText('Add preset') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Sign in only already enabled')).toBeTruthy()
    const opts = Array.from((screen.getByLabelText('Preset to add') as HTMLSelectElement).options)
    expect(opts.find((o) => o.value === 'sign-in')!.disabled).toBe(true)
    expect(opts.find((o) => o.value === 'v4v-listener')!.disabled).toBe(false)
  })

  it('disables every preset with the signing reason when signing is not approved', async () => {
    device.masters = [MASTERS[0]!]
    device.slots = [strictSignedSlot({ signing_approved: false }) as never]
    render(AppsPanel)
    expect((screen.getByText('Add preset') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Signing approval needed first')).toBeTruthy()
  })
})
