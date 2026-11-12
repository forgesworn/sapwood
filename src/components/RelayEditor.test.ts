import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import RelayEditor from './RelayEditor.svelte'
import { probeRelays } from '../lib/relay-health.js'

vi.mock('../lib/relay-health.js', () => ({
  probeRelays: vi.fn(),
}))

const A = 'wss://a.example'
const B = 'wss://b.example'
const C = 'wss://c.example'

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

beforeEach(() => {
  vi.mocked(probeRelays).mockReset().mockResolvedValue([])
})
afterEach(() => cleanup())

describe('RelayEditor ordering', () => {
  it('moves a relay down and up by calling onchange with the swapped list', async () => {
    const onchange = vi.fn()
    render(RelayEditor, { relays: [A, B, C], onchange })

    await fireEvent.click(button(`Move ${A} down`))
    expect(onchange).toHaveBeenLastCalledWith([B, A, C])

    await fireEvent.click(button(`Move ${C} up`))
    expect(onchange).toHaveBeenLastCalledWith([A, C, B])

    // The props are not updated between clicks, so this swaps B with A in the original list.
    await fireEvent.click(button(`Move ${B} up`))
    expect(onchange).toHaveBeenLastCalledWith([B, A, C])
  })

  it('shows arrow text on the move buttons', () => {
    render(RelayEditor, { relays: [A, B], onchange: vi.fn() })
    expect(button(`Move ${A} down`).textContent?.trim()).toBe('↓')
    expect(button(`Move ${B} up`).textContent?.trim()).toBe('↑')
  })

  it('disables the first row up and the last row down', () => {
    render(RelayEditor, { relays: [A, B, C], onchange: vi.fn() })
    expect(button(`Move ${A} up`).disabled).toBe(true)
    expect(button(`Move ${A} down`).disabled).toBe(false)
    expect(button(`Move ${B} up`).disabled).toBe(false)
    expect(button(`Move ${B} down`).disabled).toBe(false)
    expect(button(`Move ${C} up`).disabled).toBe(false)
    expect(button(`Move ${C} down`).disabled).toBe(true)
  })

  it('disables both moves on a single relay', () => {
    render(RelayEditor, { relays: [A], onchange: vi.fn() })
    expect(button(`Move ${A} up`).disabled).toBe(true)
    expect(button(`Move ${A} down`).disabled).toBe(true)
  })

  it('the disabled prop disables every move button', () => {
    render(RelayEditor, { relays: [A, B, C], disabled: true, onchange: vi.fn() })
    for (const relay of [A, B, C]) {
      expect(button(`Move ${relay} up`).disabled).toBe(true)
      expect(button(`Move ${relay} down`).disabled).toBe(true)
    }
  })

  it('tags only the first row as home', () => {
    const { container } = render(RelayEditor, { relays: [A, B, C], onchange: vi.fn() })
    const tags = screen.getAllByText('home')
    expect(tags).toHaveLength(1)
    const rows = container.querySelectorAll('.relay-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.contains(tags[0]!)).toBe(true)
  })

  it('moves the home tag with the first relay', async () => {
    const { container, rerender } = render(RelayEditor, { relays: [A, B], onchange: vi.fn() })
    await rerender({ relays: [B, A], onchange: vi.fn() })
    const rows = container.querySelectorAll('.relay-row')
    expect(rows[0]!.textContent).toContain(B)
    expect(rows[0]!.textContent).toContain('home')
    expect(rows[1]!.textContent).not.toContain('home')
  })

  it('explains that the first relay is kept open, only when the list is non-empty', async () => {
    const copy = 'The Heartwood keeps its first relay open all the time, so put the relay your phones and apps use first.'
    const { rerender } = render(RelayEditor, { relays: [A], onchange: vi.fn() })
    expect(screen.getByText(copy)).toBeTruthy()
    await rerender({ relays: [], onchange: vi.fn() })
    expect(screen.queryByText(copy)).toBeNull()
    expect(screen.queryByText('home')).toBeNull()
  })
})

describe('RelayEditor health probing', () => {
  it('does not re-probe when the same relays are reordered, but does when one is added', async () => {
    const onchange = vi.fn()
    const { rerender } = render(RelayEditor, { relays: [A, B], showHealth: true, onchange })
    await waitFor(() => expect(probeRelays).toHaveBeenCalledTimes(1))

    await rerender({ relays: [B, A], showHealth: true, onchange })
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(probeRelays).toHaveBeenCalledTimes(1)

    await rerender({ relays: [B, A, C], showHealth: true, onchange })
    await waitFor(() => expect(probeRelays).toHaveBeenCalledTimes(2))
    expect(vi.mocked(probeRelays).mock.calls[1]![0]).toEqual([B, A, C])
  })

  it('does not probe at all without showHealth', async () => {
    render(RelayEditor, { relays: [A, B], onchange: vi.fn() })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(probeRelays).not.toHaveBeenCalled()
  })
})
