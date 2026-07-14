import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import Connectivity from './Connectivity.svelte'
import {
  abortNetworkConfig, configureNetwork, configureNetworkRemotely, device, getNetworkConfig,
  patchNetworkOverUsb,
} from '../lib/device.svelte.js'
import { getOrCreateOperator } from '../lib/op-mgmt.js'

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
    relayDevicePub: 'a'.repeat(64),
    connectionGeneration: 1,
    usbNetworkSupport: 'unknown',
    usbNetworkState: null,
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
  return {
    device,
    abortNetworkConfig: vi.fn(),
    configureNetwork: vi.fn(),
    configureNetworkRemotely: vi.fn(),
    getNetworkConfig: vi.fn(),
    patchNetworkOverUsb: vi.fn(),
    scanWifi: vi.fn(),
  }
})

vi.mock('../lib/op-mgmt.js', () => ({
  getOrCreateOperator: vi.fn(),
}))

const ACTIVE = {
  revision: 5,
  active: {
    mode: 'wifi' as const,
    ssid: 'Home WiFi',
    relays: ['wss://old.example'],
    password_set: true,
  },
  trial: null,
  last_result: null,
}

beforeEach(() => {
  localStorage.clear()
  ;(device as { connected: boolean; mode: string }).connected = true
  ;(device as { connected: boolean; mode: string }).mode = 'relay'
  ;(device as { relayDevicePub: string }).relayDevicePub = 'a'.repeat(64)
  ;(device as { connectionGeneration: number }).connectionGeneration += 1
  ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'unknown'
  ;(device as { usbNetworkState: object | null }).usbNetworkState = null
  vi.mocked(getNetworkConfig).mockReset().mockResolvedValue(ACTIVE)
  vi.mocked(configureNetworkRemotely).mockReset().mockResolvedValue(ACTIVE)
  vi.mocked(configureNetwork).mockReset().mockResolvedValue(true)
  vi.mocked(patchNetworkOverUsb).mockReset()
  vi.mocked(abortNetworkConfig).mockReset().mockResolvedValue(ACTIVE)
  vi.mocked(getOrCreateOperator).mockReset()
})

