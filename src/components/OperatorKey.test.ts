import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import OperatorKey from './OperatorKey.svelte'
import { generateOperatorMnemonic, importOperatorMnemonic, peekOperatorPubHex } from '../lib/op-mgmt.js'

vi.mock('../lib/clipboard.js', () => ({
  copyText: vi.fn().mockResolvedValue(true),
}))

beforeEach(() => {
  localStorage.clear()
})

describe('OperatorKey', () => {
  it('frames operator restore as the relay-timeout recovery path', () => {
    render(OperatorKey)

    expect(screen.getByText(/If Sapwood reaches the relay but the signer never answers/)).toBeTruthy()
    expect(screen.getByPlaceholderText(/matching 12\/24-word operator recovery phrase/)).toBeTruthy()
    expect(screen.getByText('Restore key')).toBeTruthy()
  })

  it('restores the matching operator key from its recovery phrase', async () => {
    const phrase = generateOperatorMnemonic()
    const expected = importOperatorMnemonic(phrase).pubHex
    localStorage.clear()
    render(OperatorKey)

    await fireEvent.input(screen.getByPlaceholderText(/matching 12\/24-word operator recovery phrase/), {
      target: { value: phrase },
    })
    await fireEvent.click(screen.getByText('Restore key'))

    expect(peekOperatorPubHex()).toBe(expected)
    expect(screen.getByText(/Restored from phrase/)).toBeTruthy()
  })
})
