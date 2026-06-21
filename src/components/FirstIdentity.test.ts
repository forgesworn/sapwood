import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import FirstIdentity from './FirstIdentity.svelte'
import { serialTransport, refreshMasters } from '../lib/device.svelte.js'
import { FrameType } from '../lib/frame.js'

// Transport is mocked (no hardware); the crypto + step machine are real.
vi.mock('../lib/device.svelte.js', () => ({
  device: { connected: true, mode: 'serial', error: null, masters: [], slots: [] },
  serialTransport: { sendAndReceive: vi.fn() },
  refreshMasters: vi.fn().mockResolvedValue(undefined),
  connectRelay: vi.fn().mockResolvedValue(undefined),
}))

const send = vi.mocked(serialTransport.sendAndReceive)

beforeEach(() => {
  localStorage.clear()
  send.mockReset().mockResolvedValue({ type: FrameType.ACK, payload: new Uint8Array() })
  vi.mocked(refreshMasters).mockClear()
})

async function walkToConfirm() {
  await fireEvent.click(screen.getByText(/Create a fresh identity/))
  // 12 numbered words are shown.
  expect(screen.getAllByRole('listitem')).toHaveLength(12)
  // Continue is gated until the owner confirms they wrote the phrase down.
  expect((screen.getByText('Continue') as HTMLButtonElement).disabled).toBe(true)
  await fireEvent.click(screen.getByRole('checkbox'))
  expect((screen.getByText('Continue') as HTMLButtonElement).disabled).toBe(false)
  await fireEvent.click(screen.getByText('Continue'))
  // Derivation is async; the confirm step shows the derived public address.
  expect(await screen.findByText('Create this identity?')).toBeTruthy()
}

describe('FirstIdentity', () => {
  it('generates a phrase, derives an npub, and writes it over USB', async () => {
    render(FirstIdentity)
    await walkToConfirm()
    expect(screen.getByText(/^npub1/)).toBeTruthy()

    await fireEvent.click(screen.getByText('Create identity'))

    expect(await screen.findByText('Your signer has an identity')).toBeTruthy()
    // A single PROVISION frame was sent, awaiting ACK/NACK.
    expect(send).toHaveBeenCalledTimes(1)
    const [, accepted] = send.mock.calls[0]
    expect(accepted).toContain(FrameType.ACK)
  })

  it('offers the WiFi handoff when the device was flashed for WiFi', async () => {
    localStorage.setItem('heartwood.lastRelays', JSON.stringify(['wss://relay.example']))
    render(FirstIdentity)
    await walkToConfirm()
    await fireEvent.click(screen.getByText('Create identity'))

    expect(await screen.findByText('Manage over WiFi')).toBeTruthy()
  })

  it('surfaces a device rejection (NACK) without claiming success', async () => {
    send.mockResolvedValue({ type: FrameType.NACK, payload: new Uint8Array() })
    render(FirstIdentity)
    await walkToConfirm()
    await fireEvent.click(screen.getByText('Create identity'))

    expect(await screen.findByText(/did not accept the identity/)).toBeTruthy()
    expect(screen.queryByText('Your signer has an identity')).toBeNull()
  })

  it('routes "I already have one" to the advanced console', async () => {
    const onadvanced = vi.fn()
    render(FirstIdentity, { props: { onadvanced } })
    await fireEvent.click(screen.getByText(/I already have a recovery phrase/))
    expect(onadvanced).toHaveBeenCalledOnce()
  })
})
