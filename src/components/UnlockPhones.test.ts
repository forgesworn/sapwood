import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'

const P = 'a1'.repeat(32)
const R = 'b2'.repeat(16)
const CODE = `heartwood-unlock:enrol?v=1&p=${P}&r=${R}&label=Pixel+8&relay=wss%3A%2F%2Frelay.example`
// Each code's enrolment key is spent (module-level, not reset between tests)
// the moment `add()` asks the board, so a test that adds must use a key no
// earlier test has already sent.
const codeWith = (p: string) =>
  `heartwood-unlock:enrol?v=1&p=${p}&r=${R}&label=Pixel+8&relay=wss%3A%2F%2Frelay.example`

const api = vi.hoisted(() => {
  class PhoneUnlockAuthRequired extends Error {}
  return {
    PhoneUnlockAuthRequired,
    listUnlockPhones: vi.fn(),
    revokeUnlockPhone: vi.fn(async () => {}),
    setAnnounceOperator: vi.fn(async () => {}),
    enrolUnlockPhone: vi.fn(),
    supportsPhoneEnrolRelay: vi.fn(() => false),
    scheduleDecoyHandOff: vi.fn(() => 0 as unknown as ReturnType<typeof setTimeout>),
    awaiting: [] as (string | null)[],
  }
})

const relays = vi.hoisted(() => ({
  ensureRelay: vi.fn(async () => ({})),
  publish: vi.fn((urls: string[]) => urls.map(() => Promise.resolve(''))),
  destroy: vi.fn(),
}))

vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    ensureRelay = relays.ensureRelay
    publish = relays.publish
    destroy = relays.destroy
  },
}))

// The decoy hand-off publish runs on a real few-second delay in production;
// stub it in tests so component tests neither wait for it nor mix its calls
// into the primary publish's assertions. Its own behaviour is covered in
// phone-unlock.test.ts.
vi.mock('../lib/phone-unlock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/phone-unlock.js')>()
  return { ...actual, scheduleDecoyHandOff: api.scheduleDecoyHandOff }
})

vi.mock('../lib/device.svelte.js', async () => {
  const { createSubscriber } = await import('svelte/reactivity')
  let notify = () => {}
  const subscribe = createSubscriber((update) => {
    notify = update
    return () => { notify = () => {} }
  })
  const state: Record<string, unknown> = {
    connected: true,
    mode: 'serial',
    bridgeAuthed: true,
    awaitingButton: null,
    masters: [],
    connectionGeneration: 0,
  }
  const device = new Proxy(state, {
    get(target, property, receiver) {
      subscribe()
      return Reflect.get(target, property, receiver)
    },
    set(target, property, value, receiver) {
      if (property === 'awaitingButton') api.awaiting.push(value as string | null)
      const changed = Reflect.get(target, property, receiver) !== value
      const ok = Reflect.set(target, property, value, receiver)
      if (changed) notify()
      return ok
    },
  })
  return {
    device,
    PhoneUnlockAuthRequired: api.PhoneUnlockAuthRequired,
    listUnlockPhones: api.listUnlockPhones,
    revokeUnlockPhone: api.revokeUnlockPhone,
    setAnnounceOperator: api.setAnnounceOperator,
    enrolUnlockPhone: api.enrolUnlockPhone,
    supportsPhoneEnrolRelay: api.supportsPhoneEnrolRelay,
  }
})

import UnlockPhones from './UnlockPhones.svelte'
import { device } from '../lib/device.svelte.js'

const LIST = { phones: [{ id: 3106288131, label: 'Pixel' }], max: 16, announceOperator: true }

beforeEach(() => {
  vi.clearAllMocks()
  api.awaiting.length = 0
  Object.assign(device, { connected: true, mode: 'serial', bridgeAuthed: true, awaitingButton: null, masters: [] })
  api.listUnlockPhones.mockResolvedValue(LIST)
  api.supportsPhoneEnrolRelay.mockReturnValue(false)
})

afterEach(() => cleanup())

