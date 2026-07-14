import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'

const handoff = vi.hoisted(() => ({
  encryptOperator: vi.fn(() => 'ncryptsec1test'),
  buildHandoffLink: vi.fn(() => 'https://sapwood.test/#/plain'),
  buildProtectedHandoffLink: vi.fn(() => 'https://sapwood.test/#/protected'),
  copyText: vi.fn(async () => true),
}))

vi.mock('@paulmillr/qr', () => ({
  encodeQR: vi.fn((link: string) => `<svg aria-label="pairing QR" data-link="${link}"></svg>`),
}))

vi.mock('../lib/device.svelte.js', async () => {
  const { createSubscriber } = await import('svelte/reactivity')
  let notify = () => {}
  const subscribe = createSubscriber((update) => {
    notify = update
    return () => { notify = () => {} }
  })
  const state: Record<string, unknown> = {
    connected: true,
    mode: 'relay',
    operatorPub: '',
    relayStatus: { mode: 'wifi-standalone' },
    relays: ['wss://relay.example'],
    relayConfiguredRelays: ['wss://relay.example'],
    usbNetworkSupport: 'unknown',
    usbNetworkState: null,
    masters: [{ npub: 'c'.repeat(64) }],
  }
  const device = new Proxy(state, {
    get(target, property, receiver) {
      subscribe()
      return Reflect.get(target, property, receiver)
    },
    set(target, property, value, receiver) {
      const changed = Reflect.get(target, property, receiver) !== value
      const ok = Reflect.set(target, property, value, receiver)
      if (changed) notify()
      return ok
    },
  })
  return { device }
})

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
  ;(device as { relayConfiguredRelays: string[] | null }).relayConfiguredRelays = ['wss://relay.example']
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

  it('exports only the authenticated active relays, never cached recovery addresses', async () => {
    const operator = getOrCreateOperator()
    ;(device as { operatorPub: string }).operatorPub = operator.pubHex
    ;(device as { relays: string[] }).relays = ['wss://cached.example', 'wss://stale.example']
    ;(device as { relayConfiguredRelays: string[] | null }).relayConfiguredRelays = ['wss://active.example']

    render(PhoneHandoff)
    await fireEvent.click(screen.getByRole('button', { name: 'Pair a device' }))
    await fireEvent.click(screen.getByRole('button', { name: /Show without a PIN/ }))

    expect(handoff.buildHandoffLink).toHaveBeenCalledWith(
      expect.any(String),
      operator.skHex,
      DEVICE_HEX,
      ['wss://active.example'],
    )
    expect(JSON.stringify(handoff.buildHandoffLink.mock.calls)).not.toContain('cached.example')
    expect(JSON.stringify(handoff.buildHandoffLink.mock.calls)).not.toContain('stale.example')
  })

  it('keeps relay pairing locked until active configured relays are authenticated', () => {
    const operator = getOrCreateOperator()
    ;(device as { operatorPub: string }).operatorPub = operator.pubHex
    ;(device as { relayConfiguredRelays: string[] | null }).relayConfiguredRelays = null

    render(PhoneHandoff)

    expect(screen.getByText(/Reading this signer's active configured relays/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pair a device' })).toBeNull()
    expect(handoff.buildHandoffLink).not.toHaveBeenCalled()
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
      trial: null,
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

  it('keeps USB phone pairing locked while a network trial is non-terminal', () => {
    const operator = getOrCreateOperator()
    ;(device as { mode: string }).mode = 'serial'
    ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'supported'
    ;(device as { usbNetworkState: object | null }).usbNetworkState = {
      version: 1,
      configured: true,
      revision: 5,
      mode: 'wifi',
      ssid: 'old-network',
      relays: ['wss://stale-active.example'],
      password_set: true,
      op_mgmt: operator.pubHex,
      recovery_ok: true,
      trial: {
        transaction_id: 'ab'.repeat(16),
        revision: 5,
        phase: 'trying',
        mode: 'wifi',
        ssid: 'candidate-network',
        relays: ['wss://candidate.example'],
        password_set: true,
        attempted: true,
      },
    }

    render(PhoneHandoff)

    expect(screen.getByText(/Phone pairing stays locked while this signer is trying a network change/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pair a device' })).toBeNull()
    expect(handoff.buildHandoffLink).not.toHaveBeenCalled()
    expect(handoff.buildProtectedHandoffLink).not.toHaveBeenCalled()
  })

  it('invalidates an A QR across trial and missing proof before allowing a fresh B QR', async () => {
    const operator = getOrCreateOperator()
    const terminalState = (revision: number, relay: string) => ({
      version: 1,
      configured: true,
      revision,
      mode: 'wifi',
      ssid: `network-${revision}`,
      relays: [relay],
      password_set: true,
      op_mgmt: operator.pubHex,
      recovery_ok: true,
      trial: null,
    })
    const relayA = 'wss://country-a.example'
    const relayB = 'wss://country-b.example'
    ;(device as { mode: string }).mode = 'serial'
    ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'supported'
    ;(device as { usbNetworkState: object | null }).usbNetworkState = terminalState(4, relayA)
    handoff.buildHandoffLink
      .mockImplementationOnce(() => 'https://sapwood.test/#/plain-a')
      .mockImplementationOnce(() => 'https://sapwood.test/#/plain-b')

    render(PhoneHandoff)
    await fireEvent.click(screen.getByRole('button', { name: 'Pair a device' }))
    await fireEvent.click(screen.getByRole('button', { name: /Show without a PIN/ }))
    expect(screen.getByLabelText('pairing QR').getAttribute('data-link')).toContain('plain-a')

    ;(device as { usbNetworkState: object | null }).usbNetworkState = {
      ...terminalState(5, relayA),
      trial: {
        transaction_id: 'ab'.repeat(16),
        revision: 5,
        phase: 'trying',
        mode: 'wifi',
        ssid: 'candidate-network',
        relays: [relayB],
        password_set: true,
        attempted: true,
      },
    }
    await waitFor(() => {
      expect(screen.queryByLabelText('pairing QR')).toBeNull()
      expect(screen.getByText(/Phone pairing stays locked while this signer is trying a network change/)).toBeTruthy()
    })

    ;(device as { usbNetworkState: object | null }).usbNetworkState = null
    await waitFor(() => expect(screen.queryByLabelText('pairing QR')).toBeNull())

    ;(device as { usbNetworkState: object | null }).usbNetworkState = terminalState(6, relayB)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pair a device' })).toBeTruthy())
    expect(screen.queryByLabelText('pairing QR')).toBeNull()
    expect(document.body.innerHTML).not.toContain('plain-a')

    await fireEvent.click(screen.getByRole('button', { name: 'Pair a device' }))
    await fireEvent.click(screen.getByRole('button', { name: /Show without a PIN/ }))
    expect(screen.getByLabelText('pairing QR').getAttribute('data-link')).toContain('plain-b')
    expect(screen.getByLabelText('pairing QR').getAttribute('data-link')).not.toContain('plain-a')
    expect(handoff.buildHandoffLink).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      operator.skHex,
      DEVICE_HEX,
      [relayA],
    )
    expect(handoff.buildHandoffLink).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      operator.skHex,
      DEVICE_HEX,
      [relayB],
    )
  })

  it('cannot migrate a deferred protected build into a cancelled and reopened B reveal', async () => {
    vi.useFakeTimers()
    try {
      const operator = getOrCreateOperator()
      const terminalState = (revision: number, relay: string) => ({
        version: 1,
        configured: true,
        revision,
        mode: 'wifi',
        ssid: `network-${revision}`,
        relays: [relay],
        password_set: true,
        op_mgmt: operator.pubHex,
        recovery_ok: true,
        trial: null,
      })
      const relayA = 'wss://country-a.example'
      const relayB = 'wss://country-b.example'
      ;(device as { mode: string }).mode = 'serial'
      ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'supported'
      ;(device as { usbNetworkState: object | null }).usbNetworkState = terminalState(4, relayA)

      render(PhoneHandoff)
      await fireEvent.click(screen.getByRole('button', { name: 'Pair a device' }))
      await fireEvent.input(screen.getByLabelText(/PIN or passphrase/), {
        target: { value: 'country-a-secret' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Protect and show QR' }))
      await tick()
      expect(screen.getByRole('button', { name: 'Protecting…' })).toBeTruthy()

      await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      ;(device as { usbNetworkState: object | null }).usbNetworkState = terminalState(5, relayB)
      await tick()
      await fireEvent.click(screen.getByRole('button', { name: 'Pair a device' }))
      await fireEvent.input(screen.getByLabelText(/PIN or passphrase/), {
        target: { value: 'country-b-secret' },
      })

      await vi.advanceTimersByTimeAsync(0)
      await tick()
      expect(handoff.encryptOperator).not.toHaveBeenCalled()
      expect(handoff.buildProtectedHandoffLink).not.toHaveBeenCalled()
      expect(screen.queryByLabelText('pairing QR')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Protect and show QR' }))
      await vi.advanceTimersByTimeAsync(0)
      await tick()
      expect(handoff.encryptOperator).toHaveBeenCalledWith(operator.skHex, 'country-b-secret')
      expect(handoff.encryptOperator).not.toHaveBeenCalledWith(operator.skHex, 'country-a-secret')
      expect(handoff.buildProtectedHandoffLink).toHaveBeenCalledWith(
        expect.any(String),
        'ncryptsec1test',
        DEVICE_HEX,
        [relayB],
      )
      expect(screen.getByLabelText('pairing QR')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidates a deferred protected build when the handoff component unmounts', async () => {
    vi.useFakeTimers()
    try {
      const operator = getOrCreateOperator()
      ;(device as { mode: string }).mode = 'serial'
      ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'supported'
      ;(device as { usbNetworkState: object | null }).usbNetworkState = {
        version: 1,
        configured: true,
        revision: 9,
        mode: 'wifi',
        ssid: 'not-exported',
        relays: ['wss://device-proof.example'],
        password_set: true,
        op_mgmt: operator.pubHex,
        recovery_ok: true,
        trial: null,
      }

      const rendered = render(PhoneHandoff)
      await fireEvent.click(screen.getByRole('button', { name: 'Pair a device' }))
      await fireEvent.input(screen.getByLabelText(/PIN or passphrase/), {
        target: { value: 'destroy-before-build' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Protect and show QR' }))
      await tick()
      expect(screen.getByRole('button', { name: 'Protecting…' })).toBeTruthy()

      rendered.unmount()
      await vi.advanceTimersByTimeAsync(0)
      await tick()

      expect(handoff.encryptOperator).not.toHaveBeenCalled()
      expect(handoff.buildProtectedHandoffLink).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