describe('Connectivity remote network changes', () => {
  it('loads redacted state and treats a blank password as keep for the same SSID', async () => {
    render(Connectivity)

    const ssid = await screen.findByLabelText('WiFi SSID') as HTMLInputElement
    await waitFor(() => expect(ssid.value).toBe('Home WiFi'))
    const password = screen.getByLabelText('WiFi password') as HTMLInputElement
    expect(password.value).toBe('')
    expect(password.placeholder).toMatch(/keep current password/i)
    expect(password.autocomplete).toBe('off')
    expect(password.getAttribute('data-1p-ignore')).not.toBeNull()
    expect(password.getAttribute('data-lpignore')).toBe('true')

    await fireEvent.click(screen.getByRole('button', { name: 'Test & save network' }))

    await waitFor(() => expect(configureNetworkRemotely).toHaveBeenCalledWith({
      mode: 'wifi',
      ssid: 'Home WiFi',
      relays: ['wss://old.example'],
      password: { action: 'keep' },
    }))
    expect(getOrCreateOperator).not.toHaveBeenCalled()
    expect(JSON.stringify({ ...localStorage })).not.toContain('Home WiFi password')
  })

  it('resets on signer switch and ignores a late response from the old target', async () => {
    let finishOld!: (state: typeof ACTIVE) => void
    const oldRead = new Promise<typeof ACTIVE>((resolve) => { finishOld = resolve })
    const next = {
      ...ACTIVE,
      revision: 9,
      active: {
        ...ACTIVE.active,
        ssid: 'Country B WiFi',
        relays: ['wss://country-b.example'],
        password_set: false,
      },
    }
    vi.mocked(getNetworkConfig)
      .mockReset()
      .mockImplementationOnce(() => oldRead)
      .mockResolvedValueOnce(next)

    render(Connectivity)
    await waitFor(() => expect(getNetworkConfig).toHaveBeenCalledTimes(1))
    await fireEvent.input(screen.getByLabelText('WiFi password'), { target: { value: 'must-be-cleared' } })

    ;(device as { relayDevicePub: string }).relayDevicePub = 'b'.repeat(64)
    ;(device as { connectionGeneration: number }).connectionGeneration += 1

    await waitFor(() => expect(getNetworkConfig).toHaveBeenCalledTimes(2))
    await waitFor(() => expect((screen.getByLabelText('WiFi SSID') as HTMLInputElement).value).toBe('Country B WiFi'))
    expect((screen.getByLabelText('WiFi password') as HTMLInputElement).value).toBe('')

    finishOld(ACTIVE)
    await Promise.resolve()
    expect((screen.getByLabelText('WiFi SSID') as HTMLInputElement).value).toBe('Country B WiFi')
    expect(screen.getByText('wss://country-b.example')).toBeTruthy()
  })

  it('requires an explicit password decision when the SSID changes', async () => {
    render(Connectivity)
    const ssid = await screen.findByLabelText('WiFi SSID') as HTMLInputElement
    await waitFor(() => expect(ssid.value).toBe('Home WiFi'))

    await fireEvent.input(ssid, { target: { value: 'Away WiFi' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Test & save network' }))

    expect(await screen.findByText(/Changing the WiFi name needs a new password/)).toBeTruthy()
    expect(configureNetworkRemotely).not.toHaveBeenCalled()

    await fireEvent.input(screen.getByLabelText('WiFi password'), { target: { value: 'new-secret' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Test & save network' }))
    await waitFor(() => expect(configureNetworkRemotely).toHaveBeenCalledWith(expect.objectContaining({
      ssid: 'Away WiFi',
      password: { action: 'set', value: 'new-secret' },
    })))
    expect(localStorage.getItem('heartwood.lastRelays')).toBe('["wss://old.example"]')
    expect(JSON.stringify({ ...localStorage })).not.toContain('new-secret')
    expect((screen.getByLabelText('WiFi password') as HTMLInputElement).value).toBe('')
  })

  it('shows reconnect progress and reports success only after staged orchestration resolves', async () => {
    let finish!: (state: typeof ACTIVE) => void
    vi.mocked(configureNetworkRemotely).mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    render(Connectivity)
    const ssid = await screen.findByLabelText('WiFi SSID') as HTMLInputElement
    await waitFor(() => expect(ssid.value).toBe('Home WiFi'))
    const password = screen.getByLabelText('WiFi password') as HTMLInputElement
    await fireEvent.input(password, { target: { value: 'rotated-secret' } })

    await fireEvent.click(screen.getByRole('button', { name: 'Test & save network' }))

    const progress = screen.getByRole('button', { name: 'Testing network…' }) as HTMLButtonElement
    expect(progress.disabled).toBe(true)
    expect(screen.queryByText(/Saved\. The signer reconnected/)).toBeNull()
    expect(JSON.stringify({ ...localStorage })).not.toContain('rotated-secret')

    finish(ACTIVE)
    expect(await screen.findByText(/Saved\. The signer reconnected on the staged network and committed it/)).toBeTruthy()
    expect(password.value).toBe('')
    expect(JSON.stringify({ ...localStorage })).not.toContain('rotated-secret')
  })

  it('supports an explicit clear action for an open network', async () => {
    render(Connectivity)
    const ssid = await screen.findByLabelText('WiFi SSID') as HTMLInputElement
    await waitFor(() => expect(ssid.value).toBe('Home WiFi'))
    await fireEvent.input(ssid, { target: { value: 'Cafe Open' } })
    await fireEvent.click(screen.getByLabelText(/Clear the saved password/))
    await fireEvent.click(screen.getByRole('button', { name: 'Test & save network' }))

    await waitFor(() => expect(configureNetworkRemotely).toHaveBeenCalledWith(expect.objectContaining({
      ssid: 'Cafe Open',
      password: { action: 'clear' },
    })))
  })

  it('offers recovery for an inert staged transaction', async () => {
    const staged = {
      ...ACTIVE,
      revision: 6,
      trial: {
        transaction_id: 'tx-staged',
        phase: 'staged' as const,
        attempted: 0,
        mode: 'wifi' as const,
        ssid: 'Candidate',
        relays: ['wss://new.example'],
        password_set: true,
      },
    }
    vi.mocked(getNetworkConfig).mockResolvedValue(staged)
    render(Connectivity)

    const discard = await screen.findByRole('button', { name: 'Discard pending change' })
    expect((screen.getByRole('button', { name: 'Test & save network' }) as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.click(discard)
    await waitFor(() => expect(abortNetworkConfig).toHaveBeenCalledWith('tx-staged'))
    expect(await screen.findByText(/active network was not changed/i)).toBeTruthy()
  })

  it('locks editing while a trying transaction is waiting to commit or roll back', async () => {
    vi.mocked(getNetworkConfig).mockResolvedValue({
      ...ACTIVE,
      revision: 6,
      trial: {
        transaction_id: 'tx-trying',
        phase: 'trying',
        attempted: 1,
        mode: 'wifi',
        ssid: 'Candidate',
        relays: ['wss://new.example'],
        password_set: true,
      },
    })
    render(Connectivity)

    expect(await screen.findByText(/Wait for it to reconnect or roll back automatically/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Discard pending change' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Test & save network' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Connectivity USB network changes', () => {
  const USB_STATE = {
    version: 1 as const,
    configured: true,
    revision: 8,
    mode: 'wifi' as const,
    ssid: 'Device WiFi',
    relays: ['wss://device.example'],
    password_set: true,
    op_mgmt: 'a'.repeat(64),
    recovery_ok: true,
    trial: null,
  }

  it('prefills exact signer state and patches without password or operator replacement', async () => {
    ;(device as { mode: string }).mode = 'serial'
    ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'supported'
    ;(device as { usbNetworkState: object | null }).usbNetworkState = USB_STATE
    vi.mocked(patchNetworkOverUsb).mockResolvedValue({ ...USB_STATE, revision: 9 })

    render(Connectivity)
    await waitFor(() => expect((screen.getByLabelText('WiFi SSID') as HTMLInputElement).value).toBe('Device WiFi'))
    expect((screen.getByLabelText('WiFi password') as HTMLInputElement).placeholder).toMatch(/keep current/i)
    await fireEvent.click(screen.getByRole('button', { name: 'Save to device' }))

    await waitFor(() => expect(patchNetworkOverUsb).toHaveBeenCalledWith({
      mode: 'wifi',
      ssid: 'Device WiFi',
      relays: ['wss://device.example'],
      password: { action: 'keep' },
    }))
    expect(configureNetwork).not.toHaveBeenCalled()
    expect(getOrCreateOperator).not.toHaveBeenCalled()
    expect(JSON.stringify({ ...localStorage })).not.toContain('Device WiFi password')
  })

  it('refuses the unsafe whole-config editor on old firmware', () => {
    ;(device as { mode: string }).mode = 'serial'
    ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'unsupported'
    render(Connectivity)
    expect(screen.getByText(/may clear a password or replace the operator/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save to device' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
