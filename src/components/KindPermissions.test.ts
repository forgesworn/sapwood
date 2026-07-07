import { describe, it, expect } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import KindPermissions from './KindPermissions.svelte'
import { COMMON_KINDS } from '../lib/kinds.js'

describe('KindPermissions', () => {
  it('adds an arbitrary numeric kind to a restricted slot', async () => {
    const changes: Array<number[] | null> = []
    render(KindPermissions, {
      props: {
        allowedKinds: [1],
        unrestricted: false,
        signingApproved: true,
        updating: false,
        onchange: (kinds) => changes.push(kinds),
      },
    })

    await fireEvent.click(screen.getByText('Signing'))
    await fireEvent.input(screen.getByLabelText('Kind number'), { target: { value: '31990' } })
    await fireEvent.click(screen.getByText('Add kind'))

    expect(changes.at(-1)).toEqual([1, 31990])
  })

  it('adds an arbitrary numeric kind from unrestricted mode by switching to a known-kind whitelist', async () => {
    const changes: Array<number[] | null> = []
    render(KindPermissions, {
      props: {
        allowedKinds: [],
        unrestricted: true,
        signingApproved: true,
        updating: false,
        onchange: (kinds) => changes.push(kinds),
      },
    })

    await fireEvent.click(screen.getByText('Signing'))
    expect(screen.getByText(/Allow all includes unknown and future kinds/)).toBeTruthy()
    await fireEvent.input(screen.getByLabelText('Kind number'), { target: { value: '999999' } })
    await fireEvent.click(screen.getByText('Add kind'))

    const expected = [...COMMON_KINDS.map((k) => k.kind), 999999].sort((a, b) => a - b)
    expect(changes.at(-1)).toEqual(expected)
  })

  it('shows allowed unknown kinds so they can be removed again', async () => {
    const changes: Array<number[] | null> = []
    render(KindPermissions, {
      props: {
        allowedKinds: [1, 999999],
        unrestricted: false,
        signingApproved: true,
        updating: false,
        onchange: (kinds) => changes.push(kinds),
      },
    })

    await fireEvent.click(screen.getByText('Signing'))
    await fireEvent.click(screen.getByText('Unknown kind 999999'))

    expect(changes.at(-1)).toEqual([1])
  })

  it('does not turn last-kind removal into unrestricted allow-all', async () => {
    const changes: Array<number[] | null> = []
    render(KindPermissions, {
      props: {
        allowedKinds: [999999],
        unrestricted: false,
        signingApproved: true,
        updating: false,
        onchange: (kinds) => changes.push(kinds),
      },
    })

    await fireEvent.click(screen.getByText('Signing'))
    await fireEvent.click(screen.getByText('Unknown kind 999999'))

    expect(changes).toEqual([])
    expect(screen.getByText(/To prompt for every kind/)).toBeTruthy()
  })
})