describe('UnlockPhones', () => {
  it('lists the phones and revokes one', async () => {
    render(UnlockPhones)
    expect(await screen.findByText('Pixel')).toBeTruthy()
    expect(screen.getByText('record 3106288131')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke' }))
    await waitFor(() => expect(api.revokeUnlockPhone).toHaveBeenCalledWith(3106288131))
    expect(await screen.findByText(/It can no longer unlock this signer/)).toBeTruthy()
  })

  it('says so when the firmware has no phone unlock', async () => {
    api.listUnlockPhones.mockResolvedValue(null)
    render(UnlockPhones)
    expect(await screen.findByText(/firmware has no phone unlock/)).toBeTruthy()
  })

  it('asks before authenticating rather than raising a card by itself', async () => {
    Object.assign(device, { bridgeAuthed: false })
    api.listUnlockPhones.mockRejectedValueOnce(new api.PhoneUnlockAuthRequired())
    render(UnlockPhones)
    const button = await screen.findByRole('button', { name: 'Show the phones' })
    expect(api.listUnlockPhones).toHaveBeenLastCalledWith({ authenticate: false })
    await fireEvent.click(button)
    await waitFor(() => expect(api.listUnlockPhones).toHaveBeenLastCalledWith({ authenticate: true }))
    expect(await screen.findByText('Pixel')).toBeTruthy()
  })

  it('adds a phone from a pasted code and shows the check code', async () => {
    api.enrolUnlockPhone.mockResolvedValue({ id: 77, ephemeral_pubkey: 'ab'.repeat(32), sealed: 'ciphertext' })
    render(UnlockPhones)
    await fireEvent.click(await screen.findByRole('button', { name: 'Paste a code instead' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: CODE } })
    await fireEvent.click(screen.getByRole('button', { name: 'Use this code' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Add Pixel 8' }))
    expect(await screen.findByText('9B6 164')).toBeTruthy()
    expect(api.enrolUnlockPhone).toHaveBeenCalledOnce()
    expect(api.enrolUnlockPhone).toHaveBeenCalledWith(P, 'Pixel 8', expect.stringMatching(/ADD PHONE for Pixel 8/))
    expect(relays.ensureRelay).toHaveBeenCalledWith('wss://relay.example', expect.anything())
    const [urls, event] = relays.publish.mock.calls[0] as unknown as [string[], { kind: number; tags: string[][] }]
    expect(urls).toEqual(['wss://relay.example'])
    expect(event.kind).toBe(24137)
    expect(event.tags).toEqual([['h', R]])

    // Finished, then the same code again: refused here, not sent twice.
    await fireEvent.click(screen.getByRole('button', { name: 'Finished' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Paste a code instead' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: CODE } })
    expect(screen.getByText(/already used here/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Use this code' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('refuses text that is not an enrolment code', async () => {
    render(UnlockPhones)
    await fireEvent.click(await screen.findByRole('button', { name: 'Paste a code instead' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'bunker://nope' } })
    expect(screen.getByText(/not a phone-unlock code/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Use this code' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers a new code, not a retry, once the board has seen the code', async () => {
    api.enrolUnlockPhone.mockRejectedValue(new Error('The signer refused: declined on the board.'))
    render(UnlockPhones)
    await fireEvent.click(await screen.findByRole('button', { name: 'Paste a code instead' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: CODE.replace(P, 'c3'.repeat(32)) } })
    await fireEvent.click(screen.getByRole('button', { name: 'Use this code' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Add Pixel 8' }))
    expect(await screen.findByText(/Each code works once/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Scan a new code' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('says to unlock a locked signer rather than blaming its firmware', async () => {
    Object.assign(device, { masters: [{ npub: 'x', locked: true }] })
    render(UnlockPhones)
    expect(await screen.findByText('Unlock the signer to see its phones.')).toBeTruthy()
    expect(api.listUnlockPhones).not.toHaveBeenCalled()
  })

  it('keeps the operator message on while no phone is set up', async () => {
    api.listUnlockPhones.mockResolvedValue({ phones: [], max: 16, announceOperator: true })
    render(UnlockPhones)
    expect(await screen.findByText('No phones yet.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Off' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('warns before revoking the last phone when the operator message is off', async () => {
    api.listUnlockPhones.mockResolvedValue({ ...LIST, announceOperator: false })
    render(UnlockPhones)
    await fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))
    expect(screen.getByText(/only the USB cable could unlock it/)).toBeTruthy()
  })

  it('keeps adding to the cable when the relay firmware has no enrol capability', async () => {
    Object.assign(device, { mode: 'relay' })
    render(UnlockPhones)
    expect(await screen.findByText(/needs the signer on the USB cable/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add a phone' })).toBeNull()
  })

  it('adds a phone over the relay when the signer serves phone_enrol_relay_v1, showing the words as a convenience', async () => {
    const p = 'd4'.repeat(32)
    Object.assign(device, { mode: 'relay' })
    api.supportsPhoneEnrolRelay.mockReturnValue(true)
    api.enrolUnlockPhone.mockResolvedValue({ id: 77, ephemeral_pubkey: 'ab'.repeat(32), sealed: 'ciphertext' })
    render(UnlockPhones)
    await fireEvent.click(await screen.findByRole('button', { name: 'Paste a code instead' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: codeWith(p) } })
    await fireEvent.click(screen.getByRole('button', { name: 'Use this code' }))
    // Sapwood's own copy of the request-code words: for reference only.
    expect(screen.getByText('release jar chimney acoustic depart')).toBeTruthy()
    expect(screen.getByText(/Compare the words on your signer with your phone, not with this page/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Add Pixel 8' }))
    expect(await screen.findByText('9B6 164')).toBeTruthy()
    expect(api.enrolUnlockPhone).toHaveBeenCalledOnce()
    expect(api.enrolUnlockPhone).toHaveBeenCalledWith(p, 'Pixel 8', expect.stringMatching(/ADD PHONE for Pixel 8/))
    // The decoy hand-off is scheduled with the same event the primary publish used.
    expect(api.scheduleDecoyHandOff).toHaveBeenCalledOnce()
    const [decoyRelays, decoyEvent] = api.scheduleDecoyHandOff.mock.calls[0] as unknown as [string[], { kind: number; tags: string[][] }]
    expect(decoyRelays).toEqual(['wss://relay.example'])
    expect(decoyEvent.kind).toBe(24137)
    expect(decoyEvent.tags).toEqual([['h', R]])
  })

  it('offers to revoke an orphaned record when a relay enrolment times out with no reply', async () => {
    const p = 'e5'.repeat(32)
    Object.assign(device, { mode: 'relay' })
    api.supportsPhoneEnrolRelay.mockReturnValue(true)
    api.enrolUnlockPhone.mockRejectedValue(new Error('timeout waiting for device (enrol_unlock_phone)'))
    api.listUnlockPhones.mockResolvedValueOnce(LIST).mockResolvedValueOnce({
      ...LIST,
      phones: [...LIST.phones, { id: 99, label: 'phone' }],
    })
    render(UnlockPhones)
    await fireEvent.click(await screen.findByRole('button', { name: 'Paste a code instead' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: codeWith(p) } })
    await fireEvent.click(screen.getByRole('button', { name: 'Use this code' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Add Pixel 8' }))
    expect(await screen.findByRole('button', { name: 'Revoke record 99' })).toBeTruthy()
    expect(screen.getByText(/nobody holds/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Revoke record 99' }))
    await waitFor(() => expect(api.revokeUnlockPhone).toHaveBeenCalledWith(99))
  })

  it('says nothing seems to have been added when a relay timeout leaves no new record', async () => {
    const p = 'f6'.repeat(32)
    Object.assign(device, { mode: 'relay' })
    api.supportsPhoneEnrolRelay.mockReturnValue(true)
    api.enrolUnlockPhone.mockRejectedValue(new Error('timeout waiting for device (enrol_unlock_phone)'))
    api.listUnlockPhones.mockResolvedValue(LIST)
    render(UnlockPhones)
    await fireEvent.click(await screen.findByRole('button', { name: 'Paste a code instead' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: codeWith(p) } })
    await fireEvent.click(screen.getByRole('button', { name: 'Use this code' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Add Pixel 8' }))
    expect(await screen.findByText(/never answered in time/)).toBeTruthy()
    expect(screen.queryByText(/nobody holds/)).toBeNull()
  })
})
