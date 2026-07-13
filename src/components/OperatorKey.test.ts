import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import OperatorKey from './OperatorKey.svelte'
import { generateOperatorMnemonic, importOperatorMnemonic, peekOperatorPubHex } from '../lib/op-mgmt.js'

const usb = vi.hoisted(() => ({ setOperator: vi.fn() }))

vi.mock('../lib/device.svelte.js', () => ({
  device: {
    mode: 'none',
    usbNetworkSupport: 'unknown',
    usbNetworkState: null,
  },
  setOperatorOverUsb: usb.setOperator,
}))

vi.mock('../lib/clipboard.js', () => ({
  copyText: vi.fn().mockResolvedValue(true),
}))

beforeEach(() => {
  localStorage.clear()
  usb.setOperator.mockReset()
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

  it('separates physical operator recovery from network editing', async () => {
    const { device } = await import('../lib/device.svelte.js')
    const current = importOperatorMnemonic(generateOperatorMnemonic())
    ;(device as { mode: string }).mode = 'serial'
    ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'supported'
    ;(device as { usbNetworkState: unknown }).usbNetworkState = {
      configured: true,
      op_mgmt: 'f'.repeat(64),
    }
    usb.setOperator.mockResolvedValue({ configured: true, op_mgmt: current.pubHex })

    render(OperatorKey)
    expect(screen.getByText(/This browser's key does not match/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Set this browser as operator' }))
    expect(screen.getByText(/WiFi password and relays are preserved/i)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Yes, show device confirmation' }))

    expect(usb.setOperator).toHaveBeenCalledWith(current.pubHex)
  })
})
