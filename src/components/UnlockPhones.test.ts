import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'

const P = 'a1'.repeat(32)
const R = 'b2'.repeat(16)
const CODE = `heartwood-unlock:enrol?v=1&p=${P}&r=${R}&label=Pixel+8&relay=wss%3A%2F%2Frelay.example`

const api = vi.hoisted(() => {
  class PhoneUnlockAuthRequired extends Error {}
  return {
    PhoneUnlockAuthRequired,
    listUnlockPhones: vi.fn(),
    revokeUnlockPhone: vi.fn(async () => {}),
    setAnnounceOperator: vi.fn(async () => {}),
    enrolUnlockPhone: vi.fn(),
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
  }
})

import UnlockPhones from './UnlockPhones.svelte'
import { device } from '../lib/device.svelte.js'

const LIST = { phones: [{ id: 3106288131, label: 'Pixel' }], max: 16, announceOperator: true }

beforeEach(() => {
  vi.clearAllMocks()
  api.awaiting.length = 0
  Object.assign(device, { connected: true, mode: 'serial', bridgeAuthed: true, awaitingButton: null })
  api.listUnlockPhones.mockResolvedValue(LIST)
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
    expect(api.enrolUnlockPhone).toHaveBeenCalledWith(P, 'Pixel 8')
    expect(relays.ensureRelay).toHaveBeenCalledWith('wss://relay.example', expect.anything())
    const [urls, event] = relays.publish.mock.calls[0] as unknown as [string[], { kind: number; tags: string[][] }]
    expect(urls).toEqual(['wss://relay.example'])
    expect(event.kind).toBe(24137)
    expect(event.tags).toEqual([['h', R]])
    expect(api.awaiting.find((m) => m !== null)).toMatch(/Add unlock phone/)
    expect(api.awaiting.at(-1)).toBeNull()
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
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: CODE } })
    await fireEvent.click(screen.getByRole('button', { name: 'Use this code' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Add Pixel 8' }))
    expect(await screen.findByText(/Each code works once/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Scan a new code' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('keeps adding to the cable over WiFi', async () => {
    Object.assign(device, { mode: 'relay' })
    render(UnlockPhones)
    expect(await screen.findByText(/needs the signer on the USB cable/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add a phone' })).toBeNull()
  })
})
