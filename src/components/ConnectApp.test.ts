import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import ConnectApp from './ConnectApp.svelte'
import {
  mgmtCreateClient, mgmtUpdateClient, mgmtCanApproveSigning, device,
} from '../lib/device.svelte.js'

// Mock the transport layer; the flow logic (connect-flow + client-presets) is real.
vi.mock('../lib/device.svelte.js', () => ({
  device: { mode: 'relay', connected: true, error: null },
  mgmtCanApproveSigning: vi.fn(() => true),
  mgmtCreateClient: vi.fn(),
  mgmtUpdateClient: vi.fn(),
}))

const mockCreate = vi.mocked(mgmtCreateClient)
const mockUpdate = vi.mocked(mgmtUpdateClient)

const RESULT = {
  bunker_uri: 'bunker://abcdef?relay=wss%3A%2F%2Fr&secret=deadbeef',
  secret: 'deadbeef',
  signing_approved: true,
  slot_index: 2,
}

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue(RESULT)
  mockUpdate.mockReset().mockResolvedValue(undefined)
  vi.mocked(mgmtCanApproveSigning).mockReturnValue(true)
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

    // Created once, pre-approving signing (relay authority), then restricted to posting kinds.
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledWith('Damus on my phone', true)
    expect(mockUpdate).toHaveBeenCalledWith(RESULT.slot_index, { allowed_kinds: [1, 5, 6, 7, 30023, 30078] })
  })

  it('applies a kind limit when a restricting preset is chosen', async () => {
    const { container } = render(ConnectApp)
    await fireEvent.click(screen.getByText('Connect an app'))
    await fireEvent.input(container.querySelector('input')!, { target: { value: 'chat app' } })
    await fireEvent.click(screen.getByText('Continue'))

    await fireEvent.click(screen.getByText('Messages only'))
    await fireEvent.click(screen.getByText('Create connection'))

    await screen.findByText('Connection ready')
    expect(mockUpdate).toHaveBeenCalledWith(RESULT.slot_index, { allowed_kinds: [4, 1059] })
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
})
