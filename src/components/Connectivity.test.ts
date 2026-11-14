import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import Connectivity from './Connectivity.svelte'
import {
  abortNetworkConfig, configureNetwork, configureNetworkRemotely, device, getNetworkConfig,
  patchNetworkOverUsb,
} from '../lib/device.svelte.js'
import { getOrCreateOperator } from '../lib/op-mgmt.js'
import { DEFAULT_SIGNER_RELAYS, setDefaultSignerRelays } from '../lib/wizard.js'

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
    relayConfiguredRelays: null,
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
  ;(device as { relayConfiguredRelays: string[] | null }).relayConfiguredRelays = null
  vi.mocked(getNetworkConfig).mockReset().mockResolvedValue(ACTIVE)
  vi.mocked(configureNetworkRemotely).mockReset().mockResolvedValue(ACTIVE)
  vi.mocked(configureNetwork).mockReset().mockResolvedValue(true)
  vi.mocked(patchNetworkOverUsb).mockReset()
  vi.mocked(abortNetworkConfig).mockReset().mockResolvedValue(ACTIVE)
  vi.mocked(getOrCreateOperator).mockReset()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
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

  it('sends the fallback-network list with keep actions when the signer supports it', async () => {
    vi.mocked(getNetworkConfig).mockResolvedValue({
      ...ACTIVE,
      active: {
        ...ACTIVE.active,
        networks: [
          { ssid: 'hotspot', password_set: true },
          { ssid: 'starlink', password_set: false },
        ],
      },
    })
    render(Connectivity)

    await screen.findByText('hotspot')
    await screen.findByText('starlink')
    await fireEvent.click(screen.getByRole('button', { name: 'Test & save network' }))

    await waitFor(() => expect(configureNetworkRemotely).toHaveBeenCalledWith(expect.objectContaining({
      // Reorder/keep semantics: stored entries go back as keep, no secrets.
      networks: [
        { ssid: 'hotspot', password: { action: 'keep' } },
        { ssid: 'starlink', password: { action: 'keep' } },
      ],
    })))
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

  it('names the network the signer joined when it differs from the first saved network', async () => {
    ;(device as { mode: string }).mode = 'serial'
    ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'supported'
    ;(device as { usbNetworkState: object | null }).usbNetworkState = {
      ...USB_STATE,
      networks: [{ ssid: 'Phone hotspot', password_set: true }],
      joined_index: 1,
    }
    render(Connectivity)
    await waitFor(() => expect(screen.getByText(/another saved network/)).toBeTruthy())
    expect(screen.getByText('Phone hotspot', { selector: 'strong' })).toBeTruthy()
  })

  it('says nothing about the joined network when the signer does not report it', async () => {
    ;(device as { mode: string }).mode = 'serial'
    ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'supported'
    ;(device as { usbNetworkState: object | null }).usbNetworkState = USB_STATE
    render(Connectivity)
    await waitFor(() => expect((screen.getByLabelText('WiFi SSID') as HTMLInputElement).value).toBe('Device WiFi'))
    expect(screen.queryByText(/Currently on/)).toBeNull()
  })

  it('refuses the unsafe whole-config editor on old firmware', () => {
    ;(device as { mode: string }).mode = 'serial'
    ;(device as { usbNetworkSupport: string }).usbNetworkSupport = 'unsupported'
    render(Connectivity)
    expect(screen.getByText(/may clear a password or replace the operator/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save to device' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Connectivity relay order and the owner default', () => {
  const MINE = ['wss://home.example', 'wss://second.example', 'wss://third.example']
  const resetButton = () => screen.getByRole('button', { name: 'Reset to default' }) as HTMLButtonElement
  const setDevice = (patch: Record<string, unknown>) => Object.assign(device, patch)

  async function loaded() {
    const ssid = await screen.findByLabelText('WiFi SSID') as HTMLInputElement
    await waitFor(() => expect(ssid.value).toBe('Home WiFi'))
  }

  it('Reset to default loads the stored default in order, and the normal Save applies it', async () => {
    setDefaultSignerRelays(MINE)
    render(Connectivity)
    await loaded()
    expect(screen.getByText('wss://old.example')).toBeTruthy()

    await fireEvent.click(resetButton())

    expect(screen.queryByText('wss://old.example')).toBeNull()
    expect(screen.getByText(/Your default relays are loaded\. Save to apply them/)).toBeTruthy()
    expect(configureNetworkRemotely).not.toHaveBeenCalled()

    await fireEvent.click(screen.getByRole('button', { name: 'Test & save network' }))
    await waitFor(() => expect(configureNetworkRemotely).toHaveBeenCalledWith(expect.objectContaining({
      relays: MINE,
    })))
  })

  it('drops the Reset notice once the owner edits the list, and leaves other messages alone', async () => {
    setDefaultSignerRelays(MINE)
    render(Connectivity)
    await loaded()
    await fireEvent.click(resetButton())
    expect(screen.getByText(/Your default relays are loaded\. Save to apply them/)).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: `Move ${MINE[0]} down` }))

    expect(screen.queryByText(/Your default relays are loaded/)).toBeNull()
    expect(screen.getByText(MINE[1]!)).toBeTruthy()
  })

  it('keeps an unrelated message when the list is edited', async () => {
    vi.mocked(configureNetworkRemotely).mockRejectedValue(new Error('Relay said no'))
    render(Connectivity)
    await loaded()
    await fireEvent.click(screen.getByRole('button', { name: 'Test & save network' }))
    await screen.findByText('Relay said no')

    await fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(screen.getByText('Relay said no')).toBeTruthy()
  })

  it('Reset to default falls back to the built-in set when nothing is stored', async () => {
    render(Connectivity)
    await loaded()
    await fireEvent.click(resetButton())
    await fireEvent.click(screen.getByRole('button', { name: 'Test & save network' }))
    await waitFor(() => expect(configureNetworkRemotely).toHaveBeenCalledWith(expect.objectContaining({
      relays: [...DEFAULT_SIGNER_RELAYS],
    })))
  })

  it('sends the new order after a read-back relay is moved down', async () => {
    vi.mocked(getNetworkConfig).mockResolvedValue({
      ...ACTIVE,
      active: { ...ACTIVE.active, relays: ['wss://one.example', 'wss://two.example', 'wss://three.example'] },
    })
    render(Connectivity)
    await loaded()
    await waitFor(() => expect(screen.getByText('wss://one.example')).toBeTruthy())

    await fireEvent.click(screen.getByRole('button', { name: 'Move wss://one.example down' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Test & save network' }))

    await waitFor(() => expect(configureNetworkRemotely).toHaveBeenCalledWith(expect.objectContaining({
      relays: ['wss://two.example', 'wss://one.example', 'wss://three.example'],
    })))
  })

  it('disables Reset to default when the editor already equals the default, and enables it after a reorder', async () => {
    setDefaultSignerRelays(MINE)
    vi.mocked(getNetworkConfig).mockResolvedValue({
      ...ACTIVE,
      active: { ...ACTIVE.active, relays: [...MINE] },
    })
    render(Connectivity)
    await loaded()
    await waitFor(() => expect(screen.getByText(MINE[0]!)).toBeTruthy())
    expect(resetButton().disabled).toBe(true)

    await fireEvent.click(screen.getByRole('button', { name: `Move ${MINE[0]} down` }))
    expect(resetButton().disabled).toBe(false)

    await fireEvent.click(resetButton())
    expect(resetButton().disabled).toBe(true)
  })

  it('disables Reset to default whenever Save is blocked by a pending network trial', async () => {
    setDefaultSignerRelays(MINE)
    vi.mocked(getNetworkConfig).mockResolvedValue({
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
    })
    render(Connectivity)
    await screen.findByRole('button', { name: 'Discard pending change' })
    expect((screen.getByRole('button', { name: 'Test & save network' }) as HTMLButtonElement).disabled).toBe(true)
    expect(resetButton().disabled).toBe(true)
  })

  it('disables Reset to default on USB firmware that cannot safely patch its network', () => {
    setDefaultSignerRelays(MINE)
    // A different display list, so Reset is not disabled merely for matching.
    localStorage.setItem('heartwood.lastRelays', JSON.stringify(['wss://elsewhere.example']))
    setDevice({ mode: 'serial', usbNetworkSupport: 'unsupported', usbNetworkState: null })
    render(Connectivity)
    expect(screen.getByText('wss://elsewhere.example')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save to device' }) as HTMLButtonElement).disabled).toBe(true)
    expect(resetButton().disabled).toBe(true)
  })

  describe('the relay-set indicator', () => {
    it('says "Your default relays" when the proven list equals the default set in order', async () => {
      setDefaultSignerRelays(MINE)
      setDevice({ relayConfiguredRelays: [...MINE] })
      render(Connectivity)
      await loaded()
      expect(screen.getByText('Your default relays')).toBeTruthy()
      expect(screen.queryByText('Custom')).toBeNull()
    })

    it('says "Custom" when the proven list has the same relays in another order', async () => {
      setDefaultSignerRelays(MINE)
      setDevice({ relayConfiguredRelays: [MINE[1], MINE[0], MINE[2]] })
      render(Connectivity)
      await loaded()
      expect(screen.getByText('Custom')).toBeTruthy()
      expect(screen.queryByText('Your default relays')).toBeNull()
    })

    it('says "Custom" for a different set', async () => {
      setDevice({ relayConfiguredRelays: ['wss://elsewhere.example'] })
      render(Connectivity)
      await loaded()
      expect(screen.getByText('Custom')).toBeTruthy()
    })

    it('says the built-in set is the default when nothing is stored', async () => {
      setDevice({ relayConfiguredRelays: [...DEFAULT_SIGNER_RELAYS] })
      render(Connectivity)
      await loaded()
      expect(screen.getByText('Your default relays')).toBeTruthy()
    })

    it('says nothing while the device-proven list is unknown', async () => {
      setDefaultSignerRelays(MINE)
      setDevice({ relayConfiguredRelays: null })
      render(Connectivity)
      await loaded()
      expect(screen.queryByText('Your default relays')).toBeNull()
      expect(screen.queryByText('Custom')).toBeNull()
    })

    it('does not treat the editor contents as proof', async () => {
      setDefaultSignerRelays(MINE)
      vi.mocked(getNetworkConfig).mockResolvedValue({
        ...ACTIVE,
        active: { ...ACTIVE.active, relays: [...MINE] },
      })
      render(Connectivity)
      await loaded()
      await waitFor(() => expect(screen.getByText(MINE[0]!)).toBeTruthy())
      expect(screen.queryByText('Your default relays')).toBeNull()
      expect(screen.queryByText('Custom')).toBeNull()
    })
  })

  describe('over USB', () => {
    const CONFIGURED = {
      version: 1 as const,
      configured: true,
      revision: 8,
      mode: 'wifi' as const,
      ssid: 'Device WiFi',
      relays: ['wss://device.example', 'wss://device2.example'],
      password_set: true,
      op_mgmt: 'a'.repeat(64),
      recovery_ok: true,
      trial: null,
    }
    const usb = (state: object | null) => setDevice({
      mode: 'serial', usbNetworkSupport: 'supported', usbNetworkState: state,
    })

    it('seeds an unconfigured board from the stored default, not from lastRelays', async () => {
      setDefaultSignerRelays(MINE)
      localStorage.setItem('heartwood.lastRelays', JSON.stringify(['wss://other-heartwood.example']))
      usb({ version: 1, configured: false, revision: 0, recovery_ok: true, trial: null })
      render(Connectivity)

      await waitFor(() => expect(screen.getByText(MINE[0]!)).toBeTruthy())
      for (const relay of MINE) expect(screen.getByText(relay)).toBeTruthy()
      expect(screen.queryByText('wss://other-heartwood.example')).toBeNull()
      expect(resetButton().disabled).toBe(true)
    })

    it('seeds an unconfigured board from the built-in set when nothing is stored', async () => {
      localStorage.setItem('heartwood.lastRelays', JSON.stringify(['wss://other-heartwood.example']))
      usb({ version: 1, configured: false, revision: 0, recovery_ok: true, trial: null })
      render(Connectivity)

      await waitFor(() => expect(screen.getByText(DEFAULT_SIGNER_RELAYS[0]!)).toBeTruthy())
      expect(screen.queryByText('wss://other-heartwood.example')).toBeNull()
    })

    it('shows the signer\'s own relays on a configured board, whatever the default is', async () => {
      setDefaultSignerRelays(MINE)
      usb(CONFIGURED)
      render(Connectivity)
      await waitFor(() => expect(screen.getByText('wss://device.example')).toBeTruthy())
      expect(screen.queryByText(MINE[0]!)).toBeNull()
      expect(resetButton().disabled).toBe(false)
    })

    it('reports Custom for a configured WiFi board whose relays differ from the default', async () => {
      setDefaultSignerRelays(MINE)
      usb(CONFIGURED)
      render(Connectivity)
      await waitFor(() => expect(screen.getByText('Custom')).toBeTruthy())
    })

    it('reports "Your default relays" for a configured WiFi board holding the default in order', async () => {
      setDefaultSignerRelays(MINE)
      usb({ ...CONFIGURED, relays: [...MINE] })
      render(Connectivity)
      await waitFor(() => expect(screen.getByText('Your default relays')).toBeTruthy())
    })

    it('says nothing while a network trial is pending, or when the board is unconfigured', async () => {
      setDefaultSignerRelays(MINE)
      usb({
        ...CONFIGURED,
        relays: [...MINE],
        trial: { transaction_id: 'tx', revision: 9, phase: 'trying' },
      })
      const { unmount } = render(Connectivity)
      await waitFor(() => expect(screen.getByText(MINE[0]!)).toBeTruthy())
      expect(screen.queryByText('Your default relays')).toBeNull()
      expect(screen.queryByText('Custom')).toBeNull()
      unmount()

      usb({ version: 1, configured: false, revision: 0, recovery_ok: true, trial: null })
      render(Connectivity)
      await waitFor(() => expect(screen.getByText(MINE[0]!)).toBeTruthy())
      expect(screen.queryByText('Your default relays')).toBeNull()
      expect(screen.queryByText('Custom')).toBeNull()
    })

    it('says nothing for a configured board in USB-only (radio off) mode, where there are no relays', async () => {
      setDefaultSignerRelays(MINE)
      usb({ ...CONFIGURED, mode: 'usb', relays: [...MINE] })
      render(Connectivity)
      await waitFor(() => expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('usb'))
      expect(screen.queryByText('Your default relays')).toBeNull()
      expect(screen.queryByText('Custom')).toBeNull()
    })

    it('follows a change to the defaults made while the panel is open', async () => {
      setDefaultSignerRelays(MINE)
      usb({ ...CONFIGURED, relays: [...MINE] })
      render(Connectivity)
      await waitFor(() => expect(screen.getByText('Your default relays')).toBeTruthy())

      // The owner saves a different default elsewhere on the page.
      act(() => { setDefaultSignerRelays(['wss://elsewhere.example']) })
      await waitFor(() => expect(screen.getByText('Custom')).toBeTruthy())
      expect(screen.queryByText('Your default relays')).toBeNull()

      // And back again, this time as another tab would: a storage event.
      await act(() => {
        localStorage.setItem('heartwood.defaultSignerRelays', JSON.stringify(MINE))
        window.dispatchEvent(new StorageEvent('storage', { key: 'heartwood.defaultSignerRelays' }))
      })
      await waitFor(() => expect(screen.getByText('Your default relays')).toBeTruthy())
    })
  })
})
