import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
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
})
