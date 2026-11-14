import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import TetheredSetup from './TetheredSetup.svelte'
import { copyText } from '../lib/clipboard.js'
import { transport } from '../lib/serial.js'
import { DEFAULT_SIGNER_RELAYS } from '../lib/wizard.js'

// No serial port is touched: the transport answers every frame with an ACK.
vi.mock('../lib/serial.js', async () => {
  const { FrameType } = await import('../lib/frame.js')
  return {
    transport: {
      connected: true,
      connect: vi.fn(),
      sendAndReceive: vi.fn().mockResolvedValue({ type: FrameType.ACK, payload: new Uint8Array() }),
    },
  }
})
vi.mock('../lib/clipboard.js', () => ({ copyText: vi.fn().mockResolvedValue(true) }))

const KEY = 'heartwood.lastRelays'

beforeAll(() => {
  // The component only renders its steps where Web Serial exists.
  Object.defineProperty(navigator, 'serial', { value: {}, configurable: true })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.mocked(copyText).mockClear()
})

/** Walk intro, flash (skipped) and provision to the bridge step. */
async function reachBridgeStep() {
  render(TetheredSetup)
  await fireEvent.click(screen.getByRole('button', { name: 'Begin →' }))
  await fireEvent.click(screen.getByRole('button', { name: /Skip \(already flashed\)/ }))
  await fireEvent.click(screen.getByRole('checkbox', { name: /disconnected from the internet/ }))
  await fireEvent.click(screen.getByRole('button', { name: 'Generate recovery words' }))
  await fireEvent.click(await screen.findByRole('checkbox', { name: /written down every word/ }))
  await fireEvent.click(screen.getByRole('button', { name: 'Connect + write key →' }))
  await screen.findByText('3 · Run the bridge')
}

describe('TetheredSetup bridge relays', () => {
  it('records the relays the bridge is given when either Copy button is pressed', async () => {
    await reachBridgeStep()
    expect(transport.sendAndReceive).toHaveBeenCalledTimes(2)
    // Nothing is recorded just by reaching the step.
    expect(localStorage.getItem(KEY)).toBeNull()

    const relays = screen.getByLabelText('Relays (one per line)') as HTMLTextAreaElement
    await fireEvent.input(relays, { target: { value: 'wss://bridge-one.example, wss://bridge-two.example\n\nws://lan.example:7777' } })
    const copies = screen.getAllByRole('button', { name: 'Copy' })
    expect(copies).toHaveLength(2)

    await fireEvent.click(copies[0]!)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([
      'wss://bridge-one.example', 'wss://bridge-two.example', 'ws://lan.example:7777',
    ])

    await fireEvent.input(relays, { target: { value: 'wss://only.example' } })
    await fireEvent.click(screen.getAllByRole('button', { name: /^(Copy|Copied)$/ })[1]!)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['wss://only.example'])
    expect(copyText).toHaveBeenCalledTimes(2)
  })

  it('records the relays when Done is pressed, even if nothing was copied', async () => {
    await reachBridgeStep()
    expect(localStorage.getItem(KEY)).toBeNull()

    await fireEvent.input(screen.getByLabelText('Relays (one per line)'), {
      target: { value: 'wss://done.example' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Done →' }))

    await waitFor(() => expect(screen.getByText(/Your tethered signer is ready/)).toBeTruthy())
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['wss://done.example'])
  })

  it('records the pre-filled defaults when the relays are left as offered', async () => {
    await reachBridgeStep()
    await fireEvent.click(screen.getByRole('button', { name: 'Done →' }))
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([...DEFAULT_SIGNER_RELAYS])
  })
})

describe('TetheredSetup repeated relays', () => {
  it('names each bridge relay once, in what it records and in the config it builds', async () => {
    await reachBridgeStep()
    const relays = screen.getByLabelText('Relays (one per line)') as HTMLTextAreaElement
    await fireEvent.input(relays, { target: { value: 'wss://one.example\nwss://one.example\nwss://One.example/, wss://two.example' } })
    await fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]!)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['wss://one.example', 'wss://two.example'])
    const copied = vi.mocked(copyText).mock.calls[0]![0]
    expect(copied.match(/wss:\/\/one\.example/gi)).toHaveLength(1)
  })
})

