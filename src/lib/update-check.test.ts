import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkForUpdate } from './update-check'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('checkForUpdate', () => {
  it('flags an upgrade only when the running version is known and older', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '0.15.0' }))))
    expect(await checkForUpdate('0.14.0')).toEqual({
      latest: '0.15.0',
      running: '0.14.0',
      upgrade: true,
    })
    expect(await checkForUpdate('0.15.0')).toMatchObject({ upgrade: false })
    // A signer ahead of the bundle must not be offered a downgrade.
    expect(await checkForUpdate('0.16.0')).toMatchObject({ upgrade: false })
    expect(await checkForUpdate(null)).toMatchObject({ upgrade: false })
  })

  it('returns null on fetch failure or a manifest without a version', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await checkForUpdate('0.14.0')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    expect(await checkForUpdate('0.14.0')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    expect(await checkForUpdate('0.14.0')).toBeNull()
  })
})
