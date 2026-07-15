import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import ConnectApp from './ConnectApp.svelte'
import {
  mgmtCreateClient, mgmtNostrconnect, device,
} from '../lib/device.svelte.js'

// Mock the transport layer; the flow logic (connect-flow + client-presets) is real.
vi.mock('../lib/device.svelte.js', () => ({
  device: { mode: 'relay', connected: true, error: null, relays: ['wss://relay.trotters.cc'], masters: [], selectedSlot: 0 },
  mgmtCreateClient: vi.fn(),
  mgmtNostrconnect: vi.fn(),
}))

const mockCreate = vi.mocked(mgmtCreateClient)
const mockNostrconnect = vi.mocked(mgmtNostrconnect)

const RESULT = {
  bunker_uri: 'bunker://abcdef?relay=wss%3A%2F%2Fr&secret=deadbeef',
  secret: 'deadbeef',
  signing_approved: true,
  slot_index: 2,
}

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue(RESULT)
  mockNostrconnect.mockReset().mockResolvedValue({ slot_index: 3, joined_relay: false })
  ;(device as { mode: string }).mode = 'relay'
})

describe('ConnectApp — happy path', () => {
  it('walks hero → name → permissions → result and creates the connection', async () => {
    const { container } = render(ConnectApp)

    // Hero opens the flow
    await fireEvent.click(screen.getByText('Connect an app'))
    expect(screen.getByText('What are you connecting?')).toBeTruthy()

    // Continue is gated until a name is entered
    expect((screen.getByText('Continue') as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.input(container.querySelector('input')!, { target: { value: 'Damus on my phone' } })
    expect((screen.getByText('Continue') as HTMLButtonElement).disabled).toBe(false)
    await fireEvent.click(screen.getByText('Continue'))

    // Permissions step, default "posting only" → create
    expect(screen.getByText('Posting only')).toBeTruthy()
    await fireEvent.click(screen.getByText('Create connection'))

    // Lands on the result with a scannable QR
    expect(await screen.findByText('Connection ready')).toBeTruthy()
    expect(container.querySelector('.qr svg')).toBeTruthy()

    // One atomic create carries the full method + kind policy.
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledWith('Damus on my phone', {
      allowed_methods: ['get_public_key', 'sign_event'],
      allowed_kinds: [1, 5, 6, 7, 30023, 30078],
      auto_approve: true,
    })
  })

  it('applies a kind limit when a restricting preset is chosen', async () => {
    const { container } = render(ConnectApp)
    await fireEvent.click(screen.getByText('Connect an app'))
    await fireEvent.input(container.querySelector('input')!, { target: { value: 'chat app' } })
    await fireEvent.click(screen.getByText('Continue'))

    await fireEvent.click(screen.getByText('Messages only'))
    await fireEvent.click(screen.getByText('Create connection'))

    await screen.findByText('Connection ready')
    expect(mockCreate).toHaveBeenCalledWith('chat app', {
      allowed_methods: ['get_public_key', 'nip44_encrypt', 'nip44_decrypt', 'nip04_encrypt', 'nip04_decrypt', 'sign_event'],
      allowed_kinds: [4, 13, 1059],
      auto_approve: true,
    })
  })

  it('lets custom permissions include a numeric kind', async () => {
    const { container } = render(ConnectApp)
    await fireEvent.click(screen.getByText('Connect an app'))
    await fireEvent.input(container.querySelector('input')!, { target: { value: 'custom app' } })
    await fireEvent.click(screen.getByText('Continue'))

    await fireEvent.click(screen.getByText('Let me choose'))
    await fireEvent.click(screen.getByText('Note'))
    await fireEvent.input(screen.getByLabelText('Custom kind number'), { target: { value: '999999' } })
    await fireEvent.click(screen.getByText('Add kind'))
    await fireEvent.click(screen.getByText('Create connection'))

    await screen.findByText('Connection ready')
    expect(mockCreate).toHaveBeenCalledWith('custom app', {
      allowed_methods: ['get_public_key', 'sign_event'],
      allowed_kinds: [1, 999999],
      auto_approve: true,
    })
  })

  it('does not let an empty custom preset become unrestricted', async () => {
    const { container } = render(ConnectApp)
    await fireEvent.click(screen.getByText('Connect an app'))
    await fireEvent.input(container.querySelector('input')!, { target: { value: 'empty custom app' } })
    await fireEvent.click(screen.getByText('Continue'))

    await fireEvent.click(screen.getByText('Let me choose'))
    await fireEvent.click(screen.getByText('Create connection'))

    expect(screen.getByText('Choose at least one kind, or choose Everything.')).toBeTruthy()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('surfaces a creation failure without advancing', async () => {
    mockCreate.mockRejectedValueOnce(new Error('slots full'))
    const { container } = render(ConnectApp)
    await fireEvent.click(screen.getByText('Connect an app'))
    await fireEvent.input(container.querySelector('input')!, { target: { value: 'x' } })
    await fireEvent.click(screen.getByText('Continue'))
    await fireEvent.click(screen.getByText('Create connection'))

    expect(await screen.findByText('slots full')).toBeTruthy()
    expect(screen.queryByText('Connection ready')).toBeNull()
  })

  it('shows and forwards exact nostrconnect permissions', async () => {
    const { container } = render(ConnectApp)
    await fireEvent.click(screen.getByText('Connect an app'))
    await fireEvent.click(screen.getByText(/Have a connect link/))
    const uri = `nostrconnect://${'a'.repeat(64)}?relay=wss%3A%2F%2Frelay.trotters.cc&secret=sek&name=Chat&perms=nip44_decrypt%2Csign_event%3A13%2Csign_event%3A1059`
    await fireEvent.input(container.querySelector('textarea')!, { target: { value: uri } })

    expect(await screen.findByText(/sign event kinds 13, 1059; NIP-44 decrypt/)).toBeTruthy()
    await fireEvent.click(screen.getByText('Pair this app'))
    expect(mockNostrconnect).toHaveBeenCalledWith({
      clientPubkey: 'a'.repeat(64),
      secret: 'sek',
      label: 'Chat',
      policy: {
        allowed_methods: ['get_public_key', 'nip44_decrypt', 'sign_event'],
        allowed_kinds: [13, 1059],
        auto_approve: true,
      },
    })
  })

  it('blocks a nostrconnect link with an unknown permission', async () => {
    const { container } = render(ConnectApp)
    await fireEvent.click(screen.getByText('Connect an app'))
    await fireEvent.click(screen.getByText(/Have a connect link/))
    const uri = `nostrconnect://${'a'.repeat(64)}?relay=wss%3A%2F%2Frelay.trotters.cc&secret=sek&perms=delete_everything`
    await fireEvent.input(container.querySelector('textarea')!, { target: { value: uri } })

    expect(await screen.findByText('Unknown permission “delete_everything”.')).toBeTruthy()
    expect((screen.getByText('Pair this app') as HTMLButtonElement).disabled).toBe(true)
    expect(mockNostrconnect).not.toHaveBeenCalled()
  })
})
