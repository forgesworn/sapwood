import { describe, it, expect, vi, afterEach } from 'vitest'
import { releaseGrantedPorts, findAttachedGrantedPort } from './serial-ports'

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
