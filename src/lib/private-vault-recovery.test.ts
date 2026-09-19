import { beforeEach, describe, expect, it, vi } from 'vitest'
const read = vi.hoisted(() => vi.fn())
vi.mock('signet-protocol', async importOriginal => ({
  ...await importOriginal<typeof import('signet-protocol')>(), readVaultHeadRotations: read,
}))
import { recoverVaultFamilyRoster } from './private-vault-recovery.js'
const request = vi.fn()
beforeEach(() => vi.clearAllMocks())

describe('private-first family recovery', () => {
  it('allows legacy fallback only for a confirmed absent vault', async () => {
    read.mockResolvedValue({ state: 'absent' })
    expect(await recoverVaultFamilyRoster([], request)).toBeNull()
    for (const result of [{ state: 'unavailable' }, { state: 'unusable', reason: 'chunk' }]) {
      read.mockResolvedValue(result)
      await expect(recoverVaultFamilyRoster([], request)).rejects.toThrow()
    }
  })
  it('rejects unknown profiles schemas instead of treating them as legacy', async () => {
    for (const plaintext of ['invalid', '{"v":2,"dependants":{}}', '{"v":1}']) {
      read.mockResolvedValue({ state: 'ready', snapshots: [{ plaintext }] })
      await expect(recoverVaultFamilyRoster([], request)).rejects.toThrow()
    }
  })
  it('uses explicit raw-purpose context to discover a rotation key', async () => {
    request.mockResolvedValue('a'.repeat(64))
    read.mockImplementation(async resolve => {
      await resolve(2)
      return { state: 'absent' }
    })
    await recoverVaultFamilyRoster([], request)
    expect(request).toHaveBeenCalledWith('get_public_key', [], { purpose: 'signet:vault:profiles', index: 2 })
  })
})
