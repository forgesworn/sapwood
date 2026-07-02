import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'
import Flasher from './Flasher.svelte'
import { flashDevice } from './lib/flasher.js'

// Mock only the flash itself; keep BOARDS real so the board step renders.
vi.mock('./lib/flasher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/flasher.js')>()
  return { ...actual, flashDevice: vi.fn().mockResolvedValue(undefined) }
})

const mockFlash = vi.mocked(flashDevice)

function setWebSerial(present: boolean) {
  if (present) {
    Object.defineProperty(navigator, 'serial', { value: {}, configurable: true })
  } else if ('serial' in navigator) {
    // @ts-expect-error remove the stub
    delete navigator.serial
  }
}

beforeEach(() => {
  mockFlash.mockClear()
  localStorage.clear()
})
afterEach(() => setWebSerial(false))

describe('Flasher — unsupported browser', () => {
  it('explains the requirement and disables Start when Web Serial is missing', () => {
    setWebSerial(false)
    render(Flasher)
    expect(screen.getByText('Set up your Heartwood')).toBeTruthy()
    expect(screen.getByText(/needs a computer running Chrome or Edge/i)).toBeTruthy()
    expect((screen.getByText('Start') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Flasher — happy path', () => {
  beforeEach(() => setWebSerial(true))

  it('walks welcome → board → network → review → flash → done and flashes with the entered config', async () => {
    const { container } = render(Flasher)

    // Welcome → board
    await fireEvent.click(screen.getByText('Start'))
    expect(screen.getByText('Which device do you have?')).toBeTruthy()

    // Pick the first board → Next
    await fireEvent.click(screen.getByText('Heltec WiFi LoRa 32 V4'))
    await fireEvent.click(screen.getByText('Next'))
    expect(screen.getByText('Which Wi-Fi should it use?')).toBeTruthy()

    // Fill wifi (ssid is the first input, password the second)
    const inputs = container.querySelectorAll('input')
    await fireEvent.input(inputs[0], { target: { value: 'home-wifi' } })
    await fireEvent.input(inputs[1], { target: { value: 'hunter2hunter2' } })
    await fireEvent.click(screen.getByText('Next'))
    expect(screen.getByText('Ready to flash')).toBeTruthy()

    // Flash
    await fireEvent.click(screen.getByText('Flash'))

    // Lands on the done screen
    expect(await screen.findByText('Your signer is flashed')).toBeTruthy()

    // Flashed once, with the board + a wifi config carrying an operator key
    expect(mockFlash).toHaveBeenCalledTimes(1)
    const [board, cfg] = mockFlash.mock.calls[0]
    expect(board.id).toBe('heltec-v4')
    expect(cfg.ssid).toBe('home-wifi')
    expect(cfg.mode).toBe('wifi')
    expect(cfg.password).toBe('hunter2hunter2')
    expect(cfg.op_mgmt).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reveals and re-hides the wifi password via the eye toggle', async () => {
    const { container } = render(Flasher)
    await fireEvent.click(screen.getByText('Start'))
    await fireEvent.click(screen.getByText('Heltec WiFi LoRa 32 V4'))
    await fireEvent.click(screen.getByText('Next'))

    const password = container.querySelectorAll('input')[1]
    await fireEvent.input(password, { target: { value: 'hunter2hunter2' } })
    expect(password.type).toBe('password')

    const eye = screen.getByLabelText('Show password')
    await fireEvent.click(eye)
    expect(password.type).toBe('text')
    expect(password.value).toBe('hunter2hunter2')

    await fireEvent.click(screen.getByLabelText('Hide password'))
    expect(password.type).toBe('password')
  })

  it('blocks Next on the network step until the wifi name is valid', async () => {
    const { container } = render(Flasher)
    await fireEvent.click(screen.getByText('Start'))
    await fireEvent.click(screen.getByText('Heltec WiFi LoRa 32 V4'))
    await fireEvent.click(screen.getByText('Next'))

    // No SSID yet → Next disabled
    expect((screen.getByText('Next') as HTMLButtonElement).disabled).toBe(true)

    const inputs = container.querySelectorAll('input')
    await fireEvent.input(inputs[0], { target: { value: 'home-wifi' } })
    expect((screen.getByText('Next') as HTMLButtonElement).disabled).toBe(false)
  })
})
