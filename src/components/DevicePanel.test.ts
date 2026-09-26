import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { nip19 } from 'nostr-tools'
import DevicePanel from './DevicePanel.svelte'
import { device, serialTransport } from '../lib/device.svelte.js'
import { FrameType } from '../lib/frame.js'

// device.svelte is mocked (no transport). UnlockPhones only needs
// listUnlockPhones/PhoneUnlockAuthRequired/supportsPhoneEnrolRelay wired up;
// a locked signer never calls any of them (it short-circuits to 'locked').
// Reactive, like Connectivity.test.ts and UnlockPhones.test.ts, so a test can
// mutate `device` mid-flow and see the component react.
vi.mock('../lib/device.svelte.js', async () => {
  const { createSubscriber } = await import('svelte/reactivity')
  class PhoneUnlockAuthRequired extends Error {}
  let notify = () => {}
  const subscribe = createSubscriber((update) => {
    notify = update
    return () => { notify = () => {} }
  })
  const state: Record<string, unknown> = {
    connected: true, mode: 'relay', error: null, masters: [], slots: [],
    relayStatus: null, bridgeAuthed: false, connectionGeneration: 0,
  }
  const device = new Proxy(state, {
    get(target, property, receiver) {
      subscribe()
      return Reflect.get(target, property, receiver)
    },
    set(target, property, value, receiver) {
      const changed = Reflect.get(target, property, receiver) !== value
      const ok = Reflect.set(target, property, value, receiver)
      if (changed) notify()
      return ok
    },
  })
  return {
    device,
    serialTransport: { sendAndReceive: vi.fn() },
    httpTransport: { clearClients: vi.fn(), factoryReset: vi.fn() },
    bridgeRestart: vi.fn(),
    mgmtRevokeClient: vi.fn(),
    relaySetLogQuiet: vi.fn(),
    ensureBridgeAuth: vi.fn().mockResolvedValue(undefined),
    usbDisplayFlip: vi.fn().mockResolvedValue(null),
    setDisplayFlip: vi.fn(),
    getFirmwareVersion: vi.fn().mockResolvedValue(null),
    listUnlockPhones: vi.fn(),
    revokeUnlockPhone: vi.fn(),
    setAnnounceOperator: vi.fn(),
    enrolUnlockPhone: vi.fn(),
    supportsPhoneEnrolRelay: vi.fn(() => false),
    PhoneUnlockAuthRequired,
  }
})

const NPUB = nip19.npubEncode('a'.repeat(64))

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')))
  ;(device as { masters: unknown[] }).masters = []
  ;(device as { mode: string }).mode = 'relay'
  ;(device as { relayStatus: unknown }).relayStatus = null
  vi.mocked(serialTransport.sendAndReceive).mockReset()
})

describe('DevicePanel summary: locked signer with phones', () => {
  it('reports the firmware-known phone count, not the (unlisted) enumerated one', async () => {
    // Locked: UnlockPhones cannot authenticate to list phones, so its own
    // count binding stays null. The firmware's own unlock_phone_count (sent
    // even while locked) must still reach the summary row.
    ;(device as { masters: unknown[] }).masters = [{ slot: 0, locked: true, npub: NPUB }]
    ;(device as { relayStatus: unknown }).relayStatus = { at_rest: 'encrypted', unlock_phone_count: 2 }

    render(DevicePanel)

    const row = await screen.findByText(/Unlocks from your phone/)
    expect(row.textContent).toBe('Unlocks from your phone (2 phones)')
    expect(row.textContent).not.toContain('(0 phones)')
  })
})

describe('DevicePanel: the session override on a fresh firmware report', () => {
  it('stands down once a later FIRMWARE_INFO report disagrees with the value seen when the PIN was set', async () => {
    ;(device as { mode: string }).mode = 'serial'
    ;(device as { masters: unknown[] }).masters = [{ slot: 0, npub: NPUB }]
    // No report yet at mount (older behaviour, or just not fetched): the
    // firmware's own answer is unknown, so the panel starts on "Unknown".
    const getFirmwareVersion = (await import('../lib/device.svelte.js')).getFirmwareVersion
    vi.mocked(getFirmwareVersion).mockResolvedValueOnce(null)
    vi.mocked(serialTransport.sendAndReceive).mockResolvedValue({ type: FrameType.ACK, payload: new Uint8Array() })

    const { container } = render(DevicePanel)
    await waitFor(() => expect(screen.getAllByText(/After a power cut/).length).toBeGreaterThan(0))

    const pinInput = container.querySelector('input.field-input[type="password"]') as HTMLInputElement
    expect(pinInput).toBeTruthy()
    await fireEvent.input(pinInput, { target: { value: '1234' } })

    // Setting the PIN wins immediately: the session knows encryption just
    // turned on, well ahead of a re-read of FIRMWARE_INFO.
    const buttons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.trim() === 'Set PIN')
    // The re-read of FIRMWARE_INFO that the PIN action triggers reports
    // `at_rest: 'none'`, deliberately disagreeing with the PIN just set, so a
    // pass demonstrates the fresh report winning rather than the session's own
    // snapshot ("PIN set" => 'sapwood') sticking forever.
    vi.mocked(getFirmwareVersion).mockResolvedValueOnce({ version: '0.18.0', board: 'heltec-v4', at_rest: 'none', unlock_phone_count: 0 })
    await fireEvent.click(buttons[0])

    // Without the fix, the session's own "PIN set" snapshot would win forever
    // and this would stay "Waits for Sapwood" even once FIRMWARE_INFO
    // disagreed; the retired override lets the fresh report show through.
    await waitFor(() => expect(screen.getByText('Not encrypted: anyone holding it can read the keys')).toBeTruthy())
  })
})
