import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { getConversationKey, encrypt as nip44Encrypt } from 'nostr-tools/nip44'
import { hexToBytes } from '@noble/hashes/utils.js'

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
    awaiting: [] as (string | null)[],
  }
})

const relays = vi.hoisted(() => ({
  ensureRelay: vi.fn(async () => ({})),
  publish: vi.fn((urls: string[]) => urls.map(() => Promise.resolve(''))),
  destroy: vi.fn(),
  subscribe: vi.fn((
    _relays: string[],
    _filter: Record<string, unknown>,
    _opts: { onevent: (event: unknown) => void },
  ) => ({ close: vi.fn() })),
}))

vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    ensureRelay = relays.ensureRelay
    publish = relays.publish
    destroy = relays.destroy
    subscribe = relays.subscribe
  },
}))

// A fixed invite keypair, so a test can build a genuine encrypted reply
// without reading anything out of the rendered QR. Everything else
// (openInviteReply, reduceInvite) is the real implementation.
const INVITE_SECRET = hexToBytes('44'.repeat(32))
const INVITE_PUBKEY = getPublicKey(INVITE_SECRET)
const INVITE_RENDEZVOUS = '77'.repeat(16)

const invite = vi.hoisted(() => ({ createInvite: vi.fn() }))

vi.mock('../lib/enrol-invite.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/enrol-invite.js')>('../lib/enrol-invite.js')
  return { ...actual, createInvite: invite.createInvite }
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
  relays.subscribe.mockReturnValue({ close: vi.fn() })
  invite.createInvite.mockImplementation((relayUrls: string[], now: number = Date.now()) => ({
    uri: `heartwood-unlock:invite?v=1&k=${INVITE_PUBKEY}&r=${INVITE_RENDEZVOUS}&x=${Math.floor(now / 1000) + 600}`
      + relayUrls.map((r) => `&relay=${encodeURIComponent(r)}`).join(''),
    // A fresh copy each call: the component zeroes this in place on cancel,
    // confirm and unmount, and the shared constant must survive that.
    secret: INVITE_SECRET.slice(),
    pubkey: INVITE_PUBKEY,
    rendezvous: INVITE_RENDEZVOUS,
    expiresAt: Math.floor(now / 1000) + 600,
  }))
})

/** A genuine kind-24137 invite reply, as Cambium would publish it: signed by
 *  a fresh throwaway key, encrypted to the fixed invite pubkey above. */
