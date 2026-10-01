import { describe, it, expect, vi, beforeEach } from 'vitest'

const { flashMock } = vi.hoisted(() => ({ flashMock: vi.fn() }))
vi.mock('./flasher', () => ({ flashAppOnly: flashMock }))

import { usbUpdate, runUsbUpdate, clearUsbUpdate, usbUpdateBusy } from './usb-update.svelte'
import type { BoardSpec } from './flasher'

const BOARD = { id: 'tdisplay', label: 'T-Display', assets: '/firmware/tdisplay', configOffset: 0x310000 } as BoardSpec

describe('runUsbUpdate', () => {
  beforeEach(() => {
    flashMock.mockReset()
    usbUpdate.status = 'idle'
    usbUpdate.progress = 0
    usbUpdate.message = ''
    usbUpdate.installedVersion = null
  })

  it('releases the console port before the flasher opens it', async () => {
    const order: string[] = []
    flashMock.mockImplementation(async () => { order.push('flash') })
    await runUsbUpdate(BOARD, { version: '1.2.3', release: async () => { order.push('release') } })
    expect(order).toEqual(['release', 'flash'])
  })

  it('keeps the progress and outcome outside any component', async () => {
    const seen: Array<[string, number, string]> = []
    flashMock.mockImplementation(async (_b, h) => {
      h.onLog('Select the device serial port…')
      seen.push([usbUpdate.status, usbUpdate.progress, usbUpdate.message])
      h.onProgress(40, 'firmware')
      seen.push([usbUpdate.status, usbUpdate.progress, usbUpdate.message])
      // A log line during the write must not replace the progress message.
      h.onLog('Writing at 0x00020000...')
      seen.push([usbUpdate.status, usbUpdate.progress, usbUpdate.message])
      h.onProgress(100, 'done')
    })
    await runUsbUpdate(BOARD, { version: '1.2.3' })
    expect(seen[0]).toEqual(['waiting', 0, 'Select the device serial port…'])
    expect(seen[1][0]).toBe('uploading')
    expect(seen[1][1]).toBe(40)
    expect(seen[1][2]).toMatch(/Writing firmware… 40%.*screen/)
    expect(seen[2]).toEqual(seen[1])
    expect(usbUpdate.status).toBe('done')
    expect(usbUpdate.installedVersion).toBe('1.2.3')
    expect(usbUpdate.message).toMatch(/v1\.2\.3.*Reconnect/)
  })

  it('records a failure instead of throwing', async () => {
    flashMock.mockRejectedValue(new Error('No port selected'))
    await expect(runUsbUpdate(BOARD, { version: '1.2.3' })).resolves.toBeUndefined()
    expect(usbUpdate.status).toBe('error')
    expect(usbUpdate.message).toBe('No port selected')
    expect(usbUpdate.installedVersion).toBeNull()
  })

  it('counts a failed release as a failure, before touching the flasher', async () => {
    await runUsbUpdate(BOARD, { version: null, release: async () => { throw new Error('port stuck') } })
    expect(flashMock).not.toHaveBeenCalled()
    expect(usbUpdate.status).toBe('error')
  })

  it('runs one update at a time, and a dismiss cannot clear a live one', async () => {
    let finish!: () => void
    flashMock.mockImplementation(() => new Promise<void>((r) => { finish = r }))
    const first = runUsbUpdate(BOARD, { version: '1.2.3' })
    await Promise.resolve()
    expect(usbUpdateBusy()).toBe(true)
    await runUsbUpdate(BOARD, { version: '9.9.9' })
    clearUsbUpdate()
    expect(usbUpdate.status).toBe('waiting')
    finish()
    await first
    expect(flashMock).toHaveBeenCalledTimes(1)
    expect(usbUpdate.installedVersion).toBe('1.2.3')
    clearUsbUpdate()
    expect(usbUpdate.status).toBe('idle')
  })
})
