import { describe, it, expect, vi, afterEach } from 'vitest'
import { releaseGrantedPorts } from './serial-ports'

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
})
