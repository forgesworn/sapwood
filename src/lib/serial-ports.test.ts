import { describe, it, expect, vi, afterEach } from 'vitest'
import { releaseGrantedPorts, findAttachedGrantedPort, releasePortsOnUnload } from './serial-ports'

function stubSerial(getPorts: () => Promise<unknown[]>) {
  Object.defineProperty(navigator, 'serial', { value: { getPorts }, configurable: true })
}

afterEach(() => {
  if ('serial' in navigator) {
    // @ts-expect-error remove the stub between tests
    delete navigator.serial
  }
})

describe('releaseGrantedPorts', () => {
  it('closes open granted ports and leaves closed ones alone', async () => {
    const open = { readable: {}, writable: {}, close: vi.fn(async () => {}) }
    const closed = { readable: null, writable: null, close: vi.fn(async () => {}) }
    stubSerial(async () => [open, closed])
    await releaseGrantedPorts()
    expect(open.close).toHaveBeenCalledTimes(1)
    expect(closed.close).not.toHaveBeenCalled()
  })

  it('swallows close() errors from a stale (re-enumerated) handle', async () => {
    const stale = { readable: {}, writable: null, close: vi.fn(async () => { throw new Error('stale') }) }
    stubSerial(async () => [stale])
    await expect(releaseGrantedPorts()).resolves.toBeUndefined()
    expect(stale.close).toHaveBeenCalled()
  })

  it('no-ops when Web Serial is unavailable', async () => {
    await expect(releaseGrantedPorts()).resolves.toBeUndefined()
  })

  it('swallows a getPorts() failure', async () => {
    stubSerial(async () => { throw new Error('denied') })
    await expect(releaseGrantedPorts()).resolves.toBeUndefined()
  })

  it('cancels a locked stream so close() can succeed', async () => {
    // The bug this fixes: close() rejects while a reader still holds the
    // lock, the rejection is swallowed, and the port stays open — the
    // "port is busy, unplug the device" state. Cancelling first is what
    // actually frees it.
    let locked = true
    const reader = { cancel: vi.fn(async () => { locked = false }), releaseLock: vi.fn() }
    const port = {
      readable: {
        cancel: vi.fn(async () => { if (locked) throw new TypeError('stream is locked') }),
        getReader: vi.fn(() => reader),
      },
      writable: { abort: vi.fn(async () => {}) },
      close: vi.fn(async () => { if (locked) throw new Error('port busy') }),
    }
    stubSerial(async () => [port])

    await releaseGrantedPorts()

    expect(port.readable.getReader).toHaveBeenCalled()
    expect(reader.cancel).toHaveBeenCalled()
    expect(port.close).toHaveBeenCalled()
    expect(locked).toBe(false)
  })

  it('aborts the writable before closing', async () => {
    const port = {
      readable: { cancel: vi.fn(async () => {}), getReader: vi.fn() },
      writable: { abort: vi.fn(async () => {}) },
      close: vi.fn(async () => {}),
    }
    stubSerial(async () => [port])
    await releaseGrantedPorts()
    expect(port.writable.abort).toHaveBeenCalled()
    expect(port.close).toHaveBeenCalled()
  })
})

describe('releasePortsOnUnload', () => {
  it('registers exactly one pagehide handler that closes granted ports', async () => {
    const port = {
      readable: { cancel: vi.fn(async () => {}), getReader: vi.fn() },
      writable: { abort: vi.fn(async () => {}) },
      close: vi.fn(async () => {}),
    }
    stubSerial(async () => [port])
    const addSpy = vi.spyOn(window, 'addEventListener')

    releasePortsOnUnload()
    releasePortsOnUnload() // idempotent: callers should not need to guard

    const pagehide = addSpy.mock.calls.filter(([name]) => name === 'pagehide')
    expect(pagehide).toHaveLength(1)

    // Invoke the registered handler directly rather than dispatching a real
    // event and waiting on a timer: the assertion is about what the handler
    // does, and awaiting releaseGrantedPorts() here keeps it deterministic.
    ;(pagehide[0]![1] as EventListener)(new Event('pagehide'))
    await releaseGrantedPorts()
    expect(port.close).toHaveBeenCalled()
    addSpy.mockRestore()
  })
})

describe('findAttachedGrantedPort', () => {
  it('returns the granted port whose device is physically attached', async () => {
    const unplugged = { connected: false }
    const plugged = { connected: true }
    stubSerial(async () => [unplugged, plugged])
    expect(await findAttachedGrantedPort()).toBe(plugged)
  })

  it('trusts only an explicit connected: true (older browsers report nothing)', async () => {
    const legacy = {} // no `connected` property pre-Chrome 117
    stubSerial(async () => [legacy])
    expect(await findAttachedGrantedPort()).toBeNull()
  })

  it('is null when Web Serial is unavailable or getPorts fails', async () => {
    expect(await findAttachedGrantedPort()).toBeNull()
    stubSerial(async () => { throw new Error('denied') })
    expect(await findAttachedGrantedPort()).toBeNull()
  })
})
