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

  it('shows strict automatic policy as auto-signed versus denied, never prompted', async () => {
    render(KindPermissions, {
      props: {
        allowedKinds: [1],
        unrestricted: false,
        signingApproved: true,
        autoApprove: true,
        strictPermissions: true,
        updating: false,
        onchange: () => {},
      },
    })

    expect(screen.getByText(/1 auto-signed, \d+ denied/)).toBeTruthy()
    expect(screen.queryByText(/prompted/)).toBeNull()
    await fireEvent.click(screen.getByText('Signing'))
    expect(screen.getByText(/Unknown or unlisted kinds are denied by this exact policy/)).toBeTruthy()
    expect(screen.getByTitle('Profile (kind 0): denied (exact policy)')).toBeTruthy()
    expect(screen.getByTitle('Note (kind 1): auto-sign')).toBeTruthy()
  })

  it('shows a strict manual policy as button-approved versus denied', () => {
    render(KindPermissions, {
      props: {
        allowedKinds: [1],
        unrestricted: false,
        signingApproved: true,
        autoApprove: false,
        strictPermissions: true,
        updating: false,
        onchange: () => {},
      },
    })

    expect(screen.getByText(/1 button-approved, \d+ denied/)).toBeTruthy()
  })

  it('treats a strict crypto-only slot as no signing, never legacy TOFU approval', () => {
    render(KindPermissions, {
      props: {
        allowedKinds: [],
        unrestricted: true,
        signingApproved: false,
        signingIncluded: false,
        strictPermissions: true,
        updating: false,
        onchange: () => {},
      },
    })

    expect(screen.getByText(/Signing is not included in this app's exact policy/)).toBeTruthy()
    expect(screen.getByText(/Reconnect it with a signing preset/)).toBeTruthy()
    expect(screen.queryByText(/Awaiting first approval/)).toBeNull()
  })
})
