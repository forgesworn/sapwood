import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import { nip19 } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import FirstIdentity from './FirstIdentity.svelte'
import { generateIdentity, restoreIdentity, provisionSecret, refreshMasters } from '../lib/device.svelte.js'

// Transport is mocked (no hardware). The DEVICE generates (or takes) the seed +
// shows the phrase on its own screen for the on-device paths; the paste paths
// derive in-browser and hand the secret to provisionSecret. The step machine is real.
vi.mock('../lib/device.svelte.js', () => ({
  device: { connected: true, mode: 'serial', error: null, masters: [], slots: [] },
  refreshMasters: vi.fn().mockResolvedValue(undefined),
  connectRelay: vi.fn().mockResolvedValue(undefined),
  generateIdentity: vi.fn(),
  restoreIdentity: vi.fn(),
  provisionSecret: vi.fn().mockResolvedValue(undefined),
  getFirmwareVersion: vi.fn().mockResolvedValue({ version: '0.9.12', board: 'lilygo' }),
}))

// A real, decodable npub so rememberProvisioned() can derive its hex.
const NPUB = 'npub186c5ke7vjsk98z8qx4ctdrggsl2qlu627g6xvg6yumrj5c5c6etqcfaclx'

// A fixed, valid nsec (scalar = 1) for the paste-restore path.
const SK = new Uint8Array(32); SK[31] = 1
const NSEC = nip19.nsecEncode(SK)
const OWN_NPUB = nip19.npubEncode(bytesToHex(schnorr.getPublicKey(SK)))

const gen = vi.mocked(generateIdentity)
const restore = vi.mocked(restoreIdentity)
const provision = vi.mocked(provisionSecret)

beforeEach(() => {
  localStorage.clear()
  gen.mockReset().mockResolvedValue(NPUB)
  restore.mockReset().mockResolvedValue(NPUB)
  provision.mockReset().mockResolvedValue(undefined)
  vi.mocked(refreshMasters).mockClear()
})

/** intro → naming → (device generates) → writedown. */
async function walkToWritedown() {
  await fireEvent.click(screen.getByRole('button', { name: /Create a fresh key/ }))
  await fireEvent.click(screen.getByText(/Create it on my device/))
  expect(await screen.findByText(/Write down the words on your device/)).toBeTruthy()
}

describe('FirstIdentity — create', () => {
  it('asks the device to generate, never shows a phrase in the browser, and shows the npub', async () => {
    render(FirstIdentity)
    await walkToWritedown()

    expect(gen).toHaveBeenCalledTimes(1)
    expect(screen.getByText(NPUB)).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()

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
    await fireEvent.click(screen.getByRole('button', { name: /Create a fresh key/ }))
    await fireEvent.click(screen.getByText(/Create it on my device/))

    expect(await screen.findByText(/could not generate an identity/)).toBeTruthy()
    expect(screen.queryByText('Your signer has an identity')).toBeNull()
    expect(screen.queryByText(/Write down the words/)).toBeNull()
  })

  it('opens the advanced console from the intro', async () => {
    const onadvanced = vi.fn()
    render(FirstIdentity, { props: { onadvanced } })
    await fireEvent.click(screen.getByText(/Open the advanced console/))
    expect(onadvanced).toHaveBeenCalledOnce()
  })
})

describe('FirstIdentity — restore on the device', () => {
  it('restores an existing phrase on the device, never collecting it in the browser', async () => {
    let resolveRestore: (npub: string) => void = () => {}
    restore.mockImplementation(() => new Promise((r) => { resolveRestore = r }))

    render(FirstIdentity)
    await fireEvent.click(screen.getByText(/Restore a key I already have/))
    await fireEvent.click(screen.getByText(/typed on the device/))
    await fireEvent.click(screen.getByText(/Restore on my device/))

    expect(await screen.findByText(/Enter your 12 words on the device/)).toBeTruthy()
    expect(screen.getByText(/Double-tap/)).toBeTruthy()

    resolveRestore(NPUB)
    expect(await screen.findByText('Your signer has an identity')).toBeTruthy()
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('surfaces a restore failure and returns to naming', async () => {
    restore.mockRejectedValue(new Error('Restore was cancelled on the device, or the phrase did not check out. You can try again.'))
    render(FirstIdentity)
    await fireEvent.click(screen.getByText(/Restore a key I already have/))
    await fireEvent.click(screen.getByText(/typed on the device/))
    await fireEvent.click(screen.getByText(/Restore on my device/))

    expect(await screen.findByText(/did not check out/)).toBeTruthy()
    expect(screen.queryByText('Your signer has an identity')).toBeNull()
  })
})

describe('FirstIdentity — restore from a pasted nsec', () => {
  it('derives, confirms the same npub, then sends the key over USB', async () => {
    render(FirstIdentity)
    await fireEvent.click(screen.getByText(/Restore a key I already have/))
    await fireEvent.click(screen.getByText(/An nsec/))

    // Enter the nsec; the "keep my npub" (bunker) option is the default.
    await fireEvent.input(screen.getByPlaceholderText('nsec1...'), { target: { value: NSEC } })
    await fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    // Confirm shows the key's own npub with a "Same npub" chip.
    expect(await screen.findByText('Check the address')).toBeTruthy()
    expect(screen.getByText(OWN_NPUB)).toBeTruthy()
    expect(screen.getByText('Same npub')).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: /Send to my signer/ }))

    expect(await screen.findByText('Your signer has an identity')).toBeTruthy()
    expect(provision).toHaveBeenCalledTimes(1)
    // Bunker mode (sign as-is), 32-byte secret, default label.
    const [secret, label, mode] = provision.mock.calls[0]
    expect(mode).toBe('bunker')
    expect(label).toBe('default')
    expect(secret).toHaveLength(32)
  })

  it('lets the owner derive a new npub instead of signing as-is', async () => {
    render(FirstIdentity)
    await fireEvent.click(screen.getByText(/Restore a key I already have/))
    await fireEvent.click(screen.getByText(/An nsec/))
    await fireEvent.input(screen.getByPlaceholderText('nsec1...'), { target: { value: NSEC } })

    // Choose "Derive a fresh key" (new npub).
    await fireEvent.click(screen.getByText(/Derive a fresh key/))
    await fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    expect(await screen.findByText('Check the address')).toBeTruthy()
    expect(screen.getByText('New npub')).toBeTruthy()
    // The derived address is not the key's own npub.
    expect(screen.queryByText(OWN_NPUB)).toBeNull()

    await fireEvent.click(screen.getByRole('button', { name: /Send to my signer/ }))
    expect(await screen.findByText('Your signer has an identity')).toBeTruthy()
    expect(provision.mock.calls[0][2]).toBe('tree-nsec')
  })
})
