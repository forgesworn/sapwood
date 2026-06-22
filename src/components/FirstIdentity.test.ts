import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import FirstIdentity from './FirstIdentity.svelte'
import { generateIdentity, restoreIdentity, refreshMasters } from '../lib/device.svelte.js'

// Transport is mocked (no hardware). The DEVICE generates (or takes) the seed +
// shows the phrase on its own screen; the browser only asks it to generate or
// restore and receives the public npub. The step machine is real.
vi.mock('../lib/device.svelte.js', () => ({
  device: { connected: true, mode: 'serial', error: null, masters: [], slots: [] },
  refreshMasters: vi.fn().mockResolvedValue(undefined),
  connectRelay: vi.fn().mockResolvedValue(undefined),
  generateIdentity: vi.fn(),
  restoreIdentity: vi.fn(),
}))

// A real, decodable npub so rememberProvisioned() can derive its hex.
const NPUB = 'npub186c5ke7vjsk98z8qx4ctdrggsl2qlu627g6xvg6yumrj5c5c6etqcfaclx'

const gen = vi.mocked(generateIdentity)
const restore = vi.mocked(restoreIdentity)

beforeEach(() => {
  localStorage.clear()
  gen.mockReset().mockResolvedValue(NPUB)
  restore.mockReset().mockResolvedValue(NPUB)
  vi.mocked(refreshMasters).mockClear()
})

/** intro → naming → (device generates) → writedown. */
async function walkToWritedown() {
  await fireEvent.click(screen.getByText(/Create a fresh identity/))
  await fireEvent.click(screen.getByText(/Create it on my device/))
  expect(await screen.findByText(/Write down the words on your device/)).toBeTruthy()
}

describe('FirstIdentity', () => {
  it('asks the device to generate, never shows a phrase in the browser, and shows the npub', async () => {
    render(FirstIdentity)
    await walkToWritedown()

    // The device generated it; the browser shows only the public address.
    expect(gen).toHaveBeenCalledTimes(1)
    expect(screen.getByText(NPUB)).toBeTruthy()
    // No recovery phrase is rendered in the browser (it's on the device screen).
    expect(screen.queryByRole('listitem')).toBeNull()

    // Continue is gated until the owner confirms they wrote the on-screen words down.
    expect((screen.getByText('Continue') as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.click(screen.getByRole('checkbox'))
    expect((screen.getByText('Continue') as HTMLButtonElement).disabled).toBe(false)
    await fireEvent.click(screen.getByText('Continue'))

    expect(await screen.findByText('Your signer has an identity')).toBeTruthy()
  })

  it('offers the WiFi handoff when the device was flashed for WiFi', async () => {
    localStorage.setItem('heartwood.lastRelays', JSON.stringify(['wss://relay.example']))
    render(FirstIdentity)
    await walkToWritedown()
    await fireEvent.click(screen.getByRole('checkbox'))
    await fireEvent.click(screen.getByText('Continue'))

    expect(await screen.findByText('Manage over WiFi')).toBeTruthy()
  })

  it('surfaces a generation failure without claiming success', async () => {
    gen.mockRejectedValue(new Error('The device could not generate an identity (storage write failed). Try again.'))
    render(FirstIdentity)
    await fireEvent.click(screen.getByText(/Create a fresh identity/))
    await fireEvent.click(screen.getByText(/Create it on my device/))

    expect(await screen.findByText(/could not generate an identity/)).toBeTruthy()
    expect(screen.queryByText('Your signer has an identity')).toBeNull()
    expect(screen.queryByText(/Write down the words/)).toBeNull()
  })

  it('routes the advanced raw-key door to the advanced console', async () => {
    const onadvanced = vi.fn()
    render(FirstIdentity, { props: { onadvanced } })
    await fireEvent.click(screen.getByText(/use a raw key/))
    expect(onadvanced).toHaveBeenCalledOnce()
  })

  it('restores an existing phrase on the device, never collecting it in the browser', async () => {
    // Hold the restore pending so we can assert the on-device instruction screen.
    let resolveRestore: (npub: string) => void = () => {}
    restore.mockImplementation(() => new Promise((r) => { resolveRestore = r }))

    render(FirstIdentity)
    await fireEvent.click(screen.getByText(/Restore from my 12 words/))
    await fireEvent.click(screen.getByText(/Restore on my device/))

    // The browser hands off to the device and shows the button gestures — it
    // never renders a phrase input.
    expect(await screen.findByText(/Enter your 12 words on the device/)).toBeTruthy()
    expect(screen.getByText(/Double-tap/)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()

    resolveRestore(NPUB)
    expect(await screen.findByText('Your signer has an identity')).toBeTruthy()
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('surfaces a restore failure and returns to naming', async () => {
    restore.mockRejectedValue(new Error('Restore was cancelled on the device, or the phrase did not check out. You can try again.'))
    render(FirstIdentity)
    await fireEvent.click(screen.getByText(/Restore from my 12 words/))
    await fireEvent.click(screen.getByText(/Restore on my device/))

    expect(await screen.findByText(/did not check out/)).toBeTruthy()
    expect(screen.queryByText('Your signer has an identity')).toBeNull()
  })
})