function inviteReply(plaintext: string, rendezvous = INVITE_RENDEZVOUS) {
  const throwaway = generateSecretKey()
  const ck = getConversationKey(throwaway, INVITE_PUBKEY)
  const content = nip44Encrypt(plaintext, ck)
  return finalizeEvent({
    kind: 24137,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['h', rendezvous]],
    content,
  }, throwaway)
}

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
    await fireEvent.click(await screen.findByText('Phone shows a code instead? Paste it'))
    await fireEvent.click(screen.getByRole('button', { name: 'Paste a code' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: CODE } })
    await fireEvent.click(screen.getByRole('button', { name: 'Use this code' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Send to the signer' }))
    expect(await screen.findByText('9B6 164')).toBeTruthy()
    expect(api.enrolUnlockPhone).toHaveBeenCalledOnce()
    expect(api.enrolUnlockPhone).toHaveBeenCalledWith(P, 'Pixel 8', expect.stringMatching(/compare the five words/i))
    expect(relays.ensureRelay).toHaveBeenCalledWith('wss://relay.example', expect.anything())
    const [urls, event] = relays.publish.mock.calls[0] as unknown as [string[], { kind: number; tags: string[][] }]
    expect(urls).toEqual(['wss://relay.example'])
    expect(event.kind).toBe(24137)
    expect(event.tags).toEqual([['h', R]])

    // Finished, then the same code again: refused here, not sent twice.
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await fireEvent.click(await screen.findByText('Phone shows a code instead? Paste it'))
    await fireEvent.click(screen.getByRole('button', { name: 'Paste a code' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: CODE } })
    expect(screen.getByText(/already used here/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Use this code' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('refuses text that is not an enrolment code', async () => {
    render(UnlockPhones)
    await fireEvent.click(await screen.findByText('Phone shows a code instead? Paste it'))
    await fireEvent.click(screen.getByRole('button', { name: 'Paste a code' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'bunker://nope' } })
    expect(screen.getByText(/not a phone-unlock code/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Use this code' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers a new code, not a retry, once the board has seen the code', async () => {
    api.enrolUnlockPhone.mockRejectedValue(new Error('The signer refused: declined on the board.'))
    render(UnlockPhones)
    await fireEvent.click(await screen.findByText('Phone shows a code instead? Paste it'))
    await fireEvent.click(screen.getByRole('button', { name: 'Paste a code' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: CODE.replace(P, 'c3'.repeat(32)) } })
    await fireEvent.click(screen.getByRole('button', { name: 'Use this code' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Send to the signer' }))
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
    await fireEvent.click(await screen.findByText('Phone shows a code instead? Paste it'))
    await fireEvent.click(screen.getByRole('button', { name: 'Paste a code' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: codeWith(p) } })
    await fireEvent.click(screen.getByRole('button', { name: 'Use this code' }))
    // Sapwood's own copy of the request-code words: for reference only.
    expect(screen.getByText('release')).toBeTruthy()
    expect(screen.getByText('depart')).toBeTruthy()
    expect(screen.getByText('Check Cambium shows these five words, in this order.')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Send to the signer' }))
    expect(await screen.findByText('9B6 164')).toBeTruthy()
    expect(api.enrolUnlockPhone).toHaveBeenCalledOnce()
    expect(api.enrolUnlockPhone).toHaveBeenCalledWith(p, 'Pixel 8', expect.stringMatching(/compare the five words/i))
    // Sent exactly once: the hand-off is only ever published the once.
    const [urls, event] = relays.publish.mock.calls[0] as unknown as [string[], { kind: number; tags: string[][] }]
    expect(urls).toEqual(['wss://relay.example'])
    expect(event.kind).toBe(24137)
    expect(event.tags).toEqual([['h', R]])
    expect(relays.publish).toHaveBeenCalledOnce()
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
    await fireEvent.click(await screen.findByText('Phone shows a code instead? Paste it'))
    await fireEvent.click(screen.getByRole('button', { name: 'Paste a code' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: codeWith(p) } })
    await fireEvent.click(screen.getByRole('button', { name: 'Use this code' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Send to the signer' }))
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
    await fireEvent.click(await screen.findByText('Phone shows a code instead? Paste it'))
    await fireEvent.click(screen.getByRole('button', { name: 'Paste a code' }))
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: codeWith(p) } })
    await fireEvent.click(screen.getByRole('button', { name: 'Use this code' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Send to the signer' }))
    expect(await screen.findByText(/never answered in time/)).toBeTruthy()
    expect(screen.queryByText(/nobody holds/)).toBeNull()
  })

  describe('the invite (Sapwood shows a QR)', () => {
    it('shows a QR, opens the phone\'s relays, and moves to confirm once the phone replies', async () => {
      api.enrolUnlockPhone.mockResolvedValue({ id: 61, ephemeral_pubkey: 'ab'.repeat(32), sealed: 'ciphertext' })
      render(UnlockPhones)
      await fireEvent.click(await screen.findByRole('button', { name: 'Add a phone' }))
      await screen.findByText('Scan this with Cambium')
      expect(relays.ensureRelay).toHaveBeenCalledWith('wss://relay.trotters.cc', expect.anything())
      expect(relays.subscribe).toHaveBeenCalledOnce()
      const [subRelays, filter, opts] = relays.subscribe.mock.calls[0]
      expect(subRelays).toEqual(['wss://relay.trotters.cc'])
      expect(filter).toMatchObject({ kinds: [24137], '#h': [INVITE_RENDEZVOUS] })

      const p = '11'.repeat(32)
      opts.onevent(inviteReply(codeWith(p)))

      expect(await screen.findByText('Pixel 8 wants to unlock this signer')).toBeTruthy()
      expect(screen.getAllByText('Pixel 8').length).toBeGreaterThan(0)
      await fireEvent.click(screen.getByRole('button', { name: 'Send to the signer' }))
      expect(await screen.findByText('9B6 164')).toBeTruthy()
      expect(api.enrolUnlockPhone).toHaveBeenCalledWith(p, 'Pixel 8', expect.stringMatching(/compare the five words/i))
    })

    it('ignores a repeat of the identical reply', async () => {
      render(UnlockPhones)
      await fireEvent.click(await screen.findByRole('button', { name: 'Add a phone' }))
      await screen.findByText('Scan this with Cambium')
      const opts = relays.subscribe.mock.calls[0][2]

      const p = '22'.repeat(32)
      opts.onevent(inviteReply(codeWith(p)))
      await screen.findByText('Pixel 8 wants to unlock this signer')
      opts.onevent(inviteReply(codeWith(p)))
      expect(screen.getByText('Pixel 8 wants to unlock this signer')).toBeTruthy()
      expect(screen.queryByText(/Two phones answered/)).toBeNull()
    })

    it('aborts when a second, different phone answers the same code', async () => {
      render(UnlockPhones)
      await fireEvent.click(await screen.findByRole('button', { name: 'Add a phone' }))
      await screen.findByText('Scan this with Cambium')
      const opts = relays.subscribe.mock.calls[0][2]

      opts.onevent(inviteReply(codeWith('33'.repeat(32))))
      await screen.findByText('Pixel 8 wants to unlock this signer')
      opts.onevent(inviteReply(codeWith('44'.repeat(32))))

      expect(await screen.findByText('Two phones answered')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'New code' })).toBeTruthy()
      expect(api.enrolUnlockPhone).not.toHaveBeenCalled()
    })

    it('closes the subscription and pool on cancel', async () => {
      const closer = { close: vi.fn() }
      relays.subscribe.mockReturnValue(closer)
      render(UnlockPhones)
      await fireEvent.click(await screen.findByRole('button', { name: 'Add a phone' }))
      await screen.findByText('Scan this with Cambium')
      await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(closer.close).toHaveBeenCalledOnce()
      expect(relays.destroy).toHaveBeenCalledOnce()
      expect(await screen.findByRole('button', { name: 'Add a phone' })).toBeTruthy()
    })

    it('ignores a reply with the wrong rendezvous', async () => {
      render(UnlockPhones)
      await fireEvent.click(await screen.findByRole('button', { name: 'Add a phone' }))
      await screen.findByText('Scan this with Cambium')
      const opts = relays.subscribe.mock.calls[0][2]
      opts.onevent(inviteReply(codeWith('55'.repeat(32)), 'ff'.repeat(16)))
      expect(screen.queryByText('Pixel 8 wants to unlock this signer')).toBeNull()
    })
  })
})
