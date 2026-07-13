import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'

const handoff = vi.hoisted(() => ({
  encryptOperator: vi.fn(() => 'ncryptsec1test'),
  buildHandoffLink: vi.fn(() => 'https://sapwood.test/#/plain'),
  buildProtectedHandoffLink: vi.fn(() => 'https://sapwood.test/#/protected'),
  copyText: vi.fn(async () => true),
}))

vi.mock('@paulmillr/qr', () => ({
  encodeQR: vi.fn(() => '<svg aria-label="pairing QR"></svg>'),
}))

vi.mock('../lib/device.svelte.js', () => ({
  device: {
    connected: true,
    mode: 'relay',
    operatorPub: '',
    relayStatus: { mode: 'wifi-standalone' },
    relays: ['wss://relay.example'],
    usbNetworkSupport: 'unknown',
    usbNetworkState: null,
    masters: [{ npub: 'c'.repeat(64) }],
  },
}))

vi.mock('../lib/known-devices.js', () => ({
  listKnownDevices: vi.fn(() => [{
    pubHex: 'c'.repeat(64),
    relays: ['wss://relay.example'],
  }]),
}))

vi.mock('../lib/import-link.svelte.js', () => ({
  encryptOperator: handoff.encryptOperator,
  buildHandoffLink: handoff.buildHandoffLink,
  buildProtectedHandoffLink: handoff.buildProtectedHandoffLink,
}))

vi.mock('../lib/clipboard.js', () => ({ copyText: handoff.copyText }))

import PhoneHandoff from './PhoneHandoff.svelte'
import { device } from '../lib/device.svelte.js'
import {
  generateOperatorMnemonic,
  getOperatorCandidates,
  getOrCreateOperator,
} from '../lib/op-mgmt.js'

const LS_MNEMONIC = 'heartwood.opMgmt.mnemonic'
const LS_SK = 'heartwood.opMgmt.skHex'
const DEVICE_HEX = 'c'.repeat(64)
const LEGACY_SK = 'b'.repeat(64)

beforeEach(() => {
  localStorage.clear()
  handoff.encryptOperator.mockClear()
  handoff.buildHandoffLink.mockClear()
  handoff.buildProtectedHandoffLink.mockClear()
  handoff.copyText.mockClear()
  ;(device as { mode: string }).mode = 'relay'
  ;(device as { operatorPub: string }).operatorPub = ''
  ;(device as { relayStatus: object | null }).relayStatus = { mode: 'wifi-standalone' }
  ;(device as { relays: string[] }).relays = ['wss://relay.example']
  ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'unknown'
  ;(device as { usbNetworkState: object | null }).usbNetworkState = null
  ;(device as { masters: Array<{ npub: string }> }).masters = [{ npub: DEVICE_HEX }]
})

afterEach(cleanup)

describe('PhoneHandoff authority selection', () => {
  it('uses the exact authenticated legacy candidate for plain and protected links', async () => {
    localStorage.setItem(LS_MNEMONIC, generateOperatorMnemonic())
    localStorage.setItem(LS_SK, LEGACY_SK)
    const [primary, legacy] = getOperatorCandidates()
    expect(primary?.pubHex).not.toBe(legacy?.pubHex)
    ;(device as { operatorPub: string }).operatorPub = legacy!.pubHex

    render(PhoneHandoff)
    await fireEvent.click(screen.getByRole('button', { name: 'Pair a device' }))
    await fireEvent.click(screen.getByRole('button', { name: /Show without a PIN/ }))

    expect(handoff.buildHandoffLink).toHaveBeenCalledWith(
      expect.any(String),
      LEGACY_SK,
      DEVICE_HEX,
      ['wss://relay.example'],
    )
    expect(handoff.buildHandoffLink).not.toHaveBeenCalledWith(
      expect.any(String),
      primary!.skHex,
      expect.anything(),
      expect.anything(),
    )

    await fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Pair a device' }))
    await fireEvent.input(screen.getByLabelText(/PIN or passphrase/), {
      target: { value: 'correct horse battery staple' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Protect and show QR' }))

    await waitFor(() => expect(handoff.encryptOperator).toHaveBeenCalledWith(
      LEGACY_SK,
      'correct horse battery staple',
    ))
    expect(handoff.buildProtectedHandoffLink).toHaveBeenCalledWith(
      expect.any(String),
      'ncryptsec1test',
      DEVICE_HEX,
      ['wss://relay.example'],
    )
  })

  it('fails closed when the authenticated relay key is not saved', () => {
    getOrCreateOperator()
    ;(device as { operatorPub: string }).operatorPub = 'f'.repeat(64)

    render(PhoneHandoff)

    expect(screen.getByText(/Pairing is unavailable because this browser does not have the operator key/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pair a device' })).toBeNull()
  })

  it('does not export an operator until the signer has answered authenticated status', () => {
    const operator = getOrCreateOperator()
    ;(device as { operatorPub: string }).operatorPub = operator.pubHex
    ;(device as { relayStatus: object | null }).relayStatus = null

    render(PhoneHandoff)

    expect(screen.getByText(/Pairing stays locked until this signer answers an authenticated status request/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pair a device' })).toBeNull()
    expect(handoff.buildHandoffLink).not.toHaveBeenCalled()
  })

  it('does not offer an authority handoff from an unproven USB session', () => {
    getOrCreateOperator()
    ;(device as { mode: string }).mode = 'serial'
    ;(device as { operatorPub: string }).operatorPub = ''

    render(PhoneHandoff)

    expect(screen.getByText(/Reading this signer's operator and relays/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pair a device' })).toBeNull()
    expect(handoff.buildHandoffLink).not.toHaveBeenCalled()
    expect(handoff.buildProtectedHandoffLink).not.toHaveBeenCalled()
  })

  it('offers a handoff over USB only from exact device-read operator and relays', async () => {
    const operator = getOrCreateOperator()
    ;(device as { mode: string }).mode = 'serial'
    ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'supported'
    ;(device as { usbNetworkState: object | null }).usbNetworkState = {
      version: 1,
      configured: true,
      revision: 4,
      mode: 'wifi',
      ssid: 'not-exported',
      relays: ['wss://device-proof.example'],
      password_set: true,
      op_mgmt: operator.pubHex,
      recovery_ok: true,
    }

    render(PhoneHandoff)
    await fireEvent.click(screen.getByRole('button', { name: 'Pair a device' }))
    await fireEvent.click(screen.getByRole('button', { name: /Show without a PIN/ }))

    expect(handoff.buildHandoffLink).toHaveBeenCalledWith(
      expect.any(String),
      operator.skHex,
      DEVICE_HEX,
      ['wss://device-proof.example'],
    )
    expect(JSON.stringify(handoff.buildHandoffLink.mock.calls)).not.toContain('not-exported')
  })
})
