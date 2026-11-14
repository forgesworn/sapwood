import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import DefaultRelays from './DefaultRelays.svelte'
import {
  DEFAULT_SIGNER_RELAYS, defaultSignerRelays, hasOwnDefaultRelays, setDefaultSignerRelays,
} from '../lib/wizard.js'

vi.mock('../lib/relay-health.js', () => ({
  probeRelays: vi.fn().mockResolvedValue([]),
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

const [FIRST, SECOND] = DEFAULT_SIGNER_RELAYS as readonly [string, string]
const SAVED = 'Saved. New Heartwoods start with these relays.'
// The content sits inside a closed <details>, which hides it from role queries.
const q = { hidden: true } as const
const saveButton = () => screen.getByRole('button', { name: 'Save defaults', ...q }) as HTMLButtonElement

describe('DefaultRelays', () => {
  it('shows the built-in set when nothing is stored, with Save disabled', () => {
    render(DefaultRelays)
    expect(screen.getByText('Default relays for new Heartwoods')).toBeTruthy()
    for (const relay of DEFAULT_SIGNER_RELAYS) expect(screen.getByText(relay)).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /built-in set/, ...q })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard changes', ...q })).toBeNull()
  })

  it('persists a reordered set on Save and confirms it', async () => {
    render(DefaultRelays)
    await fireEvent.click(screen.getByRole('button', { name: `Move ${FIRST} down`, ...q }))
    expect(saveButton().disabled).toBe(false)
    expect(hasOwnDefaultRelays()).toBe(false)

    await fireEvent.click(saveButton())

    expect(defaultSignerRelays()).toEqual([SECOND, FIRST])
    expect(hasOwnDefaultRelays()).toBe(true)
    expect(screen.getByText(SAVED)).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    // Once the owner has their own set, the way back to the built-in one appears.
    expect(screen.getByRole('button', { name: "Use Sapwood's built-in set", ...q })).toBeTruthy()
  })

  it('discards unsaved changes', async () => {
    render(DefaultRelays)
    await fireEvent.click(screen.getByRole('button', { name: `Move ${FIRST} down`, ...q }))
    await fireEvent.click(screen.getByRole('button', { name: 'Discard changes', ...q }))
    expect(saveButton().disabled).toBe(true)
    expect(hasOwnDefaultRelays()).toBe(false)
    expect(defaultSignerRelays()).toEqual([...DEFAULT_SIGNER_RELAYS])
  })

  it('starts from a stored set', () => {
    setDefaultSignerRelays(['wss://mine.example'])
    render(DefaultRelays)
    expect(screen.getByText('wss://mine.example')).toBeTruthy()
    expect(screen.queryByText(FIRST)).toBeNull()
    expect(screen.getByRole('button', { name: "Use Sapwood's built-in set", ...q })).toBeTruthy()
  })

  it("'Use Sapwood's built-in set' clears the stored set and restores the built-in one", async () => {
    setDefaultSignerRelays(['wss://mine.example'])
    render(DefaultRelays)

    await fireEvent.click(screen.getByRole('button', { name: "Use Sapwood's built-in set", ...q }))

    expect(hasOwnDefaultRelays()).toBe(false)
    expect(defaultSignerRelays()).toEqual([...DEFAULT_SIGNER_RELAYS])
    for (const relay of DEFAULT_SIGNER_RELAYS) expect(screen.getByText(relay)).toBeTruthy()
    expect(screen.queryByText('wss://mine.example')).toBeNull()
    expect(screen.queryByRole('button', { name: /built-in set/, ...q })).toBeNull()
    expect(saveButton().disabled).toBe(true)
  })

  it('refuses an empty list: shows the reminder and keeps Save disabled', async () => {
    render(DefaultRelays)
    expect(screen.queryByText('Keep at least one relay.')).toBeNull()
    for (const _ of DEFAULT_SIGNER_RELAYS) {
      await fireEvent.click(screen.getAllByRole('button', { name: 'Remove', ...q })[0]!)
    }
    expect(screen.getByText('Keep at least one relay.')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    expect(hasOwnDefaultRelays()).toBe(false)
  })

  it('clears the saved message on the next edit', async () => {
    render(DefaultRelays)
    await fireEvent.click(screen.getByRole('button', { name: `Move ${FIRST} down`, ...q }))
    await fireEvent.click(saveButton())
    expect(screen.getByText(SAVED)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: `Move ${FIRST} up`, ...q }))
    expect(screen.queryByText(SAVED)).toBeNull()
  })

  it('shows the error, not Saved, when the browser will not store the set, and keeps the panel state', async () => {
    render(DefaultRelays)
    await fireEvent.click(screen.getByRole('button', { name: `Move ${FIRST} down`, ...q }))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })

    await fireEvent.click(saveButton())

    expect(screen.getByText(
      'This browser did not save the setting. Check that it allows site data for this page.',
    )).toBeTruthy()
    expect(screen.queryByText(SAVED)).toBeNull()
    // Nothing was saved: the edit is still pending and there is no own set.
    expect(saveButton().disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Discard changes', ...q })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /built-in set/, ...q })).toBeNull()
    expect(hasOwnDefaultRelays()).toBe(false)
  })

  it('shows the rule message for a set the signer would reject', async () => {
    render(DefaultRelays)
    const input = screen.getByPlaceholderText('wss://relay.example.com')
    // Two built-in relays plus seven more: nine in all.
    for (let i = 0; i < 7; i++) {
      await fireEvent.input(input, { target: { value: `wss://extra${i}.example` } })
      await fireEvent.click(screen.getByRole('button', { name: 'Add', ...q }))
    }

    await fireEvent.click(saveButton())

    expect(screen.getByText('A Heartwood holds at most eight relays.')).toBeTruthy()
    expect(screen.queryByText(SAVED)).toBeNull()
    expect(hasOwnDefaultRelays()).toBe(false)
  })

  it('clears the error on the next edit', async () => {
    render(DefaultRelays)
    await fireEvent.click(screen.getByRole('button', { name: `Move ${FIRST} down`, ...q }))
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    await fireEvent.click(saveButton())
    spy.mockRestore()
    expect(screen.getByRole('alert', q)).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: `Move ${FIRST} up`, ...q }))
    expect(screen.queryByRole('alert', q)).toBeNull()
  })

  describe('a change made in another tab', () => {
    const otherTab = (relays: string[]) => act(() => {
      localStorage.setItem('heartwood.defaultSignerRelays', JSON.stringify(relays))
      window.dispatchEvent(new StorageEvent('storage', { key: 'heartwood.defaultSignerRelays' }))
    })

    it('replaces the list when the panel has no unsaved edits', async () => {
      render(DefaultRelays)
      expect(screen.getByText(FIRST)).toBeTruthy()

      await otherTab(['wss://theirs.example'])

      expect(screen.getByText('wss://theirs.example')).toBeTruthy()
      expect(screen.queryByText(FIRST)).toBeNull()
      expect(saveButton().disabled).toBe(true)
      expect(screen.getByRole('button', { name: "Use Sapwood's built-in set", ...q })).toBeTruthy()
    })

    it('keeps what the owner is typing when there are unsaved edits', async () => {
      render(DefaultRelays)
      await fireEvent.click(screen.getByRole('button', { name: `Move ${FIRST} down`, ...q }))

      await otherTab(['wss://theirs.example'])

      // The draft (reordered built-ins) is untouched and still unsaved.
      expect(screen.queryByText('wss://theirs.example')).toBeNull()
      expect(screen.getByText(FIRST)).toBeTruthy()
      expect(saveButton().disabled).toBe(false)
      // The saved side did follow the other tab: discarding reveals it.
      await fireEvent.click(screen.getByRole('button', { name: 'Discard changes', ...q }))
      expect(screen.getByText('wss://theirs.example')).toBeTruthy()
    })
  })
})
