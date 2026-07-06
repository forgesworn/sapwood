import { describe, it, expect } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import KindPermissions from './KindPermissions.svelte'

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

  it('shows allowed unknown kinds so they can be removed again', async () => {
    const changes: Array<number[] | null> = []
    render(KindPermissions, {
      props: {
        allowedKinds: [1, 31990],
        unrestricted: false,
        signingApproved: true,
        updating: false,
        onchange: (kinds) => changes.push(kinds),
      },
    })

    await fireEvent.click(screen.getByText('Signing'))
    await fireEvent.click(screen.getByText('kind 31990'))

    expect(changes.at(-1)).toEqual([1])
  })
})
