import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import { nip19 } from 'nostr-tools'
import ConnectionPicker from './ConnectionPicker.svelte'
import { rememberDevice } from '../lib/known-devices.js'
import { connectRelay, device } from '../lib/device.svelte.js'

const HEX = 'd'.repeat(64)

vi.mock('../lib/device.svelte.js', () => ({
  device: { connected: false, mode: 'none', error: null, portInfo: '' },
  connectSerial: vi.fn().mockResolvedValue(undefined),
  connectHttp: vi.fn().mockResolvedValue(undefined),
  connectRelay: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  HttpTransport: class {
    static savedAddress() { return '' }
  },
}))

vi.mock('../lib/serial-ports.js', () => ({
  findAttachedGrantedPort: vi.fn().mockResolvedValue(null),
}))

vi.mock('../lib/bridge-probe.js', () => ({
  probeBridge: vi.fn().mockResolvedValue(false),
}))

vi.mock('../lib/route.svelte.js', () => ({
  navigate: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(navigator, 'serial', {
    configurable: true,
    value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  })
  vi.mocked(connectRelay).mockClear()
  ;(device as { connected: boolean; mode: string; error: unknown; portInfo: string }).connected = false
  ;(device as { connected: boolean; mode: string; error: unknown; portInfo: string }).mode = 'none'
  ;(device as { connected: boolean; mode: string; error: unknown; portInfo: string }).error = null
  ;(device as { connected: boolean; mode: string; error: unknown; portInfo: string }).portInfo = ''
})

describe('ConnectionPicker', () => {
  it('prefills and connects with every remembered relay for a WiFi signer', async () => {
    const relays = [
      'wss://relay.trotters.cc',
      'wss://nos.lol',
      'wss://relay.damus.io',
      'wss://relay.primal.net',
    ]
    rememberDevice(HEX, relays, 'TheCryptoDonkey')

    render(ConnectionPicker)

    await fireEvent.click(screen.getByRole('button', { name: /Connect by signer address/ }))

    expect((screen.getByLabelText(/Your device's address/) as HTMLInputElement).value)
      .toBe(nip19.npubEncode(HEX))
    expect((screen.getByLabelText(/The relays it uses/) as HTMLInputElement).value)
      .toBe(relays.join(', '))

    await fireEvent.click(screen.getByRole('button', { name: 'Connect remotely' }))

    expect(vi.mocked(connectRelay)).toHaveBeenCalledWith(HEX, relays, 'TheCryptoDonkey')
  })
})
